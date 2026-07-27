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
- `LICENSE`、`THIRD_PARTY_NOTICES.md`、`CHANGELOG.md`、贡献/安全/支持文档和官方
  Packs 均在 tarball 中，产物内 Markdown 相对链接没有断链。
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

以下外部设置和动作都需要维护者明确授权，当前尚未执行：

1. 合并版本与 changelog 变更，等待 public `main` CI/CodeQL 全绿。
2. 为 `refs/tags/v*` 配置不可更新/删除的 tag ruleset，并创建与 `package.json`
   完全一致的受保护 tag。
3. 创建 GitHub environment `npm-publish`，启用 required reviewer、禁止 self-review
   和管理员绕过，并只允许受保护 release tag。
4. 在 npm package settings 中把 trusted publisher 精确绑定到：
   `Hardboiled98k/pitlore`、workflow `npm-publish.yml`、environment `npm-publish`，
   allowed action 只启用 `npm publish`。当前包名查询仍是 E404；首次包名取得/owner
   bootstrap 和 trusted publisher 是否可预配必须由维护者在 npm 官方页面确认，不能由
   workflow 猜测或用临时 token 静默绕过。
5. 从已存在的 tag ref 先运行不改变 registry 的工程演练；它验证 artifact 与 npm
   客户端 dry-run，不验证 OIDC 授权：

   ```bash
   PITLORE_RELEASE_TAG=v0.1.0
   gh workflow run npm-publish.yml \
     --ref "$PITLORE_RELEASE_TAG" \
     -f tag="$PITLORE_RELEASE_TAG" \
     -f publish_npm=false
   ```

6. 核对演练结果后，再显式运行发布：

   ```bash
   PITLORE_RELEASE_TAG=v0.1.0
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
`npm stage publish`）才能验证；因此 owner/bootstrap、environment 和 publisher 配置
必须在第 6 步之前完成，dry-run 通过不能替代这一外部前提。

发布成功后：

1. 创建 GitHub Release，附上该 workflow artifact、SHA-256 和变更说明。
2. 在无仓库、无既有 `node_modules` 的新 consumer 中验证
   `npm install --global pitlore@0.1.0` 与 `npx pitlore@0.1.0 --version`；后续版本替换
   示例中的版本号。

如果 trusted publishing、npm owner/2FA、tag protection 或同一 artifact provenance
任一条件不成立，停止发布并保持 GitHub source install，不以本机镜像 registry 或临时
token 绕过。

## 5. 撤回与修复

- 已发布 npm 版本保持不可变；优先发布修复版本，不覆盖同一版本。
- 发现安全或破坏性问题时，先按 `SECURITY.md` 协调，再决定 npm deprecate、GitHub
  Release 标记和修复版本。
- Pack yank、npm deprecate 和 GitHub Release 状态是三套不同机制，必须分别记录，
  不能把其中一个动作冒充全部撤回完成。
