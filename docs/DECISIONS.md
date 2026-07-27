# PitLore 决策记录

这里只记录需要跨会话长期保留的已接受决策。决策改变时追加“替代”条目，
不要静默抹掉旧原因。

## D-001 — 三阶段串行验收，不同时造三套产品

- **日期**：2026-07-15
- **状态**：accepted
- **决策**：先交付本地个人/团队使用，再做 Git 托管的开源共享，最后才做网站。
- **原因**：真正需要验证的是 fix → Lesson → retrieve → check；Registry 市场和
  SaaS 会在核心假设成立前引入治理、投毒和网络效应风险。
- **影响**：网站、账号、RBAC/SSO、计费、Hosted Registry 都不是 Phase 1 工作。

## D-002 — Phase 1 坚持 local-first、Git-friendly

- **日期**：2026-07-15
- **状态**：accepted
- **决策**：Phase 1 使用可 review 的 YAML 文件，通过普通私有 Git 分享团队 lore，
  不建设 PitLore 服务端。
- **原因**：本地文件可检查、可 diff、可回滚、可跨 agent，适合专有调试知识。
- **影响**：Phase 1 直接读 YAML；SQLite、embedding、Hosted Sync、Registry API
  必须等数据证明需要后再引入。

## D-003 — Agent 只能生成 candidate，不能 approve

- **日期**：2026-07-15
- **状态**：accepted
- **决策**：distill/remember 默认生成 private candidate；批准是独立人类动作，
  直接写 approved 也不能绕过。
- **原因**：错误或被投毒的长期记忆可能比没有记忆更危险，人审是持久门禁的信任边界。
- **影响**：自动化可以建议、测试和修改 Lesson，但不能自行进入 approved 集合。

## D-004 — 同一 Lesson 同时驱动软检索与硬检查

- **日期**：2026-07-15
- **状态**：accepted
- **决策**：编码前 retrieve 相关 Lesson，编码后和 CI 运行确定性 check。
- **原因**：纯自然语言记忆只有建议性；纯静态检查没有学习回路；两者闭环才是核心差异。
- **影响**：dogfood 必须同时测 retrieval relevance 和 detector precision。

## D-005 — 声明式 detector，block 必须 fixture-gated

- **日期**：2026-07-15
- **状态**：accepted
- **决策**：Phase 1 detector 只允许声明式 patterns；block candidate 需要非空
  patterns、被 lore root 包含的 bad/good fixtures，并证明 bad 命中、good clean；
  配置错误 fail-closed。
- **原因**：执行任意 Lesson 代码会引入供应链和注入攻击面；fixtures 让门禁可审查。
- **影响**：任意脚本、AST plugin、公共 Pack 执行都要等 sandbox/provenance 成立。

## D-006 — 私有知识保持抽象，公开必须显式

- **日期**：2026-07-15
- **状态**：accepted
- **决策**：public Lesson 禁止凭据、PII、内部主机、客户名和专有源码；公开导出与
  sanitization 属于 Phase 2。
- **原因**：一次泄漏就会破坏“调试知识是公司资产”的信任基础。
- **影响**：`.pitlore/` 默认 ignored；任何后台任务都不能静默发布。

## D-007 — Phase 1 以使用证据退出，不以功能数退出

- **日期**：2026-07-15
- **状态**：accepted
- **决策**：至少一个真实个人/团队连续使用一周，且 onboarding、candidate、retrieve、
  detector 指标可信后，才能进入 Phase 2。
- **原因**：继续堆功能不能证明 Lesson 有用，也不能证明误报不会让团队关闭 gate。
- **影响**：近期 Roadmap 是 dogfood 与测量，不是 Pack 或网站。

## D-008 — 当前 Phase 1 工程基线

- **日期**：2026-07-15
- **状态**：accepted for Phase 1
- **决策**：TypeScript + Node.js 20+、官方 npm registry lockfile、Apache-2.0、
  GitHub Actions v6、私有 GitHub 仓库。
- **原因**：同一语言覆盖 CLI/MCP/package；官方源减少镜像 CI 风险；维护中的
  Actions 消除 runtime 弃用告警。
- **影响**：工具链调整必须保持 `npm ci`、完整 verify、Demo 和 package smoke 可复现。

## D-009 — 自动工作流只消费 approved Lesson

- **日期**：2026-07-16
- **状态**：accepted
- **决策**：日常 MCP retrieve/check 固定为 approved-only；Codex 只自动批准
  retrieve/check/export。可能读取 private candidate 的 search/get，以及写 candidate
  的 remember，保留显式提示。
- **原因**：read-only 只表示不修改磁盘，不代表不会把 private candidate 正文送进
  模型上下文；candidate 也尚未通过持久信任门禁。
- **影响**：候选审核继续使用显式 search/get 或本地 CLI；旧 MCP 调用即使传
  `includeCandidate` / `onlyApproved: false`，也不能把 candidate 注入自动工作流。

## D-010 — LLM 主审是建议层，人类批准仍是授权层

- **日期**：2026-07-16
- **状态**：accepted for Phase 1
- **决策**：LLM 可以读取显式选中的 private candidate、执行结构化审核并把
  accept/edit/reject 建议写入 `.pitlore/reviews/<id>.yaml`；只有人类独立运行
  `approve` 才能进入 approved 集合。
- **原因**：把整理、找风险和提出修改交给 LLM 能降低人审成本，但同模型偏差、提示
  注入、过度泛化和伪造治理字段使 LLM 结果不能成为授权凭证。
- **约束**：模型输出使用 strict schema；本地生成 hash、detector/fixture 结果和时间；
  review 绑定 candidate、fixture 内容、approved catalog、实际 instructions/rubric、
  related lessons 与确定性检查，任一变化即 stale。
  reviewer identity 明确标为 self-reported；review MCP 始终需要显式提示，也不存在
  MCP approve。
- **影响**：人只需查看短审核卡片再独立接受、编辑或拒绝，不必从零阅读完整 YAML；
  LLM recommendation 不计作人审决定，也不被 retrieve/check 消费。

## D-011 — Dogfood 评价显式记录，读取工具保持无副作用

- **日期**：2026-07-16
- **状态**：accepted for Phase 1
- **决策**：新增 CLI-only 的本地 evidence ledger；只有在真实任务结束并获得人的判断后，
  才显式运行 `pitlore evidence record`。retrieve/check/MCP 不自动写评价，也不提供
  MCP evidence 写工具。
- **原因**：自动记录会把已按最小权限批准的读取工具变成有写副作用的工具；让 agent
  自动判断自身是否有用也会污染产品验证。自由文本表格又无法稳定计算分母和复核口径。
- **约束**：ledger 位于 ignored `.pitlore/evidence/events.jsonl`，append-only、strict
  schema、稳定 observation id；retrieve/check 的无副作用响应显式返回 catalog hash，
  人工评价必须回传该 `observed_catalog_hash`，若 record 时目录已变化则拒绝写入，避免把
  新批准 Lesson 伪记成历史漏召回。同一 id 的并发等价写入逻辑合并计数，内容冲突则
  fail-closed；schema 不提供 raw prompt、源码或 private Lesson 正文字段，`reason`
  必须保持抽象，并在 record/load 时拒绝常见凭据与邮箱形态。只把 `real` 样本计入指标；检索的
  missed-existing 与 coverage-gap 分开；`used` 包含改变、阻止或有效确认方案的相关
  Lesson，precision/recall 是人工 utility/relevance proxy，
  detector 只记 TP/FP/FN，不从 clean 自动推导 TN/accuracy，零分母保持未知。
- **影响**：`docs/DOGFOOD.md` 保存每日摘要，结构化 ledger 保存原始本地证据；Phase 1
  是否退出仍由连续真实使用和人工评价决定，不能由事件数量自动宣告。

## D-012 — 拒绝保留 tombstone，治理终态只能显式迁移

- **日期**：2026-07-16
- **状态**：accepted for Phase 1
- **决策**：`candidate` 只能经显式生命周期动作（CLI/库 API；MCP 不暴露）变为
  `approved` 或 `rejected`；重复同一
  终态动作幂等。`rejected` 保留原 Lesson 与 review sidecar 供审计，但永不进入
  retrieve/check/export/review queue；只有 `approved` 可经独立 `deprecate` 变为
  `deprecated`，表示曾生效后退役。
- **原因**：删除候选会丢失拒绝历史，而把 LLM 的 `reject` 建议直接变成状态又会混淆
  建议和授权。正向状态白名单还能避免未来新增状态意外进入自动消费链路。
- **约束**：普通 `putLesson` 只允许新建或编辑 candidate，不能伪造终态或覆盖既有
  approved/rejected/deprecated；approved 不能 reject，rejected 不能 approve，candidate
  不能直接 deprecate。MCP 不暴露 lifecycle transition，LLM review 保持 advisory。
  显式 search/get 可以查看 tombstone。
- **写入安全**：同一 Lesson 的写入和状态迁移共享 fail-closed 互斥锁（不自动删除疑似
  stale lock），覆盖使用同目录临时文件原子 rename。初始化把 manifest 作为最后完成
  标记；YAML 通过 `O_NOFOLLOW` descriptor 读取并核对 inode，读写期间持续复核 root、
  lessons/reviews 目录 identity；原子替换后在支持的平台同步父目录元数据，主错误也保留
  lock/temp 清理失败上下文。新私有目录/文件在 POSIX 上默认 `0700`/`0600`。静态
  symlink 一律拒绝；拥有同一系统用户权限的恶意进程仍不属于纯 Node 文件 API 能提供的
  强隔离边界。
- **兼容性**：新增 `rejected` 对旧 `0.1.0` reader 是前向格式变化。npm 包尚未发布，
  当前是成本最低的引入时点；新建默认值同时收紧为只能是 `candidate`。

## D-013 — 用户明确授权在 Phase 1 证据未完成前启动 Phase 2 准备

- **日期**：2026-07-16
- **状态**：accepted override
- **决策**：用户明确批准在 Phase 1 的 7 天真实使用、retrieve/detector 样本和剩余
  candidate 人工决定完成前，开始 Phase 2 工程；Phase 1 未完成证据必须继续保留，不能
  宣布其已满足退出门槛。
- **范围**：先实现 public sanitize/export 等可独立验证的 Git-friendly 能力；不自动发布、
  不绕过人审、不建设 Hosted Registry、账号、RBAC 或计费。
- **约束**：public 导出必须显式触发、默认拒绝不安全内容，并只允许 approved Lesson；
  Phase 1 dogfood 指标继续单独记录，不能被 Phase 2 功能数量替代。

## D-014 — 用户授权继续实现全部 Phase 的本地可验证工程范围

- **日期**：2026-07-16
- **状态**：accepted override；替代 D-013 的开发范围限制，不改变证据事实
- **决策**：用户明确要求继续实现剩余全部开发，不再以 Phase 编号暂停。允许推进
  Phase 2 完整 Pack 供应链和 Phase 3 可本地/自托管运行的 Registry、组织权限、审计、
  分析与计费领域能力。
- **约束**：Phase 1/2 的真实使用、社区贡献和需求证据仍按实际状态记录；本地测试 adapter、
  Docker smoke 或领域接口不能宣称为真实 Hosted SaaS、生产 SSO、真实收款、生产部署或
  合规认证。任何发布、部署、域名、外部身份商或支付商动作仍需独立授权与真实凭据。
- **顺序**：先完成 Git-first Pack artifact、安装、锁文件、校验和、来源与依赖边界，
  再让 Registry 和 Web 复用同一不可变 artifact contract，避免产生两套供应链真相源。

## D-015 — Public discovery 只投影已验证 artifact，不接受自报 metadata

- **日期**：2026-07-22
- **状态**：accepted for the self-hosted engineering baseline
- **决策**：public package search 的默认 item 继续精确保持 `name`、`visibility`、
  `created_at` 三字段；只有显式 `include=facets` 才扩展 discovery wire contract。
  language/ecosystem/tag 每维最多接受 4 个重复值，同维 OR、跨维 AND；游标绑定规范化
  query 与 filters，带 filters 时不接受旧的未绑定游标。
- **真相源**：description、Lesson 数和 facets 必须在服务端完整复验 immutable Pack
  artifact 后生成，且只聚合 active `approved` Lessons。发布请求不能提供受信 discovery
  metadata。每个 package 只投影 strict SemVer 最高的 `published` release；yank 后回退到
  下一条 published release。reputation 数据和排序不在 v1 内。
- **数据库边界**：migration `009` 为每个 release 增加 append-only discovery snapshot，
  以 RLS 约束 tenant/public 可见性，并以受外键和 deferred trigger 约束的 package pointer
  维护 latest-published projection。public RLS 只允许读取 public package 的 published/yanked
  snapshot；搜索 projection 本身只选择 published。facet lookup 使用与 snapshot 精确对应、
  C-collated、append-only 且同样受 RLS 约束的规范化行和 B-tree 索引；不使用 RLS
  无法安全下推的 array-overlap + GIN，也不使用绕过 RLS 的 owner view。
- **升级约束**：历史安装不得由 migration 猜测或伪造 metadata。升级时必须先停掉旧
  writer，再应用 migration，然后用 migration-owner 连接分批运行
  `pitlore registry reindex-discovery`，逐个重新校验 immutable artifact 并只追加缺失行。
  未完成或无法复验的历史 release 对 public search 明确显示 discovery unavailable；不得
  用空值冒充“已验证但没有 metadata”。
- **原因**：这同时保护旧客户端 wire 兼容、metadata provenance、private/pending release
  隔离和 yank 行为；一个可搜索字段不能成为绕过 artifact 验证的第二套发布真相源。

## D-016 — 转为独立开源开发，7 天 dogfood 降为非阻塞质量信号

- **日期**：2026-07-27
- **状态**：accepted override；替代 D-001/D-007 的串行阶段门槛、D-008 的源码仓库
  private 方向，以及 D-011/D-013 中“Phase 1 退出”的门槛表述；保留这些条目的历史事实
  和当时原因。
- **决策**：项目不再以参加黑客松为交付目标，转为持续、公开的开源产品开发。连续
  7 天真实使用与 current-catalog 人工 evidence 继续如实积累，但不再作为源码开源、
  日常开发、版本发布或 Phase 推进的前置条件。
- **公开顺序**：文档决策本身不等于 GitHub visibility 已改变。截至本决策记录时，
  `Hardboiled98k/pitlore` 仍为 private；先完成当前主线收口与全历史开源安全审计，再执行
  公开动作，不能提前宣称仓库已 public。
- **不变边界**：D-003/D-010 的独立人类生命周期授权、D-006 的显式脱敏公开和 D-011 的
  evidence 完整性继续有效。Agent 仍只能生成 private candidate 或 advisory review，
  不能 approve/reject/deprecate，也不能给自己的 usefulness、TP/FP/FN 打分。
- **证据口径**：单测、Demo、synthetic 数据、Docker/self-host smoke 和 CI 只证明工程
  性质；不能冒充真实采用、社区贡献、生产运维或人工产品效用证据。7 天观察和人工样本
  达标后，只能宣称相应产品质量信号成立，不能倒推此前不存在的采用事实。

## D-017 — 公共仓库采用 clean import，旧开发历史保留为私有归档

- **日期**：2026-07-27
- **状态**：accepted
- **决策**：把原 GitHub 仓库重命名并继续保持 private，以保留完整开发、PR 和 Actions
  记录；从经过全树安全审计的当前 `main` 生成新的 root history，不导入原仓 commits、
  refs、PR、Actions、tags 或 releases，在 `Hardboiled98k/pitlore` 建立 public 仓库。
  公共历史从单个 GitHub noreply import commit 开始。
- **原因**：旧历史未发现真实凭据或 private Lesson 泄漏，但全部旧提交使用非 noreply
  个人邮箱，少量历史文档还包含本机用户名路径。直接改变 visibility 会公开这些个人
  metadata；仅重写分支也不能可靠清除 GitHub 托管的旧 PR refs 和 Actions 关联记录。
- **公开边界**：公开的是已审计源码快照、Apache-2.0 许可、贡献与安全流程，不是本地
  `.pitlore/`、candidate、review、evidence、凭据、客户数据或旧私有协作历史。
- **历史口径**：公共 Git history 有意从 clean import 开始，不冒充项目从该提交才开始；
  公开后以 public `main`、Actions 和 release artifact 为对外真相源；私有归档只用于
  维护者追溯，不作为公开用户必须依赖的构建、发布或 provenance 来源。
