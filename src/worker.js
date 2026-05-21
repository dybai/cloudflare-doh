/**
 * 私有 DNS-over-HTTPS (DoH) — 仅转发到固定上游，带密钥校验。
 * 不含公开落地页、多路径转发或外链，避免被误判为开放代理。
 *
 * 鉴权（二选一，需在 wrangler secret 中设置 DOH_AUTH_TOKEN）：
 * 1) 请求头：Authorization: Bearer <DOH_AUTH_TOKEN>
 * 2) 路径（适合无法在浏览器 DoH 里带头部的场景）：
 *    https://<你的域名>/v1/<DOH_AUTH_TOKEN>/dns-query?dns=...
 *
 * 上游默认 Cloudflare 公共 DoH，可通过环境变量 DOH_UPSTREAM_URL 覆盖。
 *
 * 边缘缓存：对 GET 上游请求使用 Workers 子请求缓存（cf：cacheEverything +
 * cacheTtlByStatus），相同上游 URL+查询串在 TTL 内命中边缘。POST 不缓存（避免仅按 URL
 * 键控导致错答）。变量 DOH_CACHE_TTL 为秒数，默认 120，范围 0–3600；0 表示关闭。
 *
 * 查询日志：DOH_LOG_QUERIES 为 1/true/yes/on 时在 console 打印 DNS 查询参数（默认关闭）。
 */

const DEFAULT_UPSTREAM = 'https://cloudflare-dns.com/dns-query';
const LOG_QUERY_TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const DEFAULT_CACHE_TTL_SEC = 120;
const MAX_CACHE_TTL_SEC = 3600;

function getEdgeCacheTtlSeconds(env) {
	const raw = env.DOH_CACHE_TTL;
	if (raw === undefined || raw === null || raw === '') return DEFAULT_CACHE_TTL_SEC;
	const n = Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_CACHE_TTL_SEC;
	return Math.min(Math.max(Math.floor(n), 0), MAX_CACHE_TTL_SEC);
}

function jsonError(status, message) {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
}

function stripHopByHopHeaders(src) {
	const out = new Headers();
	const allow = new Set(['accept', 'content-type', 'content-length']);
	for (const [k, v] of src.entries()) {
		if (allow.has(k.toLowerCase())) out.set(k, v);
	}
	return out;
}

function isQueryLogEnabled(env) {
	const raw = env.DOH_LOG_QUERIES;
	if (raw === undefined || raw === null || raw === '') return false;
	return LOG_QUERY_TRUTHY.has(String(raw).trim().toLowerCase());
}

/** 日志用路径：/v1/<token>/dns-query 中的 token 脱敏 */
function redactPathnameForLog(pathname) {
	const parts = pathname.split('/').filter(Boolean);
	if (parts.length === 3 && parts[0] === 'v1' && parts[2] === 'dns-query') {
		return '/v1/[redacted]/dns-query';
	}
	return pathname;
}

function summarizeDnsParam(value, maxLen = 80) {
	if (value.length <= maxLen) return value;
	return `${value.slice(0, maxLen)}…(${value.length} chars)`;
}

function collectDnsQueryParams(search) {
	if (!search) return {};
	const params = {};
	for (const [key, value] of new URLSearchParams(search)) {
		if (key === 'dns') {
			params.dns = summarizeDnsParam(value);
		} else {
			params[key] = value;
		}
	}
	return params;
}

function logDnsQuery(request, pathname) {
	const accept = request.headers.get('Accept') ?? '';
	const contentType = request.headers.get('Content-Type') ?? '';
	const contentLength = request.headers.get('Content-Length') ?? '';

	const entry = {
		method: request.method,
		path: redactPathnameForLog(pathname),
		accept: accept || undefined,
	};

	if (request.method === 'GET') {
		const query = collectDnsQueryParams(new URL(request.url).search);
		if (Object.keys(query).length > 0) entry.query = query;
	} else if (request.method === 'POST') {
		entry.contentType = contentType || undefined;
		entry.contentLength = contentLength || undefined;
		entry.note = 'POST body is DNS wire format; see Workers log or packet capture for raw bytes';
	}

	console.log('[doh] query', JSON.stringify(entry));
}

export default {
	async fetch(request, env) {
		if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'OPTIONS') {
			return jsonError(405, 'method not allowed');
		}

		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: {
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
					'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization',
					'Access-Control-Max-Age': '86400',
				},
			});
		}

		const token = env.DOH_AUTH_TOKEN;
		if (!token || typeof token !== 'string' || token.length < 16) {
			return jsonError(
				503,
				'server misconfigured: set DOH_AUTH_TOKEN secret (min 16 chars)',
			);
		}

		const url = new URL(request.url);
		const pathname = url.pathname.replace(/\/+$/, '') || '/';

		let upstreamPathQuery = url.search;

		// 标准路径 /dns-query
		if (pathname === '/dns-query') {
			const auth = request.headers.get('Authorization');
			if (auth !== `Bearer ${token}`) {
				return jsonError(401, 'unauthorized');
			}
		} else if (pathname.startsWith('/v1/')) {
			// /v1/<token>/dns-query
			const parts = pathname.split('/').filter(Boolean);
			if (parts.length !== 3 || parts[0] !== 'v1' || parts[2] !== 'dns-query') {
				return jsonError(404, 'not found');
			}
			if (parts[1] !== token) {
				return jsonError(401, 'unauthorized');
			}
		} else {
			return new Response('Not Found', { status: 404 });
		}

		if (isQueryLogEnabled(env)) {
			logDnsQuery(request, pathname);
		}

		const upstreamBase = (env.DOH_UPSTREAM_URL || DEFAULT_UPSTREAM).replace(/\/+$/, '');
		const upstreamUrl = `${upstreamBase}${upstreamPathQuery}`;

		const headers = stripHopByHopHeaders(request.headers);
		const upstreamReq = new Request(upstreamUrl, {
			method: request.method,
			headers,
			body: request.method === 'POST' ? request.body : undefined,
			redirect: 'manual',
		});

		const cacheTtl = getEdgeCacheTtlSeconds(env);
		const fetchOptions =
			request.method === 'GET' && cacheTtl > 0
				? {
						cf: {
							cacheEverything: true,
							cacheTtl: 0,
							cacheTtlByStatus: { '200': cacheTtl },
						},
					}
				: {};

		const res = await fetch(upstreamReq, fetchOptions);
		const outHeaders = new Headers(res.headers);
		outHeaders.delete('set-cookie');
		return new Response(res.body, { status: res.status, headers: outHeaders });
	},
};
