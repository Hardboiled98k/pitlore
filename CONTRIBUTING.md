# Contributing to PitLore

Thanks for helping make coding-agent lessons safer, more portable, and more
useful.

## Before you start

- Read [`docs/STATUS.md`](./docs/STATUS.md) for the current engineering
  baseline and unverified boundaries.
- Read [`docs/DECISIONS.md`](./docs/DECISIONS.md) before changing trust,
  lifecycle, storage, Registry, or evidence semantics.
- For a large feature or contract change, open an issue first so the intended
  scope and compatibility impact are visible.
- Use the repository's bug, feature, or false-positive issue form and follow
  [`SUPPORT.md`](./SUPPORT.md). Suspected vulnerabilities must use the private
  process in [`SECURITY.md`](./SECURITY.md).

Never submit a local `.pitlore/` directory, private Lesson or review content,
evidence ledgers, credentials, PII, customer names, proprietary source, or
internal hosts. Public Lessons must remain abstract and must pass the explicit
public-export and Pack verification boundaries.

## Development

PitLore requires Node.js 22 or newer.

```bash
npm ci
npm run verify
npm run demo:tenant
npm run test:install
npm run -s pitlore -- pack verify packs/<pack>
```

Changes to PostgreSQL migrations, RLS, Registry persistence, backup/restore, or
Docker self-hosting also require:

```bash
npm run test:self-host
```

Run `npm run audit:prod` for the published dependency tree and
`npm run audit:build` for the repository's high/critical build gate. Do not make
checks pass by weakening compiler settings, skipping assertions, swallowing
errors, or forcing a breaking dependency downgrade.

Repository agents follow
[`AGENTS.md`](https://github.com/Hardboiled98k/pitlore/blob/main/AGENTS.md):
retrieve relevant approved Lessons before non-trivial implementation, check
changed production sources before completion, and record a real bug fix only as
a private candidate. Humans alone approve, reject, or deprecate Lessons and
judge evidence.

## Pull requests

Keep each pull request focused and include:

- the problem and user-visible behavior;
- trust, privacy, compatibility, migration, and rollback impact;
- tests added or changed;
- exact verification commands and results;
- any intentionally unverified external or production boundary.

Pack and Lesson changes must satisfy the
[Pack specification](./docs/PACK-SPEC.md), copy the
[Pack-specific checklist](https://github.com/Hardboiled98k/pitlore/blob/main/.github/PULL_REQUEST_TEMPLATE/pack.md)
into the pull request body, include applicable license terms, and explain the
real failure mode, abstraction boundary, sources, detector precision, and SemVer
impact. A block-level detector needs at least one bad and one good fixture:
every bad fixture must hit and every good fixture must remain clean. Public
Packs may contain only declarative regex detectors; executable plugins,
scripts, lifecycle hooks, symlinks, and non-empty `detector_ref` values are
rejected.

Maintainers may request edits, reject an over-specific Lesson, deprecate a
previously active Lesson, or yank a compromised release. False-positive reports
should contain only an abstract minimal reproduction and state whether the
finding created pressure to disable the gate.

By submitting a contribution, you agree that it is licensed under the
repository's [Apache License 2.0](./LICENSE).
