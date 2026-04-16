-- Migration: Change audit_log from per-request to per-session model
-- IMPORTANT: Run "DELETE FROM audit_log;" before this migration if you have existing data

-- Drop old columns
ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "request_id";
ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "request_seq";
ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "status_code";

-- Add new columns
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "request_count" integer DEFAULT 1;
ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

-- Make session_id NOT NULL (required for unique constraint)
ALTER TABLE "audit_log" ALTER COLUMN "session_id" SET NOT NULL;

-- Set defaults for token columns
ALTER TABLE "audit_log" ALTER COLUMN "input_tokens" SET DEFAULT 0;
ALTER TABLE "audit_log" ALTER COLUMN "output_tokens" SET DEFAULT 0;
ALTER TABLE "audit_log" ALTER COLUMN "content_size" SET DEFAULT 0;

-- Drop old indexes
DROP INDEX IF EXISTS "idx_audit_log_session_seq";

-- Add unique constraint on session_id
CREATE UNIQUE INDEX IF NOT EXISTS "idx_audit_log_session_id_uniq" ON "audit_log" ("session_id");
