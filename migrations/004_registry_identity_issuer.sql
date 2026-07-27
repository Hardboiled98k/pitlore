ALTER TABLE registry_users
  ADD COLUMN identity_issuer text;

CREATE UNIQUE INDEX registry_users_verified_identity_idx
  ON registry_users (issuer, identity_issuer, subject)
  WHERE identity_issuer IS NOT NULL;
