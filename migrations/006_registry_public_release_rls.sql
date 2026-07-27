-- Keep the anonymous database surface aligned with the public HTTP contract.
-- Public packages may be discovered without tenant context, but release
-- payloads and approval metadata are not public until a release is published.
-- Yanked releases remain readable so clients can propagate revocations.

DROP POLICY IF EXISTS registry_releases_public_read ON registry_releases;
CREATE POLICY registry_releases_public_read ON registry_releases
  FOR SELECT
  USING (
    status IN ('published', 'yanked')
    AND EXISTS (
      SELECT 1 FROM registry_packages AS p
       WHERE p.id = package_id
         AND p.visibility = 'public'));

DROP POLICY IF EXISTS registry_release_approvals_public_read
  ON registry_release_approvals;
CREATE POLICY registry_release_approvals_public_read
  ON registry_release_approvals
  FOR SELECT
  USING (EXISTS (
    SELECT 1
      FROM registry_releases AS r
      JOIN registry_packages AS p ON p.id = r.package_id
     WHERE r.id = release_id
       AND r.status IN ('published', 'yanked')
       AND p.visibility = 'public'));
