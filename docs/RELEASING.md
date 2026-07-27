# PitLore 发行手册

本手册用于维护者发布 CLI/npm artifact。源码公开、CI 全绿和本地 smoke 都不等于已经
授权创建 tag、GitHub Release 或 npm publication。

## 1. 发行前提

- 从 public `main` 的干净工作树发行，并确认对应 GitHub Actions 全绿。
- Node.js 22+、Git、npm 官方 registry 可达；consumer CI 同时覆盖 Node.js 22/24 LTS。
- npm package owner 已开启 2FA，并优先配置 GitHub Actions trusted publishing。
- Trusted publishing 的版本和 OIDC 要求以
  [npm 官方文档](https://docs.npmjs.com/trusted-publishers/) 为准。
- 不把 npm token、OIDC 凭据、签名私钥或本地 `.npmrc` 提交到仓库。
- `CHANGELOG.md` 已把本次用户可见变化从 `Unreleased` 移到目标版本。

版本号的发行真相源是 `package.json`。CLI 与 MCP server 运行时从该 manifest 读取版本；
Lesson、Pack、evidence 或 Registry API 中独立出现的 `0.1.0` 不是 npm package 版本。

## 2. 本地发行候选

先设置目标版本；如果 `package.json` 已经是该版本，跳过 `npm version`。需要更新时不要
自动创建 tag：

```bash
PITLORE_RELEASE_VERSION=0.1.0
PITLORE_CURRENT_VERSION=$(node -p "require('./package.json').version")
if [ "$PITLORE_CURRENT_VERSION" != "$PITLORE_RELEASE_VERSION" ]; then
  npm version "$PITLORE_RELEASE_VERSION" --no-git-tag-version
fi
npm ci --ignore-scripts
npm run verify
npm run demo:tenant
npm run test:git-install
```

然后只生成一个候选 tarball，并测试同一文件：

```bash
mkdir -p release-artifact
npm pack --pack-destination release-artifact --silent
PITLORE_RELEASE_ARCHIVE="release-artifact/pitlore-$PITLORE_RELEASE_VERSION.tgz"
npm run test:package -- "$PITLORE_RELEASE_ARCHIVE"
shasum -a 256 "$PITLORE_RELEASE_ARCHIVE"
npm publish "$PITLORE_RELEASE_ARCHIVE" \
  --dry-run \
  --access public \
  --registry=https://registry.npmjs.org
```

`npm pack` 会执行 `prepare`。不要用 fresh clone 上的
`npm pack --ignore-scripts` 作为发行物：`dist/` 不进入 Git，这会生成缺少 CLI 的坏包。
发布已有 `.tgz` 时，tarball 内的 `prepublishOnly`/`prepare` 不会替代上述显式验证。

本地候选至少必须证明：

- `npm run verify`、tenant Demo、Git dependency smoke 全部通过。
- `npm run test:package -- release-artifact` 在消费端以 `--ignore-scripts` 安装成功。
- 同一 tarball 的普通临时 `npm exec --package` 与全局安装都能直接执行 CLI。
- CLI bin、`--version`、`--help`、`init`、retrieve/check、MCP initialize/tools/list 可用。
- `LICENSE`、`THIRD_PARTY_NOTICES.md`、`CHANGELOG.md`、行为准则、
  贡献/安全/支持文档和官方 Packs 均在 tarball 中，产物内 Markdown 相对链接没有断链。
- `npm run verify:lockfile` 证明全部 resolved artifact 只来自允许的 npm 官方 registry；
  MCP bundle 构建同时核对 bundled package 版本和 reviewed notice body SHA-256。
- 压缩包不超过 2 MB，展开后的 tar stream 不超过 10 MB 且不超过 500 个 entry。
- `npm publish ... --dry-run` 不修改 manifest，也不产生 npm 自动修正警告。

## 3. 跨平台与同一 artifact

`.github/workflows/ci.yml` 的 `package-artifact` job 只生成一个 tarball；
`consumer-install` 在 Ubuntu、macOS、Windows 安装并验证该同一 artifact，同时验证
项目本地 Git dependency 的 `prepare` 安装路径。全局安装只由 tarball/registry 路径承担；
不承诺 npm 的全局 Git dependency 生命周期。正式发布必须使用对应成功 run 产生并
核对过的字节产物，不能在 smoke 之后重新 pack。

## 4. 外部发布

Tag、GitHub Release 和 npm publication 都是外部、不可假装回滚的维护者动作。先完成
以下一次性仓库设置：

1. 为 `refs/tags/v*` 配置 active tag ruleset，至少禁止已创建 tag 的更新和删除。
   不要让 release tag 在创建后静默漂移。
2. 创建 GitHub environment `npm-publish`，只允许匹配 `v*` 的 tag deployment。
   单维护者仓库不能同时要求本人 review 并禁止 self-review，否则会形成发布死锁；
   当前以受保护 tag、手动 workflow 和显式 `publish_npm=true` 作为门禁。加入第二位
   可信维护者后，再启用 required reviewer 和 prevent self-review。
3. 等待 public `main` 的 required CI 与 CodeQL 全绿，再创建与 `package.json`
   完全一致的 release tag。

### 4.1 Tag 上的工程演练

从已存在的受保护 tag ref 先运行不改变 registry 的工程演练：

```bash
PITLORE_RELEASE_TAG=v0.1.0
gh workflow run npm-publish.yml \
  --ref "$PITLORE_RELEASE_TAG" \
  -f tag="$PITLORE_RELEASE_TAG" \
  -f publish_npm=false
```

它验证 source、自托管、六种 OS/Node consumer 组合、artifact 身份、SHA-256 和 npm
客户端 dry-run，但不验证 OIDC 授权。成功 run 的 `pitlore-npm-release` artifact 同时
包含唯一 `.tgz` 和 `SHA256SUMS`；正式发布不得重新 pack。

### 4.2 首次 npm package bootstrap

npm 只允许已经存在的 package 配置 trusted publisher。因此包名仍为 E404 时，第一次
发布不能由本项目的 OIDC workflow 自举，也不能用临时 token 静默绕过。维护者必须先
通过官方 registry 的交互式账号登录和 2FA，发布上一步已经验证的同一 artifact：

```bash
PITLORE_RELEASE_RUN_ID=<successful-dry-run-id>
PITLORE_RELEASE_TAG=v0.1.0
PITLORE_RELEASE_VERSION="${PITLORE_RELEASE_TAG#v}"
PITLORE_RELEASE_COMMIT=$(git rev-parse "$PITLORE_RELEASE_TAG^{commit}")
PITLORE_RELEASE_DIR=$(mktemp -d)

test "$(gh run view "$PITLORE_RELEASE_RUN_ID" \
  --json workflowName --jq .workflowName)" = "npm Publish"
test "$(gh run view "$PITLORE_RELEASE_RUN_ID" \
  --json event --jq .event)" = "workflow_dispatch"
test "$(gh run view "$PITLORE_RELEASE_RUN_ID" \
  --json conclusion --jq .conclusion)" = "success"
test "$(gh run view "$PITLORE_RELEASE_RUN_ID" \
  --json headBranch --jq .headBranch)" = "$PITLORE_RELEASE_TAG"
test "$(gh run view "$PITLORE_RELEASE_RUN_ID" \
  --json headSha --jq .headSha)" = "$PITLORE_RELEASE_COMMIT"
gh run view "$PITLORE_RELEASE_RUN_ID" --exit-status >/dev/null
gh run download "$PITLORE_RELEASE_RUN_ID" \
  --name pitlore-npm-release \
  --dir "$PITLORE_RELEASE_DIR"
(cd "$PITLORE_RELEASE_DIR" && shasum -a 256 -c SHA256SUMS)
node scripts/verify-release-artifact.mjs \
  "$PITLORE_RELEASE_DIR" \
  "$PITLORE_RELEASE_TAG" \
  "$PITLORE_RELEASE_VERSION"

npm login --auth-type=web --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm profile get tfa --json --registry=https://registry.npmjs.org
npm exec --yes \
  --registry=https://registry.npmjs.org \
  --package=npm@11.18.0 -- \
  npm publish "$PITLORE_RELEASE_DIR/pitlore-$PITLORE_RELEASE_VERSION.tgz" \
  --access public \
  --registry=https://registry.npmjs.org
```

这是唯一允许的账号 bootstrap 例外：它使用公开 workflow 已验证的字节产物和交互式
2FA，不使用长期或临时 automation token。该首次版本不会获得 npm trusted-publishing
自动 provenance；GitHub Release 必须附上 artifact、SHA-256、tag commit 和这一边界。
`npm profile get tfa` 的结果必须证明 2FA 已启用且不是 pending；`npm whoami` 单独不
足以证明 2FA。
如果维护者要求从 `0.1.0` 起每个正式版本都有 OIDC provenance，应停止并先明确设计、
审计和记录一个非 `latest` 的 bootstrap prerelease；不得临时发明版本后继续。

package 存在后，用支持该命令的 npm 11 配置唯一 trusted publisher：

```bash
npm exec --yes \
  --registry=https://registry.npmjs.org \
  --package=npm@11.18.0 -- \
  npm trust github pitlore \
  --file npm-publish.yml \
  --repo Hardboiled98k/pitlore \
  --environment npm-publish \
  --allow-publish \
  --registry=https://registry.npmjs.org
npm logout --registry=https://registry.npmjs.org
```

账号必须启用 2FA。Publisher 必须精确绑定 `Hardboiled98k/pitlore`、workflow
`npm-publish.yml` 和 environment `npm-publish`，allowed action 只启用 `npm publish`。

### 4.3 后续 OIDC 发布

从下一版本开始，先按 4.1 演练，核对同一 artifact 后再显式运行：

```bash
PITLORE_RELEASE_TAG=v0.1.1
gh workflow run npm-publish.yml \
  --ref "$PITLORE_RELEASE_TAG" \
  -f tag="$PITLORE_RELEASE_TAG" \
  -f publish_npm=true
```

`.github/workflows/npm-publish.yml` 只有 `workflow_dispatch` 入口。它要求 workflow ref、
输入 tag 和 package version 完全一致，tag commit 必须位于 public `main` 历史；单次
run 只 pack 一次，记录 SHA-256，让 Ubuntu/macOS/Windows × Node.js 22/24 消费同一
artifact，完成 source/self-host/dry-run 门禁后才进入受 environment 保护的 publish job。
只有 publish job 获得 `id-token: write`，并用 Node.js 24 与固定 npm 11.18.0 发布同一
tarball；不设置长期 npm token。Trusted publishing 会为公开仓库的公开包自动生成
provenance。OIDC/trusted-publisher 认证只有真实 `npm publish`（或未来
`npm stage publish`）才能验证；dry-run 通过不能替代 package owner、2FA、environment
和 publisher 配置。

发布成功后：

1. 创建 GitHub Release，附上该 workflow artifact、SHA-256、tag commit、变更说明，
   以及首次 bootstrap 是否没有 trusted-publishing provenance。
2. 在无仓库、无既有 `node_modules` 的新 consumer 中验证
   `npm install --global pitlore@0.1.0` 与 `npx pitlore@0.1.0 --version`；后续版本替换
   示例中的版本号。

除上面明确记录的首次账号 bootstrap 边界外，如果 trusted publishing、npm owner/2FA、
tag protection 或同一 artifact 验证任一条件不成立，停止发布并保持 GitHub source
install，不以本机镜像 registry 或临时 token 绕过。

## 5. 撤回与修复

- 已发布 npm 版本保持不可变；优先发布修复版本，不覆盖同一版本。
- 发现安全或破坏性问题时，先按 `SECURITY.md` 协调，再决定 npm deprecate、GitHub
  Release 标记和修复版本。
- Pack yank、npm deprecate 和 GitHub Release 状态是三套不同机制，必须分别记录，
  不能把其中一个动作冒充全部撤回完成。
