-- Row-level security defence in depth for org-scoped Registry tables.
--
-- Tenant context is set per transaction by the application:
--   SELECT set_config('pitlore.tenant_id', $1, true);
-- current_setting('pitlore.tenant_id', true) returns NULL when the context is
-- absent, so every tenant policy fails closed: without context, org rows are
-- invisible and unwritable for non-owner roles such as pitlore_runtime.
--
-- Deliberately outside RLS (documented boundary, enforced at the application
-- layer instead): registry_users, registry_organizations, and
-- registry_api_tokens, because bootstrap, identity resolution, slug lookups,
-- and hash-indexed token authentication run before any tenant is known.
-- Roles that own these tables (the migrator) bypass RLS by default; this is
-- intentional so append-only migrations keep working.

ALTER TABLE registry_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY registry_memberships_tenant ON registry_memberships
  USING (org_id = current_setting('pitlore.tenant_id', true))
  WITH CHECK (org_id = current_setting('pitlore.tenant_id', true));

ALTER TABLE registry_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY registry_packages_tenant ON registry_packages
  USING (org_id = current_setting('pitlore.tenant_id', true))
  WITH CHECK (org_id = current_setting('pitlore.tenant_id', true));
CREATE POLICY registry_packages_public_read ON registry_packages
  FOR SELECT
  USING (visibility = 'public');

ALTER TABLE registry_releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY registry_releases_tenant ON registry_releases
  USING (EXISTS (
    SELECT 1 FROM registry_packages AS p
     WHERE p.id = package_id
       AND p.org_id = current_setting('pitlore.tenant_id', true)))
  WITH CHECK (EXISTS (
    SELECT 1 FROM registry_packages AS p
     WHERE p.id = package_id
       AND p.org_id = current_setting('pitlore.tenant_id', true)));
CREATE POLICY registry_releases_public_read ON registry_releases
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM registry_packages AS p
     WHERE p.id = package_id
       AND p.visibility = 'public'));

ALTER TABLE registry_release_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY registry_release_approvals_tenant ON registry_release_approvals
  USING (EXISTS (
    SELECT 1
      FROM registry_releases AS r
      JOIN registry_packages AS p ON p.id = r.package_id
     WHERE r.id = release_id
       AND p.org_id = current_setting('pitlore.tenant_id', true)))
  WITH CHECK (EXISTS (
    SELECT 1
      FROM registry_releases AS r
      JOIN registry_packages AS p ON p.id = r.package_id
     WHERE r.id = release_id
       AND p.org_id = current_setting('pitlore.tenant_id', true)));

CREATE POLICY registry_release_approvals_public_read ON registry_release_approvals
  FOR SELECT
  USING (EXISTS (
    SELECT 1
      FROM registry_releases AS r
      JOIN registry_packages AS p ON p.id = r.package_id
     WHERE r.id = release_id
       AND p.visibility = 'public'));

ALTER TABLE registry_audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY registry_audit_events_tenant ON registry_audit_events
  USING (org_id = current_setting('pitlore.tenant_id', true))
  WITH CHECK (org_id = current_setting('pitlore.tenant_id', true));

ALTER TABLE registry_usage_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY registry_usage_events_tenant ON registry_usage_events
  USING (org_id = current_setting('pitlore.tenant_id', true))
  WITH CHECK (org_id = current_setting('pitlore.tenant_id', true));

ALTER TABLE registry_usage_reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY registry_usage_reservations_tenant ON registry_usage_reservations
  USING (org_id = current_setting('pitlore.tenant_id', true))
  WITH CHECK (org_id = current_setting('pitlore.tenant_id', true));

ALTER TABLE registry_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY registry_subscriptions_tenant ON registry_subscriptions
  USING (org_id = current_setting('pitlore.tenant_id', true))
  WITH CHECK (org_id = current_setting('pitlore.tenant_id', true));

ALTER TABLE registry_billing_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY registry_billing_webhook_events_tenant ON registry_billing_webhook_events
  USING (org_id = current_setting('pitlore.tenant_id', true))
  WITH CHECK (org_id = current_setting('pitlore.tenant_id', true));
