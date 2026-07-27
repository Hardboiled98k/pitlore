-- Persist a PostgreSQL-native SemVer precedence key so release pagination can
-- use an indexed keyset and read only the requested page plus one lookahead.
-- The parser deliberately matches the strict `semver` contract used by the
-- application: 256 ASCII characters, safe core integers, strict prerelease
-- identifiers, and build metadata excluded from precedence.

CREATE FUNCTION registry_semver_sort_key(input_version text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  parsed text[];
  prerelease_identifier text;
  sort_key text[];
  core_identifier text;
BEGIN
  IF length(input_version) > 256 THEN
    RAISE EXCEPTION 'registry release version is not strict SemVer'
      USING ERRCODE = '22023';
  END IF;

  parsed := regexp_match(
    input_version COLLATE "C",
    '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?(\+([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'
  );
  IF parsed IS NULL THEN
    RAISE EXCEPTION 'registry release version is not strict SemVer'
      USING ERRCODE = '22023';
  END IF;

  FOREACH core_identifier IN ARRAY parsed[1:3]
  LOOP
    IF length(core_identifier) > 16
      OR (
        length(core_identifier) = 16
        AND core_identifier COLLATE "C" > '9007199254740991' COLLATE "C"
      )
    THEN
      RAISE EXCEPTION 'registry release SemVer core exceeds Number.MAX_SAFE_INTEGER'
        USING ERRCODE = '22003';
    END IF;
  END LOOP;

  sort_key := ARRAY[
    lpad(parsed[1], 16, '0'),
    lpad(parsed[2], 16, '0'),
    lpad(parsed[3], 16, '0')
  ];

  IF parsed[5] IS NULL THEN
    -- A stable release has greater precedence than every prerelease with the
    -- same core version.
    RETURN array_append(sort_key, '1:');
  END IF;

  sort_key := array_append(sort_key, '0:');
  FOREACH prerelease_identifier IN ARRAY string_to_array(parsed[5], '.')
  LOOP
    IF prerelease_identifier ~ '^[0-9]+$' THEN
      IF length(prerelease_identifier) > 1
        AND left(prerelease_identifier, 1) = '0'
      THEN
        RAISE EXCEPTION 'registry release SemVer numeric prerelease has a leading zero'
          USING ERRCODE = '22023';
      END IF;
      -- Numeric identifiers may be longer than Number.MAX_SAFE_INTEGER. Their
      -- digit length followed by digits preserves arbitrary-precision order.
      sort_key := array_append(
        sort_key,
        '0:' || lpad(length(prerelease_identifier)::text, 3, '0') || ':' ||
          prerelease_identifier
      );
    ELSE
      -- SemVer orders every numeric identifier before every non-numeric one,
      -- then compares non-numeric identifiers by ASCII code point.
      sort_key := array_append(sort_key, '1:' || prerelease_identifier);
    END IF;
  END LOOP;

  RETURN sort_key;
END;
$$;

ALTER TABLE registry_releases
  ADD COLUMN semver_sort_key text[] COLLATE "C"
    GENERATED ALWAYS AS (registry_semver_sort_key(version)) STORED,
  ADD COLUMN semver_version_tie_key text COLLATE "C"
    GENERATED ALWAYS AS (version) STORED;

CREATE INDEX registry_releases_package_semver_keyset_idx
  ON registry_releases
    (package_id, semver_sort_key DESC, semver_version_tie_key DESC);
