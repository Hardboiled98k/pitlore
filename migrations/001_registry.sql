CREATE TABLE IF NOT EXISTS registry_users (
  id text PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE IF NOT EXISTS registry_organizations (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  owner_user_id text NOT NULL REFERENCES registry_users(id),
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'team', 'enterprise')),
  two_person_approval boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry_memberships (
  org_id text NOT NULL REFERENCES registry_organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES registry_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer', 'publisher', 'admin', 'owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS registry_api_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES registry_users(id) ON DELETE CASCADE,
  org_id text REFERENCES registry_organizations(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry_packages (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES registry_organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
  description text NOT NULL DEFAULT '',
  created_by text NOT NULL REFERENCES registry_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS registry_releases (
  id text PRIMARY KEY,
  package_id text NOT NULL REFERENCES registry_packages(id),
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'published', 'rejected', 'yanked')),
  artifact_integrity text NOT NULL,
  artifact jsonb NOT NULL,
  manifest jsonb NOT NULL,
  provenance jsonb NOT NULL,
  submitted_by text NOT NULL REFERENCES registry_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  yanked_at timestamptz,
  yank_reason text,
  CHECK (
    (status = 'pending' AND published_at IS NULL AND rejected_at IS NULL
      AND rejection_reason IS NULL AND yanked_at IS NULL AND yank_reason IS NULL)
    OR
    (status = 'published' AND published_at IS NOT NULL AND rejected_at IS NULL
      AND rejection_reason IS NULL AND yanked_at IS NULL AND yank_reason IS NULL)
    OR
    (status = 'rejected' AND published_at IS NULL AND rejected_at IS NOT NULL
      AND rejection_reason IS NOT NULL AND yanked_at IS NULL AND yank_reason IS NULL)
    OR
    (status = 'yanked' AND published_at IS NOT NULL AND rejected_at IS NULL
      AND rejection_reason IS NULL AND yanked_at IS NOT NULL AND yank_reason IS NOT NULL)
  ),
  UNIQUE (package_id, version)
);

CREATE TABLE IF NOT EXISTS registry_release_approvals (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES registry_releases(id) ON DELETE CASCADE,
  reviewer_user_id text NOT NULL REFERENCES registry_users(id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, reviewer_user_id)
);

CREATE TABLE IF NOT EXISTS registry_audit_events (
  sequence bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  request_id text NOT NULL,
  org_id text NOT NULL REFERENCES registry_organizations(id),
  actor_id text,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'service', 'system')),
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (actor_kind = 'system' AND actor_id IS NULL)
    OR (actor_kind IN ('human', 'service') AND actor_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS registry_usage_events (
  event_id text NOT NULL,
  org_id text NOT NULL REFERENCES registry_organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('download', 'install', 'retrieve', 'check', 'false_positive')),
  consent text NOT NULL CHECK (consent IN ('server-observed-download', 'client-opt-in')),
  package_name text NOT NULL,
  package_version text NOT NULL,
  lesson_id text,
  outcome text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, event_id)
);

CREATE TABLE IF NOT EXISTS registry_subscriptions (
  org_id text PRIMARY KEY REFERENCES registry_organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_customer_id text,
  provider_subscription_id text,
  plan text NOT NULL CHECK (plan IN ('free', 'team', 'enterprise')),
  status text NOT NULL CHECK (status IN ('active', 'past_due', 'canceled')),
  provider_event_created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registry_billing_webhook_events (
  event_id text PRIMARY KEY,
  claim_id text NOT NULL,
  payload_hash text NOT NULL,
  provider_created_at timestamptz NOT NULL,
  applied boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registry_packages_org_visibility_idx
  ON registry_packages (org_id, visibility);
CREATE INDEX IF NOT EXISTS registry_releases_package_status_idx
  ON registry_releases (package_id, status);
CREATE INDEX IF NOT EXISTS registry_audit_org_sequence_idx
  ON registry_audit_events (org_id, sequence);
CREATE INDEX IF NOT EXISTS registry_usage_package_time_idx
  ON registry_usage_events (package_name, occurred_at);
