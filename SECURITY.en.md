# Security Policy

[简体中文](SECURITY.md) | [English](SECURITY.en.md)

## Supported versions

Company AI Hub is currently pre-1.0. Security fixes target the latest code on `main` until versioned releases are published.

## Reporting a vulnerability

Do not disclose vulnerability details through a public issue, discussion, or pull request.

Prefer the repository's private **Report a vulnerability** feature on the GitHub **Security** page. Include:

- the affected version or commit;
- reproducible steps and impact;
- the smallest proof material needed;
- known mitigations, if any.

Do not submit real API keys, company data, or another person's personal information. Maintainers will acknowledge the report and coordinate remediation and disclosure timing. Keep details private until the fix is published.

AI-assisted creation sends administrator-pasted or uploaded text to the configured company upstream provider. The application does not store the original file, but provider-side processing and retention depend on the service selected by the deployer. Administrators must not upload unauthorized credentials, personal data, or company secrets, and model scoring never replaces human review. Upload content and model output are handled only as untrusted text and are never executed as code.
