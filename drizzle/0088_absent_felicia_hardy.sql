CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"user_name" varchar(128),
	"key" varchar NOT NULL,
	"session_id" varchar(64),
	"request_seq" integer DEFAULT 1,
	"model" varchar(128),
	"endpoint" varchar(256),
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cost_usd" numeric(21, 15) DEFAULT '0',
	"status_code" integer,
	"content_summary" text,
	"content_path" varchar(512),
	"content_size" integer,
	"compressed" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_user_created_at" ON "audit_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_session_seq" ON "audit_log" USING btree ("session_id","request_seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_created_at_id" ON "audit_log" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_log_model" ON "audit_log" USING btree ("model");