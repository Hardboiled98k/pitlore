-- Preserve the evidence used to review, meter, and audit Registry releases.
--
-- Release lifecycle fields remain mutable because approve/reject/yank update
-- them in place. Identity, payload, provenance, submitter, and creation time
-- are immutable after insertion. Approval, audit, usage, quota-reservation,
-- and billing-webhook rows are append-only. These guards prevent accidental
-- mutation; a database owner can still alter the schema, so they are not WORM.

-- The application has always required two distinct human reviewers. Remove
-- the legacy-looking false value so storage cannot advertise a policy toggle
-- that the release state machine does not implement.
UPDATE registry_organizations
   SET two_person_approval = true
 WHERE two_person_approval IS NOT TRUE;

ALTER TABLE registry_organizations
  ALTER COLUMN two_person_approval SET DEFAULT true,
  ADD CONSTRAINT registry_organizations_two_person_approval_required
    CHECK (two_person_approval IS TRUE);

CREATE FUNCTION registry_releases_enforce_immutable_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  approved_reviewer_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'registry releases cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.package_id IS DISTINCT FROM OLD.package_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.artifact_integrity IS DISTINCT FROM OLD.artifact_integrity
    OR NEW.artifact IS DISTINCT FROM OLD.artifact
    OR NEW.manifest IS DISTINCT FROM OLD.manifest
    OR NEW.provenance IS DISTINCT FROM OLD.provenance
    OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'registry release identity and payload are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
      OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
      OR NEW.yanked_at IS DISTINCT FROM OLD.yanked_at
      OR NEW.yank_reason IS DISTINCT FROM OLD.yank_reason
    THEN
      RAISE EXCEPTION 'registry release lifecycle metadata is immutable without a state transition'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'pending' AND NEW.status = 'published' THEN
    SELECT count(DISTINCT reviewer_user_id)::integer
      INTO approved_reviewer_count
      FROM public.registry_release_approvals
     WHERE release_id = OLD.id
       AND decision = 'approved';
    IF approved_reviewer_count <> 2 THEN
      RAISE EXCEPTION 'registry release publication requires exactly two distinct approvals'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
      OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
      OR NEW.yanked_at IS DISTINCT FROM OLD.yanked_at
      OR NEW.yank_reason IS DISTINCT FROM OLD.yank_reason
    THEN
      RAISE EXCEPTION 'registry release lifecycle transition changed unrelated metadata'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'pending' AND NEW.status = 'rejected' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM public.registry_release_approvals
       WHERE release_id = OLD.id
         AND decision = 'rejected'
    ) THEN
      RAISE EXCEPTION 'registry release rejection requires a rejected decision'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.yanked_at IS DISTINCT FROM OLD.yanked_at
      OR NEW.yank_reason IS DISTINCT FROM OLD.yank_reason
    THEN
      RAISE EXCEPTION 'registry release lifecycle transition changed unrelated metadata'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'published' AND NEW.status = 'yanked' THEN
    IF NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
      OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
    THEN
      RAISE EXCEPTION 'registry release lifecycle transition changed unrelated metadata'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'registry release lifecycle transition is not allowed'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER registry_releases_immutable_payload
  BEFORE UPDATE OR DELETE ON registry_releases
  FOR EACH ROW
  EXECUTE FUNCTION registry_releases_enforce_immutable_payload();

CREATE FUNCTION registry_reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

-- Approval rows capture who was authorized at decision time. Lifecycle guards
-- below consume those immutable facts. Yank authorization remains an
-- application-layer check because the release row does not store its actor.
CREATE FUNCTION registry_release_approvals_enforce_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  release_status text;
  release_submitter text;
  reviewer_status text;
  reviewer_role text;
  existing_approved_count integer;
BEGIN
  SELECT r.status, r.submitted_by, u.status, m.role
    INTO release_status, release_submitter, reviewer_status, reviewer_role
    FROM public.registry_releases AS r
    JOIN public.registry_packages AS p ON p.id = r.package_id
    LEFT JOIN public.registry_users AS u ON u.id = NEW.reviewer_user_id
    LEFT JOIN public.registry_memberships AS m
      ON m.org_id = p.org_id
     AND m.user_id = NEW.reviewer_user_id
   WHERE r.id = NEW.release_id
   FOR UPDATE OF r;

  IF NOT FOUND OR release_status <> 'pending' THEN
    RAISE EXCEPTION 'registry release approval requires a pending release'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.reviewer_user_id = release_submitter THEN
    RAISE EXCEPTION 'registry release submitter cannot review their own release'
      USING ERRCODE = '55000';
  END IF;
  IF reviewer_status IS DISTINCT FROM 'active'
    OR reviewer_role IS NULL
    OR reviewer_role NOT IN ('admin', 'owner')
  THEN
    RAISE EXCEPTION 'registry release reviewer must be an active admin or owner'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.decision = 'approved' THEN
    SELECT count(*)::integer
      INTO existing_approved_count
      FROM public.registry_release_approvals
     WHERE release_id = NEW.release_id
       AND decision = 'approved';
    IF existing_approved_count >= 2 THEN
      RAISE EXCEPTION 'registry release accepts exactly two approved decisions'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER registry_release_approvals_integrity
  BEFORE INSERT ON registry_release_approvals
  FOR EACH ROW
  EXECUTE FUNCTION registry_release_approvals_enforce_integrity();

CREATE TRIGGER registry_release_approvals_append_only
  BEFORE UPDATE OR DELETE ON registry_release_approvals
  FOR EACH ROW
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_releases_reject_truncate
  BEFORE TRUNCATE ON registry_releases
  FOR EACH STATEMENT
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_release_approvals_reject_truncate
  BEFORE TRUNCATE ON registry_release_approvals
  FOR EACH STATEMENT
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_audit_events_append_only
  BEFORE UPDATE OR DELETE ON registry_audit_events
  FOR EACH ROW
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_audit_events_reject_truncate
  BEFORE TRUNCATE ON registry_audit_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_usage_events_append_only
  BEFORE UPDATE OR DELETE ON registry_usage_events
  FOR EACH ROW
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_usage_events_reject_truncate
  BEFORE TRUNCATE ON registry_usage_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_usage_reservations_append_only
  BEFORE UPDATE OR DELETE ON registry_usage_reservations
  FOR EACH ROW
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_usage_reservations_reject_truncate
  BEFORE TRUNCATE ON registry_usage_reservations
  FOR EACH STATEMENT
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_billing_webhook_events_append_only
  BEFORE UPDATE OR DELETE ON registry_billing_webhook_events
  FOR EACH ROW
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_billing_webhook_events_reject_truncate
  BEFORE TRUNCATE ON registry_billing_webhook_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION registry_reject_append_only_mutation();
