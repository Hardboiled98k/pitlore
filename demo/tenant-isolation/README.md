# 多租户查询隔离 Demo

这是一个 Phase 1 本地闭环：团队把“查询租户数据时遗漏 `tenantId`”蒸馏为私有候选 Lesson，先用坏/好样本试跑，再由人审核批准。所有命令都从仓库根目录执行。

## 1. 创建可变的临时 lore

不直接修改仓库里的 Demo 或主仓 `.pitlore`：

```sh
DEMO_LORE="$(mktemp -d)/tenant-isolation-lore"
cp -R demo/tenant-isolation/lore "$DEMO_LORE"
```

## 2. 候选阶段试跑

候选 Lesson 不会被默认检索：

```sh
PITLORE_LORE="$DEMO_LORE" npm run -s pitlore -- retrieve \
  -i "review a multi-tenant project query for missing tenantId" \
  -f demo/tenant-isolation/lore/fixtures/bad/tenant-missing.ts \
  -l typescript
```

预期输出：`No PitLore lessons matched this context.`

人工审核前可以显式带上 `--all` 运行候选检测器：

```sh
PITLORE_LORE="$DEMO_LORE" npm run -s pitlore -- check --all \
  demo/tenant-isolation/lore/fixtures/bad/tenant-missing.ts

PITLORE_LORE="$DEMO_LORE" npm run -s pitlore -- check --all \
  demo/tenant-isolation/lore/fixtures/good/tenant-scoped.ts
```

坏样本预期命中 `tenant-query-requires-tenant-id` 并退出 `2`；好样本预期输出 `No PitLore findings.` 并退出 `0`。

## 3. 人工审核与批准

先查看候选内容、scope、检测正则和好/坏样本，确认没有过度匹配后，再由人执行批准。对 `block` Lesson，`approve` 还会强制运行 `enforcement.fixtures.bad/good`：每个坏样本都必须命中，每个好样本都必须干净。

```sh
PITLORE_LORE="$DEMO_LORE" npm run -s pitlore -- get \
  tenant-query-requires-tenant-id

PITLORE_LORE="$DEMO_LORE" npm run -s pitlore -- approve \
  tenant-query-requires-tenant-id
```

`approve` 只改动第 1 步创建的临时副本，不会自动批准主仓 `.pitlore` 中的任何 Lesson。

## 4. 批准后的默认闭环

```sh
PITLORE_LORE="$DEMO_LORE" npm run -s pitlore -- retrieve \
  -i "review a multi-tenant project query for missing tenantId" \
  -f demo/tenant-isolation/lore/fixtures/bad/tenant-missing.ts \
  -l typescript

PITLORE_LORE="$DEMO_LORE" npm run -s pitlore -- check \
  demo/tenant-isolation/lore/fixtures/bad/tenant-missing.ts

PITLORE_LORE="$DEMO_LORE" npm run -s pitlore -- check \
  demo/tenant-isolation/lore/fixtures/good/tenant-scoped.ts
```

批准后，默认 `retrieve` 会返回该 Lesson，默认 `check` 会拦截坏样本并放行好样本。

> 这个 MVP 检测器是面向演示代码形态的启发式正则，不是 TypeScript AST 安全证明。真实仓库应把 scope 缩小到指定 repository 目录，并用集成测试验证跨租户查询被拒绝。
