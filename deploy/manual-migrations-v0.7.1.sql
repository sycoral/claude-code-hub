-- =================================================================
-- Manual migration bundle v3 — hash-gated + DDL-level idempotency
-- 
-- Safe to re-run from ANY starting state:
--   * Fresh DB
--   * Pre-v0.7.1 local deploy (legacy session-schema audit_log)
--   * App already auto-migrated (drizzle.__drizzle_migrations populated)
--   * App applied schema under DIFFERENT hash (bytes drift) — this is what
--     v2 missed: the hash check said 'run it' but the column already existed.
--     v3 adds ADD COLUMN IF NOT EXISTS on top, so re-apply is harmless.
--   * Fully migrated (complete no-op)
-- 
-- Idempotency mechanisms (two layers):
--   1. Each migration gated by hash in drizzle.__drizzle_migrations via
--      psql \if + \gset — skips the whole block if hash matches.
--   2. Inside the block, ALTER TABLE ADD COLUMN is rewritten to use
--      IF NOT EXISTS so even on hash mismatch, the DDL is harmless.
-- 
-- Invocation:
--   podman exec -i <pg_container> \
--     psql -U postgres -d claude_code_hub \
--       -v ON_ERROR_STOP=1 --single-transaction \
--     < deploy/manual-migrations-v0.7.1.sql
-- 
-- HEAVY-OPERATION WARNING:
--   Migration 0088's CREATE INDEX on message_request can block writes during
--   build. Prefer out-of-band creation with CONCURRENTLY first:
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS
--       "idx_message_request_provider_created_at_finalized_active"
--       ON "message_request" (provider_id, created_at DESC NULLS LAST)
--       WHERE deleted_at IS NULL AND status_code IS NOT NULL;
-- =================================================================

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS "drizzle";
CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at numeric
);

-- =================================================================
-- PRE-STEP: rename legacy audit_log (session schema) → conversation_audit_log
-- =================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename = 'audit_log'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'audit_log'
      AND column_name = 'session_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename = 'conversation_audit_log'
  ) THEN
    ALTER TABLE "audit_log" RENAME TO "conversation_audit_log";
    ALTER INDEX IF EXISTS "idx_audit_log_session_id_uniq" RENAME TO "idx_conversation_audit_log_session_id_uniq";
    ALTER INDEX IF EXISTS "idx_audit_log_user_created_at" RENAME TO "idx_conversation_audit_log_user_created_at";
    ALTER INDEX IF EXISTS "idx_audit_log_session_seq" RENAME TO "idx_conversation_audit_log_session_seq";
    ALTER INDEX IF EXISTS "idx_audit_log_created_at_id" RENAME TO "idx_conversation_audit_log_created_at_id";
    ALTER INDEX IF EXISTS "idx_audit_log_model" RENAME TO "idx_conversation_audit_log_model";
    RAISE NOTICE 'PRE-STEP: renamed legacy audit_log → conversation_audit_log';
  ELSE
    RAISE NOTICE 'PRE-STEP: no legacy audit_log to rename';
  END IF;
END
$$;

-- =================================================================
-- Cleanup orphan drizzle rows (legacy local audit migrations)
-- =================================================================
DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash IN (
  '05d674fbbcb4d7c51d4a1a90f15d88607b306b40fc95e24a527db449324a545d',  -- 0088_absent_felicia_hardy (legacy)
  '3f85f8f543a7e1ebef7bcaa8daa7c9564e22b66a281a6ab066b42692febba3df',  -- 0089_supreme_skreet (legacy)
  '7594de911706f9890f3c9a4cb5a21df4fef91a8324bc74a5e4e4f8cf4871aa6b'   -- 0090_audit_session_model (legacy)
);

-- ----------------------------------------------------------------
-- Migration 1/12: 0088_amazing_energizer
-- Hash: 8c216238324d86b4d908947e5a542f43bce989ad99cd288b6014ddb684b6a39d
-- created_at (ms): 1776095902010
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '8c216238324d86b4d908947e5a542f43bce989ad99cd288b6014ddb684b6a39d') AS run_0088_amazing_energizer \gset
\if :run_0088_amazing_energizer
\echo Running 0088_amazing_energizer
-- Note: message_request is a high-write table. Standard CREATE INDEX may block writes during index creation.
-- Drizzle migrator does not support CREATE INDEX CONCURRENTLY. If write blocking is a concern,
-- manually pre-create this index with CONCURRENTLY before running this migration (IF NOT EXISTS prevents conflicts).
CREATE INDEX IF NOT EXISTS "idx_message_request_provider_created_at_finalized_active" ON "message_request" USING btree ("provider_id","created_at" DESC NULLS LAST) WHERE "message_request"."deleted_at" IS NULL AND "message_request"."status_code" IS NOT NULL;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('8c216238324d86b4d908947e5a542f43bce989ad99cd288b6014ddb684b6a39d', 1776095902010);
\else
\echo Skipping 0088_amazing_energizer (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 2/12: 0089_curly_grey_gargoyle
-- Hash: 6ebc47c8396bb69ca8de489b0d1d69f9b20bdf49a3cb0348d93f81b9daf221a5
-- created_at (ms): 1776409181358
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '6ebc47c8396bb69ca8de489b0d1d69f9b20bdf49a3cb0348d93f81b9daf221a5') AS run_0089_curly_grey_gargoyle \gset
\if :run_0089_curly_grey_gargoyle
\echo Running 0089_curly_grey_gargoyle
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"action_category" varchar(32) NOT NULL,
	"action_type" varchar(64) NOT NULL,
	"target_type" varchar(32),
	"target_id" varchar(64),
	"target_name" varchar(256),
	"before_value" jsonb,
	"after_value" jsonb,
	"operator_user_id" integer,
	"operator_user_name" varchar(128),
	"operator_key_id" integer,
	"operator_key_name" varchar(128),
	"operator_ip" varchar(45),
	"user_agent" varchar(512),
	"success" boolean NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"cost_multiplier" numeric(10, 4) DEFAULT '1.0' NOT NULL,
	"description" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_groups_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "group_cost_multiplier" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "cost_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "client_ip" varchar(45);--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "ip_extraction_config" jsonb;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "ip_geo_lookup_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN IF NOT EXISTS "group_cost_multiplier" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN IF NOT EXISTS "client_ip" varchar(45);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_category_created_at" ON "audit_log" USING btree ("action_category","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_operator_user_created_at" ON "audit_log" USING btree ("operator_user_id","created_at" DESC NULLS LAST) WHERE "audit_log"."operator_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_operator_ip_created_at" ON "audit_log" USING btree ("operator_ip","created_at" DESC NULLS LAST) WHERE "audit_log"."operator_ip" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_target" ON "audit_log" USING btree ("target_type","target_id") WHERE "audit_log"."target_type" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_created_at_id" ON "audit_log" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_message_request_client_ip_created_at" ON "message_request" USING btree ("client_ip","created_at" DESC NULLS LAST) WHERE "message_request"."deleted_at" IS NULL AND "message_request"."client_ip" IS NOT NULL;--> statement-breakpoint
-- Update fn_upsert_usage_ledger trigger to propagate client_ip and group_cost_multiplier
-- from message_request to usage_ledger. Mirror of src/lib/ledger-backfill/trigger.sql.
CREATE OR REPLACE FUNCTION fn_upsert_usage_ledger()
RETURNS TRIGGER AS $$
DECLARE
  v_final_provider_id integer;
  v_is_success boolean;
BEGIN
  IF NEW.blocked_by = 'warmup' THEN
    UPDATE usage_ledger SET blocked_by = 'warmup' WHERE request_id = NEW.id;
    RETURN NEW;
  END IF;

  IF NEW.provider_chain IS NOT NULL
     AND jsonb_typeof(NEW.provider_chain) = 'array'
     AND jsonb_array_length(NEW.provider_chain) > 0
     AND jsonb_typeof(NEW.provider_chain -> -1) = 'object'
     AND (NEW.provider_chain -> -1 ? 'id')
     AND (NEW.provider_chain -> -1 ->> 'id') ~ '^[0-9]+$' THEN
    v_final_provider_id := (NEW.provider_chain -> -1 ->> 'id')::integer;
  ELSE
    v_final_provider_id := NEW.provider_id;
  END IF;

  v_is_success := (NEW.error_message IS NULL OR NEW.error_message = '');

  INSERT INTO usage_ledger (
    request_id, user_id, key, provider_id, final_provider_id,
    model, original_model, endpoint, api_type, session_id,
    status_code, is_success, blocked_by,
    cost_usd, cost_multiplier, group_cost_multiplier,
    input_tokens, output_tokens,
    cache_creation_input_tokens, cache_read_input_tokens,
    cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
    cache_ttl_applied, context_1m_applied, swap_cache_ttl_applied,
    duration_ms, ttfb_ms, client_ip, created_at
  ) VALUES (
    NEW.id, NEW.user_id, NEW.key, NEW.provider_id, v_final_provider_id,
    NEW.model, NEW.original_model, NEW.endpoint, NEW.api_type, NEW.session_id,
    NEW.status_code, v_is_success, NEW.blocked_by,
    NEW.cost_usd, NEW.cost_multiplier, NEW.group_cost_multiplier,
    NEW.input_tokens, NEW.output_tokens,
    NEW.cache_creation_input_tokens, NEW.cache_read_input_tokens,
    NEW.cache_creation_5m_input_tokens, NEW.cache_creation_1h_input_tokens,
    NEW.cache_ttl_applied, NEW.context_1m_applied, NEW.swap_cache_ttl_applied,
    NEW.duration_ms, NEW.ttfb_ms, NEW.client_ip, NEW.created_at
  )
  ON CONFLICT (request_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    key = EXCLUDED.key,
    provider_id = EXCLUDED.provider_id,
    final_provider_id = EXCLUDED.final_provider_id,
    model = EXCLUDED.model,
    original_model = EXCLUDED.original_model,
    endpoint = EXCLUDED.endpoint,
    api_type = EXCLUDED.api_type,
    session_id = EXCLUDED.session_id,
    status_code = EXCLUDED.status_code,
    is_success = EXCLUDED.is_success,
    blocked_by = EXCLUDED.blocked_by,
    cost_usd = EXCLUDED.cost_usd,
    cost_multiplier = EXCLUDED.cost_multiplier,
    group_cost_multiplier = EXCLUDED.group_cost_multiplier,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
    cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
    cache_creation_5m_input_tokens = EXCLUDED.cache_creation_5m_input_tokens,
    cache_creation_1h_input_tokens = EXCLUDED.cache_creation_1h_input_tokens,
    cache_ttl_applied = EXCLUDED.cache_ttl_applied,
    context_1m_applied = EXCLUDED.context_1m_applied,
    swap_cache_ttl_applied = EXCLUDED.swap_cache_ttl_applied,
    duration_ms = EXCLUDED.duration_ms,
    ttfb_ms = EXCLUDED.ttfb_ms,
    client_ip = EXCLUDED.client_ip;
    -- created_at deliberately NOT updated on conflict: it represents the
    -- original insert time of the ledger row, which is immutable by design.

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_upsert_usage_ledger failed for request_id=%: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('6ebc47c8396bb69ca8de489b0d1d69f9b20bdf49a3cb0348d93f81b9daf221a5', 1776409181358);
\else
\echo Skipping 0089_curly_grey_gargoyle (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 3/12: 0090_demonic_captain_universe
-- Hash: 8bc51f2aa51d63a5718392e76539f7674506fad6d1c1ed51ca82139b4b5875a2
-- created_at (ms): 1776421578713
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '8bc51f2aa51d63a5718392e76539f7674506fad6d1c1ed51ca82139b4b5875a2') AS run_0090_demonic_captain_universe \gset
\if :run_0090_demonic_captain_universe
\echo Running 0090_demonic_captain_universe
ALTER TABLE "provider_groups" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_groups" ALTER COLUMN "updated_at" SET NOT NULL;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('8bc51f2aa51d63a5718392e76539f7674506fad6d1c1ed51ca82139b4b5875a2', 1776421578713);
\else
\echo Skipping 0090_demonic_captain_universe (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 4/12: 0091_daily_carnage
-- Hash: 42d31e9e5d5ee7653b3bd28eb67b1cab754b2699e9d4f5cb822208767f5acdcb
-- created_at (ms): 1776767493777
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '42d31e9e5d5ee7653b3bd28eb67b1cab754b2699e9d4f5cb822208767f5acdcb') AS run_0091_daily_carnage \gset
\if :run_0091_daily_carnage
\echo Running 0091_daily_carnage
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "public_status_window_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "public_status_aggregation_interval_minutes" integer DEFAULT 5 NOT NULL;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('42d31e9e5d5ee7653b3bd28eb67b1cab754b2699e9d4f5cb822208767f5acdcb', 1776767493777);
\else
\echo Skipping 0091_daily_carnage (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 5/12: 0092_smart_stone_men
-- Hash: 1b6bbb106dac0345216a48c38727608eeff7d135016584cdcd02eee33d0f9b81
-- created_at (ms): 1776800253243
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '1b6bbb106dac0345216a48c38727608eeff7d135016584cdcd02eee33d0f9b81') AS run_0092_smart_stone_men \gset
\if :run_0092_smart_stone_men
\echo Running 0092_smart_stone_men
ALTER TABLE "keys" ADD COLUMN IF NOT EXISTS "limit_5h_reset_mode" "daily_reset_mode" DEFAULT 'rolling' NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "limit_5h_reset_mode" "daily_reset_mode" DEFAULT 'rolling' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "limit_5h_reset_mode" "daily_reset_mode" DEFAULT 'rolling' NOT NULL;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('1b6bbb106dac0345216a48c38727608eeff7d135016584cdcd02eee33d0f9b81', 1776800253243);
\else
\echo Skipping 0092_smart_stone_men (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 6/12: 0093_tricky_shockwave
-- Hash: 66e19ed0a2686f0779da64145157e83d2c7bd1f2cc5fe0958459c55109c98024
-- created_at (ms): 1776823153912
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '66e19ed0a2686f0779da64145157e83d2c7bd1f2cc5fe0958459c55109c98024') AS run_0093_tricky_shockwave \gset
\if :run_0093_tricky_shockwave
\echo Running 0093_tricky_shockwave
ALTER TABLE "provider_groups" ALTER COLUMN "description" SET DATA TYPE text;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('66e19ed0a2686f0779da64145157e83d2c7bd1f2cc5fe0958459c55109c98024', 1776823153912);
\else
\echo Skipping 0093_tricky_shockwave (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 7/12: 0094_third_spacker_dave
-- Hash: 367bf8b6af5332886251230f37dde0de3926daae8a90d609b0066d5087753ce5
-- created_at (ms): 1776831143074
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '367bf8b6af5332886251230f37dde0de3926daae8a90d609b0066d5087753ce5') AS run_0094_third_spacker_dave \gset
\if :run_0094_third_spacker_dave
\echo Running 0094_third_spacker_dave
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "limit_5h_cost_reset_at" timestamp with time zone;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('367bf8b6af5332886251230f37dde0de3926daae8a90d609b0066d5087753ce5', 1776831143074);
\else
\echo Skipping 0094_third_spacker_dave (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 8/12: 0095_young_lily_hollister
-- Hash: 8be4e71ceebbe38013ebea0069c2e6f3d1207a15e405ceb2efb532c7111c077e
-- created_at (ms): 1776916341782
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '8be4e71ceebbe38013ebea0069c2e6f3d1207a15e405ceb2efb532c7111c077e') AS run_0095_young_lily_hollister \gset
\if :run_0095_young_lily_hollister
\echo Running 0095_young_lily_hollister
ALTER TABLE "usage_ledger" ADD COLUMN IF NOT EXISTS "success_rate_outcome" varchar(16);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fn_is_message_request_finalized(
  blocked_by varchar,
  status_code integer,
  provider_chain jsonb,
  error_message text
)
RETURNS boolean AS $$
DECLARE
  last_reason text;
  last_status_code integer;
  last_error_message text;
BEGIN
  IF blocked_by IS NOT NULL THEN
    RETURN TRUE;
  END IF;

  IF status_code IS NOT NULL THEN
    RETURN TRUE;
  END IF;

  IF error_message IS NOT NULL AND error_message <> '' THEN
    RETURN TRUE;
  END IF;

  IF provider_chain IS NOT NULL
     AND jsonb_typeof(provider_chain) = 'array'
     AND jsonb_array_length(provider_chain) > 0
     AND jsonb_typeof(provider_chain -> -1) = 'object' THEN
    last_reason := provider_chain -> -1 ->> 'reason';
    IF (provider_chain -> -1 ? 'statusCode')
       AND jsonb_typeof(provider_chain -> -1 -> 'statusCode') = 'number' THEN
      last_status_code := (provider_chain -> -1 ->> 'statusCode')::integer;
    END IF;
    last_error_message := provider_chain -> -1 ->> 'errorMessage';

    IF last_reason IN (
      'request_success',
      'retry_success',
      'retry_failed',
      'system_error',
      'resource_not_found',
      'client_error_non_retryable',
      'concurrent_limit_failed',
      'hedge_winner',
      'hedge_loser_cancelled',
      'client_abort'
    )
    OR last_status_code IS NOT NULL
    OR COALESCE(last_error_message, '') <> '' THEN
      RETURN TRUE;
    END IF;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fn_compute_message_request_success_rate_outcome(
  blocked_by varchar,
  status_code integer,
  error_message text,
  provider_chain jsonb
)
RETURNS varchar AS $$
DECLARE
  last_reason text;
  last_status_code integer;
  last_error_message text;
  normalized_error text;
  has_matched_rule boolean := false;
BEGIN
  IF NOT fn_is_message_request_finalized(blocked_by, status_code, provider_chain, error_message) THEN
    RETURN NULL;
  END IF;

  IF blocked_by IS NOT NULL THEN
    RETURN 'excluded';
  END IF;

  IF provider_chain IS NOT NULL
     AND jsonb_typeof(provider_chain) = 'array'
     AND jsonb_array_length(provider_chain) > 0
     AND jsonb_typeof(provider_chain -> -1) = 'object' THEN
    last_reason := provider_chain -> -1 ->> 'reason';
    IF (provider_chain -> -1 ? 'statusCode')
       AND jsonb_typeof(provider_chain -> -1 -> 'statusCode') = 'number' THEN
      last_status_code := (provider_chain -> -1 ->> 'statusCode')::integer;
    END IF;
    last_error_message := provider_chain -> -1 ->> 'errorMessage';
    has_matched_rule := jsonb_typeof(provider_chain -> -1 -> 'errorDetails') = 'object'
      AND (provider_chain -> -1 -> 'errorDetails' ? 'matchedRule');
  END IF;

  IF has_matched_rule THEN
    RETURN 'excluded';
  END IF;

  IF COALESCE(last_status_code, status_code) IN (404, 499) THEN
    RETURN 'excluded';
  END IF;

  IF last_reason IN (
    'resource_not_found',
    'concurrent_limit_failed',
    'hedge_loser_cancelled',
    'client_error_non_retryable',
    'client_abort'
  ) THEN
    RETURN 'excluded';
  END IF;

  normalized_error := lower(COALESCE(last_error_message, error_message, ''));
  IF normalized_error LIKE '%no available provider%' THEN
    RETURN 'excluded';
  END IF;

  IF normalized_error LIKE '%insufficient quota%'
     OR normalized_error LIKE '%quota exceeded%'
     OR normalized_error LIKE '%rate limit%'
     OR normalized_error LIKE '%rate_limit%'
     OR normalized_error LIKE '%concurrency limit%'
     OR normalized_error LIKE '%concurrent limit%'
     OR normalized_error LIKE '%limit exceeded%' THEN
    RETURN 'excluded';
  END IF;

  IF last_reason IN ('request_success', 'retry_success', 'hedge_winner')
     OR COALESCE(last_status_code, status_code) BETWEEN 200 AND 399 THEN
    RETURN 'success';
  END IF;

  IF last_reason IN (
    'session_reuse',
    'initial_selection',
    'hedge_triggered',
    'hedge_launched',
    'client_restriction_filtered',
    'http2_fallback'
  )
  AND last_status_code IS NULL
  AND COALESCE(last_error_message, error_message, '') = '' THEN
    RETURN NULL;
  END IF;

  RETURN 'failure';
END;
$$ LANGUAGE plpgsql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fn_upsert_usage_ledger()
RETURNS TRIGGER AS $$
DECLARE
  v_final_provider_id integer;
  v_is_success boolean;
  v_success_rate_outcome varchar;
BEGIN
  v_success_rate_outcome := fn_compute_message_request_success_rate_outcome(
    NEW.blocked_by,
    NEW.status_code,
    NEW.error_message,
    NEW.provider_chain
  );

  IF NEW.blocked_by = 'warmup' THEN
    UPDATE usage_ledger
    SET blocked_by = 'warmup',
        success_rate_outcome = v_success_rate_outcome
    WHERE request_id = NEW.id;
    RETURN NEW;
  END IF;

  IF NEW.provider_chain IS NOT NULL
     AND jsonb_typeof(NEW.provider_chain) = 'array'
     AND jsonb_array_length(NEW.provider_chain) > 0
     AND jsonb_typeof(NEW.provider_chain -> -1) = 'object'
     AND (NEW.provider_chain -> -1 ? 'id')
     AND (NEW.provider_chain -> -1 ->> 'id') ~ '^[0-9]+$' THEN
    v_final_provider_id := (NEW.provider_chain -> -1 ->> 'id')::integer;
  ELSE
    v_final_provider_id := NEW.provider_id;
  END IF;

  v_is_success := (NEW.error_message IS NULL OR NEW.error_message = '');

  INSERT INTO usage_ledger (
    request_id, user_id, key, provider_id, final_provider_id,
    model, original_model, endpoint, api_type, session_id,
    status_code, is_success, success_rate_outcome, blocked_by,
    cost_usd, cost_multiplier, group_cost_multiplier,
    input_tokens, output_tokens,
    cache_creation_input_tokens, cache_read_input_tokens,
    cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
    cache_ttl_applied, context_1m_applied, swap_cache_ttl_applied,
    duration_ms, ttfb_ms, client_ip, created_at
  ) VALUES (
    NEW.id, NEW.user_id, NEW.key, NEW.provider_id, v_final_provider_id,
    NEW.model, NEW.original_model, NEW.endpoint, NEW.api_type, NEW.session_id,
    NEW.status_code, v_is_success, v_success_rate_outcome, NEW.blocked_by,
    NEW.cost_usd, NEW.cost_multiplier, NEW.group_cost_multiplier,
    NEW.input_tokens, NEW.output_tokens,
    NEW.cache_creation_input_tokens, NEW.cache_read_input_tokens,
    NEW.cache_creation_5m_input_tokens, NEW.cache_creation_1h_input_tokens,
    NEW.cache_ttl_applied, NEW.context_1m_applied, NEW.swap_cache_ttl_applied,
    NEW.duration_ms, NEW.ttfb_ms, NEW.client_ip, NEW.created_at
  )
  ON CONFLICT (request_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    key = EXCLUDED.key,
    provider_id = EXCLUDED.provider_id,
    final_provider_id = EXCLUDED.final_provider_id,
    model = EXCLUDED.model,
    original_model = EXCLUDED.original_model,
    endpoint = EXCLUDED.endpoint,
    api_type = EXCLUDED.api_type,
    session_id = EXCLUDED.session_id,
    status_code = EXCLUDED.status_code,
    is_success = EXCLUDED.is_success,
    success_rate_outcome = EXCLUDED.success_rate_outcome,
    blocked_by = EXCLUDED.blocked_by,
    cost_usd = EXCLUDED.cost_usd,
    cost_multiplier = EXCLUDED.cost_multiplier,
    group_cost_multiplier = EXCLUDED.group_cost_multiplier,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
    cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
    cache_creation_5m_input_tokens = EXCLUDED.cache_creation_5m_input_tokens,
    cache_creation_1h_input_tokens = EXCLUDED.cache_creation_1h_input_tokens,
    cache_ttl_applied = EXCLUDED.cache_ttl_applied,
    context_1m_applied = EXCLUDED.context_1m_applied,
    swap_cache_ttl_applied = EXCLUDED.swap_cache_ttl_applied,
    duration_ms = EXCLUDED.duration_ms,
    ttfb_ms = EXCLUDED.ttfb_ms,
    client_ip = EXCLUDED.client_ip;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_upsert_usage_ledger failed for request_id=%: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('8be4e71ceebbe38013ebea0069c2e6f3d1207a15e405ceb2efb532c7111c077e', 1776916341782);
\else
\echo Skipping 0095_young_lily_hollister (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 9/12: 0096_nosy_lifeguard
-- Hash: fb0611e011de581bcd21015c68fe4369c5af3a98ecfe7450abd0aea23e935311
-- created_at (ms): 1776930506029
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = 'fb0611e011de581bcd21015c68fe4369c5af3a98ecfe7450abd0aea23e935311') AS run_0096_nosy_lifeguard \gset
\if :run_0096_nosy_lifeguard
\echo Running 0096_nosy_lifeguard
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "pass_through_upstream_error_message" boolean DEFAULT true NOT NULL;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('fb0611e011de581bcd21015c68fe4369c5af3a98ecfe7450abd0aea23e935311', 1776930506029);
\else
\echo Skipping 0096_nosy_lifeguard (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 10/12: 0097_flaky_bishop
-- Hash: 69c8bf95d4a7df3b92c2681f227420a237636d20f9aa080f824379bdc6225e3e
-- created_at (ms): 1776965161942
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '69c8bf95d4a7df3b92c2681f227420a237636d20f9aa080f824379bdc6225e3e') AS run_0097_flaky_bishop \gset
\if :run_0097_flaky_bishop
\echo Running 0097_flaky_bishop
ALTER TABLE "message_request" ADD COLUMN IF NOT EXISTS "actual_response_model" varchar(128);--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN IF NOT EXISTS "actual_response_model" varchar(128);--> statement-breakpoint
-- Update fn_upsert_usage_ledger trigger to propagate actual_response_model
-- from message_request to usage_ledger. Mirror of src/lib/ledger-backfill/trigger.sql.
CREATE OR REPLACE FUNCTION fn_upsert_usage_ledger()
RETURNS TRIGGER AS $$
DECLARE
  v_final_provider_id integer;
  v_is_success boolean;
  v_success_rate_outcome varchar;
BEGIN
  v_success_rate_outcome := fn_compute_message_request_success_rate_outcome(
    NEW.blocked_by,
    NEW.status_code,
    NEW.error_message,
    NEW.provider_chain
  );

  IF NEW.blocked_by = 'warmup' THEN
    -- If a ledger row already exists (row was originally non-warmup), mark it as warmup
    -- and sync the latest actual_response_model so audit stays consistent across tables.
    UPDATE usage_ledger
    SET blocked_by = 'warmup',
        success_rate_outcome = v_success_rate_outcome,
        actual_response_model = NEW.actual_response_model
    WHERE request_id = NEW.id;
    RETURN NEW;
  END IF;

  IF NEW.provider_chain IS NOT NULL
     AND jsonb_typeof(NEW.provider_chain) = 'array'
     AND jsonb_array_length(NEW.provider_chain) > 0
     AND jsonb_typeof(NEW.provider_chain -> -1) = 'object'
     AND (NEW.provider_chain -> -1 ? 'id')
     AND (NEW.provider_chain -> -1 ->> 'id') ~ '^[0-9]+$' THEN
    v_final_provider_id := (NEW.provider_chain -> -1 ->> 'id')::integer;
  ELSE
    v_final_provider_id := NEW.provider_id;
  END IF;

  v_is_success := (NEW.error_message IS NULL OR NEW.error_message = '');

  INSERT INTO usage_ledger (
    request_id, user_id, key, provider_id, final_provider_id,
    model, original_model, actual_response_model, endpoint, api_type, session_id,
    status_code, is_success, success_rate_outcome, blocked_by,
    cost_usd, cost_multiplier, group_cost_multiplier,
    input_tokens, output_tokens,
    cache_creation_input_tokens, cache_read_input_tokens,
    cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
    cache_ttl_applied, context_1m_applied, swap_cache_ttl_applied,
    duration_ms, ttfb_ms, client_ip, created_at
  ) VALUES (
    NEW.id, NEW.user_id, NEW.key, NEW.provider_id, v_final_provider_id,
    NEW.model, NEW.original_model, NEW.actual_response_model, NEW.endpoint, NEW.api_type, NEW.session_id,
    NEW.status_code, v_is_success, v_success_rate_outcome, NEW.blocked_by,
    NEW.cost_usd, NEW.cost_multiplier, NEW.group_cost_multiplier,
    NEW.input_tokens, NEW.output_tokens,
    NEW.cache_creation_input_tokens, NEW.cache_read_input_tokens,
    NEW.cache_creation_5m_input_tokens, NEW.cache_creation_1h_input_tokens,
    NEW.cache_ttl_applied, NEW.context_1m_applied, NEW.swap_cache_ttl_applied,
    NEW.duration_ms, NEW.ttfb_ms, NEW.client_ip, NEW.created_at
  )
  ON CONFLICT (request_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    key = EXCLUDED.key,
    provider_id = EXCLUDED.provider_id,
    final_provider_id = EXCLUDED.final_provider_id,
    model = EXCLUDED.model,
    original_model = EXCLUDED.original_model,
    actual_response_model = EXCLUDED.actual_response_model,
    endpoint = EXCLUDED.endpoint,
    api_type = EXCLUDED.api_type,
    session_id = EXCLUDED.session_id,
    status_code = EXCLUDED.status_code,
    is_success = EXCLUDED.is_success,
    success_rate_outcome = EXCLUDED.success_rate_outcome,
    blocked_by = EXCLUDED.blocked_by,
    cost_usd = EXCLUDED.cost_usd,
    cost_multiplier = EXCLUDED.cost_multiplier,
    group_cost_multiplier = EXCLUDED.group_cost_multiplier,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
    cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
    cache_creation_5m_input_tokens = EXCLUDED.cache_creation_5m_input_tokens,
    cache_creation_1h_input_tokens = EXCLUDED.cache_creation_1h_input_tokens,
    cache_ttl_applied = EXCLUDED.cache_ttl_applied,
    context_1m_applied = EXCLUDED.context_1m_applied,
    swap_cache_ttl_applied = EXCLUDED.swap_cache_ttl_applied,
    duration_ms = EXCLUDED.duration_ms,
    ttfb_ms = EXCLUDED.ttfb_ms,
    client_ip = EXCLUDED.client_ip;
    -- created_at deliberately NOT updated on conflict: it represents the
    -- original insert time of the ledger row, which is immutable by design.

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_upsert_usage_ledger failed for request_id=%: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('69c8bf95d4a7df3b92c2681f227420a237636d20f9aa080f824379bdc6225e3e', 1776965161942);
\else
\echo Skipping 0097_flaky_bishop (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 11/12: 0098_equal_selene
-- Hash: 431224a0a57a0f7f42db8e19cb41b45f0a13e722ca4a27473e41ace83378c9c7
-- created_at (ms): 1776965161943
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = '431224a0a57a0f7f42db8e19cb41b45f0a13e722ca4a27473e41ace83378c9c7') AS run_0098_equal_selene \gset
\if :run_0098_equal_selene
\echo Running 0098_equal_selene
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "allow_non_conversation_endpoint_provider_fallback" boolean DEFAULT true NOT NULL;

DELETE FROM "usage_ledger"
WHERE "endpoint" IS NOT NULL
  AND LOWER(REGEXP_REPLACE("endpoint", '/+$', ''))
    IN ('/v1/messages/count_tokens', '/v1/responses/compact');

CREATE OR REPLACE FUNCTION fn_upsert_usage_ledger()
RETURNS TRIGGER AS $$
DECLARE
  v_final_provider_id integer;
  v_is_success boolean;
  v_success_rate_outcome varchar;
BEGIN
  v_success_rate_outcome := fn_compute_message_request_success_rate_outcome(
    NEW.blocked_by,
    NEW.status_code,
    NEW.error_message,
    NEW.provider_chain
  );

  IF NEW.blocked_by = 'warmup' THEN
    UPDATE usage_ledger
    SET blocked_by = 'warmup',
        success_rate_outcome = v_success_rate_outcome,
        actual_response_model = NEW.actual_response_model
    WHERE request_id = NEW.id;
    RETURN NEW;
  END IF;

  IF LOWER(REGEXP_REPLACE(COALESCE(NEW.endpoint, ''), '/+$', ''))
    IN ('/v1/messages/count_tokens', '/v1/responses/compact') THEN
    DELETE FROM usage_ledger WHERE request_id = NEW.id;
    RETURN NEW;
  END IF;

  IF NEW.provider_chain IS NOT NULL
     AND jsonb_typeof(NEW.provider_chain) = 'array'
     AND jsonb_array_length(NEW.provider_chain) > 0
     AND jsonb_typeof(NEW.provider_chain -> -1) = 'object'
     AND (NEW.provider_chain -> -1 ? 'id')
     AND (NEW.provider_chain -> -1 ->> 'id') ~ '^[0-9]+$' THEN
    v_final_provider_id := (NEW.provider_chain -> -1 ->> 'id')::integer;
  ELSE
    v_final_provider_id := NEW.provider_id;
  END IF;

  v_is_success := (NEW.error_message IS NULL OR NEW.error_message = '')
                  AND (NEW.status_code IS NULL OR NEW.status_code < 400);

  INSERT INTO usage_ledger (
    request_id, user_id, key, provider_id, final_provider_id,
    model, original_model, actual_response_model, endpoint, api_type, session_id,
    status_code, is_success, success_rate_outcome, blocked_by,
    cost_usd, cost_multiplier, group_cost_multiplier,
    input_tokens, output_tokens,
    cache_creation_input_tokens, cache_read_input_tokens,
    cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
    cache_ttl_applied, context_1m_applied, swap_cache_ttl_applied,
    duration_ms, ttfb_ms, client_ip, created_at
  ) VALUES (
    NEW.id, NEW.user_id, NEW.key, NEW.provider_id, v_final_provider_id,
    NEW.model, NEW.original_model, NEW.actual_response_model, NEW.endpoint, NEW.api_type,
    NEW.session_id,
    NEW.status_code, v_is_success, v_success_rate_outcome, NEW.blocked_by,
    NEW.cost_usd, NEW.cost_multiplier, NEW.group_cost_multiplier,
    NEW.input_tokens, NEW.output_tokens,
    NEW.cache_creation_input_tokens, NEW.cache_read_input_tokens,
    NEW.cache_creation_5m_input_tokens, NEW.cache_creation_1h_input_tokens,
    NEW.cache_ttl_applied, NEW.context_1m_applied, NEW.swap_cache_ttl_applied,
    NEW.duration_ms, NEW.ttfb_ms, NEW.client_ip, NEW.created_at
  )
  ON CONFLICT (request_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    key = EXCLUDED.key,
    provider_id = EXCLUDED.provider_id,
    final_provider_id = EXCLUDED.final_provider_id,
    model = EXCLUDED.model,
    original_model = EXCLUDED.original_model,
    actual_response_model = EXCLUDED.actual_response_model,
    endpoint = EXCLUDED.endpoint,
    api_type = EXCLUDED.api_type,
    session_id = EXCLUDED.session_id,
    status_code = EXCLUDED.status_code,
    is_success = EXCLUDED.is_success,
    success_rate_outcome = EXCLUDED.success_rate_outcome,
    blocked_by = EXCLUDED.blocked_by,
    cost_usd = EXCLUDED.cost_usd,
    cost_multiplier = EXCLUDED.cost_multiplier,
    group_cost_multiplier = EXCLUDED.group_cost_multiplier,
    input_tokens = EXCLUDED.input_tokens,
    output_tokens = EXCLUDED.output_tokens,
    cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
    cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
    cache_creation_5m_input_tokens = EXCLUDED.cache_creation_5m_input_tokens,
    cache_creation_1h_input_tokens = EXCLUDED.cache_creation_1h_input_tokens,
    cache_ttl_applied = EXCLUDED.cache_ttl_applied,
    context_1m_applied = EXCLUDED.context_1m_applied,
    swap_cache_ttl_applied = EXCLUDED.swap_cache_ttl_applied,
    duration_ms = EXCLUDED.duration_ms,
    ttfb_ms = EXCLUDED.ttfb_ms,
    client_ip = EXCLUDED.client_ip;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_upsert_usage_ledger failed for request_id=%: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('431224a0a57a0f7f42db8e19cb41b45f0a13e722ca4a27473e41ace83378c9c7', 1776965161943);
\else
\echo Skipping 0098_equal_selene (already applied)
\endif

-- ----------------------------------------------------------------
-- Migration 12/12: 0099_conversation_audit_log
-- Hash: ab26006653d97ca162dc2f4df30ea823e1ed1079690e161495af14ab98fffa54
-- created_at (ms): 1776965161944
-- ----------------------------------------------------------------
SELECT NOT EXISTS (SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = 'ab26006653d97ca162dc2f4df30ea823e1ed1079690e161495af14ab98fffa54') AS run_0099_conversation_audit_log \gset
\if :run_0099_conversation_audit_log
\echo Running 0099_conversation_audit_log
-- Conversation Audit Log: session-level audit of AI proxy requests.
-- Separate from the upstream "audit_log" table (admin operations audit) introduced in v0.7.1.
--
-- This migration is safe for three starting states:
--   (A) Pre-v0.7.1 local deployment: a `audit_log` table with session_id column already
--       exists (created by old local migrations 0088/0089/0090). We RENAME it to
--       `conversation_audit_log` so the upstream `audit_log` table can coexist.
--   (B) Fresh v0.7.1 install: neither `conversation_audit_log` nor a session-style
--       `audit_log` exists — we CREATE the table outright. Note that v0.7.1's own
--       `audit_log` table (admin ops) may already exist; it stays untouched since its
--       column set does not include `session_id`.
--   (C) Already-migrated: `conversation_audit_log` exists from a prior run of this
--       migration — all statements are idempotent, so it's a no-op.

DO $$
BEGIN
  -- Detect the legacy local audit_log (has session_id column) and rename it.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename = 'audit_log'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'audit_log'
      AND column_name = 'session_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename = 'conversation_audit_log'
  ) THEN
    ALTER TABLE "audit_log" RENAME TO "conversation_audit_log";

    -- Rename the indexes if they still use the old names
    ALTER INDEX IF EXISTS "idx_audit_log_session_id_uniq" RENAME TO "idx_conversation_audit_log_session_id_uniq";
    ALTER INDEX IF EXISTS "idx_audit_log_user_created_at" RENAME TO "idx_conversation_audit_log_user_created_at";
    ALTER INDEX IF EXISTS "idx_audit_log_session_seq" RENAME TO "idx_conversation_audit_log_session_seq";
    ALTER INDEX IF EXISTS "idx_audit_log_created_at_id" RENAME TO "idx_conversation_audit_log_created_at_id";
    ALTER INDEX IF EXISTS "idx_audit_log_model" RENAME TO "idx_conversation_audit_log_model";
  END IF;
END
$$;
--> statement-breakpoint

-- Fresh install path: create table if it does not exist.
CREATE TABLE IF NOT EXISTS "conversation_audit_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "user_name" varchar(128),
  "key" varchar NOT NULL,
  "session_id" varchar(64) NOT NULL,
  "model" varchar(128),
  "endpoint" varchar(256),
  "input_tokens" bigint DEFAULT 0,
  "output_tokens" bigint DEFAULT 0,
  "cost_usd" numeric(21, 15) DEFAULT '0',
  "request_count" integer DEFAULT 1,
  "total_messages" integer,
  "content_summary" text,
  "content_path" varchar(512),
  "content_size" integer DEFAULT 0,
  "compressed" boolean DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

-- Drop the stale session-seq index (only ever populated during the old per-request schema).
-- It is incompatible with the per-session schema and was replaced by the session_id uniq index.
DROP INDEX IF EXISTS "idx_conversation_audit_log_session_seq";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_conversation_audit_log_session_id_uniq"
  ON "conversation_audit_log" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversation_audit_log_user_created_at"
  ON "conversation_audit_log" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversation_audit_log_created_at_id"
  ON "conversation_audit_log" USING btree ("created_at", "id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversation_audit_log_model"
  ON "conversation_audit_log" USING btree ("model");
INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('ab26006653d97ca162dc2f4df30ea823e1ed1079690e161495af14ab98fffa54', 1776965161944);
\else
\echo Skipping 0099_conversation_audit_log (already applied)
\endif

-- =================================================================
-- Migration 13/13: 0100_client_version_pinned
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
