# PitLore Pack specification 0.1

A Pack is a Git-friendly, immutable, versioned set of PitLore Lessons. Public Packs are
the default community format. Private Packs use the same artifact contract but may enter a
project only through an authorized Registry or an explicitly transferred air-gap artifact;
direct local/Git `pitlore install` accepts public Packs only.

## Payload and visibility

The canonical payload may contain only:

- `manifest.yaml` with a name, strict SemVer version, visibility, dependency ranges, and
  `default_status_for_new: candidate`;
- `lessons/<id>.yaml` with strict-schema `approved` or `deprecated` Lessons whose
  visibility exactly matches the manifest;
- fixture files explicitly referenced by block Lessons;
- a non-empty UTF-8 `LICENSE` file for every public Pack; private Packs may omit it;
- optional `README.md`, `CHANGELOG.md`, and `SIGNATURE.json`.

The PitLore repository and official Packs license their code, documentation, and Lesson
content under Apache-2.0; each official Pack carries the complete license text so a copied,
cached, Registry, or air-gap artifact remains self-contained. Community public Packs may
choose different terms, but must state those terms in their own `LICENSE`; PitLore validates
the file boundary and does not infer, rewrite, or certify the publisher's legal choice.

Public names must use lowercase `namespace/name` segments. Every allowed public payload
file (manifest, raw Lesson YAML, fixtures, documentation, license, and signature metadata)
is decoded as UTF-8 and scanned for secret/PII shapes, internal hosts, user-specific local
paths, and prompt-injection-shaped instructions. Standard license attribution may contain
a public contact email; other payload files may not. Parsed Lessons retain the stricter
abstract-content size check. A private Pack is not sanitized for publication and must be
handled as confidential data.

Both visibility modes reject unknown files or schema fields, symlinks, non-regular files,
candidate/rejected Lessons, non-empty `detector_ref`, unsafe regex, missing/bad fixtures,
path traversal, and size/count overages. A public Pack also fails closed when `LICENSE` is
missing, blank, or not valid UTF-8. Packs cannot execute JS, shell, hooks, installers, or
arbitrary detector code.

## Integrity and publisher identity

Canonical payload integrity is SHA-256 over sorted POSIX relative paths, byte lengths, and
raw bytes. Mtime and local file mode are not hashed. `SIGNATURE.json` is excluded from the
signed payload integrity and included in the separate cache artifact digest.

`pitlore pack sign` signs the canonical integrity string with Ed25519. A valid embedded key
proves that the payload matches that key, but the key identity is still `self-asserted`.
Only an installer that explicitly pins the expected fingerprint with `--trust-key` records
`identity_trust: explicit-key`. A checksum, Git commit, tag, and publisher key are distinct
claims and remain distinct in the lock.

## Installation, cache, and lock

`pitlore.lock.yaml` is deterministic and contains no timestamp. It records root Packs and,
for every reachable package:

- exact version and canonical payload integrity;
- content-addressed cache artifact digest;
- local/Git/Registry/air-gap source and applicable ref, commit, repository subdirectory,
  URL, or organization id;
- signature status and identity trust;
- dependencies resolved to exact versions.

Runtime search/retrieve/check loads only cache entries referenced by this lock. Unreferenced
cache content is inert. Every load rechecks the cache digest, payload integrity,
name/version, dependencies, signature status, and cross-Pack Lesson ID uniqueness.

Missing or altered cache entries, cycles, unreachable packages, dependency mismatches,
duplicate Lesson IDs, or different content at an existing `name@version` fail closed.
Version upgrades create a new cache artifact. Uninstall edits only the lock and refuses to
remove a Pack that another locked Pack needs. Lock mutations are serialized across
processes; a suspected stale lock is never deleted automatically.

`pitlore install <url> --subdir <path>` can select one Pack from a monorepo. The portable
POSIX relative path is stored with Git provenance; absolute paths, dot segments, `.git`,
backslashes, traversal, missing directories, and symlinked directories fail closed. The
same option works for a repository already cloned inside the current project.

An untrusted HTTPS Git source is cloned with an isolated global Git configuration,
credential helpers and redirects disabled, a 120-second absolute deadline, a 1 KiB/s for
30 seconds low-speed cutoff, and 2 MiB stdout/stderr capture limits. Operators may set
`PITLORE_PACK_GIT_TIMEOUT_MS` only within 250–300000 ms. Timeout/failure removes the temporary
clone and never falls back to another source. A supervisor process additionally enforces a
fail-closed disk-growth budget on the temporary clone directory (default 64 MiB,
`PITLORE_PACK_GIT_MAX_TRANSFER_BYTES` within 64 KiB–1 GiB), so a fast hostile remote cannot
flood the disk until the deadline. This budget meters on-disk growth, not protocol-level
network bytes: memory-buffered transfer phases such as the refs advertisement remain bounded
only by git itself and the deadlines. After checkout, the ordinary 20 MiB/1000-file Pack
bounds still fail closed, but that post-clone verification is not a network-download quota.

## Dependencies and exact air-gap closure

Manifest dependencies are SemVer ranges; the lock is the exact resolved graph. A single
artifact install requires every compatible dependency to be already locked. For a complete
disconnected transfer, use the bundle commands:

```bash
pitlore pack artifact bundle-export <installed-root-name> --output pack.bundle.json
pitlore pack artifact bundle-verify pack.bundle.json
pitlore pack artifact bundle-install pack.bundle.json
```

Bundle export starts from a verified installed root and includes exactly its reachable
locked dependency closure in canonical name order. Verification rejects a missing root,
missing or extra Pack, duplicate name, cycle, range/version mismatch, metadata/content
mismatch, or artifact/path/size violation. Installation verifies the complete closure,
orders dependencies before dependents, and commits the resulting lock once.

## Registry and portable artifacts

Registry publication uploads the complete immutable Pack as
`pitlore.pack.artifact.v1`. Each file is base64 encoded with its byte length and SHA-256;
the envelope repeats name, version, payload integrity, and artifact digest. Materialization
rejects traversal, absolute or duplicate paths, malformed base64, checksum mismatch,
symlinks, and bounded-size violations before the ordinary Pack verifier runs.

`pitlore pack artifact export`, `verify`, and `install` use the same contract for one-Pack
transfer. Writers use exclusive creation and refuse to overwrite or follow a symlink.
Air-gap installs record `source.type: airgap` without inventing a network origin.

Registry package visibility must match artifact visibility. Public discovery is anonymous;
private download requires an organization id and authorized bearer. A Registry lock records
the exact Registry URL and will not send a token to a different URL during sync.
Publication provenance may contain only an absolute credential-free HTTPS source URL with
no userinfo, query, or fragment, plus the exact commit in its separate field. The Registry
stores this claim for audit; it does not fetch or authenticate to the source URL.

## Compatibility, deprecation, and yank

- Patch: clarification or detector precision improvement without broader matching.
- Minor: backward-compatible Lessons or optional fields.
- Major: stricter detector behavior, removed/renamed IDs, or incompatible schema policy.
- Retire one Lesson by publishing it as `deprecated`; clients retain the tombstone but do
  not consume it in retrieve/check/export.
- A Registry may `yank` a published release. Yank preserves audit history and blocks new
  installs. `pitlore registry sync` revalidates exact Registry locks and exits nonzero when
  a locked release is yanked. An offline client cannot learn a later revocation until it
  reconnects and explicitly syncs.
