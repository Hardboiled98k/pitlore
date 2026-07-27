CREATE TABLE registry_usage_reservations (
  event_id text NOT NULL,
  org_id text NOT NULL REFERENCES registry_organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  claim_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, event_id)
);

CREATE INDEX registry_usage_reservations_org_period_idx
  ON registry_usage_reservations (org_id, period_start);
