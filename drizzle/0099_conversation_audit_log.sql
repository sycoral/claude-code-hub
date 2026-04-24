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
