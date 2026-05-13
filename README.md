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
