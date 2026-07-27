# PitLore 项目状态

> 当前工作交接与事实快照。工程核验与产品方向决策更新：
> **2026-07-28（Asia/Shanghai）**。
> Git commit、CI 和候选队列会变化，新会话必须先用实时状态复核。

## 结论先行

PitLore 已形成三层可运行工程基线：本地 Lesson 闭环、Git-first Pack 供应链，
以及 PostgreSQL + Web/API 自托管 Registry。本轮把 MCP npm tarball、Pack 许可/边界、
全集合分页、browser session 权限、PostgreSQL 不变量、SemVer keyset、限流和请求体
上限继续收紧，并补齐了隐私安全、有界的真实 Pack semantic version diff，以及只从
已验证 release artifact 派生的 public Pack discovery facets v1。

项目已转为持续、公开的开源产品开发。按 D-018，固定周期 dogfood 收口已经移除；
独立用户安装、跨真实任务重复使用和 current-catalog 人工 evidence 作为长期产品质量
信号持续记录，不阻塞源码开源、日常开发或版本推进；人审和 evidence 完整性边界不变。

“工程基线可运行”仍不等于真实采用或生产就绪：当前没有 npm 发布或独立社区使用，
也没有公网托管、真实 IdP/browser E2E、真实支付和生产运维证据。GitHub 源码仓库已从
受审计的工程基线做 clean import 并公开；无凭据临时 consumer 已按 README 从公开
GitHub URL 安装、锁定和重放成功，但这仍是维护者验收，不能冒充社区采用。此前包含
个人作者 metadata 的开发历史保留在 private archive，不属于公共 Git 历史。

## 实时快照

| 字段             | 2026-07-28 本地已核验值                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 产品             | PitLore `0.1.0`；Apache-2.0；Node.js 22+ / TypeScript；consumer CI 已配置覆盖 Node.js 22/24 LTS                         |
| 仓库             | `Hardboiled98k/pitlore`，public；默认分支 `main`                                                                         |
| 当前工程基线     | `6b5af87` 发布准备基线；包含 public discovery facets v1、migration `009`、完整开源文档、跨平台安装门禁与社区治理配置       |
| CI 见证          | 公开 `6b5af87`：CI run `30282642062`（11/11 jobs）、CodeQL run `30282641056`（3/3）及两个 Dependabot update run 全绿；17/17 check-runs success、0 annotations |
| 工作树           | 公共历史从 GitHub noreply clean import 开始；本地与公开 `main` 同步，旧开发历史只保留在 private archive                  |
| 完整验证         | 当前工作树 `npm run verify`：43 files / **376 tests**，typecheck 和 build 通过                                         |
| 自托管           | 真 PostgreSQL 17：`001`–`008` 历史 release → `009` → CLI reindex/幂等复跑/runtime 拒绝，以及 fresh restore/restart 全通过 |
| 分页性能探针     | synthetic 100k releases：PostgreSQL keyset 取 101 行 lookahead，index 扫描约 102 行，约 0.57 ms；只是工程证据           |
| Demo / 发布包    | tenant Demo 通过；tarball、npm exec/全局安装、隔离 Git smoke 及无凭据公开 GitHub URL 安装/lock 重放均通过；约 0.53 MB / 2.73 MB / 243 files |
| npm 发布自动化   | 仅手动 tag-ref workflow 已实现同一 artifact/SHA/六组合 consumer/OIDC 门禁；`npm-publish` environment 只允许 `v*` tag，但 workflow 尚未运行；npm 包仍未首发，trusted publisher 必须等首次 2FA bootstrap 后配置 |
| 仓库保护         | live `main` 禁止 force-push/delete，要求 GitHub Actions `CI required`、PR stale-review dismiss 与 conversation resolution；单维护者审批数为 0，admin 保留紧急绕过；active `v*` tag ruleset 禁止已创建标签更新或删除 |
| 开源治理         | GitHub community profile = 100%；CODEOWNERS、Contributor Covenant 2.1、结构化 issue forms、PR template 和 Dependabot 已启用；行为准则如实披露单维护者无独立申诉方边界 |
| 依赖审计         | production tree = 0；high/critical gate 通过；286 个 lock artifact 均为 npm 官方 registry；MCP bundle notice 正文有 SHA-256 门禁；audit 汇总的 2 个 dev-only Hono moderate 已在所装 1.19.17 修复，且 adapter 不进入 MCP bundle |
| 本地 lore        | 当前 115 条：60 approved，55 candidate；29 条有 current advisory，26 条未 advisory review；均未由 agent 批准           |
| Evidence current | `catalog_hash=637418aa…`；0 events；usefulness/precision/recall 均为 unknown (`null`)                                   |
| Evidence all     | 跨 2 个 catalog 共 8 条 real；retrieve 5，useful 2，precision 2/7，recall 2/3；detector 3 条全为历史 FP                 |
| PitLore check    | semantic diff、discovery 与本轮安装、发行及社区入口 source/config 定向扫描均为 0 findings；本轮 hash `637418aa…`，未写 agent 自评 evidence |

## 新会话恢复顺序

1. 读本文件，然后运行 `git status -sb`、`git log --oneline -5`、
   `gh repo view Hardboiled98k/pitlore` 和 `gh run list --branch main`。
2. 改变信任/阶段边界前读 [DECISIONS.md](./DECISIONS.md)；D-018 已移除固定周期收口，
   不取消 D-003 人审边界和 D-011 证据口径。
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

- current catalog 没有任何人工 evidence；历史 8 条不能代表当前 detector 0.2.0
  或当前 approved catalog 质量。
- 新 candidate 仍待独立人审；advisory review 不能冒充生命周期授权。
- 历史 retrieve/check/remember 是真实工程调用，但缺少足量人的 usefulness/detector
  判断，因此未写 evidence record。
- 尚无独立外部用户的安装、跨任务重复使用或贡献证据。
- 以上缺口必须如实披露，但不是开源、开发或 release 门槛；工程测试
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
- Git dependency 通过 `prepare` 从不含 `dist/` 的源码构建发行内容；隔离 smoke 会创建
  临时 Git 仓并验证安装后的真实 bin/version/help，防止 npm 零退出码掩盖缺失 CLI。
- CI 只构建一次 npm tarball，并让 Ubuntu、macOS、Windows consumer 安装同一 artifact；
  tarball 在 `--ignore-scripts` 下完成 CLI、MCP、init、retrieve/check 和治理闭环验证。
- Package smoke 同时限制压缩包、展开 tar stream 和 entry 数，防止高压缩比异常内容
  绕过仅针对 `.tgz` 字节数的门禁。
- 独立 `npm-publish.yml` 只允许从手动选择的既有 release tag 运行；tag/ref/package
  version、main ancestry、package identity 和 SHA-256 必须一致，只有最后的受保护 job
  获得 OIDC 权限。GitHub `npm-publish` environment 已仅允许 `v*` tag；active tag ruleset
  会阻止已创建的 `v*` 标签更新或删除。workflow 尚未实际运行；npm trusted publisher
  必须等首次包由账号 2FA bootstrap 后配置。

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
npm run verify                 # 43 files / 376 tests + typecheck + build
npm run demo:tenant            # passed
npm run test:install           # passed; tarball + isolated Git dependency consumer smokes
npm install --save-dev "git+https://github.com/Hardboiled98k/pitlore.git#main"
                               # passed in no-credential temp HOME; lock replay also passed
npm run test:self-host         # passed; 008→009 reindex + fresh restore/restart on PostgreSQL 17
npm run audit:prod             # 0 vulnerabilities
npm run audit:build            # 2 moderate dev-only Hono findings; no high/critical
npm pack --dry-run --json      # runs prepare; inspect current size/file list (currently 243 files)
npm publish --dry-run --json   # passed; lifecycle/install gates execute, registry unchanged
docker compose config --quiet  # passed
actionlint                     # passed
shellcheck -e SC2016 ...       # passed
git diff --check               # passed
gitleaks dir . --redact        # no leaks
pitlore check <changed sources> # 安装/发行 source/config 定向扫描 0 findings
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
