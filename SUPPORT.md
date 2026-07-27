# PitLore support

PitLore is a pre-release, independently maintained open-source project. Public
support is best effort and currently has no response-time SLA.

## Before opening an issue

1. Check the current verified and unverified boundaries in
   [`docs/STATUS.md`](./docs/STATUS.md).
2. Check common failures in
   [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md).
3. Reproduce with Node.js 22 or newer and record the exact PitLore version,
   Git tag, or commit.
4. Reduce the report to a sanitized minimal reproduction.

For GitHub installs, prefer an exact release tag or commit over a moving branch.
The supported development verification command is:

```bash
npm run test:install
```

It exercises both the packed artifact and a real `git+file://` dependency
install from a repository that does not contain prebuilt `dist/` output.

## Choose the right channel

- Reproducible bug: use the **Bug report** issue form.
- Feature or compatibility request: use the **Feature request** form.
- Installation, usage, or documentation question: use the **Question** form.
- Detector false positive: use the **False-positive report** form with only an
  abstract minimal reproduction.
- Suspected vulnerability or private-data exposure: follow
  [`SECURITY.md`](./SECURITY.md) and use GitHub private vulnerability reporting.

Do not put secrets, credentials, a local `.pitlore/`, private Lessons or
reviews, evidence ledgers, customer information, proprietary source, internal
hostnames, or identifying production data in any public issue.

An issue or pull request does not count as human usefulness evidence and does
not approve, reject, or deprecate a Lesson. Those remain explicit maintainer
actions under PitLore's trust model.
