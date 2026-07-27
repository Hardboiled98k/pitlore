# Changelog

All notable user-visible changes are recorded here. PitLore follows Semantic Versioning
for the distributed CLI package; Lesson and Pack schema versions have their own contracts.

## Unreleased

## [0.1.1] - 2026-07-28

### Fixed

- Mark local npm tarball arguments with an explicit `./` prefix so npm 11 treats the
  release candidate as a file instead of a GitHub package shorthand.

### Release

- Published `pitlore@0.1.1` to the official npm registry from the exact tarball validated
  by the protected-tag release workflow and attached the same bytes plus `SHA256SUMS` to
  the GitHub Release.
- The first publication used interactive account-level 2FA and therefore does not claim
  trusted-publishing provenance. Future publications are bound to the repository's
  protected GitHub Actions OIDC workflow and `npm-publish` environment.
- Used `0.1.1` for the first npm publication. The protected `v0.1.0` engineering tag
  remains publicly visible and immutable after its final npm dry-run exposed the path
  bug, but it has no GitHub Release and no corresponding npm version.

## [0.1.0] - 2026-07-28

### Changed

- Require Node.js 22+; consumer CI is configured to exercise the Node.js 22 and
  24 LTS lines before release.
- Normalize reviewed notice text across LF and CRLF checkouts, execute global npm
  shims through a static consumer script, and use artifact actions with a supported
  runner runtime so the release gate is portable across Windows, macOS, and Linux.

### Added

- Public Apache-2.0 source repository with CLI, MCP, Pack supply chain, and self-hosted
  Registry engineering baseline.
- Reproducible npm tarball smoke covering the installed CLI, MCP runtime, local lore
  lifecycle, Pack installation, retrieval, checks, packaged Markdown links, licenses,
  ordinary `npm exec`, and global installation.
- Git dependency installation that builds the ignored `dist/` output through `prepare`,
  exercises the documented `npx --no-install` quick start, and verifies the generated
  lockfile pins the requested branch to an exact commit.
- Ubuntu, macOS, and Windows consumer installation checks against one npm tarball.
- A manually dispatched, tag-bound npm trusted-publishing workflow that verifies one
  SHA-256-pinned tarball across Node.js 22/24 consumers before the protected publish job.
- Public support guidance, structured bug/feature/question/false-positive issue forms, and
  default code plus Pack-specific pull-request checklists.
- Contributor Covenant 2.1, repository ownership, weekly dependency-update
  configuration, and one stable aggregate CI check for branch protection.

### Security

- Private lore, candidates, reviews, evidence, credentials, and operator artifacts remain
  excluded from public Git by default.
- Every package-lock artifact is constrained to the official npm registry, and bundled MCP
  third-party notice bodies are pinned to reviewed SHA-256 values.
- Public Pack verification is bounded and fail-closed for paths, symlinks, sizes,
  sensitive content, detector safety, signatures, and licenses.

[0.1.1]: https://github.com/Hardboiled98k/pitlore/releases/tag/v0.1.1
[0.1.0]: https://github.com/Hardboiled98k/pitlore/tree/v0.1.0
