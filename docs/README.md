# PitLore 文档导航

按问题选择最小文档，不要把所有上下文常驻加载。

| 文档 | 用途 | 何时更新 |
|---|---|---|
| [`STATUS.md`](./STATUS.md) | 当前阶段、验证基线、缺口、下一步 | 里程碑、阻塞或阶段状态变化时 |
| [`DOGFOOD.md`](./DOGFOOD.md) | Phase 1 每日使用、指标、candidate 人审与摩擦证据 | 每次真实使用或人审后 |
| [`DECISIONS.md`](./DECISIONS.md) | 长期产品与工程决策 | 决策被接受、替代或撤销时 |
| [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) | 真实故障、根因、修复与回归检查 | 非平凡问题被真正解决后 |
| [`PRD.md`](./PRD.md) | 产品定义、完整范围、阶段门槛 | 产品范围或验收标准改变时 |
| [`MARKET-RESEARCH.md`](./MARKET-RESEARCH.md) | 带日期的竞品研究与战略证据 | 有计划地刷新调研时 |
| [`PACK-SPEC.md`](./PACK-SPEC.md) | Pack artifact、校验、签名、锁文件、撤销与 air-gap 契约 | Pack 供应链边界改变时 |
| [`SELF-HOSTING.md`](./SELF-HOSTING.md) | Registry Docker 启动、身份边界、备份恢复和升级手册 | 自托管运行方式或外部边界改变时 |
| [`../demo/tenant-isolation/README.md`](../demo/tenant-isolation/README.md) | 仓库特定的端到端 Demo | Demo 行为改变时 |

## 事实源优先级

记录冲突时按以下顺序判断：

1. 当前源码、测试、Git 状态和 GitHub Actions 证据。
2. `STATUS.md` 的最新书面工作快照。
3. `DOGFOOD.md` 中逐次记录的 Phase 1 实际使用证据。
4. `DECISIONS.md` 中已接受的原因和边界。
5. `PRD.md` 中的产品范围和阶段规划。
6. Obsidian、Claude memory、Codex memory 只作为导航和恢复入口。

README 继续作为用户入口，不承载会话日志或完整项目状态。
