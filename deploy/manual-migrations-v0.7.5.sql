-- =================================================================
-- Manual migration bundle v0.7.5 — incremental on top of v0.7.1 bundle
--
-- Contains only migration 0100_confused_lockheed (provider_groups sticky/cap).
-- Apply v0.7.1 bundle first if not already applied (it covers 0088-0099).
--
-- Safe to re-run: hash-gated + DDL-level IF NOT EXISTS.
--
-- Invocation:
--   podman exec -i <pg_container> \
--     psql -U postgres -d claude_code_hub \
--       -v ON_ERROR_STOP=1 --single-transaction \
--     < deploy/manual-migrations-v0.7.5.sql
-- =================================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
);

-- ----------------------------------------------------------------
-- Migration 0100_confused_lockheed: provider_groups sticky/cap fields
-- Hash: fb1697e54b14444ff8e0c683e513bd6eb9e3d1c97dd42b1eabbb4c6de924d70e
-- created_at (ms): 1777620155758
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = 'fb1697e54b14444ff8e0c683e513bd6eb9e3d1c97dd42b1eabbb4c6de924d70e') AS run_0100_confused_lockheed \gset
\if :run_0100_confused_lockheed
\echo Running 0100_confused_lockheed
ALTER TABLE "provider_groups" ADD COLUMN IF NOT EXISTS "sticky_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_groups" ADD COLUMN IF NOT EXISTS "sticky_ttl_hours" integer DEFAULT 168 NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_groups" ADD COLUMN IF NOT EXISTS "max_active_users_per_provider" integer;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('fb1697e54b14444ff8e0c683e513bd6eb9e3d1c97dd42b1eabbb4c6de924d70e', 1777620155758);
\else
\echo Skipping 0100_confused_lockheed (already applied)
\endif

-- Done. --single-transaction auto-COMMITs on clean exit.
