-- Migration: replace_user_contacts_atomic
--
-- Issue M17 fix: auth.controller.js#updateContacts previously did a
-- DELETE (by type) followed by a separate batch UPSERT — if the upsert
-- failed after the delete succeeded, the user would lose those contact
-- methods entirely with no rollback. The same TOCTOU class of bug already
-- fixed via RPC in upsertContact (upsert_primary_contact) just above it in
-- the same file, just not applied here too.
--
-- VERIFIED AGAINST LIVE SCHEMA (kith_schema.txt):
--   user_contacts(id, user_id, type, label, value, country_code,
--                 is_primary, is_verified, verified_at, created_at)
--   UNIQUE (user_id, type, value)
--   CHECK type IN ('email_secondary','whatsapp','phone','telegram',
--                   'signal','instagram','facebook','twitter','linkedin','custom')
-- No partial-unique-index surprises here (unlike contributor_targets) —
-- this table's only relevant constraint is the (user_id, type, value)
-- uniqueness the application already upserts against.
--
-- Rollback: DROP FUNCTION IF EXISTS replace_user_contacts_atomic(uuid, text[], jsonb);

CREATE OR REPLACE FUNCTION replace_user_contacts_atomic(
  p_user_id  uuid,
  p_types    text[],
  p_contacts jsonb  -- array of { type, label, value, country_code, is_primary }
)
RETURNS SETOF user_contacts
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM user_contacts
  WHERE user_id = p_user_id
    AND type = ANY(p_types);

  RETURN QUERY
  INSERT INTO user_contacts (user_id, type, label, value, country_code, is_primary)
  SELECT
    p_user_id,
    c->>'type',
    c->>'label',
    c->>'value',
    c->>'country_code',
    COALESCE((c->>'is_primary')::boolean, false)
  FROM jsonb_array_elements(p_contacts) AS c
  ON CONFLICT (user_id, type, value) DO UPDATE SET
    label        = EXCLUDED.label,
    country_code = EXCLUDED.country_code,
    is_primary   = EXCLUDED.is_primary
  RETURNING *;
END;
$$;
