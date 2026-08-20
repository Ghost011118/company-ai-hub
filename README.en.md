# Company AI Hub

[简体中文](README.md) | [English](README.en.md)

[![CI](https://github.com/Ghost011118/company-ai-hub/actions/workflows/verify.yml/badge.svg)](https://github.com/Ghost011118/company-ai-hub/actions/workflows/verify.yml)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.en.md)

A self-hosted, Codex-compatible company AI capability gateway. Administrators centrally manage Agents, Skills, and Prompts. Employees use a shared upstream through the company API and can submit their own ideas for admin review and publication in the company capability library.

## Why it exists

```text
Local Codex / API clients
          |
          v
Company AI Hub  ----  Admin review & capability registry
          |
          v
Approved upstream AI provider
```

- Govern company-wide AI capabilities on the server instead of manually synchronizing prompts to every employee device.
- Support the Responses API used by Codex while preserving the caller's original tools and request fields.
- Let employees contribute Agents, Skills, and Prompts, while publishing only immutable snapshots approved by an administrator.
- Keep employee Codex configuration and upstream provider credentials outside the application; deployers configure the gateway and upstream explicitly.

## MVP features

- Administrator and employee accounts, database-backed sessions, and role authorization
- Codex-compatible `POST /v1/responses` with safe JSON proxying and byte-streamed SSE
- OpenAI-compatible `POST /v1/chat/completions` and `GET /v1/models`
- Central upstream provider configuration with encrypted credentials
- Company and personal Agent, Skill, and Prompt management
- Employee submission, admin approval/rejection, and immutable reviewed-snapshot publication
- Deterministic server-side capability injection and Agent selection through `X-Company-Agent`
- A management-only web console for configuration, submission, and review, with no AI chat interface
- AES-256-GCM provider-key encryption and scrypt password hashing
- CSRF protection, login throttling, request validation, CSP, baseline SSRF protections, and audit events

Skills are declarative instruction modules in the MVP. The server does not execute contributor-supplied JavaScript, Python, or Shell code.

## Run locally

Requires Node.js 24+ and pnpm.

```powershell
Copy-Item .env.example .env

# Generate a 32-byte base64 encryption key for APP_ENCRYPTION_KEY in .env
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)

# Also set ADMIN_PASSWORD, then run:
pnpm install
pnpm dev
```

Set `GATEWAY_BEARER_TOKEN` as well. Open `http://localhost:3780` and let an administrator configure the upstream provider. The application bootstraps `ADMIN_EMAIL` / `ADMIN_PASSWORD` only when the user table is empty.

## Connect local Codex to the company API

Add this to the employee's user-level `~/.codex/config.toml`:

```toml
model = "company-approved-model"
model_provider = "company_ai"

[model_providers.company_ai]
name = "Company AI Hub"
base_url = "https://ai.example.com/v1"
env_key = "COMPANY_AI_TOKEN"
wire_api = "responses"
```

Put the gateway access credential issued by the company in `COMPANY_AI_TOKEN`. Provider configuration must be user-level; a project `.codex/config.toml` cannot override it.

To pin a published Agent, add a static header to the provider:

```toml
http_headers = { "X-Company-Agent" = "code-review" }
```

See the official [Codex configuration reference](https://developers.openai.com/codex/config-reference). The gateway modifies `instructions` according to the [Responses create API](https://developers.openai.com/api/reference/resources/responses/methods/create) and passes through the other request fields and tool definitions.

## Docker

Create `.env` from `.env.example`, set all required values, and run:

```powershell
docker compose up --build
```

SQLite data is stored in the named volume `company-ai-hub-data`.

## Injection order

1. Always-on company Prompts and Skills
2. The company Agent selected by `X-Company-Agent` and its bound Skills
3. The caller's original `instructions`
4. The caller's original `input`, tools, and other Responses fields

Each group is sorted by ascending `priority`, then stable name and ID order. Composition happens on the server; the management console neither composes nor sends model conversations.
When no company capability is enabled, the gateway adds no default system prompt and preserves the caller's original instructions unchanged.

## Submission and review

Submitting a personal capability creates an immutable snapshot. The administrator approves that snapshot, not a personal draft that can change later. Approval creates a company version with contributor attribution; rejection requires a reason. Later changes to the personal draft do not alter the published version.

## Production notes

- Store `.env` secrets in the deployment platform's Secret Manager; never commit them.
- Serve production through an HTTPS reverse proxy and set `SESSION_COOKIE_SECURE=true`.
- Set `PROVIDER_HOST_ALLOWLIST` to an exact list of approved provider hostnames. This is the upstream network trust boundary.
- `compose.yaml` defaults `SESSION_COOKIE_SECURE` to `false` for local HTTP acceptance only; enable it behind HTTPS.
- The MVP has no employee API-key issuance console. One deployment-managed token protects the gateway; use company SSO/IAP or an enterprise API gateway for production at scale.
- A “company API key” means a gateway credential, not the OpenAI/upstream key. The upstream key stays encrypted on the server and is never distributed to employees.
- The gateway governs every Codex **model request** routed through the company API. Purely local file or command actions that do not make a model API request never traverse the gateway and cannot be injected there.
- Back up SQLite regularly. Migrate persistence to PostgreSQL for high concurrency or multiple application instances.
- Providers must actually support Responses request and SSE event semantics.

## Verification

```powershell
pnpm typecheck
pnpm test
pnpm build
```

See the [architecture](docs/architecture.en.md) and [requirements acceptance matrix](docs/requirements-matrix.en.md) for the complete workflow and boundaries.

## Contributing

Issues and pull requests are welcome. The `main` branch is protected; external code must pass automated checks and maintainer review before merge. See [CONTRIBUTING.en.md](CONTRIBUTING.en.md).

Do not disclose vulnerabilities in public issues. Follow [SECURITY.en.md](SECURITY.en.md) for private reporting.

## Citation

GitHub's **Cite this repository** feature is powered by [CITATION.cff](CITATION.cff). If you use this project in a paper, internal technical proposal, or open-source project, please cite and link the repository.

## License

Licensed under the [Apache License 2.0](LICENSE).
