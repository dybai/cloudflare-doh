# 私有 DoH（Cloudflare Workers）

基于 Cloudflare Workers 的自用 DNS over HTTPS 转发：固定上游、密钥鉴权、无公开落地页，适合个人或小范围使用。

## 前置条件

- [Cloudflare](https://dash.cloudflare.com/) 账号
- 本机已安装 [Node.js](https://nodejs.org/)（建议 LTS）
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)（`npm install -g wrangler`）

## 配置说明

| 名称 | 类型 | 说明 |
|------|------|------|
| `DOH_AUTH_TOKEN` | **Secret**（必填） | 随机字符串，**至少 16 字符**。勿写入仓库或 `wrangler.toml`。 |
| `DOH_UPSTREAM_URL` | 可选 **变量** | 上游 DoH 根地址，默认 `https://cloudflare-dns.com/dns-query`。可在 `wrangler.toml` 的 `[vars]` 或控制台「变量」中配置。 |
| `DOH_CACHE_TTL` | 可选 **变量** | **GET** 查询在边缘缓存的秒数（仅缓存上游 **HTTP 200**）。默认 `120`，范围 `0`–`3600`；`0` 表示关闭。POST 不参与缓存。 |
| `DOH_LOG_QUERIES` | 可选 **变量** | 为 `1`、`true`、`yes`、`on`（不区分大小写）时，将 DNS 查询参数写入 Workers 日志（`console.log`）；**默认关闭**。 |

### 查询日志（`DOH_LOG_QUERIES`）

开启后，每次通过鉴权的查询会在 Cloudflare 控制台 **Workers → 你的服务 → Logs**（或 `wrangler tail`）中看到一行 JSON，前缀为 `[doh] query`。

- **GET**：记录 `name`、`type`、`dns` 等 URL 查询参数；`dns`（wire format）过长时会截断并标注总长度。
- **POST**：记录 `Content-Type`、`Content-Length` 等；报文体为二进制 DNS 报文，不在日志中展开。
- **路径**：`/v1/<token>/dns-query` 中的 token 在日志里显示为 `[redacted]`，避免密钥进日志。

调试示例（`wrangler.toml` 的 `[vars]` 或控制台变量）：

```toml
DOH_LOG_QUERIES = "true"
```

生产环境建议保持关闭，以免日志量过大或泄露查询域名习惯。

### 边缘缓存说明

- 实现方式：对已鉴权的 **GET** 请求，对上游 `fetch` 使用 Workers 的 `cf.cacheTtlByStatus`，在 Cloudflare 边缘复用相同「上游 URL + 查询串」的应答，减轻延迟与上游压力。
- **POST**（wire format）不按 URL 区分报文体，若强行用同一套边缘键容易错缓存，因此 **始终回源**。
- 缓存时长为固定秒数，**未按 DNS 记录 TTL 动态调整**；若你解析变更频繁，可把 `DOH_CACHE_TTL` 调小或设为 `0`。

## 部署方法

1. 克隆或进入本仓库目录。

2. 登录 Cloudflare（浏览器会打开授权）：

   ```bash
   wrangler login
   ```

3. 设置鉴权密钥（按提示粘贴你的随机 token，回车确认）：

   ```bash
   wrangler secret put DOH_AUTH_TOKEN
   ```

4. （可选）修改 `wrangler.toml` 顶部的 `name = "private-doh"` 为你想要的 Worker 名称。

5. （可选）若需自定义上游，在 `wrangler.toml` 中取消注释并修改：

   ```toml
   [vars]
   DOH_UPSTREAM_URL = "https://cloudflare-dns.com/dns-query"
   ```

6. 部署：

   ```bash
   wrangler deploy
   ```

部署成功后，终端会显示 Worker 的默认域名（形如 `https://private-doh.<你的子域>.workers.dev`）。也可在控制台为该 Worker 绑定自定义域名。

## 使用方法

Worker 仅处理 **`/dns-query`** 相关路径；其它路径返回 `404`。

### 方式一：标准路径 + Bearer（推荐）

适用于 `curl`、支持自定义请求头的客户端、部分系统/应用。

- **URL**：`https://<你的域名>/dns-query`
- **鉴权**：请求头 `Authorization: Bearer <DOH_AUTH_TOKEN>`

**GET（DNS JSON 示例）**

```bash
export DOH_BASE="https://<你的域名>/dns-query"
export DOH_TOKEN="<你的 DOH_AUTH_TOKEN>"

curl -sS \
  -H "Accept: application/dns-json" \
  -H "Authorization: Bearer ${DOH_TOKEN}" \
  "${DOH_BASE}?name=example.com&type=A"
```

**GET（wire format，`dns` 为 base64url 编码的 DNS 报文）**

按 [RFC 8484](https://www.rfc-editor.org/rfc/rfc8484) 构造 `?dns=` 查询串；请求头中 `Accept: application/dns-message` 与上游约定一致即可。

**POST（wire format）**

```bash
curl -sS -X POST \
  -H "Authorization: Bearer ${DOH_TOKEN}" \
  -H "Accept: application/dns-message" \
  -H "Content-Type: application/dns-message" \
  --data-binary @query.bin \
  "${DOH_BASE}"
```

其中 `query.bin` 为二进制 DNS 查询报文（需自行生成）。

### 方式二：路径中带密钥（适合只能填 URL 的场景）

适用于部分浏览器「安全 DNS - 自定义提供商」等无法附加 `Authorization` 的情况。

- **URL**：`https://<你的域名>/v1/<DOH_AUTH_TOKEN>/dns-query?...`

查询参数与标准 DoH 一致（例如 JSON：`?name=example.com&type=A` 且 `Accept: application/dns-json`）。

**示例**

```bash
export DOH_HOST="https://<你的域名>"
export DOH_TOKEN="<你的 DOH_AUTH_TOKEN>"

curl -sS \
  -H "Accept: application/dns-json" \
  "${DOH_HOST}/v1/${DOH_TOKEN}/dns-query?name=example.com&type=A"
```

**安全提示**：密钥出现在 URL 中可能进入代理/网关/访问日志；请使用足够长的随机 token，且不要将浏览器截图或日志随意分享。

## 常见问题

- **返回 503 且 JSON 提示未配置 token**：未设置 `DOH_AUTH_TOKEN` 或长度不足 16，请执行 `wrangler secret put DOH_AUTH_TOKEN` 后重新部署或等待 Secret 生效。
- **返回 401**：Bearer 拼写错误、路径中 token 与 Secret 不一致，或使用了错误路径。
- **上游**：默认转发到 Cloudflare 公共 DoH；更换上游时确保对方允许从你的 Worker 出口访问，且路径仍为上游的 `/dns-query` 及相同查询语义。
