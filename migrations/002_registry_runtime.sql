ALTER TABLE registry_subscriptions
  ADD COLUMN provider_event_id text;

ALTER TABLE registry_billing_webhook_events
  ADD COLUMN org_id text REFERENCES registry_organizations(id),
  ADD COLUMN provider text,
  ADD COLUMN event_type text CHECK (
    event_type IN ('subscription.updated', 'subscription.canceled')
  );

CREATE INDEX IF NOT EXISTS registry_api_tokens_org_created_idx
  ON registry_api_tokens (org_id, created_at);

CREATE INDEX IF NOT EXISTS registry_usage_org_package_time_idx
  ON registry_usage_events (org_id, package_name, occurred_at);

CREATE INDEX IF NOT EXISTS registry_billing_webhook_org_time_idx
  ON registry_billing_webhook_events (org_id, provider_created_at);

CREATE UNIQUE INDEX IF NOT EXISTS registry_package_name_idx
  ON registry_packages (name);
