-- =================================================================
-- Manual migration bundle v0.7.6 — incremental on top of v0.7.5 bundle
--
-- Contains:
--   - 0101_thin_toro: provider_groups.load_sort_mode
--   - 0102_overrated_the_professor: providers.max_active_users_override
--
-- Apply v0.7.1 + v0.7.5 bundles first if not already applied.
--
-- Safe to re-run: hash-gated + DDL-level IF NOT EXISTS.
--
-- Invocation:
--   podman exec -i <pg_container> \
--     psql -U postgres -d claude_code_hub \
--       -v ON_ERROR_STOP=1 --single-transaction \
--     < deploy/manual-migrations-v0.7.6.sql
-- =================================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
);

-- ----------------------------------------------------------------
-- Migration 0101_thin_toro: provider_groups load_sort_mode field
-- Hash: b064df23d4975eb66c961a4c141f360e73b87f32c5c6f02ca97a91a1aea49011
-- created_at (ms): 1778160163677
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = 'b064df23d4975eb66c961a4c141f360e73b87f32c5c6f02ca97a91a1aea49011') AS run_0101_thin_toro \gset
\if :run_0101_thin_toro
\echo Running 0101_thin_toro
ALTER TABLE "provider_groups" ADD COLUMN IF NOT EXISTS "load_sort_mode" varchar(20) DEFAULT 'headcount' NOT NULL;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('b064df23d4975eb66c961a4c141f360e73b87f32c5c6f02ca97a91a1aea49011', 1778160163677);
\else
\echo Skipping 0101_thin_toro (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 0102_overrated_the_professor: providers.max_active_users_override
-- Hash: 844e8334e77e717823f76d424bc4bf820a65e771d241a53462c59943bbd177fe
-- created_at (ms): 1778734817838
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '844e8334e77e717823f76d424bc4bf820a65e771d241a53462c59943bbd177fe') AS run_0102_overrated_the_professor \gset
\if :run_0102_overrated_the_professor
\echo Running 0102_overrated_the_professor
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "max_active_users_override" integer;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('844e8334e77e717823f76d424bc4bf820a65e771d241a53462c59943bbd177fe', 1778734817838);
\else
\echo Skipping 0102_overrated_the_professor (already applied)
\endif

-- Done. --single-transaction auto-COMMITs on clean exit.
