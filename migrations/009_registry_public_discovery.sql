-- PITLORE_REGISTRY_PUBLIC_DISCOVERY_V1
--
-- Store a server-derived, append-only discovery snapshot for each verified
-- release and keep one package pointer to the highest non-yanked published
-- version. Historical installations intentionally receive no fabricated
-- metadata: an operator reindex must reverify their immutable artifacts.

ALTER TABLE registry_releases
  ADD CONSTRAINT registry_releases_package_id_id_key
    UNIQUE (package_id, id);

CREATE TABLE registry_release_discovery (
  release_id text PRIMARY KEY,
  package_id text NOT NULL,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  description text NOT NULL CHECK (
    char_length(description) <= 512
    AND description !~ '[[:cntrl:]]'
  ),
  languages text[] NOT NULL CHECK (
    cardinality(languages) <= 64
    AND array_position(languages, NULL) IS NULL
    AND COALESCE(array_ndims(languages), 1) = 1
    AND COALESCE(array_lower(languages, 1), 1) = 1
  ),
  ecosystems text[] NOT NULL CHECK (
    cardinality(ecosystems) <= 64
    AND array_position(ecosystems, NULL) IS NULL
    AND COALESCE(array_ndims(ecosystems), 1) = 1
    AND COALESCE(array_lower(ecosystems, 1), 1) = 1
  ),
  tags text[] NOT NULL CHECK (
    cardinality(tags) <= 64
    AND array_position(tags, NULL) IS NULL
    AND COALESCE(array_ndims(tags), 1) = 1
    AND COALESCE(array_lower(tags, 1), 1) = 1
  ),
  lesson_count integer NOT NULL CHECK (lesson_count BETWEEN 0 AND 1000),
  indexed_at timestamptz NOT NULL,
  CONSTRAINT registry_release_discovery_release_fk
    FOREIGN KEY (package_id, release_id)
    REFERENCES registry_releases (package_id, id)
);

CREATE TABLE registry_release_discovery_facets (
  release_id text NOT NULL,
  package_id text NOT NULL,
  dimension text COLLATE "C" NOT NULL CHECK (
    dimension IN ('language', 'ecosystem', 'tag')
  ),
  value text COLLATE "C" NOT NULL CHECK (
    char_length(value) BETWEEN 1 AND 64
    AND value !~ '[[:cntrl:]]'
  ),
  PRIMARY KEY (release_id, dimension, value),
  CONSTRAINT registry_release_discovery_facets_release_fk
    FOREIGN KEY (package_id, release_id)
    REFERENCES registry_releases (package_id, id)
);

ALTER TABLE registry_packages
  ADD COLUMN discovery_release_id text,
  ADD CONSTRAINT registry_packages_discovery_release_fk
    FOREIGN KEY (id, discovery_release_id)
    REFERENCES registry_releases (package_id, id);

UPDATE registry_packages AS package
   SET discovery_release_id = (
     SELECT release.id
       FROM registry_releases AS release
      WHERE release.package_id = package.id
        AND release.status = 'published'
      ORDER BY release.semver_sort_key DESC,
               release.semver_version_tie_key DESC
      LIMIT 1
   );

CREATE INDEX registry_releases_latest_published_idx
  ON registry_releases
    (package_id, semver_sort_key DESC, semver_version_tie_key DESC)
  WHERE status = 'published';

CREATE UNIQUE INDEX registry_packages_discovery_release_idx
  ON registry_packages (discovery_release_id)
  WHERE discovery_release_id IS NOT NULL;

-- PostgreSQL cannot safely push the non-leakproof array-overlap operator
-- through an RLS security boundary. A normalized B-tree lookup keeps rare and
-- absent public filters bounded without bypassing row-level security.
CREATE INDEX registry_release_discovery_facets_lookup_idx
  ON registry_release_discovery_facets
    (dimension, value, release_id, package_id);

ALTER TABLE registry_release_discovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry_release_discovery_facets ENABLE ROW LEVEL SECURITY;

CREATE POLICY registry_release_discovery_tenant
  ON registry_release_discovery
  USING (EXISTS (
    SELECT 1
      FROM registry_releases AS release
      JOIN registry_packages AS package ON package.id = release.package_id
     WHERE release.id = registry_release_discovery.release_id
       AND release.package_id = registry_release_discovery.package_id
       AND package.org_id = current_setting('pitlore.tenant_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1
      FROM registry_releases AS release
      JOIN registry_packages AS package ON package.id = release.package_id
     WHERE release.id = registry_release_discovery.release_id
       AND release.package_id = registry_release_discovery.package_id
       AND package.org_id = current_setting('pitlore.tenant_id', true)
  ));

CREATE POLICY registry_release_discovery_public_read
  ON registry_release_discovery
  FOR SELECT
  USING (EXISTS (
    SELECT 1
      FROM registry_releases AS release
      JOIN registry_packages AS package ON package.id = release.package_id
     WHERE release.id = registry_release_discovery.release_id
       AND release.package_id = registry_release_discovery.package_id
       AND release.status IN ('published', 'yanked')
       AND package.visibility = 'public'
  ));

CREATE POLICY registry_release_discovery_facets_tenant
  ON registry_release_discovery_facets
  USING (EXISTS (
    SELECT 1
      FROM registry_releases AS release
      JOIN registry_packages AS package ON package.id = release.package_id
     WHERE release.id = registry_release_discovery_facets.release_id
       AND release.package_id =
           registry_release_discovery_facets.package_id
       AND package.org_id = current_setting('pitlore.tenant_id', true)
  ))
  WITH CHECK (EXISTS (
    SELECT 1
      FROM registry_releases AS release
      JOIN registry_packages AS package ON package.id = release.package_id
     WHERE release.id = registry_release_discovery_facets.release_id
       AND release.package_id =
           registry_release_discovery_facets.package_id
       AND package.org_id = current_setting('pitlore.tenant_id', true)
  ));

CREATE POLICY registry_release_discovery_facets_public_read
  ON registry_release_discovery_facets
  FOR SELECT
  USING (EXISTS (
    SELECT 1
      FROM registry_releases AS release
      JOIN registry_packages AS package ON package.id = release.package_id
     WHERE release.id = registry_release_discovery_facets.release_id
       AND release.package_id =
           registry_release_discovery_facets.package_id
       AND release.status IN ('published', 'yanked')
       AND package.visibility = 'public'
  ));

CREATE TRIGGER registry_release_discovery_append_only
  BEFORE UPDATE OR DELETE ON registry_release_discovery
  FOR EACH ROW
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_release_discovery_reject_truncate
  BEFORE TRUNCATE ON registry_release_discovery
  FOR EACH STATEMENT
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_release_discovery_facets_append_only
  BEFORE UPDATE OR DELETE ON registry_release_discovery_facets
  FOR EACH ROW
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE TRIGGER registry_release_discovery_facets_reject_truncate
  BEFORE TRUNCATE ON registry_release_discovery_facets
  FOR EACH STATEMENT
  EXECUTE FUNCTION registry_reject_append_only_mutation();

CREATE FUNCTION registry_validate_discovery_facet()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  allowed_values text[];
BEGIN
  SELECT CASE NEW.dimension
           WHEN 'language' THEN discovery.languages
           WHEN 'ecosystem' THEN discovery.ecosystems
           WHEN 'tag' THEN discovery.tags
         END
    INTO allowed_values
    FROM public.registry_release_discovery AS discovery
   WHERE discovery.release_id = NEW.release_id
     AND discovery.package_id = NEW.package_id;

  IF allowed_values IS NULL OR NOT (NEW.value = ANY(allowed_values)) THEN
    RAISE EXCEPTION
      'registry discovery facet must match verified discovery metadata'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER registry_release_discovery_facets_validate
  BEFORE INSERT ON registry_release_discovery_facets
  FOR EACH ROW
  EXECUTE FUNCTION registry_validate_discovery_facet();

CREATE FUNCTION registry_require_discovery_facets()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  expected_count integer;
  actual_count integer;
BEGIN
  expected_count :=
    cardinality(NEW.languages)
    + cardinality(NEW.ecosystems)
    + cardinality(NEW.tags);

  SELECT count(*)::integer
    INTO actual_count
    FROM public.registry_release_discovery_facets AS facet
   WHERE facet.release_id = NEW.release_id
     AND facet.package_id = NEW.package_id;

  IF actual_count <> expected_count THEN
    RAISE EXCEPTION
      'registry discovery metadata requires an exact normalized facet index'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER registry_release_discovery_require_facets
  AFTER INSERT ON registry_release_discovery
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION registry_require_discovery_facets();

CREATE FUNCTION registry_validate_discovery_projection()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_package_id text;
  selected_release_id text;
  expected_release_id text;
BEGIN
  IF TG_TABLE_NAME = 'registry_packages' THEN
    target_package_id := NEW.id;
  ELSE
    target_package_id := NEW.package_id;
  END IF;

  -- A deferred trigger can have several queued UPDATE events for one package.
  -- Validate the row's final transactional state, not the historical NEW value
  -- captured by an earlier event in the same publish/yank transaction.
  SELECT discovery_release_id
    INTO selected_release_id
    FROM public.registry_packages
   WHERE id = target_package_id;

  SELECT id
    INTO expected_release_id
    FROM public.registry_releases
   WHERE package_id = target_package_id
     AND status = 'published'
   ORDER BY semver_sort_key DESC, semver_version_tie_key DESC
   LIMIT 1;

  IF selected_release_id IS DISTINCT FROM expected_release_id THEN
    RAISE EXCEPTION 'registry package discovery projection is stale'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER registry_packages_discovery_projection
  AFTER UPDATE OF discovery_release_id ON registry_packages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION registry_validate_discovery_projection();

CREATE CONSTRAINT TRIGGER registry_releases_discovery_projection
  AFTER INSERT OR UPDATE OF status ON registry_releases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION registry_validate_discovery_projection();

CREATE FUNCTION registry_require_release_discovery()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.registry_release_discovery AS discovery
     WHERE discovery.release_id = NEW.id
       AND discovery.package_id = NEW.package_id
  ) THEN
    RAISE EXCEPTION 'registry release requires verified discovery metadata'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER registry_releases_require_discovery
  AFTER INSERT ON registry_releases
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION registry_require_release_discovery();
