# Requirements Acceptance Matrix

[简体中文](requirements-matrix.md) | [English](requirements-matrix.en.md)

This page compares the current implementation with the core business workflow. The result is based on the current code and automated tests. A production deployment still requires a real upstream, HTTPS, secret management, and company access controls.

| Requirement | Current implementation | Status |
| --- | --- | --- |
| Admin configures company Agents, Skills, and Prompts in the web console | Administrators manage all three company-scoped capability types. Prompts and always-on Skills can join every injection; Agents can bind Skills | Implemented |
| Regular employee can log into the web console | Administrator/employee accounts, sessions, and role authorization are provided | Implemented |
| Employee submits personal Agent, Skill, or Prompt ideas | Employees maintain personal drafts; submission creates an immutable, author-attributed snapshot | Implemented |
| Admin reviews employee submissions | Administrators inspect snapshots and approve or reject them. Approval creates a company copy; rejection requires a reason | Implemented |
| Web console is management-only and offers no AI conversation | The browser chat/API-debug page and its `/api/chat` endpoint are removed. The console retains capability, upstream, submission, review, and account management only | Implemented |
| Admin produces capabilities from text or files | The company library has a small AI creation window for pasted text, supported text files, follow-up guidance, and re-analysis | Implemented |
| AI identifies, judges, and scores proposals | The upstream returns Agent/Skill/Prompt proposals, four 0–100 scores, verdicts, and risks; the server validates them strictly | Implemented |
| Admin confirms installation | `REJECT` items cannot install. Selected proposals enter the company library in one database transaction with Agent/Skill bindings resolved | Implemented |
| Employee's local Codex uses the company API | The gateway provides Codex-compatible `POST /v1/responses`; Codex can point `base_url` at the company `/v1` | Implemented |
| Company credential is isolated from the upstream key | Employees use a gateway Bearer Token. The admin-configured upstream key is AES-256-GCM encrypted and used only by the server | Implemented |
| Company capabilities are injected before forwarding | Before forwarding, the server composes always-on company Prompts/Skills, the selected Agent and its Skills, then the caller's original `instructions` | Implemented |
| Codex request capabilities are preserved | Original `input`, tool definitions, and other Responses fields pass through; JSON and SSE are supported | Implemented |
| Request is forwarded to OpenAI/a compatible provider and returned | The gateway calls upstream `/responses`, preserving status and supported safe headers. JSON is parsed and secret-redacted; SSE is byte-streamed | Implemented |
| External code contributions require review | Contribution guide, PR template, and CI are present; `main` requires automated checks and maintainer review | Process established; repository administrators must keep GitHub branch rules enabled |

## Exact boundaries

- “Actions through desktop Codex” can technically cover only actions that **produce a model API request routed through the company gateway**. Purely local file reads, Shell commands, or other operations that do not call the model API never reach the gateway.
- The MVP uses one deployment-level `GATEWAY_BEARER_TOKEN`. This provides a unified company credential boundary but not per-employee issuance, rotation, revocation, or usage attribution.
- A Skill is a declarative instruction module; employee-submitted arbitrary code is not executed.
- `/v1/chat/completions` provides compatible forwarding, but the primary injection path and Codex configuration target are the Responses API at `/v1/responses`.
- Before connecting real OpenAI, the deployer must configure a valid upstream URL, model, and credential. The repository contains no real API keys and does not read an employee's local keys.

## End-to-end acceptance path

1. An administrator signs in, creates an always-on company Prompt or Skill, and optionally creates an Agent with bound Skills.
2. An employee signs in, creates a personal capability, and submits it.
3. The administrator approves it in the review queue and confirms that an author-attributed copy appears in the company library.
4. The employee points local Codex `base_url` to the company gateway `/v1` and stores the gateway credential in the configured environment variable.
5. A Codex model request is sent; verify that the upstream receives company capabilities before the caller's original `instructions`.
6. Verify that upstream JSON returns after safe processing or that SSE returns as a byte stream through the gateway.
