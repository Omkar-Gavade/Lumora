-- Database-level prerequisites. No application tables — those arrive with the
-- milestone that owns them (docs/04-data-and-api.md §1.1).
--
-- Extensions are separated from the tables that use them on purpose: CREATE
-- EXTENSION needs privileges an application role often does not have, so a
-- deployment where a DBA runs this file once and the service runs the rest is
-- a normal arrangement, not a special case.

-- Case-insensitive text. `users.email` is CITEXT so that uniqueness and lookup
-- are case-insensitive in the database rather than depending on every call site
-- remembering to lowercase first — which is how duplicate accounts differing
-- only by capitalisation get created.
CREATE EXTENSION IF NOT EXISTS citext;

-- gen_random_bytes / digest, used for token hashing, and gen_random_uuid() as
-- the primary-key default until the schema moves to uuidv7() (native in
-- PostgreSQL 18; docs/04-data-and-api.md §1 specifies uuidv7 for index
-- locality). Which one applies is decided in M2 against the deployed server
-- version, in the migration that creates the first table.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
