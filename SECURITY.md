# Security Policy

## Supported versions

PitLore is currently pre-release. Security fixes are made on the `main` branch;
no older release line is supported yet.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability or include
working secrets, private Lessons, evidence, customer data, or proprietary source
in a report.

Use [GitHub private vulnerability reporting](https://github.com/Hardboiled98k/pitlore/security/advisories/new).
Include only the minimum reproduction needed, the affected commit or version,
the security impact, and a suggested mitigation when available. If the report
involves leaked credentials, revoke or rotate them before reporting.

Particularly relevant areas include:

- authentication, authorization, tenant isolation, and PostgreSQL RLS;
- public/private Lesson or artifact disclosure;
- Pack provenance, signature, path, archive, and dependency verification;
- Registry upload/download bounds and request smuggling or traversal;
- secret, PII, review, or evidence leakage;
- unsafe detector execution or sandbox escape.

The maintainer will coordinate disclosure after the issue is understood and a
fix is available. As a pre-release independent project, PitLore does not yet
offer a response-time SLA or bug bounty.

When applicable, remediation preserves the release record, deprecates a
compromised Lesson or yanks a compromised release, publishes a corrected SemVer
version, and documents publisher-key rotation. Offline clients cannot receive a
revocation until an explicit sync or update, so urgent advisories will state
that limitation.

Checksums and self-asserted signatures are supply-chain controls, not proof of a
publisher's identity unless the installer explicitly pins the expected key
fingerprint. They are not a legal compliance certification.
