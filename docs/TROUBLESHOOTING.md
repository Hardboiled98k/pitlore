# PitLore 已解决问题

只记录真实出现并已经解决的问题。每条分开写现象、根因、修复和回归检查，
避免未来把推测当事实重复处理。

## macOS Docker Desktop 从非 ASCII 项目路径构建时 BuildKit metadata 失败

- **发生时间**：2026-07-17，Phase 3 Docker Compose 真实 smoke。
- **现象**：从含中文字符的项目 cwd 构建镜像时，BuildKit/gRPC 在 session metadata
  `x-docker-expose-session-sharedkey` 处报告不可打印字符；Dockerfile 尚未进入应用构建
  步骤。同一源码从 ASCII `/tmp` 路径构建成功。
- **根因边界**：已通过“源码不变、只换构建上下文绝对路径”确认是当前 macOS Docker
  Desktop/BuildKit 的路径到 metadata 兼容问题，不是 TypeScript、npm、Dockerfile 或
  GitHub 故障；尚未把它外推为所有 Docker/非 ASCII 路径的普遍行为。
- **修复/绕过**：把受版本控制的构建输入复制到新的 ASCII 临时目录，再从那里执行
  Compose build。不要复制 `.git`、`.pitlore`、`node_modules`、`.env`、`secrets`、
  `operator-artifacts`、bearer 或 dump；运行完整 Compose smoke 时，在 staging 目录重新
  生成临时 secret files。

  ```bash
  STAGE="$(mktemp -d /tmp/pitlore-compose-ascii.XXXXXX)"
  rsync -a \
    --exclude .git --exclude .pitlore --exclude node_modules \
    --exclude .env --exclude secrets --exclude operator-artifacts \
    --exclude 'bootstrap-token*.json' --exclude '*.dump' --exclude '*.dump.sha256' \
    ./ "$STAGE/"
  (cd "$STAGE" && docker compose build --pull migrate registry)
  ```

- **回归检查**：ASCII staging 中使用相同 pinned Node/PostgreSQL image 和源码完成镜像
  build；后续 fresh Compose、迁移和 restore smoke 也从 ASCII staging 运行。临时目录和
  secret 由 smoke cleanup 负责，不把 workaround 变成第二份源码真相源。

## Alpine/BusyBox 的 grep interval 让合法数据库 secret 被误拒绝

- **发生时间**：2026-07-17，首次真实 fresh Compose 初始化 PostgreSQL volume。
- **现象**：三个 secret files 都满足预期长度和字符集，但 `init-roles.sh` 在 Alpine
  PostgreSQL 容器中拒绝合法值，导致数据库角色未创建、migrate/Registry 无法启动。
- **根因**：首版 shell 校验依赖 grep ERE 的 `{32,256}` interval 行为；真实 BusyBox
  环境与本机工具链表现不一致，把可移植性假设带进了 bootstrap critical path。
- **修复**：不再用 interval regex。脚本以 POSIX shell 读取恰好一行，显式拒绝空值和
  第二行，用 `case` 校验 base64url-safe 字符，再用 `${#value}` 检查 32–256 长度。
- **回归检查**：销毁仅用于 smoke 的空测试 volume 后重新 fresh start，admin/migrator/
  runtime 三角色成功创建，migrations、Registry readiness 和后续非空 backup/restore 均
  通过。已有生产 volume 不会重跑 init script；不能用删 volume 作为线上修复手段。

## Linux Compose 无法让非 root 服务读取 `0600` file secret

- **发生时间**：2026-07-17，Phase 3 首次 GitHub Actions self-host job。
- **现象**：同一 self-host/restore smoke 在 macOS Docker Desktop 通过，但两套 Ubuntu
  Actions run 的时序不同：push run 报 PostgreSQL unhealthy；PR run 先把 PostgreSQL 判为
  healthy，随后 migrate 立即 exit 1。常规 Ubuntu 测试全绿；旧 cleanup 又在保留 service
  logs 前执行了 `down`。
- **根因**：本地 Compose 在 Linux 上把 file-backed secret 实现为宿主 bind mount；对
  file source 声明的 `uid`、`gid`、`mode` 不会重映射。smoke 创建的文件是 runner UID
  所有的 `0600`，而 PostgreSQL init script 以 UID 70 读取 migrator/runtime secret，
  migrate/Registry 又以 Node UID 1000 读取各自 secret，因此都会得到权限拒绝。macOS 的
  文件共享层没有复现这条宿主 UID 边界。
- **修复**：宿主 `secrets/` 目录继续保持 `0700`，其中三个文件改为 `0644`。其他宿主
  用户无法穿越私有父目录；容器侧只有 `compose.yaml` 明确授权的服务收到对应只读挂载。
  PostgreSQL healthcheck 同时显式探测 `127.0.0.1` TCP listener，避免把官方 entrypoint
  初始化期间的 socket-only 临时 server 当作最终 readiness。
- **回归检查**：smoke 对真实 file-backed secret、三个不同非 root service identity、fresh
  migration、Registry、backup/restore 全链路负责；失败 cleanup 会先输出 bounded
  `compose ps -a` 和最后 200 行 service logs，再删除临时项目。`9c952b9` 的 push run
  `29527092423` 与 PR run `29527096596` 两套 Ubuntu self-host jobs 均成功。不能用环境变量
  明文或让 Registry 以 root 运行来绕过权限问题。

## Windows 并发 CLI 测试因进程启动竞争超过局部时限

- **发生时间**：2026-07-17，Phase 3 完整 Windows CI 收口。
- **现象**：相同断言在单文件或相邻 PR run 通过，但并行 full suite 的失败目标会在 Pack、
  Registry CLI 与三进程 reject 聚合间移动。`9d49821` 的 push 中 reject 用例为 5376ms，
  同 commit PR 为 4191ms；Windows `maxWorkers=2` 后，push/PR 仍分别以 7865ms/6914ms 超过
  默认 5 秒。Ubuntu 和 self-host jobs 同时保持成功。
- **根因**：多个 subprocess-heavy test files 在 Windows runner 上并发启动 Node 进程，造成
  可重复的启动资源竞争；不是某条业务断言稳定退化，也不是随机网络依赖。
- **修复**：只在 Windows CI 把 Vitest file workers 串行为 `--maxWorkers=1`；Pack 与 Registry
  CLI 保留与实际 subprocess 数量相称的既有 scoped budget，只给已确认的三进程 reject
  聚合 15 秒。没有增加 retry、全局 `testTimeout`、跳过平台或删除断言。
- **回归检查**：`9c952b9` 的 push run `29527092423` 与 PR run `29527096596` 均为 35/35 files、
  271/271 tests；Windows 测试分别耗时 103.37s/113.02s，随后 typecheck、build、tenant Demo
  和 package smoke 全部成功。

## OIDC JWT 在 verifier 前被 512 字符 bearer 上限拒绝

- **发生时间**：2026-07-17，Phase 3 身份与 HTTP transport 收口审计。
- **现象**：OIDC verifier 接受有界 JWT，但 Registry client/server 的通用 bearer 入口复用
  API token 的 512 字符校验；现实尺寸的 RSA-signed JWT 因而可能在签名、issuer、audience
  和 tenant 验证之前直接得到 401。
- **根因**：把短、由 PitLore 生成的 API token 格式约束误当成所有 HTTP bearer assertion
  的 transport contract，两个信任对象的长度边界没有分开。
- **修复**：client 与 server 共用独立的 HTTP bearer 校验，允许最多 12 KiB 的 token-safe
  字符；内部 API token 继续保留更小的独立上限。该值低于当前 Node 默认 aggregate header
  上限，并不授权反向代理放宽自己的 header 限制。
- **回归检查**：client 确实传递含 1024 字符 payload 的 JWT-shaped assertion，server 可把
  同一 assertion 交给 actor resolver；超过 transport 上限或包含空格的 bearer 均 fail
  closed。这里没有接入真实 IdP，也不能当成 browser SSO 证据。

## PostgreSQL `DATE` 经 JavaScript instant 往返后配额幂等冲突

- **发生时间**：2026-07-17，Phase 3 完整测试在 Asia/Shanghai 时区运行。
- **现象**：usage reservation 已存在且语义相同，但比较路径可能把数据库
  `period_start DATE` 读成 local-midnight `Date`，再经 `toISOString().slice(0, 10)` 退到
  前一个 UTC 日，进而误报 `UsageConflictError`。把列强制 `::text` 的中间修复又在 pg-mem
  回归中报 `cannot cast type date to text`。
- **根因**：calendar date 没有时刻或时区语义，却被当作 JavaScript instant 往返；测试
  adapter 的 cast 支持也不能替代 PostgreSQL 语义本身。
- **修复**：reservation 查询直接在数据库内计算
  `period_start = $3::date AS same_period`，应用只消费布尔结果；用量聚合也继续以参数化
  `$n::date` 比较，不再把数据库 `DATE` 转为 ISO timestamp 后判断。
- **回归检查**：telemetry 定向测试覆盖首次 claim、重复 event、并发相同 event、跨组织和
  历史客户端时间，最终 SQL 路径在当前 pg-mem adapter 中通过。完整矩阵仍必须单独全量
  运行，不能用定向通过替代。

## 成员降权后旧 actor 快照仍可管理 API token

- **发生时间**：2026-07-17，Phase 3 durable auth 对抗式审计。
- **现象**：HTTP 层先解析出的 admin/owner actor 若随后被降权或移除，PostgreSQL token
  service 仍可能依据这份旧快照执行 list、issue、revoke 或 subject-wide revoke。
- **根因**：持久化敏感操作只把 route actor 当授权事实，没有在 mutation/read 所在事务
  重新读取 active user、membership 和当前 role；请求解析与最终提交之间存在权限时序窗。
- **修复**：四条 durable token lifecycle 路径先锁 organization row，在同一事务重读用户
  状态和 membership，并按存储中的当前 role 重新授权后才继续。路由仍传 actor identity，
  但不再把其 role snapshot 当最终权限来源。
- **回归检查**：测试在 actor 解析后把 admin 降为 viewer，随后对 list/issue/revoke/
  subject-revoke 均断言拒绝；正常 owner/admin 与服务 token 既有边界保持。

## 公开 provenance URL 把 query/fragment 凭据带入不可变记录

- **发生时间**：2026-07-17，Phase 3 publication 供应链审计。
- **现象**：source URL 已要求 HTTPS 且禁止 `user:password@host`，但仍接受
  `?access_token=...` 或 `#access_token=...`；这些值可能进入 release provenance、audit
  和后续客户端数据。
- **根因**：“credential-free”只检查 URL userinfo，没有把 query/fragment 视为不可接受的
  credential carrier；client 也缺少发送前的同构边界。
- **修复**：server schema 与 client preflight 都只接受 absolute HTTPS URL，拒绝 username、
  password、query 和 fragment，包括尾随空 `?`/`#`。source commit 继续作为独立字段。
- **回归检查**：覆盖 HTTP、userinfo、query token、fragment token 与空 query/fragment；
  client 在发请求前拒绝，server 也 fail closed。checksum、commit 和 publisher identity 仍是
  不同信任事实。

## OIDC 用户只按 provider + subject 绑定，issuer namespace 丢失

- **发生时间**：2026-07-17，Phase 3 OIDC identity mapping 审计。
- **现象**：JWT verifier 会校验 `iss`，但持久化用户只按本地 provider id + `sub` 查询；
  provider 配置迁移或多个 issuer 复用 subject 时，数据库身份键没有保留原 issuer 事实。
- **根因**：验证层的 issuer 约束没有贯穿 bootstrap、provision、repository unique identity
  和 actor resolution，导致验证事实在持久化边界被降维。
- **修复**：`004_registry_identity_issuer.sql` 新增 nullable `identity_issuer` 和 issuer-bound
  unique index；新 bootstrap/token bootstrap 必须提供 exact issuer，provision 从已验证
  human assertion 派生 issuer，resolver 按 provider + issuer + subject 查找。已绑定的
  non-null issuer 不允许替换。
- **回归检查**：同一 issuer 的 bootstrap 幂等，不同 issuer replacement 失败；错误 issuer
  的 JWT 返回 401。旧 NULL identity 必须按 [self-hosting upgrade](./SELF-HOSTING.md#8-upgrade-safely)
  显式绑定，migration 不猜测历史 issuer。

## 折叠的 reject form 仍留在键盘 tab order

- **发生时间**：2026-07-17，Phase 3 Web accessibility 收口。
- **现象/根因**：reject panel 只以 CSS grid rows 和 opacity 视觉折叠，内部 input/button
  仍可被键盘聚焦；视觉状态没有成为 DOM 可交互状态。
- **修复**：初始与关闭状态使用 HTML `hidden`，触发器同步 `aria-expanded` 和
  `aria-controls`；展开后把焦点移到 reason input。CSS 只负责动画/呈现，不单独控制可达性。
- **回归检查**：Web asset 测试锁定 hidden、ARIA 关联与 focus 行为；仍需真实辅助技术和
  浏览器矩阵验收后才能宣称完整 accessibility。

## Service token 认证随历史 token 数量线性变慢

- **发生时间**：2026-07-17，Phase 3 auth resource-exhaustion 审计。
- **现象/根因**：每个 bearer request 曾加载 active、expired、revoked 的所有 token rows，
  再逐条校验与比较 hash；任意伪造 token 都可触发 O(n) 数据库读取和 CPU 工作。
- **修复**：先校验短 API token 格式并计算 SHA-256 lookup key，通过 unique hash index 读取
  单行，再对该行做 constant-time verification 与 expiry/revocation/scope 检查。legacy
  embedding fallback 保留兼容，但 durable PostgreSQL path 不再 full scan。
- **回归检查**：测试注入禁止 list/full-scan 的 store 并完成有效、伪造、过期和 revoked
  token 路径。indexed lookup 降低单请求成本，不替代公网 rate limiting。

## 未知 storage 故障被错误映射成 quota/conflict

- **发生时间**：2026-07-17，Phase 3 HTTP error boundary 审计。
- **现象/根因**：usage fallback adapter 捕获任意 entitlement/storage exception 并统一返回
  quota 或 conflict client error，数据库故障和程序错误因此被误分类，还可能诱导客户端
  做错误补救。
- **修复**：in-memory 与 PostgreSQL 边界使用相同的 typed
  `UsageQuotaExceededError`/`UsageConflictError`；HTTP 层只映射这些已知 domain errors，
  其他异常重新抛出并由统一 handler 返回不含内部 detail 的 500。
- **回归检查**：已知 quota/conflict 状态码保持，未知 storage detail 不出现在响应中。
  这只是安全错误映射，不等于外部 monitoring/alerting 已部署。

## Chunked Registry response 在检查大小前已被完整缓冲

- **发生时间**：2026-07-17，Phase 3 client resource-bound 审计。
- **现象/根因**：client 只预检 `Content-Length`，然后调用 `response.text()`；无
  `Content-Length` 的 chunked peer 可让进程先无界缓冲，事后 35 MiB 检查来不及阻止 OOM。
- **修复**：保留 declared-length preflight，同时逐 chunk 读取 `ReadableStream`、累计
  bytes，超过上限立即 cancel，只有在界内才 decode/parse JSON。
- **回归检查**：oversized chunked fixture 在读完前被拒绝；正常 bounded response 和
  declared oversize 路径保持。单响应上限不提供下载 rate/concurrency/egress 控制。

## 不可信 HTTPS Git clone 可无限等待

- **发生时间**：2026-07-17，Phase 2/3 供应链收口审计。
- **现象/根因**：remote Pack 安装以同步 `git clone` 读取不可信 HTTPS source，却没有绝对
  child timeout 或 low-speed deadline；慢速/恶意 endpoint 可长期占住 agent。
- **修复**：默认 120 秒绝对 timeout（`PITLORE_PACK_GIT_TIMEOUT_MS` 只允许
  250–300000 ms）、低于 1 KiB/s 持续 30 秒即中止、stdout/stderr 各限制 2 MiB；隔离 global
  Git config，并禁用 credential helper 与 redirects。失败/超时都清理临时 clone，不回退到
  未验证缓存或其他 source。
- **回归检查**：无响应 loopback TCP endpoint 在测试 deadline 内失败，错误明确且临时目录
  被清理；credential-bearing URL 仍在 clone 前拒绝。Clone 传输总字节目前没有协议层硬上限；
  checkout 完成后仍由 Pack 的 20 MiB/1000 files 上限 fail closed，不应把后置校验写成网络
  下载配额。不同 Git/proxy 环境仍需持续验证。

## Pack 安装成功但锁文件或缓存校验失败

- `pitlore.lock.yaml` 是运行时唯一依赖图真相源；`.pitlore/packs/sha256/` 中未被锁定的
  目录不会被扫描或消费。
- `pitlore install --frozen-lockfile` 与 `pitlore pack verify-installed` 会重新验证每个
  Pack 的 canonical SHA-256、manifest name/version、解析后的依赖和 Lesson ID 冲突。
- 缓存缺失、单字节篡改、依赖版本不匹配、循环、private/candidate Lesson、未知文件、
  symlink、非空 `detector_ref` 或高风险 regex 都会 fail-closed；不会静默退回仅本地目录。
- 同一 `name@version` 内容不可变化。内容变更必须 bump SemVer；Git tag 只是来源提示，
  lock 中的 commit 与内容校验和才是固定证据。无签名 Pack 明确为 `unverified`；嵌入
  Ed25519 公钥的有效签名默认仍是 `self-asserted`。只有显式安装参数
  `--trust-key sha256-…` 匹配时才记录 `explicit-key`，checksum 或 Git 来源本身不等于
  发布者身份。

## 两个 Pack 进程同时安装时 lockfile 丢失其中一次更新

- **发生时间**：2026-07-17，Phase 3 收口时对 Phase 2 lock 做对抗式并发审计。
- **现象**：两个独立进程从同一个初始 `pitlore.lock.yaml` 安装不同 root Pack；两者都
  报成功，但后写进程覆盖先写结果，最终 lock 只剩一个 root。缓存中的另一份内容存在但
  因未被 lock 引用而保持 inert。
- **根因**：旧实现只在最终 write/rename 周围加锁，read → dependency resolve → next lock
  计算发生在 guard 之外；两个进程因此可以基于同一旧快照各自完成 read-modify-write。
- **修复**：install、air-gap bundle install 和 uninstall 都在同一个跨进程 mutation guard
  内重新读取 lock、解析依赖、计算并原子提交。guard 用 exclusive create，descriptor 与
  path identity 在提交前复核；等待超时 fail-closed，不按文件年龄自动删除疑似 stale lock。
- **回归检查**：测试先人为持有 guard，让两个真实子进程都进入等待，再同时释放；修复后
  第二个进程获取 guard 时重读第一个提交，最终两个 root/package 都存在且
  `verifyInstalledPacks` 通过。另覆盖 install/bundle/uninstall 遇到他人 guard 时超时且不
  删除 guard、不改变原 lock；`tests/pack.test.ts` 15/15 通过。

## GitHub Actions 成功但出现 Node 20 Action runtime 弃用告警

- **发生时间**：2026-07-15，CI run `29429923212`。
- **现象**：项目检查全部通过，但 GitHub 标注 `actions/checkout@v4` 与
  `actions/setup-node@v4` 的内部 Node 20 runtime 已弃用。
- **根因**：Action 自身 runtime 与项目要测试的 Node.js 版本是两层配置；旧 Action
  major 已过期。当时 `node-version: 20` 仍是项目测试目标；Node.js 20 后来进入 EOL，
  当前最低运行时已由 D-019 提升到 22。
- **修复**：当时先把两项 Action 升级到 v6；当前 workflow 继续使用 v6，并以
  Node.js 22 为最低版本、在 consumer CI 额外覆盖 Node.js 24。
- **回归检查**：CI run `29430093844` 全步骤成功，annotations 为空。

## Lockfile 固定到镜像，CI 被镜像可用性绑架

- **发生时间**：2026-07-15，首次 push 前审计。
- **现象**：`package-lock.json` 的 205 条 resolved URL 全指向
  `registry.npmmirror.com`；本机此前已经遇到该镜像 audit endpoint 返回 HTTP 404。
- **根因**：本机 npm 默认 registry 是镜像；已有 lockfile 使用绝对 URL，仅传
  `--registry` 不会自动改写这些地址。
- **修复**：只把 registry host 归一到 `registry.npmjs.org`，保持版本与 integrity
  不变，再用官方源执行 fresh `npm ci`。
- **回归检查**：fresh install 成功、audit 0 vulnerabilities、本地完整验证和
  GitHub Actions `npm ci` 均通过。

## Secret detector 测试字符串形似真实凭据

- **发生时间**：2026-07-15，首次 GitHub push 前。
- **现象**：测试中有连续的 GitHub token 形态假值，虽然不是秘密，但可能触发
  Push Protection 或秘密扫描器。
- **根因**：detector 需要接收接近真实格式的 runtime 输入，但源码没必要保存连续
  token-shaped literal。
- **修复**：源码中把 provider-shaped 测试值拆为片段，运行时再拼接；检测语义不变。
- **回归检查**：57 tests 继续通过，staged secret-pattern scan 零命中。

## Codex 无交互模式取消可信本地只读 MCP 调用

- **发生时间**：2026-07-16，Phase 1 dogfood。
- **现象**：Codex 已连接 PitLore，但 `pitlore_retrieve` 在 headless `codex exec`
  中显示 `user cancelled MCP tool call`。
- **根因**：默认 MCP tool approval 仍会为没有 read-only annotation 的工具发起人工
  提示；无交互 stdin 无法回答，因而被记为取消。
- **修复**：项目级 Codex 配置只对 approved-only 的 retrieve/check/export 使用
  `approve`；可能读取 private candidate 的 search/get 与写 candidate 的 remember
  保持 `prompt`。服务端的日常 retrieve/check 也固定为 approved-only。
- **回归检查**：真实 Codex 客户端随后显示 `pitlore_retrieve (completed)` 并返回
  `MCP_OK`；Claude Code 同一 stdio server 也完成真实 retrieve。

## Heuristic candidate 标题截断在半句话或半个单词

- **发生时间**：2026-07-16，检查两个真实 private candidate 时。
- **现象**：candidate 列表标题分别被截在英文单词和中文分句中间，人工审核时难以
  快速理解问题。
- **根因**：离线 distill 直接使用 `description.slice(0, 80)`，按 UTF-16 code unit
  生硬截断，也没有利用调用者提供的 `idHint`。
- **修复**：短描述保持原样；长描述优先取完整分句，其次使用可读 id hint，最后按
  Unicode code point 与英文词边界截断并显式添加省略号，同时规范多余空白和截断后
  的尾部分隔符。
- **回归检查**：新增中文分句、英文词边界、80/81 Unicode、短多句、窗口边缘和
  id hint 回归用例；完整验证 65/65 tests 通过，修复后的真实 remember 生成了
  完整分句标题。

## warn/info candidate 的非法 detector 可在批准时漏过

- **发生时间**：2026-07-16，开发 LLM review 的确定性 readiness 检查时。
- **现象**：带非法正则的 warn/info candidate 能被 `approve`，直到后续运行 `check`
  才以 detector configuration error 形式 fail-closed；block candidate 不受影响。
- **根因**：批准路径只在 block fixture gate 内校验 detector 配置，非 block severity
  没有经过同一配置校验。
- **修复**：所有 severity 在批准前先隔离校验 detector 配置；block 再额外执行
  pattern 与 bad/good fixture gate。
- **回归检查**：新增 warn 非法正则不能批准的测试；完整验证 80/80 tests、typecheck、
  build、package smoke、租户 Demo 及 GitHub push/PR CI 均通过。

## 长任务描述因单个通用词召回无关 Lesson

- **发生时间**：2026-07-16，Phase 1 dogfood 首条真实 retrieve 人评。
- **现象**：为 CLI `--files` 兼容任务检索时返回了无关的
  `date-tz-naive`；用户判定为 irrelevant + coverage gap。
- **根因**：长 intent 与该 Lesson 只共享 root cause 中的通用词 `mixed`；
  单 token 获得的 `0.8` relevance 恰好达到当时的全局门槛。
- **修复**：token score 仍参与排序，但多词 intent 的纯正文命中至少需要
  2 个 hits 且覆盖 60% 查询词才能独立构成相关性；单词、path scope
  和按 token 边界匹配的 tag/ecosystem 信号仍可独立过门槛。
- **回归检查**：中英文原始风格误报 intent 在完整 seed 上不再召回无关 Lesson；
  单词 `mixed`、多词 `async await mistakes`、时区强相关、tag/ecosystem 边界查询仍能召回；
  substring-only 的 `updates`→`dates`、`offset`→`fs`、`reactive`→`react` 均不再误命中；完整验证 99/99 tests、
  typecheck、build、tenant Demo 与 package smoke 均通过。

## 普通 Lesson 覆盖可绕过终态并跟随外逃 symlink

- **发生时间**：2026-07-16，实现 candidate 正式 reject 时的对抗式状态机评审。
- **现象**：库调用者可用 `putLesson(..., { overwrite: true })` 把既有 approved/deprecated
  覆盖回 candidate；覆盖写也只检查 bundled seed，没有验证最终目标仍在 lore root，
  `lessons/` 或 Lesson 文件 symlink 可能让写入落到外部路径。
- **根因**：普通 candidate 编辑与治理终态迁移共用无前态检查的覆盖 writer；写入使用
  直接截断，状态过滤也依赖逐个排除旧枚举，新增状态容易漏入 retrieve/check `--all`。
- **修复**：普通 put 只允许 candidate 新建/编辑；approve/reject/deprecate 走显式状态机
  和同一 per-Lesson 锁，覆盖先写同目录临时文件再原子 rename，并保留既有权限。init
  预检 root、manifest、README、lessons 与 seed 目标；store/review load 用
  `O_NOFOLLOW` descriptor 并核对 inode；Lesson/review 写入持续复核对应目录 identity。
  retrieve/check 改为 consumable 正向白名单。
- **回归检查**：新增终态防覆盖、重复 reject、approved/rejected 互斥、review/hash、
  CLI/MCP、默认与 candidate-aware retrieve/check/export、目录/文件 symlink、瞬时目录替换
  和锁冲突测试。

## 初始化中断留下假完成状态，private 文件默认可被同机其他用户读取

- **发生时间**：2026-07-16，reject/deprecate 生命周期的文件系统终审。
- **现象**：manifest 在 seed/README 之前写入，后续复制失败会让半成品被误判为已初始化；
  标准 `umask 022` 下新 Lesson/review 为 `0644`、目录为 `0755`。
- **根因**：manifest 没有承担 commit marker 语义，文件模式依赖进程默认值；路径预检与
  实际 read/write 之间也缺少 descriptor/目录身份绑定。
- **修复**：seed 与 README 成功后才原子落 manifest；新目录/私有文件显式使用
  `0700`/`0600`；YAML 通过 `O_NOFOLLOW` descriptor 读取并核对已检查 inode，root、
  lessons、reviews 在操作期间持续核对 identity；原子替换后在支持的平台 fsync 父目录，
  并在主操作失败时保留任何 lock/temp 清理错误。
- **回归检查**：覆盖初始化失败后可重试、瞬时父目录替换不注入 Lesson、review 写不外逃、
  POSIX owner-only 权限和 manifest 最后提交。

## Windows package smoke 不能直接执行 npm / `.cmd` shim

- **发生时间**：2026-07-16，新增真实 Windows package job 后的连续两轮 CI。
- **现象**：首轮 push/PR runs `29489535257`、`29489535848` 在 Windows 报
  `spawnSync npm ENOENT`；把命令名改成 `npm.cmd` 后，第二轮 runs `29489855240`、
  `29489858204` 又报 `spawnSync npm.cmd EINVAL`。同一 commit 的 Ubuntu verify 已成功。
- **根因**：Windows 的 npm 与 npm `.bin` 命令是 command-processor shim，而不是可由
  no-shell `execFile` 直接启动的原生 executable。仅做平台文件名分支没有改变执行模型，
  而且若完整测试都绕过 `.cmd`，Windows job 又可能假绿。Node 官方也要求 `.bat`/`.cmd`
  经 shell、`cmd.exe` 或其他受控 runner 启动。
- **修复**：npm pack/install 通过 `process.execPath + npm_execpath` 无 shell 执行；完整 CLI
  矩阵在 Windows 通过 Node 直跑安装包内 `dist/cli.js`。另用静态 npm script 从含空格的
  临时消费者目录真实解析并执行一次安装生成的 `pitlore.cmd --help`，同时断言 shim、
  JS entry 与 LICENSE 都存在，避免把动态参数拼进 shell。
- **回归检查**：代码 head `eea610a` 的 push run `29490431583` 与 PR run
  `29490435666` 均成功；两边 Ubuntu `verify` 和真实 Windows `package-windows` 全绿，
  失败 runs 未 rerun 或删除。

## Windows full verify 暴露 POSIX-only CLI 测试与路径/时延假设

- **发生时间**：2026-07-16，把完整 verify 从仅 Ubuntu 扩为 Ubuntu/Windows 矩阵后。
- **现象**：矩阵首轮 push/PR runs `29491520540`、`29491523299` 在开发 CLI 测试执行
  `node_modules/.bin/tsx` 时报 `ENOENT`，目录 identity-swap 测试则因 Windows 用 `EPERM`
  阻止 rename 而失败；同一 commits 的 Ubuntu job 全绿。修正这一层后，runs
  `29492615775`、`29492618208` 继续暴露 runner 8.3 short path 与 long path 的纯文本差异，
  以及两个聚合多次 CLI 启动的测试超过默认 5 秒。
- **根因**：extensionless `.bin/tsx` 是 POSIX 启动假设；Windows 对仍打开目录的 rename
  约束可以在攻击到达 store 前安全阻止替换；同一 Windows 路径可能同时有 short/long
  文本表示；把 4–5 次独立 CLI 进程启动聚合进一个 5 秒测试又隐含了 POSIX 时延预算。
- **修复**：开发 CLI 测试统一用 `process.execPath` 加
  `createRequire(...).resolve("tsx/cli")` 启动真实源码入口；只精确接受 identity-swap rename
  的 Windows `EPERM`，同时断言外部目标和原目标都未被写入，保持 fail-closed。路径断言
  比较 `realpathSync.native` 后的 canonical file identity；聚合场景按原断言拆成独立测试，
  未放宽 timeout、吞错或跳过平台。
- **回归检查**：代码 head `122f714` 的 push run `29494844884` 与 PR run `29494849185`
  均成功；Ubuntu/Windows 都通过 15 个测试文件、140/140 tests、typecheck、build、租户
  Demo 与 package smoke。中间失败 runs `29494555799`/`29494557344` 保留，未 rerun 或删除。
  后者曾在 Windows 两个聚合 CLI 测试上报 5 秒 timeout；`122f714` 拆分后恢复全绿。

## OpenAI distill 请求可能无限等待

- **现象**：配置 `OPENAI_API_KEY` 后，distill 直接等待 OpenAI 响应；网络半开或服务端
  不返回时，现有 heuristic fallback 无法及时接管。这是从代码路径和 approved
  `http-no-timeout` Lesson 得出的高可信风险推断，不是一次真实线上挂起证据。
- **根因**：`fetch` 没有 `AbortSignal` 或总 deadline；只有收到 HTTP 错误、空响应或 schema
  错误时才会进入既有 fallback。
- **修复**：请求统一附带 60 秒 `AbortSignal.timeout`；捕获 `TimeoutError`/`AbortError` 时
  输出明确 timeout warning，继续生成 `candidate`、`private`、`warn` 的本地 heuristic
  Lesson。没有把模型返回内容提升为治理字段。
- **回归检查**：`tests/distill-security.test.ts` 模拟 abort，验证 signal、告警和 fallback
  治理字段；`7df6e31` 本地 138/138 tests、typecheck/build、tenant Demo、package smoke
  和 PitLore check 均通过；push `29494324917` 与 PR `29494327751` 的 Ubuntu/Windows
  全矩阵也已成功。

## 生命周期操作提示已有 lock

## 公开导出必须显式选择且默认拒绝不安全内容

- `pitlore export-public <id>` 只接受 `approved` Lesson；candidate、rejected、deprecated
  都会被拒绝。
- 导出会清空本地路径 scope，并仅保留 `http://` / `https://` 来源引用，避免把本机路径
  或内部文件名带入公共内容。
- secret/PII/过大内容由 `assertPublicSafe` fail-closed 拦截。该命令只打印已清洗 YAML，
  不写公共仓库、不创建发布记录，也不替代人工审核。

## MCP 项目配置可能意外扩大自动批准范围

- **现象**：Codex 配置若把整个 server 或 candidate-aware 工具批量设为 `approve`，headless
  retrieve 可能读取 private candidate，review/remember 也可能写入状态。
- **根因**：MCP server 级别的 read-only 标签不能证明每个工具都是 approved-only；项目配置
  之前没有自动契约回归，后续编辑容易扩大权限范围。
- **修复**：`tests/mcp-config.test.ts` 锁定逐工具分层：retrieve/check/export 为 `approve`，
  remember/review 为 `prompt`；同时确保 Claude stdio 配置的 `env` 为空。
- **回归检查**：`69ebaec` 本地 143/143、typecheck/build、Demo、package smoke 和
  Ubuntu/Windows 全矩阵均成功；配置测试不替代首次真实客户端审批或日常 usefulness 证据。

## 检索正文的单复数词形可能造成漏召回

- **现象**：已批准 `http-no-timeout` 对 `bounded timeout request` 这类任务未命中，但
  `HTTP request timeout` 可以命中；差异来自 Lesson 正文的 `timeouts`/`requests` 复数形式。
- **根因**：正文 token 之前只做精确字符串相等比较；相关性 coverage floor 会把词形差异
  当作完全未命中。
- **修复**：正文 token 只增加受限的 `s`/`ies` 词形 key 比较；tag、ecosystem、path
  scope 和 60% coverage floor 保持原语义，避免用宽泛 substring 换召回。
- **回归检查**：`tests/store-retrieve-check.test.ts` 覆盖相关任务和 `status classes` 防误报；
  `650e287` 本地 141/141 与 Ubuntu/Windows 全矩阵均通过。

- PitLore 不会根据 PID 自动删除疑似 stale lock，避免并发恢复误删另一个活跃进程的新锁。
- 按错误中的 lock 路径读取 PID，先用系统工具确认该进程已经退出，再手工删除对应 lock；
  不能只依据文件年龄判断。若进程仍在，等待或终止原操作，不要绕过互斥。

## npm Git dependency 可能安装成功却没有 CLI

- **发生时间**：2026-07-27，公开仓库匿名安装与发行链路审计。
- **现象**：`npm install git+https://github.com/...` 返回 0 并显示已安装依赖，但消费端
  没有 `node_modules/pitlore/dist/cli.js`，也没有 `.bin/pitlore`；真正执行 CLI 才返回
  command not found。把同一 Git dependency 直接做全局临时 prefix 安装，在当前 npm 10
  环境还可能让构建依赖落到错误 prefix，因此不能从项目本地成功外推全局 Git 安装。
- **根因**：`dist/` 正确地保持 Git ignored，但包此前只有 `prepack`；真实 Git dependency
  生命周期没有生成发行目录。测试只覆盖源码树 `npm pack`，且把 npm 零退出码误当成可用
  CLI 证据。
- **修复**：用 `prepare` 构建 Git dependency，项目本地安装后直接断言真实 bin、
  package/CLI/MCP version 和 help；Git 路径明确不支持 `--ignore-scripts`，也不承诺全局
  安装。全局安装由已经包含 `dist/` 的 tarball/未来 registry 包承担。
- **回归检查**：`npm run test:git-install` 从不含 `dist/` 的临时 Git 仓安装到空 consumer；
  `npm run test:package` 让 tarball 在 `--ignore-scripts` 下完成项目本地与全局安装，并验证
  CLI/MCP/init/retrieve/check。CI 只生成一个 tarball，由 Ubuntu、macOS、Windows consumer
  验证同一文件；提交后的公开 Actions 结果仍必须复核。

## ignored `dist/` 的旧输出可能进入新 npm 包

- **发生时间**：2026-07-27，发行包对抗式审计。
- **现象**：在 `dist/` 预放已不再对应任何 source 的旧 JavaScript 后运行原有 build，
  文件仍然存在，随后的 `npm pack` 也把它纳入 tarball。Git 工作树仍可显示 clean，
  因为 `dist/` 本来就应当 ignored。
- **根因**：`tsc` 只写当前输出，不删除已移除 source 对应的旧文件；package `files`
  又正确地包含整个 `dist/`，所以“重新编译成功”不等于发行目录干净。
- **修复**：build 先运行 `scripts/clean-dist.mjs`，只允许删除解析后的仓库直属 `dist`
  路径，再执行 TypeScript 和 MCP bundle；Git install smoke 还明确拒绝任何预带 `dist`
  的 source fixture，避免 `prepare` 失效时借旧产物蒙混通过。
- **回归检查**：故意写入的旧输出在 build 后不存在；package/Git install smoke 与
  `npm publish --dry-run --json` 均通过。

## 外层 npm publish 配置会污染嵌套 smoke

- **发生时间**：2026-07-27，仓库根发布演练。
- **现象**：`npm publish --dry-run --json` 的 `prepublishOnly` 进入 package smoke 后，
  内层 `npm pack --silent` 返回 JSON；脚本把最后一行 `]` 当成 tgz 文件名并报 `ENOENT`。
  只修 JSON 解析仍会留下更危险的 dry-run 假阳性：临时 install 可以不执行却返回成功。
- **根因**：npm 会把外层 CLI 配置作为 `npm_config_*` 传给 lifecycle；嵌套 npm 命令
  不能假设自己拥有默认输出和执行语义。
- **修复**：两个 install smoke 的 npm helper 都显式使用
  `--dry-run=false --json=false`。这只影响由脚本创建并最终删除的临时 consumer，不改变
  外层 publish 的 dry-run 边界。
- **回归检查**：仓库根 `npm publish --dry-run --json` 完成 376 tests、typecheck/build、
  tenant Demo、tarball/Git install smoke 后成功返回完整发行 manifest，registry 未改变。

## 新 build helper 没有进入 Docker build stage

- **发生时间**：2026-07-27，新增 clean build 后的 self-host 回归。
- **现象**：主机上的 build、package 和 Git install 全绿，但 fresh Docker image 在
  `npm run build` 报找不到 `/app/scripts/clean-dist.mjs`，PostgreSQL 已 healthy 而应用
  无法启动。
- **根因**：多阶段 Dockerfile 只 allowlist-copy 旧的 bundle helper；新增 build 依赖
  没有同步进入镜像。主机文件系统完整，因此本地 npm 验证无法覆盖该差异。
- **修复**：build stage 同时复制 bundle 与 clean helper，继续保持最小 build context。
- **回归检查**：真实 PostgreSQL 17 self-host smoke 重新完成 001–008 fresh、008→009、
  least privilege、bootstrap token、非空 backup、隔离 exact restore 和 restart。
