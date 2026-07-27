# PitLore 项目状态

> 当前工作交接与事实快照。工程核验与产品方向决策更新：
> **2026-07-27（Asia/Shanghai）**。
> Git commit、CI 和候选队列会变化，新会话必须先用实时状态复核。

## 结论先行

PitLore 已形成三层可运行工程基线：本地 Lesson 闭环、Git-first Pack 供应链，
以及 PostgreSQL + Web/API 自托管 Registry。本轮把 MCP npm tarball、Pack 许可/边界、
全集合分页、browser session 权限、PostgreSQL 不变量、SemVer keyset、限流和请求体
上限继续收紧，并补齐了隐私安全、有界的真实 Pack semantic version diff，以及只从
已验证 release artifact 派生的 public Pack discovery facets v1。

2026-07-27 用户决定不再参加黑客松，项目转为边开源边持续开发。按 D-016，连续
7 天 dogfood 与 current-catalog 人工 evidence 保留为非阻塞产品质量信号，不再阻塞
源码开源、日常开发、版本发布或 Phase 推进；人审和 evidence 完整性边界不变。

“工程基线可运行”仍不等于真实采用或生产就绪：当前没有 npm 发布或独立社区使用，
也没有公网托管、真实 IdP/browser E2E、真实支付和生产运维证据。GitHub 源码仓库已从
受审计的工程基线做 clean import 并公开；此前包含个人作者 metadata 的开发历史保留在
private archive，不属于公共 Git 历史。公开仓库本身不能冒充社区采用。

## 实时快照

| 字段             | 2026-07-27 本地已核验值                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 产品             | PitLore `0.1.0`；Apache-2.0；Node.js 20+ / TypeScript                                                                   |
| 仓库             | `Hardboiled98k/pitlore`，public；默认分支 `main`                                                                         |
| 当前工程基线     | clean public import；包含 public discovery facets v1、migration `009` 与完整开源文档                                   |
| CI 见证          | 导入前同一源码已通过 Ubuntu、Windows、PostgreSQL self-host；公开 `main` 以实时 GitHub Actions 为准                      |
| 工作树           | 公共历史从单个 GitHub noreply import commit 开始；旧开发历史只保留在 private archive                                   |
| 完整验证         | 当前工作树 `npm run verify`：43 files / **373 tests**，typecheck 和 build 通过                                         |
| 自托管           | 真 PostgreSQL 17：`001`–`008` 历史 release → `009` → CLI reindex/幂等复跑/runtime 拒绝，以及 fresh restore/restart 全通过 |
| 分页性能探针     | synthetic 100k releases：PostgreSQL keyset 取 101 行 lookahead，index 扫描约 102 行，约 0.57 ms；只是工程证据           |
| Demo / 发布包    | tenant Demo 通过；package smoke 通过；当前 tarball dry-run = 510,064 bytes / 2,500,288 unpacked bytes / 233 files       |
| 依赖审计         | production tree = 0；high/critical build gate 通过；MCP SDK → `@hono/node-server` 仍有 2 个 moderate，未 force/downgrade |
| 本地 lore        | 当前 105 条：60 approved，45 candidate；29 条有 current advisory，16 条未 advisory review；均未由 agent 批准           |
| Evidence current | `catalog_hash=637418aa…`；0 events；usefulness/precision/recall 均为 unknown (`null`)                                   |
| Evidence all     | 跨 2 个 catalog 共 8 条 real；retrieve 5，useful 2，precision 2/7，recall 2/3；detector 3 条全为历史 FP                 |
| PitLore check    | semantic diff 与 discovery core/Web 的 production source 定向扫描均为 0 findings；未写 agent 自评 evidence             |

## 新会话恢复顺序

1. 读本文件，然后运行 `git status -sb`、`git log --oneline -5`、
   `gh repo view Hardboiled98k/pitlore` 和 `gh run list --branch main`。
2. 改变信任/阶段边界前读 [DECISIONS.md](./DECISIONS.md)；D-016 已将 7 天观察降为
   非阻塞质量信号，不取消 D-003 人审边界和 D-011 证据口径。
3. 完整产品目标读 [PRD.md](./PRD.md)；已交付事实以本文件和实时代码为准。
4. 非平凡实现前 retrieve，完成前 check；真实 bug 只记 private candidate，agent 不得
   approve，也不得给自己的 usefulness/detector 结果打分。
5. 先跑最相关回归，交接前再跑 verify、Demo、package、self-host/restore、audit、
   changed-source check 和提交后跨平台 CI。

## Phase 1 — 本地 Lesson 闭环

### 已有工程基线

- 严格 schema 与 candidate → approved/rejected、approved → deprecated 显式状态机；日常
  retrieve/check 只消费 approved。
- private 默认，public 导出 fail-closed 脱敏；LLM review 是 hash-bound advisory sidecar，
  MCP 不暴露 approve/reject/deprecate。
- scope-aware retrieve、声明式 detector、block bad/good fixture gate、CLI/MCP、
  AGENTS prompt export。
- symlink/path identity、原子写、owner-only 权限和跨进程锁均 fail-closed。
- CLI-only append-only evidence ledger；retrieve/check 保持无写副作用，人工评价必须
  绑定调用当时 `observed_catalog_hash`。

### 尚未满足的非阻塞产品质量信号

- 初始 `2026-07-16`–`2026-07-22` 窗口只有 4 个真实活跃日（7/16、17、18、22），
  最长连续 3 天；该历史窗口未达到 7 天观察目标。
- current catalog 没有任何人工 evidence；历史 8 条不能代表当前 detector 0.2.0
  或当前 approved catalog 质量。
- 新 candidate 仍待独立人审；advisory review 不能冒充生命周期授权。
- 7/22 的 retrieve/check/remember 是真实工程调用，但没有人的 usefulness/detector
  判断，因此未写 evidence record。
- 以上缺口必须如实披露，但不再作为开源、开发、release 或 Phase 推进门槛；工程测试
  也不能替代这些采用与人工效用事实。

详情见 [DOGFOOD.md](./DOGFOOD.md)。

## Phase 2 — Pack 供应链

### 已有工程基线

- 显式 public export；本地/无凭据 HTTPS Git 安装，支持 `--ref` 和 monorepo
  `--subdir`；strict SemVer 依赖与确定性 lock/cache。
- Git clone 有 deadline、low-speed 边界、输出上限和临时目录磁盘增长 cap。
- Pack 验证在 YAML 解析前遍历并限制所有允许文件；防中间 symlink、路径逃逸、
  大文件/总量放大、敏感内容和可执行 detector。
- public Pack 必须带非空 UTF-8 `LICENSE`；3 个官方 Pack 已内置完整 Apache-2.0
  许可文本。
- canonical SHA-256、不变 `name@version`、Ed25519 签名与显式 key fingerprint pin；
  single artifact 和 exact dependency-closure air-gap bundle。
- npm tarball 内 MCP runtime 直接 bundle SDK 而不要求安装 Hono，且带精确
  `THIRD_PARTY_NOTICES.md`；package smoke 会在无 SDK/Hono 的安装目录验证 MCP initialize
  和 `tools/list`。

### 仍缺真实采用

- npm 包未发布，公开仓尚无独立社区用户的安装、贡献、升级、yank 响应或误报反馈；
  仓库公开本身不计为采用证据。
- 官方 Pack 未用真实发布者 key 签名；代码中的签名能力不等于发布者治理
  已成立。

## Phase 3 — 自托管 Registry / Web

### 已有工程基线

- public search/release/artifact 与 authenticated tokens/packages/releases/members/audit 均使用
  opaque、query/org-bound cursor，默认 50、最大 100；client 会消费所有页并防重复
  cursor，Web 显式 `Load More`。
- PostgreSQL SemVer keyset 按 strict SemVer precedence + raw build tie 排序；public 只取
  `approval_count`，tenant 审批细节一次有界 batch，不再 Node 内加载/排序全 catalog。
- public package search 默认仍精确返回 `name` / `visibility` / `created_at` 三字段；只有
  `include=facets` 才扩展 latest version、可用性、description、approved Lesson 数和
  language/ecosystem/tag。每维最多 4 个值，同维 OR、跨维 AND。
- discovery 只从完整校验后的不可变 artifact 的 active `approved` Lessons 派生，不信任
  发布请求自报 metadata；选择最高 strict-SemVer `published` release，yank 后回退到下一条。
- browser authorization-code + PKCE(S256)、state browser binding、nonce、bounded token exchange、
  HttpOnly/Secure/SameSite=Strict session 和 session-bound CSRF。每次 cookie 请求重读当前
  active user/membership/role；Bearer header 存在时绝不回退 cookie；protected 成功/失败均
  `Cache-Control: no-store`。
- migration `006` 限制 public RLS；`007` 强制 release payload/lifecycle 不变、
  exactly-two approval 与事实表 append-only；`008` 提供 C-collated SemVer keyset；
  `009` 增加 append-only/RLS discovery snapshot、与 snapshot 精确对应的 normalized
  facet B-tree，以及受约束的 latest-published projection。
- `009` 不为历史 release 伪造 metadata；旧安装必须先停旧 writer、迁移，再以
  migration-owner 分批运行 `registry reindex-discovery` 重新验证 artifact。缺行期间明确
  返回 discovery unavailable。
- semantic diff、普通 public、auth、billing webhook、protected API 和 release upload
  六套独立 pre-auth limiter；
  规范路由匹配防 percent-encoding 绕过；显式 proxy IP/CIDR allow-list；64 KiB、256 KiB、
  30 MiB 分路由 body cap。
- `/v1/public/diff` 完整复验两个 published/yanked artifact，只返回计数、Lesson ID 和
  allow-listed 变化字段；每类最多 100 项、JSON 最多 128 KiB。private/pending/rejected
  对匿名调用保持 404，yanked 下载仍为 410，比较不计 download usage。
- semantic diff 使用第六套独立 pre-auth limiter（GET/HEAD 同桶）；Node client 不发送
  bearer、将响应绑定回请求身份并以 129 KiB envelope 上限流式读取。Web 对 wire contract
  做 exact/bounded 校验，public/bearer 不带 cookie，同时保留显式 session 恢复路径。
- billing/usage 领域可执行严格幂等和配额逻辑；`billing=off` 默认不收款且
  不冒充真实支付。
- Docker 默认 loopback、PostgreSQL 无 host port、三角色分离、非 root/read-only rootfs、
  drop caps、bounded tmpfs、digest-pinned images。

### 已验证但不可过度解读

- 真 PostgreSQL 17 self-host smoke 验证 `001`–`008` 历史 release 升级 `009` 前后的
  discovery unavailable、migration-owner CLI reindex、幂等复跑、runtime-role 拒绝，
  以及 fresh migrations、least privilege、RLS、第三个 approval 拒绝、常规
  publish/reject/yank、discovery/facet append-only/RLS、facet 注入与缺项拒绝、yank
  fallback、非空 backup、隔离 restore、normalized data 精确比对、restart/auth 和 cleanup。
- append-only 是应用角色/误操作防护，database owner 仍可 alter/drop schema；这不是
  WORM 或合规认证。
- 100k 分页数据是 synthetic 查询计划探针，不是真实公网负载测试。

### 仍缺外部/生产证据

- public hosting/domain/TLS、真实流量/压测、HA/PITR、外部监控、on-call、事故响应
  和定期灾备演练。
- 真实 browser + 真实 IdP E2E、durable multi-instance sessions、SAML/SCIM。
- 真实 checkout/customer portal、收款/退款/税务、provider event-order contract；同一
  `created_at` 的事件目前只以 `event_id` 做确定性 tie，不能冒充供应商时序。
- live Sentry/GitHub webhook receiver/签名/凭据/持续投递；当前仍是本地 bounded
  adapter。
- 第三方安全评估、法律/隐私评审或任何合规认证。
- public discovery 的 reputation 数据与 reputation ranking 尚未实现。

## 当前验证命令

```text
npm run verify                 # 43 files / 373 tests + typecheck + build
npm run demo:tenant            # passed
npm run test:package           # passed; tarball MCP initialize/tools-list smoke
npm run test:self-host         # passed; 008→009 reindex + fresh restore/restart on PostgreSQL 17
npm run audit:prod             # 0 vulnerabilities
npm run audit:build            # 2 moderate dev-only Hono findings; no high/critical
npm pack --dry-run --json --ignore-scripts  # 510,064 bytes / 2,500,288 unpacked / 233 files
docker compose config --quiet  # passed
actionlint                     # passed
shellcheck -e SC2016 ...       # passed
git diff --check               # passed
pitlore check <semantic-diff/discovery production files>  # 定向扫描 0 findings
```

## 状态维护规则

- 每次重要里程碑更新日期、commit/CI、验证数字、外部缺口和下一步；不要
  只累加功能清单。
- 边界/原因改变时追加 [DECISIONS.md](./DECISIONS.md)，不要抹掉历史决策。
- 真实问题解决后写 private candidate；需复用的操作故障再写
  [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。
- README 只做入口；PRD 保存目标；本文件保存已实现/已验证事实。
- `.pitlore/`、reviews、evidence、凭据、专有源码和 private Lesson 正文不得进入仓库
  或外部记忆。
