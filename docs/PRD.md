# PRD：PitLore（可执行踩坑知识库 / Coding Agent 负向经验库）

| 字段     | 内容                                                         |
| -------- | ------------------------------------------------------------ |
| 状态     | Draft                                                        |
| 版本     | 0.4                                                          |
| 日期     | 2026-07-27                                                   |
| 来源     | Coding-agent 工程经验沉淀需求；当前为独立开源产品            |
| 产品方向 | Open-source Developer Tools                                  |
| 工作名   | **PitLore**（暂定；域名 pitlore.com 意向持有，**暂不购买**） |
| 核心单元 | **Lesson**（单条踩坑经验 / 可执行负向约束）                  |
| 仓库单元 | **Lore**（一组 Lesson 的 debug 仓，可公可私）                |
| 安装单元 | **Pack**（可版本化安装的 lesson 集合）                       |

> 本文保存产品范围和产品质量信号。项目按 D-018 持续公开开发，不设置固定周期
> dogfood 收口；独立安装、跨任务重复使用和人工 evidence 长期记录，但仍不能用工程测试
> 冒充真实采用或生产证据。当前实现/验证事实以
> [`STATUS.md`](./STATUS.md) 为准。

---

## 1. Problem Statement

AI 辅助编程（Codex、Claude Code、Cursor、Gemini CLI、Grok 等）极大加快了写代码速度，但**同类错误会反复出现**：

- 个人/团队修过的 bug，换一次会话、换一个 agent 就「失忆」。
- 经验散落在 git commit、PR review、CI 日志、Sentry、群聊和老人脑袋里，**无法被 agent 稳定消费**。
- 现有手段要么是**软规则**（`AGENTS.md` / `.cursorrules`，易被忽略），要么是**通用静态规则**（Semgrep/CVE，覆盖不全），缺少从「真实修复行为」到「可执行负向约束」的闭环。
- 企业有强烈意愿把踩坑沉淀为**私有财产**，但又不敢把业务细节上传到公有云；社区则需要可共享的**语言/框架级**通用陷阱库。

从用户视角：

> 我希望每一次修 bug 的代价，都能变成以后所有 coding agent 的「疫苗」——
> 本地/团队私有沉淀，也可选择脱敏开源；写代码时自动引以为戒，能挡的硬挡。

---

## 2. Solution

**PitLore** 是一个面向 coding agent 的 **可执行踩坑知识库（Lore Registry）**：

1. **采集**修 bug / 失败 / review 中的信号（不强制上传源码）。
2. **蒸馏**为结构化 **Lesson**（症状、根因抽象、禁止模式、推荐模式、作用域、可选检测器）。
3. **存储与协作**类似 GitHub：每人/每团队可有 lore 仓，**可私有可开源**。
4. **分发**类似 npm：以 **Pack** 版本化安装，本地 / 内网 / 公网 registry。
5. **运行时**通过 MCP / Plugin / CLI / CI，被 Codex、Claude、Cursor 等**统一消费**。
6. **硬化**优先：能写成测试或 lint 的，不只依赖 prompt 提醒。

一句话定位：

> 给 coding agent 用的「负向 npm + 私有 GitHub」——
> **把踩过的坑变成可安装的 lore**，而不是又一篇 wiki。

类比：

| 已有概念                      | PitLore 对应                                            |
| ----------------------------- | ------------------------------------------------------- |
| OpenClaw / Agent 记忆胶囊     | 能力与记忆可分发 → 我们分发的是 **踩坑 lore 包**        |
| GitHub repo public/private    | Lore 仓可公可私                                         |
| npm / 私有 registry           | Pack 版本安装与组织源                                   |
| CVE / Semgrep registry        | 安全/模式规则 → 扩展到日常逻辑坑 + agent 注入           |
| AGENTS.md                     | 由 Lesson **生成/同步** 的软层，不是唯一真相            |
| 原工作名 NeverAgain / Capsule | 已弃用主品牌（Capsule.ai 等冲突）；语义保留在产品能力中 |

---

## 3. Goals & Non-Goals

### 3.1 Goals

- 将「修 bug 的行为与结论」沉淀为**可版本化、可检索、可执行**的 Lesson。
- 支持 **本地优先** 与 **企业自托管**，私有财产不离开控制范围。
- 支持可选的 **公共贡献网络**（类 GitHub），只共享脱敏后的 L1/L2 抽象。
- 一次沉淀，**多个 coding agent** 共用（不绑死单一模型厂商）。
- 明确 **软约束（提示）+ 硬约束（检测/测试/CI）** 双轨，降低复发率。
- 提供可演示、可安装、可持续开源维护的 Developer Tools 产品。
- 品牌与域名：**暂定 PitLore**；在验证需求前 **不购买域名**，以 GitHub 仓库名 + 本地 CLI 为准。

### 3.2 Non-Goals（本期明确不做）

- 不声称能检测或禁止「所有错误」；目标是**已知模式降频**，不是永生免疫。
- 不训练/微调基座大模型权重；只做 **运行时外挂**（检索、注入、门禁）。
- 不做完整社交网络（动态、关注链）；协作以 Git/PR/权限为主。
- 不自动公开任何私有仓内容；公开必须经 **显式脱敏 + 确认**。
- 不替代完整 APM/Sentry；可集成信号，不重建观测平台。
- 不在 MVP 做全语言完美解析器；检测器可插拔、可空。

---

## 4. Personas & User Stories

### 4.1 Personas

| 角色              | 诉求                                       |
| ----------------- | ------------------------------------------ |
| 个人开发者        | 自己的坑别再犯；多工具（Codex/Claude）同步 |
| 团队 Tech Lead    | 把团队事故沉淀成强制门禁；新人少踩雷       |
| 平台/效能工程     | 内网部署、SSO、审计、与 CI 集成            |
| 开源贡献者        | 贡献通用语言/框架陷阱，建立信誉            |
| 开源试用者        | 2 分钟装上，演示「诱导犯错 → 拦截」        |

### 4.2 User Stories

1. 作为个人开发者，我希望把一次修 bug 的结论存成 Lesson，以便下次任意 agent 写相关代码时被提醒。
2. 作为个人开发者，我希望 Lesson 只描述错误类型与抽象模式、不含业务源码，以便可以放心开源部分内容。
3. 作为个人开发者，我希望用 Git 管理自己的 lore 仓，以便版本回溯与备份。
4. 作为团队成员，我希望订阅组织的私有 Pack 源，以便和同事共用同一套「宪法」。
5. 作为 Tech Lead，我希望高危 Lesson 必须进入 CI，以便 LLM 忽略提示时仍被拦住。
6. 作为 Tech Lead，我希望 lesson 有候选/批准状态，以便避免一人误写规则误伤全组。
7. 作为平台工程师，我希望 Docker 一键自托管 Registry，以便数据不出内网。
8. 作为平台工程师，我希望有 SSO 与审计日志，以便满足合规。
9. 作为使用 Codex 的开发者，我希望通过 MCP/Plugin 自动 `retrieve` 相关 Lesson，以便无需手动翻文档。
10. 作为使用 Claude/Cursor 的开发者，我希望同一套 Lore 能同步为 rules/skill 片段，以便不绑死 Codex。
11. 作为开发者，我希望写到某路径/技术栈时只注入 Top-K 相关条目，以便不污染上下文窗口。
12. 作为开发者，我希望 agent 在 edit 后能跑 `pitlore_check`，以便即时发现踩雷。
13. 作为开发者，我希望一条 Lesson 能附带「建议测试/检测规则」草稿，以便硬化约束。
14. 作为贡献者，我希望从私有 lesson 一键脱敏再 publish 到公共源，以便分享通用经验且不泄密。
15. 作为公共库使用者，我希望按语言/框架/标签搜索 Lesson/Pack，以便安装所需子集。
16. 作为公共库使用者，我希望看到来源数量、置信度与信誉，以便判断是否采纳。
17. 作为维护者，我希望 Pack/Lesson 支持 semver，以便规则变严时下游可知 breaking。
18. 作为新人，我希望浏览团队「我们踩过的坑」站点/目录，以便 onboarding。
19. 作为 agent 会话，我希望在任务开始时根据 intent + 文件列表拉取 Lesson，以便开写前对齐红线。
20. 作为开源试用者，我希望有演示脚本：诱导经典坏模式 → 命中 Lesson → 改写为安全模式，以便 3 分钟看懂价值。
21. 作为企业客户，我希望空气间隙离线可用，以便无外网环境仍能检索本地索引。
22. 作为开源作者，我希望我的 lore 仓可 public 可 private，体验类似 GitHub。
23. 作为系统，我希望拒绝含密钥/PII/明显业务标识的公开提交，以便降低泄露与投毒风险。
24. 作为系统，我希望恶意/错误 Lesson 可撤销与降权，以便治理生态。

---

## 5. Product Concepts

### 5.0 品牌与命名（暂定）

| 用语        | 含义                                  |
| ----------- | ------------------------------------- |
| **PitLore** | 产品名（pit + lore：踩坑传说/知识）   |
| **Lesson**  | 单条可执行负向经验（原 Capsule 概念） |
| **Lore**    | 一个 Git 仓/知识集，内含多条 Lesson   |
| **Pack**    | 可安装、带版本的发布单元              |
| **pitlore** | CLI / MCP 服务命令名                  |

**域名策略：** 意向 `pitlore.com`（及可选 `.dev`），**在项目验证前不购买**。早期开源开发使用 GitHub repo 名、本地 package 名即可；对外链接用 GitHub Pages 或临时预览域名。

**Tagline（草案）：** _The lore of pits your agents must not fall into again._

### 5.1 Lesson（单条踩坑经验）

一条可独立版本化的 **负向经验单元**，描述「不要再这样」，而非大段业务代码。

**公开层抽象级别：**

| 级别 | 内容                                    | 默认可公开     |
| ---- | --------------------------------------- | -------------- |
| L1   | 语言陷阱（如 `forEach` + `async`）      | 是             |
| L2   | 框架/生态陷阱（React stale closure 等） | 是             |
| L3   | 业务/组织特定约束                       | **否**（私有） |

### 5.2 Lore Repo（踩坑知识仓库）

一组 Lesson 的集合，类 Git 仓库：

- 可见性：`private` | `public`
- 归属：user / org
- 可依赖其他 lore（组合安装为 Pack）

### 5.3 Registry（注册中心）

- **Local**：文件系统 + Git
- **Team**：自托管服务
- **Public**：可选 SaaS / 社区站（域名成熟后再挂 pitlore.com）

### 5.4 Enforcement 级别

| 级别    | 行为                       |
| ------- | -------------------------- |
| `info`  | 仅提示 / 注入 prompt       |
| `warn`  | 提示 + agent 需确认        |
| `block` | CI/hook 失败；禁止宣称完成 |

### 5.5 双轨执行

```text
软轨道：检索 → 注入 system/skill/AGENTS 片段
硬轨道：声明式 patterns + bad/good fixtures → `pitlore check` / CI / agent hook
```

原则：**故事给人看，测试与规则给机器挡。**

---

## 6. Implementation Decisions

### 6.1 系统模块（Deep Modules）

| 模块             | 职责                               | 对外接口（概念）                   |
| ---------------- | ---------------------------------- | ---------------------------------- |
| **Schema**       | Lesson/Lore 规范化、校验、迁移     | `validate(lesson) -> Result`       |
| **Store**        | 本地/远端读写、索引                | `put` / `get` / `list` / `search`  |
| **Distill**      | 从 fix 信号生成候选 Lesson（LLM）  | `distill(signal) -> LessonDraft`   |
| **Sanitize**     | 公开前脱敏                         | `sanitize(private) -> PublicDraft` |
| **Retrieve**     | 按文件路径/语言/intent 取 Top-K    | `retrieve(context, k) -> Lesson[]` |
| **Enforce**      | 运行检测器、汇总命中               | `check(diff_or_paths) -> Findings` |
| **Sync**         | 导出到 AGENTS/rules/skill 片段     | `export(agent_target) -> files`    |
| **Registry API** | HTTP 安装/发布/搜索（Team/Public） | REST/JSON                          |
| **MCP Server**   | 给各 coding agent 的统一工具面     | MCP tools                          |
| **CLI**          | 开发者日常入口                     | `pitlore` 命令                     |
| **Web（可选）**  | 浏览、搜索、PR 式贡献              | 只读 + 轻贡献；正式域名后置        |

### 6.2 Lesson Schema（最小字段）

```yaml
id: string # 稳定 ID，如 js-async-foreach-await-miss
version: semver
title: string
languages: [string]
ecosystems: [string] # node, react, next, go-std...
category: string # concurrency | security | api | data...
symptom: string # 现象
root_cause: string # 抽象根因（无业务细节）
forbid_pattern_abstract: string
safe_pattern_abstract: string
scope:
  paths: [string] # glob，可选
  confidence_min: number
severity: info | warn | block
confidence: number # 0~1
sources:
  count: number # 支撑次数（可聚合）
  references: [string] # PR/issue/链接，可脱敏
enforcement:
  test_idea: string | null
  detector_ref: null # 0.1.0 保留字段；不执行任意 detector code
  patterns: [string] # 有界声明式 regex
  fixtures:
    bad: [relative-path]
    good: [relative-path]
tags: [string]
status: candidate | approved | rejected | deprecated
visibility: private | public
created_at: iso8601
updated_at: iso8601
```

**禁止进入 public Lesson 的内容：** 完整业务源码、内部主机名、密钥、PII、未脱敏路径与客户名。

### 6.3 仓库布局（约定）

```text
my-lore/
  manifest.yaml           # name: org/my-lore, visibility, ...
  lessons/*.yaml
  fixtures/...            # 仅限 Lesson 显式引用的 bad/good fixture
  README.md               # 可选
  CHANGELOG.md            # 可选
  LICENSE                 # public Pack 必填：非空 UTF-8；private Pack 可选
  SIGNATURE.json          # 可选 Ed25519 签名
```

仓库代码、文档与官方 public Lesson/Pack 内容统一采用 Apache-2.0；每个官方 Pack
携带完整 `LICENSE`，脱离主仓、进入缓存/Registry/air-gap 后仍自包含。第三方 public Pack
可自行选择内容许可，但必须在自身 `LICENSE` 中明确；PitLore 只验证文件边界，不替发布者
判断其许可是否合法或与来源权利相符。

本地全局目录约定：`~/.pitlore/`（index、已安装 packs）；项目内可选 `.pitlore/`。

### 6.4 MCP Tools（Agent 接口）

| Tool                    | 说明                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| `pitlore_search`        | 语义/标签搜索                                                             |
| `pitlore_retrieve`      | 按当前任务上下文取 Top-K                                                  |
| `pitlore_get`           | 取单条详情                                                                |
| `pitlore_check`         | 对给定 diff/路径跑命中                                                    |
| `pitlore_remember`      | 从自然语言/会话标记创建 candidate                                         |
| `pitlore_review`        | 获取 untrusted candidate 审核包或记录结构化 LLM 建议；不能 approve/reject |
| `pitlore_export_prompt` | 生成可注入的短约束文本                                                    |

### 6.5 CLI（开发者接口）

当前 `0.1.1` 已实现的命令族：

```text
pitlore init [--path <team-lore>]
pitlore add <file>
pitlore distill -d <description>
pitlore review <id> [--input <review.json>]
pitlore review-queue [--json]
pitlore approve <id>
pitlore reject <id>
pitlore deprecate <id>
pitlore evidence record --input <observation.json|->
pitlore evidence summary [--catalog all|current|<sha256>] [--json]
pitlore signal ingest|ci|sentry ...
pitlore search [query]
pitlore get <id>
pitlore retrieve -i <intent> [-f <file> ...]
pitlore check <file>
pitlore export-public <id>
pitlore install <local-path|https-git-url> [--ref <ref>] [--subdir <path>]
pitlore uninstall <pack-name>
pitlore pack verify|sign|list|verify-installed ...
pitlore pack artifact export|verify|install ...
pitlore pack artifact bundle-export|bundle-verify|bundle-install ...
pitlore registry search|create-package|provision-member|publish|install|sync ...
pitlore registry approve|reject|yank|report-usage ...
pitlore registry migrate|bootstrap|bootstrap-token|serve ...
pitlore export-agents
pitlore serve
pitlore path
```

原草案中的 `install` 与 Registry publish 生命周期已有上述具体命令。`registry up`
从未成为 CLI：源码开发使用 `pitlore registry serve`，完整自托管使用
`docker compose up -d --build --wait`。npm publish 与公共托管部署仍未发生。

### 6.6 部署模式

| 阶段                      | 数据位置                                            | 适用                       |
| ------------------------- | --------------------------------------------------- | -------------------------- |
| **Phase 1：Local**        | `~/.pitlore/` 或仓内 `.pitlore/` + 私有 Git         | 个人、本地团队、本地闭环   |
| **Phase 2：Open Sharing** | Git/GitHub 上的公开 Lore/Pack                       | 开源社区共享与协作         |
| **Phase 3：Web Platform** | 当前为 PostgreSQL 自托管 baseline；托管 SaaS 仍外部 | 搜索、权限、审计与商业化   |

三个阶段坚持 **同一 Schema、同一 CLI/MCP**。Phase 1 不依赖服务端；Phase 2 先复用 Git 托管；只有 Phase 3 才引入网站和托管 Registry。

### 6.7 多 Agent 适配策略

- **真相源**：Lore Repo / Registry
- **适配层**：export 为 Codex skill、Claude 规则、Cursor rules、通用 AGENTS 片段
- **硬执行**：CI Action / pre-commit / agent hook，与厂商无关

### 6.8 蒸馏与治理

- 默认写入 **`candidate`**；只有人工执行独立的 **`approve`** 才能进入强制集，或执行
  **`reject`** 保留不可消费的审计 tombstone。智能体生成/审核链路不能自行改变这两种终态。
- LLM review 写独立 sidecar，只提供 accept/edit/reject 建议；hash 绑定 candidate、fixtures、approved catalog 与 rubric，stale review 不能冒充当前结果。
- retrieve/check/export 只自动消费 `approved`；显式 candidate 模式也永不包含 `rejected`。
- 只有 `approved` 可经人工 `deprecate` 退役；candidate 应 approve/reject，终态不可借普通 put 复活。
- 公共提交：`Sanitize` 强制流水线 + 规则扫描（密钥/PII）+ 可人工审核。
- 信誉：来源次数、安装量、误报反馈（后续）。
- Phase 1 dogfood 原始证据写入 ignored、append-only 的本地
  `.pitlore/evidence/events.jsonl`；只允许显式 CLI 记录人的判断，不让 retrieve/check
  自动写盘，也不提供 MCP evidence 写工具。
- retrieve/check 响应携带当次 approved catalog hash；评价事件必须回传
  `observed_catalog_hash`，record 时若目录已变化则拒绝混记，避免把新批准 Lesson
  错算为历史 missed-existing。
- 检索评价区分已存在 approved Lesson 的 `missed_existing` 与知识库尚无相关 Lesson 的
  `coverage_gap`；`used` 包含改变、阻止或有效确认方案的相关 Lesson，检索指标是人工
  utility/relevance proxy；detector 分别计算 precision 与 recall，不把 clean scan
  自动记为 TN。

### 6.9 技术选型倾向（实现阶段可调）

| 层        | 倾向                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------- |
| 语言      | TypeScript（CLI + MCP + API 统一）                                                                   |
| 本地索引  | Phase 1 直接读 YAML 文件；规模验证后再评估 SQLite/embedding                                          |
| Team 服务 | Phase 1 不依赖服务；当前已有 Phase 3 Node/PostgreSQL 自托管 baseline；托管 SaaS/对象存储仍待真实需求 |
| LLM       | GPT-5.6 / 用户配置的 API（蒸馏与检索重排）                                                           |
| 打包      | Git/npm tarball；`pitlore@0.1.1` 已发布到 npm；Docker 发布 registry                                 |

### 6.10 公开开源开发方向

- 项目围绕 **Codex + GPT-5.6** 和 Developer Tools / Plugin + MCP 形态开发。
- 安装说明、Demo、架构文档和发行门禁全部服务于独立开源用户。
- 是否扩展 Registry 托管、商业化或生态集成，服从真实用户需求与生产证据。

---

## 7. Core User Flows

### 7.1 沉淀（Write path）

```text
修完 bug / CI 变绿 / 会话标记 fixed
  → distill 生成 candidate Lesson
  → 人审 approve
  → 写入私有 lore repo（Git）
  → （可选）sanitize → publish public pack
```

### 7.2 消费（Read path）

```text
开始 coding 任务
  → MCP pitlore_retrieve(intent, files, lang)
  → 注入 Top-K 软约束
  → agent 编写
  → pitlore_check(diff) / CI detectors
  → 命中 block → 阻止完成并提示 safe pattern
```

### 7.3 团队分发

```text
Org 维护普通 private Git lore repo
  → 成员 clone/pull 到本地
  → PITLORE_LORE 指向本地 checkout
  → Codex/Claude 通过各自本地 MCP 消费同一版本
```

Phase 1 不引入 PitLore 私有服务；托管组织空间属于 Phase 3。

### 7.4 类 GitHub 协作

Phase 2 才开放公共协作：

```text
Fork / PR 改进某条 lesson
  → review 合并
  → semver bump
  → 依赖方更新
```

---

## 8. Scope Phasing

### 8.1 Phase 1：本地个人 / 团队可用（产品质量信号仍在积累）

**目标：** 不依赖网站或托管服务，让个人与小团队在本地完成：

```text
真实 fix → candidate Lesson → LLM advisory review → 人工 approve → 编码前 retrieve → 编码后 check
                                                └→ 人工 reject → 审计 tombstone
```

**必须有：**

1. Lesson YAML schema、治理字段和 detector 校验。
2. 本地 lore repo；团队通过普通私有 Git 仓共享，不引入 PitLore 服务端。
3. CLI：`init` / `distill` / `review` / `review-queue` / `approve` / `reject` / `deprecate` / `search` / `retrieve` / `check` / `evidence` / `serve`。
4. MCP：读取工具 + candidate remember + advisory review；不暴露生命周期迁移，agent 不能绕过人工决策。
5. `distill` 只接收用户显式选择的错误描述 / 修复摘要，默认 private。
6. 路径 scope、相关性阈值、非法 detector fail-closed。
7. 声明式 detector 的 bad/good fixtures；新规则默认 warn，通过人工审批与测试后才可 block。
8. 一个代码库特定的 Demo（例如多租户查询遗漏 `tenantId`），展示完整闭环。
9. 可复现 Git/npm tarball 安装、CI、英文 README 与 5 分钟上手路径。

**Phase 1 范围明确不依赖：** SQLite/embedding、公共 Registry、网站、SSO/RBAC、计费、
任意代码 detector、自动扫描全部 Git 历史。D-014 允许这些后续层的工程提前开发，但
它们不能反向替代真实使用和人工效用证据。

**长期产品质量信号：**

- 新用户 5 分钟内跑通本地闭环。
- 从一次真实 fix 到 approved Lesson 小于 2 分钟。
- block detector 必须具备 bad/good fixtures，且默认无阻断级误报。
- 至少一个独立外部用户完成安装，并在多个真实任务中重复使用。
- 真实样本的 retrieve usefulness、missed-existing/coverage-gap、detector TP/FP/FN
  口径可重复汇总；分母不足时保持未知，不以 100% 代替证据。

按 D-018，以上信号用于衡量真实产品价值，不作为源码开源、日常开发或版本发布的
前置条件。工程测试不能代替这些信号，缺少样本时必须继续标为未知。

### 8.2 Phase 2：开源共享

**目标：** 在不建设网站的前提下，让社区安全地发布、安装和协作维护公开 Lore/Pack。

- 从本地私有 Lesson 显式 sanitize/export 为 public candidate。
- `pitlore install <git-url|local-path>`、lockfile、校验和、semver 与依赖解析。
- GitHub 仓库即远端；通过 PR 完成人审、版本和变更记录。
- 官方维护 3～5 个高质量 Packs，解决冷启动。
- 发布者来源、签名/校验、秘密扫描、prompt-injection 扫描。
- Detector 仅允许声明式格式，禁止 Pack 携带任意 shell/JS 执行。
- 社区贡献规范、撤销/deprecated、兼容性与误报反馈流程。

**产品质量信号（不阻塞开源/开发）：** Phase 1 核心闭环被真实团队验证，
candidate 人工接受率和 detector precision 达到目标。

**工程状态（2026-07-28）：** public export、Git/local install（含 Git `--subdir`）、
deterministic lock、checksum/cache、SemVer dependency、Ed25519 trust、3 个官方 Pack，
以及单 artifact/完整 air-gap dependency bundle 已实现。public Pack 必须携带非空 UTF-8
`LICENSE`；校验器在解析 YAML 前先执行文件数、单文件、总大小预算，并拒绝中间路径或
最终目标的 symlink/realpath 越界。npm tarball 已包含可独立运行的 bundled MCP stdio
runtime，并有真实 tarball 安装 smoke；Git dependency 通过 `prepare` 从源码生成
`dist`，隔离 consumer 会验证真实 bin/version/help。GitHub 源码仓库、npm `0.1.1`
和对应 GitHub Release 已公开，但独立社区安装、贡献和采用尚无证据。这些外部事实
必须如实披露，但不阻塞继续开源开发。

### 8.3 Phase 3：网站进化

**目标：** 在开源协议和 Pack 生态成立后，再把 Git-first 网络进化为托管产品。

- Web 搜索、浏览、版本对比、安装文档与贡献入口。
- 托管 Registry API、组织空间、public/private Lore。
- RBAC、SSO、审计日志、发布审批和供应链治理。
- 安装量、命中率、误报率、信誉和撤销传播。
- 企业自托管、空气间隙分发、Sentry/CI 信号接入。
- 用量/席位计费与商业支持（仅在真实付费需求成立后）。

**产品化触发信号（不阻塞本地工程）：** 开源 Pack 有持续安装/贡献，且团队明确提出
托管、权限或审计需求；网站应服务真实用户需求，而不是活动展示壳。

**工程状态（2026-07-27）：** Fastify/Web、PostgreSQL、organizations/RBAC、issuer-bound
OIDC JWT verification、tokens/audit、public/private releases、usage/entitlement boundaries、air-gap
和 Docker Compose 自托管 engineering baseline 已实现。public 与 tenant collections 均使用
绑定查询/组织边界的 opaque cursor；9 个有序 migration 中，`006` 收紧 public release RLS，
`007` 在数据库层强制 append-only / release lifecycle / 双人审批完整性，`008` 使用持久化
SemVer sort key 和索引执行 keyset pagination，`009` 增加 artifact-derived、
append-only/RLS discovery snapshot 与 normalized facet 索引。浏览器登录使用
`HttpOnly`/`Secure` `__Host-` session cookie、session-bound CSRF 与 protected-response
`no-store`，每次请求按 provider、issuer、subject 重新解析当前 active user / membership /
role。public read、browser auth、billing webhook、protected API auth 和 release upload
之外，双 artifact semantic diff 使用第 6 个独立限流预算；
普通 JSON、webhook、整体大请求
分别有 64 KiB、256 KiB、30 MiB body cap，转发头只在显式可信代理 allow-list 下生效。

公开 Web/API 的版本对比会完整复验两个 published/yanked artifact，输出仅包含计数、Lesson ID
和变化字段名；不返回 Lesson/manifest 值、fixture 路径或正文。每类详情最多 100 项，diff JSON
最多 128 KiB；Node client 还会把响应身份绑定回请求的 Pack/版本，并使用端点特定的有界流读取。

当前 public search 支持 package name 的大小写不敏感 substring，以及由已验证 artifact
派生的 language/ecosystem/tag facets；reputation 数据与 reputation ranking 尚未实现。
真实 Hosted SaaS、真实 IdP/browser dogfood、支付、live Sentry/CI webhook、生产运维、
合规和外部社区仍未实现或未验证，不能把本地 adapter/测试称为上述生产能力。

---

## 9. Testing Decisions

### 9.1 原则

- 测 **外部行为**：校验、检索排序、权限边界、脱敏结果、check 命中，不测 LLM 文采。
- LLM 蒸馏：用 **固定 fixture + schema 校验**；对模型输出做结构断言，不做全文金句快照。
- 金丝雀坏代码样本：`fixtures/bad/*` vs `fixtures/good/*` 保证 detector/check 稳定。

**当前工程快照（2026-07-28）：** `npm test` 为 377 项自动化测试；独立
`npm run test:self-host` 覆盖 9 个 migration 的 fresh/upgrade、least-privilege、
backup/restore 和 restart；发行 CI 已配置为让 Ubuntu、macOS、Windows consumer 安装
同一 npm tarball，并单独验证 Git dependency 构建，提交后的 public Actions 仍需复核。
这些都是工程回归证据，不等于真实 IdP、支付、公开托管或社区采用证据。

### 9.2 MVP 必测模块

| 模块          | 测什么                                                                                |
| ------------- | ------------------------------------------------------------------------------------- |
| Schema        | 合法/非法 Lesson YAML、必填字段、visibility 约束                                      |
| Store         | candidate-only put、approve/reject 状态机、幂等、终态防覆盖与 symlink 边界            |
| Retrieve      | scope/path 匹配、Top-K、默认只返回 approved，candidate 模式仍排除 rejected/deprecated |
| Enforce/check | 种子坏样本命中、好样本不误报，`--all` 仍排除 rejected/deprecated                      |
| Sanitize      | 剥离模拟密钥/内部主机名                                                               |
| CLI 烟测      | pitlore init → distill/add → approve/reject → search → retrieve → check               |

### 9.3 暂缓

- 全量 E2E 接真 Codex UI（用 MCP 协议级测试代替）
- 公共审核后台 UI

---

## 10. Security, Privacy & Trust

| 风险             | 缓解                                                        |
| ---------------- | ----------------------------------------------------------- |
| 源码/业务泄露    | 默认 private；public 强制 sanitize；schema 禁止大段代码字段 |
| 投毒 Lesson      | 签名/来源、审核、revoke、企业仅信任自有源                   |
| 密钥进仓         | 提交钩子扫描；CI 拒绝                                       |
| 软约束被忽略     | block 级必须硬检测或 CI                                     |
| 规则误伤         | candidate 默认、semver、可 deprecated                       |
| 合规审计         | Team 版操作日志（v1+）                                      |
| 过早品牌沉没成本 | **不买域名**直至有真实用量；GitHub/npm 名可迁移             |

信任模型：

- **本地/团队源**：默认高信任。
- **公共源**：按信誉与审核策略；企业可禁用公共源。

---

## 11. Success Metrics

### 11.1 产品指标（上线后）

| 指标                             | 说明                                                              |
| -------------------------------- | ----------------------------------------------------------------- |
| Pack/Lesson 安装/订阅数          | 网络效应                                                          |
| Retrieve 调用次数                | agent 真实接入                                                    |
| Check 命中率 & 误报反馈          | 质量                                                              |
| 复发间隔（同类 lesson 再次出现） | 核心价值（需埋点/志愿上报）                                       |
| 私有仓 vs 公共仓占比             | 是否打中企业财产场景                                              |
| 域名购买触发                     | 例如：连续 4 周周活 agent 接入 > N，或出现第二团队付费/自托管意向 |

### 11.2 开源 onboarding / Demo 质量标准

以下内容用于约束公开用户第一次体验和可验证 Demo：

1. 试用者按 README **&lt; 5 分钟** 跑通 MCP + 一次 retrieve。
2. Demo 中 **可见**「坏模式 → 命中 Lesson → 安全改写」。
3. 讲清：**本地私有财产** 与 **GitHub 公/私 Pack** 路线。
4. 如制作公开演示材料，应准确说明 Codex + GPT-5.6、repo 和验证边界。

---

## 12. Out of Scope（复述边界）

- 基座模型 fine-tune / RL 训练管线
- 自动保证 100% 不再犯错
- 重做通用文档 Wiki/Notion
- 完整 GitHub 社交与 Impostor 级代码托管（可用真 Git 承载内容）
- 法律意义上的自动合规认证

---

## 13. Open Questions

1. ~~品牌最终名~~ → **暂定 PitLore**；是否永久采用待验证后再定。
2. 本地真相源：纯 Git 是否足够，还是 MVP 就上 SQLite index？
3. 蒸馏输入默认接受「脱敏 diff」还是「纯自然语言描述」优先？
4. ~~首个 npm 版本与 GitHub Release 何时发布~~ → **`v0.1.1` 已于 2026-07-28
   发布**；后续稳定版本节奏继续由真实修复、采用反馈和工程门禁决定。

---

## 14. Further Notes

### 14.1 战略叙事

- **个人**：第二大脑里的「踩坑 lore」。
- **团队**：可审计、可执行的工程宪法。
- **生态**：跨 Claude / Codex / Gemini / Grok 的中立层——**模型可换，lore 不丢**。

### 14.2 与前期其他创意的关系

讨论中曾探索 Shame Court、Vibe Dial、Ghost Pair 等；收敛结论：

- 网页沙雕玩具传播强，但与「Codex 使用时不一样」结合弱。
- 当时判断 **PitLore** 直接打在 coding agent 基建缺口上，支持本地私有化与类 GitHub
  贡献，因此收敛为当前独立开源产品方向。

### 14.3 一句话 PRD 摘要

> 构建本地优先、可自托管、可选公开贡献的 **PitLore**：
> 把修 bug 的经验变成跨 agent 可安装的踩坑 lore；
> 软提示 + 硬检测双轨，让组织与社区少付第二次学费。
> 品牌暂定、域名后置——先做能用的本地 CLI/MCP。

---

## 15. Approval

| 角色       | 姓名 | 日期 | 结论 |
| ---------- | ---- | ---- | ---- |
| 发起人     |      |      |      |
| 实现负责人 |      |      |      |
| 评审       |      |      |      |

---

_本文档为讨论收敛稿（v0.2，品牌暂定 PitLore），确认后可作为实现与拆任务（to-issues）的唯一需求源。_
