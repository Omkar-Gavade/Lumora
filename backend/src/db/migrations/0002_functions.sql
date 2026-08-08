-- Schema-level functions used by every table that follows.

-- ─── uuidv7 ──────────────────────────────────────────────────────────────────
--
-- docs/04-data-and-api.md §1 specifies UUIDv7 primary keys: the first 48 bits
-- are a millisecond timestamp, so keys sort by creation time. That keeps B-tree
-- inserts appending to the rightmost page instead of scattering across the
-- index the way UUIDv4 does, and it makes range scans on creation time cheap.
--
-- PostgreSQL 18 ships uuidv7() natively. On 17 and earlier it does not exist,
-- so it is defined here — created only when absent, so upgrading the server
-- later switches to the built-in with no migration and no behavior change.
--
-- Layout (RFC 9562 §5.7):
--   bytes 0-5   48-bit big-endian unix timestamp in milliseconds
--   byte  6     high nibble = version (7), low nibble random
--   byte  8     top two bits = variant (0b10), rest random
--   remainder   random
DO $outer$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc
    WHERE proname = 'uuidv7'
      AND pronamespace = 'pg_catalog'::regnamespace
  ) THEN
    EXECUTE $fn$
      CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $body$
      DECLARE
        ts_millis bigint;
        bytes     bytea;
      BEGIN
        ts_millis := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;

        -- Start fully random, then overwrite the structured fields. Every bit
        -- not dictated by the spec stays random, which is what keeps keys
        -- unguessable — a sequential id in a URL is an enumeration invitation.
        bytes := gen_random_bytes(16);

        -- int8send yields 8 big-endian bytes; the low 6 carry the timestamp.
        bytes := overlay(bytes PLACING substring(int8send(ts_millis) FROM 3 FOR 6) FROM 1 FOR 6);

        -- 0x70 = version 7 in the high nibble, low nibble left random.
        bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
        -- 0x80 = variant 0b10 in the top two bits, rest left random.
        bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);

        RETURN encode(bytes, 'hex')::uuid;
      END;
      $body$ LANGUAGE plpgsql VOLATILE PARALLEL SAFE;
    $fn$;
  END IF;
END
$outer$;

-- ─── updated_at ──────────────────────────────────────────────────────────────
--
-- docs/04-data-and-api.md §1: "created_at/updated_at on every table with an
-- updated_at trigger".
--
-- A trigger rather than application code, because `updated_at` must be true for
-- every writer — a migration, a psql session, a future background job — not
-- only for the paths that remembered to set it.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
