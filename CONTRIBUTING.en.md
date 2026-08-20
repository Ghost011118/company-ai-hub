# Contributing to Company AI Hub

[简体中文](CONTRIBUTING.md) | [English](CONTRIBUTING.en.md)

Thank you for contributing. We welcome bug fixes, tests, documentation, and feature improvements that align with the project's goals.

## Contribution workflow

1. Search existing issues and pull requests to avoid duplicate work.
2. For behavior changes or substantial features, open an issue first and describe the problem, use case, and proposed boundaries.
3. Fork the repository and create a topic branch from the latest `main`.
4. Keep the change focused and add tests and documentation for behavior changes.
5. Open a pull request and complete the template.

## Local verification

The project requires Node.js 24+ and pnpm.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

## Review and merge

- External contributions must use pull requests; routine maintainer code changes follow the same process.
- A pull request must pass automated checks and receive approval from at least one maintainer.
- Maintainers may request additional tests, documentation, migration notes, or security analysis.
- By submitting code, you confirm that you have the right to contribute it and agree that it will be released under this repository's license.
- Approval does not promise immediate release. Maintainers still decide release timing based on compatibility, security, and project scope.

## Scope boundary

The project currently treats a Skill as a declarative instruction module. It does not execute contributor-supplied JavaScript, Python, or Shell code. Proposals that introduce arbitrary code execution or change authentication boundaries, persistence formats, or public APIs require design discussion in an issue first.

## Security issues

Do not disclose exploitable vulnerabilities, real credentials, or internal company data in public issues or pull requests. Follow [SECURITY.en.md](SECURITY.en.md) for private reporting.
