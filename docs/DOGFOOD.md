# PitLore Adoption and Dogfood Evidence Log

> 这是持续证据日志，不是营销进度或固定周期收口表。按 D-018，项目长期记录独立安装、
> 跨真实任务重复使用和人工效用，不再计算日历 streak。Demo fixture、协议单测、
> synthetic 数据和维护者重复烟测仍不能冒充独立社区使用。

## 长期产品质量观察维度

- 至少一个独立外部个人/团队从公开文档完成安装，并在多个真实任务中重复使用。
- 至少 3 个真实 fix 生成 private candidate，并由人明确接受、编辑或拒绝。
- 记录每次非烟测 retrieve 是否有用；已有 approved Lesson 未召回记为
  `missed_existing`，当时根本没有相关 approved Lesson 记为 `coverage_gap`。
- detector 只记人工判断的 TP/FP/FN 和 gate pressure；clean scan 不自动等于 TN。
- fresh clone 从 README 开始，5 分钟内完成 init、retrieve、check 和 MCP 接入。
- Claude Code 与 Codex 都完成真实 MCP 工具调用，不只是读配置。

这些维度用于判断产品是否在真实工作中有用，不是开源、开发或 release 门槛。没有样本
时必须保持“未知/样本不足”的事实，有样本后也不能把工程测试冒充为外部采用。

## 2026-07-27 计分板

| 指标                     |                          目标 |                                                                                                     实际 | 判断                                             |
| ------------------------ | ----------------------------: | -------------------------------------------------------------------------------------------------------: | ------------------------------------------------ |
| 独立外部安装             |                            ≥1 |                                                                                                     0 | 尚无社区采用证据                                 |
| 跨真实任务重复使用       |                            ≥1 |                                                                                        1（PitLore 自身） | 已开始，但有强自测偏差                           |
| candidate lifecycle      | 真实 candidate 均有独立人决定 | 60 条历史 approved；当前 53 条 candidate 仍未人审；29 条有 current advisory，24 条未 advisory review | 观察样本不足；advisory review 不是批准           |
| current catalog retrieve |                持续有人工判断 |                                                                               hash `637418aa…`；0 events | usefulness/precision/recall 均 unknown           |
| all-catalog retrieve     |                只用于历史累计 |                           5 real；2 useful；returned 7 / used 2 / irrelevant 5；missed 1；coverage gap 3 | 40% / 28.6% / 66.7% 是跨版本历史，不代表 current |
| current detector         |           有新版真实 TP/FP/FN |                                                                                                 0 events | precision/recall unknown                         |
| all-catalog detector     |                只用于历史累计 |                                                              3 real；TP 0 / FP 3 / FN 0；gate pressure 0 | 全是 0.1.0 历史 FP；0.2.0 无新人工样本           |
| 真实 MCP 客户端          |                Claude + Codex |                                                                                       历史两者均完成调用 | 连通成立，不等于日常价值成立                     |
| fresh-clone 上手         |                       <5 分钟 |                                                                                     历史 CLI 闭环约 8 秒 | 同一仓内工程证据，仍缺独立用户                   |

## Catalog 与 evidence 口径

### Current catalog

```text
catalog_hash: 637418aa591af978d340ee1fd6d8b22935b6c7029a0c655e949349b286a2c4f1
selected_events: 0
available_events: 8
distinct_catalog_hashes: 2
retrieve usefulness / precision / recall: null / null / null
detector precision / recall: null / null
```

### All catalogs（历史累计）

```text
real events: 8
retrieve: 5 observations; useful 2; returned 7; used 2; irrelevant 5;
          missed_existing 1; coverage_gap 3
detector: 3 observations; TP 0; FP 3; FN 0; gate_pressure 0
```

`all` 是生命周期历史，不是当前规则质量。旧 catalog 下的 FP 事件必须保留，
但不能把它们算成 detector 0.2.0 的当前 precision。

## 每日真实记录

| 日期                     | 仓库 / 真实任务                                                                                                        | retrieve / check                                                                                | fix / candidate / 决定                                                                             | 人工 evidence                                               | 摩擦 / 边界                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 2026-07-16               | PitLore 本地闭环、CLI/MCP、评审/evidence 设计                                                                          | 真实 MCP retrieve/check 开始                                                                    | 首批 candidate 和人审流程建立                                                                      | 按当时 catalog 写入结构化 ledger                            | 首次 Claude 普通项目仍需人在 `/mcp` 审批                                                            |
| 2026-07-17               | 文件安全、Pack/Registry 基线、tenant demo                                                                              | 继续真实 retrieve/check                                                                         | 多个真实 fix 进入 candidate                                                                        | 有当时人工决定                                              | 还未形成连续多仓使用                                                                                |
| 2026-07-18               | Pack、PKCE、RLS、Windows lock 和 detector 0.2.0                                                                        | 多次真实 retrieve/check                                                                         | 用户两次显式委托下完成历史 candidate 决定；60 approved；`sql-string-concat` 0.2.0 经 fixtures 收紧 | all-catalog ledger 累计到 8 real                            | 委托批量决定已明确标注，不冒充独立社区人审                                                          |
| 2026-07-19 至 2026-07-21 | 无可验证的真实活跃记录                                                                                                 | 不计入                                                                                          | 不计入                                                                                             | 无                                                          | 历史空档如实保留，不再用于计算固定周期                                                             |
| 2026-07-22               | MCP 发布包、Pack/Registry 加固、semantic diff、public discovery、browser auth、分页、DB integrity/SemVer、限流/body cap、self-host restore | 多次带 `observed_catalog_hash=637418aa…` 的真实 retrieve；semantic diff 与 discovery production source 定向 check clean | public discovery 新增 3 条 private candidate；当前共 40 candidate，未 agent-approve                  | **无人工 usefulness/detector 评分，未写新 evidence record** | 43 files / 369 tests、真 PG17 `001`–`009` fresh/restore/restart 通过；这些是工程证据，不是 Phase 1 人工效用证据 |
| 2026-07-27               | 转为持续开源开发；完成 discovery facets、008→009 reindex、clean public import、可复现 CLI 安装/发行门禁及社区支持入口 | 多次使用同一 current catalog retrieve；安装、发行及社区入口 source/config 以 hash `637418aa…` 最终 check clean | 真实问题只记为 private candidate；当前共 53 candidate，未 agent-approve                              | **无人工 usefulness/detector 评分，未写新 evidence record** | 43 files / 376 tests、真实 tarball、隔离 Git dependency install 与同一 tarball 的 npm publish dry-run 通过；这些仍是维护者工程证据 |

## 2026-07-22 工程 dogfood 摘要

- retrieve 暴露了已有 Lesson 在 PostgreSQL date/streaming 边界上的概念帮助，但没有人对
  本轮结果做 usefulness 判断，因此不记 `used`。
- public discovery 实现前用 intent + changed files 做了真实 retrieve，保存的
  `observed_catalog_hash` 是
  `637418aa591af978d340ee1fd6d8b22935b6c7029a0c655e949349b286a2c4f1`；随后完成
  legacy 三字段兼容、approved-only artifact-derived facets、filter-bound cursor、`009`
  append-only/RLS projection、migration-owner reindex 和 yank fallback。该记录只证明工程
  dogfood 发生，agent 没有自评 usefulness/TP/FP/FN，也没有写 evidence record。
- 真实开发中发现并修复了 Pack 解析前大小放大、中间 symlink、MCP Docker notices、
  release 分页全集合/N+1、SemVer 大整数漂移、proxy/IP 限流饥饿与绕过、路由 body
  放大、以及 DB `>=2` / domain `exactly 2` 不变量差异。
- semantic diff 的对抗复核额外关闭了 HEAD 限流绕过、client 响应身份错配、wire schema
  跨字段矛盾、Web contract 过宽、public/session credential mode 回归和端点响应预算过宽；
  6 条抽象经验均只进入 private candidate。
- 原私有开发仓曾出现同一 revision 的 Windows PR check 通过、push check 因两个旧 CLI
  lifecycle 用例超过默认 5 秒而失败；只为这两个多子进程用例设置 15 秒预算，不改断言、
  不重试。既有 `windows-cli-subprocess-test-timeout` candidate 已覆盖根因，因此没有
  重复 candidate；后续三平台 CI 通过。旧 commit/run ID 未迁入公共历史，公开可复验
  基线以 public `main` Actions 为准。
- 把通用 PR 模板迁到默认路径时，Git install smoke 暴露出 `git ls-files --cached`
  仍会列出工作树中已删除的 tracked 路径；fixture 现显式减去 `--deleted` 集合，并以
  真实 dependency install 回归。该经验只记录为 private candidate。
- 发布包审计发现 lockfile 中一条依赖仍指向区域镜像；现已核对相同 integrity 后改回
  npm 官方 registry，并以 286 条 resolved artifact 的 fail-closed verifier 防回归。
  同时 canonicalize 临时消费根，确保 `#main` 安装生成正常 lock entry 并固定 exact
  commit。两条不同根因均只记录为 private candidate。
- 每个真实 bug 都写入 private candidate；审查可以写 advisory sidecar，但不能自动
  进入 approved catalog。
- current catalog hash 因 candidate 不参与 approved catalog 而保持 `637418aa…`；这不代表
  新 candidate 已经治理。

## 客户端与安全边界

- Claude Code 历史使用仓库 `.mcp.json`；第一次普通项目必须由人确认工具信任。
- Codex 历史完成过真实 `pitlore_retrieve`；本轮也通过 MCP 记录 candidate。
- MCP retrieve/check 只读 approved；remember 只能写 candidate；review 只能写 advisory；
  不存在 MCP evidence writer 或 lifecycle approval 绕过。
- `.pitlore/lessons`、`reviews`、`evidence` 是 ignored 本地私有资产；本文档只记摘要，
  不复制 private Lesson 正文。

## 后续真实观察

1. 遇到真实非烟测任务时继续记录，区分维护者自测、独立外部用户和社区贡献。
2. 每次 retrieve/check 后等待人的判断；没有判断就只记“调用发生”，不写 evidence。
3. 人的评价完成后，在 approved catalog 改变前用
   `pitlore evidence record --input <json|->` 写入原始事件。
4. 更新计分板时默认用 `pitlore evidence summary --catalog current`；只在查看历史
   生命周期时显式使用 `--catalog all`。
5. 只有独立用户完成安装、跨真实任务重复使用且有足量 current-catalog 人工样本时，
   才能宣告相应产品质量信号成立；不得从维护者 smoke 倒推社区采用。

## 每日记录模板

| 日期       | 仓库 / 真实任务 | retrieve 输入与结果 | fix / candidate | 人审决定               | check 与 detector    | 摩擦 / 耗时 |
| ---------- | --------------- | ------------------- | --------------- | ---------------------- | -------------------- | ----------- |
| YYYY-MM-DD |                 |                     |                 | accept / edit / reject | TP / FP / FN / clean |             |
