# Changelog

All notable user-visible changes are recorded here. PitLore follows Semantic Versioning
for the distributed CLI package; Lesson and Pack schema versions have their own contracts.

## Unreleased

### Changed

- Require Node.js 22+; consumer CI is configured to exercise the Node.js 22 and
  24 LTS lines before release.

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

### Security

- Private lore, candidates, reviews, evidence, credentials, and operator artifacts remain
  excluded from public Git by default.
- Every package-lock artifact is constrained to the official npm registry, and bundled MCP
  third-party notice bodies are pinned to reviewed SHA-256 values.
- Public Pack verification is bounded and fail-closed for paths, symlinks, sizes,
  sensitive content, detector safety, signatures, and licenses.
