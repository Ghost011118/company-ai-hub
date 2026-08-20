# Company AI Hub

一个可被本地 Codex 直接连接的公司 AI 能力网关。管理员统一维护全局 Agent、Skill 和 Prompt；员工通过公司 API 使用统一上游，也可以在网页提交个人创意，经管理员审核后发布到公司能力库。

## 首版已覆盖

- 管理员与员工账号、数据库会话、角色权限
- Codex-compatible `POST /v1/responses`（JSON 与 SSE 流式透传）
- OpenAI-compatible `POST /v1/chat/completions` 和 `GET /v1/models`
- 公司统一上游供应商配置与加密密钥
- 公司与个人 Agent / Skill / Prompt 管理
- 员工投稿、管理员批准或退回、审核快照发布
- 公司能力的确定性服务端注入，以及 `X-Company-Agent` Agent 选择
- 网页 API 调试入口
- 供应商密钥 AES-256-GCM 加密、密码 scrypt 哈希
- CSRF、登录限流、请求校验、CSP、SSRF 基础防护和审计事件

首版 Skill 是声明式指令模块，不执行员工上传的 JavaScript、Python 或 Shell 代码。这避免了把“共享 Skill”变成远程代码执行入口。

## 本地运行

要求 Node.js 24+ 和 pnpm。

```powershell
Copy-Item .env.example .env

# 生成一个 32 字节的 base64 加密密钥并填入 .env 的 APP_ENCRYPTION_KEY
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)

# 同时设置首次管理员密码 ADMIN_PASSWORD，然后运行
pnpm install
pnpm dev
```

同时设置 `GATEWAY_BEARER_TOKEN`。打开 `http://localhost:3780`，登录后由管理员配置公司上游。只有数据库中没有用户时，应用才会使用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 创建首个管理员。

## 让本地 Codex 连接公司 API

在员工机器的用户级 `~/.codex/config.toml` 中加入：

```toml
model = "公司允许的模型名"
model_provider = "company_ai"

[model_providers.company_ai]
name = "Company AI Hub"
base_url = "https://ai.example.com/v1"
env_key = "COMPANY_AI_TOKEN"
wire_api = "responses"
```

然后把公司发放的网关访问凭据放入环境变量 `COMPANY_AI_TOKEN`。项目级 `.codex/config.toml` 不能覆盖 provider 配置，必须写在用户级配置中。

如需固定使用某个已发布 Agent，可在 provider 中增加静态请求头：

```toml
http_headers = { "X-Company-Agent" = "code-review" }
```

上述字段以 [Codex configuration reference](https://developers.openai.com/codex/config-file/config-reference) 为准。网关按官方 [Responses create API](https://developers.openai.com/api/reference/resources/responses/methods/create) 修改 `instructions`，其余字段与工具定义保持透传。

## Docker

先根据 `.env.example` 创建 `.env` 并设置必填项，再运行：

```powershell
docker compose up --build
```

SQLite 数据保存在命名卷 `company-ai-hub-data` 中。

## 能力注入顺序

1. 公司级、始终启用的 Prompt 与 Skill
2. `X-Company-Agent` 选中的公司 Agent 及其关联 Skill
3. 调用方原有的 `instructions`
4. 调用方原有的 `input`、工具与其他 Responses 字段

同一层级按 `priority` 升序、名称和 ID 稳定排序。实际组装发生在服务端；浏览器只展示能力名称。

## 投稿与审核

员工提交时会生成不可变快照。管理员批准的是这份快照，而不是随时可能变化的个人草稿。批准后生成带作者归属的公司版本；退回时必须填写原因。员工随后修改草稿不会改变已发布版本。

## 生产提示

- 把 `.env` 中的密钥放进部署平台的 Secret Manager，不要提交到 Git。
- 生产环境通过 HTTPS 反向代理提供服务，并把 `SESSION_COOKIE_SECURE=true`。
- 生产环境必须把 `PROVIDER_HOST_ALLOWLIST` 配置为公司允许使用的供应商域名精确列表；这是上游网络访问的信任边界。
- `compose.yaml` 默认面向本机 HTTP 验收，因此 `SESSION_COOKIE_SECURE` 默认是 `false`；接入 HTTPS 反向代理时必须设为 `true`。
- MVP 不提供员工 API Key 发放后台；网关访问 token 由部署环境统一管理。正式大规模使用建议在前置网关接入公司 SSO/IAP。
- 定期备份 SQLite；多人高并发或多实例部署时，将持久化层迁移到 PostgreSQL。
- API 网关优先支持 Codex 使用的 Responses 协议；供应商必须真正兼容 Responses 的请求与 SSE 事件格式。

## 验证

```powershell
pnpm typecheck
pnpm test
pnpm build
```

详细边界与流程见 [docs/architecture.md](docs/architecture.md)。
