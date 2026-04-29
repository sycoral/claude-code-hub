-- =================================================================
-- Manual migration bundle v0.7.4 — fork delta on top of v0.7.1
--
-- Targets servers that have ALREADY applied
-- deploy/manual-migrations-v0.7.1.sql (migrations 0088 → 0099).
--
-- Upstream v0.7.2/v0.7.3/v0.7.4 added no schema changes; this bundle
-- only carries the fork's pinned-version feature (migration 0100).
-- Fresh machines should keep using the regular AUTO_MIGRATE path or
-- run drizzle:migrate; this file is for hand-executed prod upgrades.
--
-- Safe to re-run from ANY starting state — same two-layer idempotency
-- as the v0.7.1 bundle:
--   1. Hash-gated via drizzle.__drizzle_migrations + psql \if/\gset
--   2. ALTER TABLE ADD COLUMN IF NOT EXISTS makes a hash-mismatch
--      reapply harmless
--
-- Invocation:
--   podman exec -i <pg_container> \
--     psql -U postgres -d claude_code_hub \
--       -v ON_ERROR_STOP=1 --single-transaction \
--     < deploy/manual-migrations-v0.7.4.sql
-- =================================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
);

-- =================================================================
-- Migration 1/1: 0100_client_version_pinned
-- =================================================================
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '8fad95af7259370be84c60cac936b768531a68a8182fd5ce9e087f310cabeb3d') AS run_0100_client_version_pinned \gset
\if :run_0100_client_version_pinned
\echo Running 0100_client_version_pinned

ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "client_version_pinned" jsonb DEFAULT '{}'::jsonb NOT NULL;

INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('8fad95af7259370be84c60cac936b768531a68a8182fd5ce9e087f310cabeb3d', 1777431845967);
\else
\echo Skipping 0100_client_version_pinned (already applied)
\endif

-- Done. --single-transaction auto-COMMITs on clean exit.
