@AGENTS.md

# PitLore 协作上下文

每次进入项目，先读 [`docs/STATUS.md`](./docs/STATUS.md)。它是最短的工作交接页，
记录当前阶段、已验证基线、未完成项和下一步。

- 任务可能改变产品、信任、存储、检测器或阶段边界时，读
  [`docs/DECISIONS.md`](./docs/DECISIONS.md)。
- 需要完整产品范围和阶段门槛时，读 [`docs/PRD.md`](./docs/PRD.md)。
- 重试已知 CI、registry、打包或秘密扫描问题前，先读
  [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)。
- Phase 1 实际使用时，把 session、candidate 人审结果和误报记录到
  [`docs/DOGFOOD.md`](./docs/DOGFOOD.md)，不能用 Demo 代替真实证据。保留
  retrieve/check 响应里的 `observed_catalog_hash`；获得人的评价后，在 approved
  catalog 变化前用 CLI `pitlore evidence record` 显式记录，不能让 agent 自评。
- 日期快照可能过期；必须用 `git status`、近期提交和 GitHub Actions 复核。
  实时代码与 CI 证据优先于记忆笔记。
- 不要把“Phase 1 工程基线完成”误写成“Phase 1 已退出”；真实个人/团队
  dogfood 和精度反馈仍未完成。
