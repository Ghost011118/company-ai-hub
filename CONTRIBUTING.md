# Contributing to Company AI Hub

感谢你参与 Company AI Hub。我们欢迎 Bug 修复、测试、文档和与项目目标一致的功能改进。

## 提交方式

1. 先搜索现有 Issue 和 Pull Request，避免重复工作。
2. 对行为变化或较大的功能，先创建 Issue 说明问题、使用场景和建议边界。
3. Fork 仓库，从最新 `main` 创建主题分支。
4. 保持改动聚焦，并为行为变化补充测试和文档。
5. 提交 Pull Request，完整填写模板。

## 本地验证

项目要求 Node.js 24+ 和 pnpm。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

## 审查与合并

- `main` 分支不接受未经 Pull Request 的直接变更。
- Pull Request 必须通过自动检查，并获得至少一位维护者批准。
- 维护者可以要求补充测试、文档、迁移或安全说明。
- 提交代码即表示你有权贡献该代码，并同意按本仓库许可证发布。
- 评审通过不承诺立即发布；维护者仍会根据兼容性、安全和项目范围决定版本安排。

## 范围边界

本项目当前把 Skill 视为声明式指令模块，不执行投稿者上传的 JavaScript、Python 或 Shell。引入任意代码执行、改变认证边界、持久化格式或公共 API 的提案，必须先通过 Issue 完成设计讨论。

## 安全问题

请勿在公开 Issue 或 Pull Request 中披露可利用漏洞、真实凭据或公司内部数据。按照 [SECURITY.md](SECURITY.md) 私下报告。

---

Contributions are welcome through forks and pull requests. Keep changes focused, add tests for behavior changes, and run the full verification commands above. Every change to `main` requires passing checks and maintainer review.
