ALTER TABLE "provider_groups" ADD COLUMN "sticky_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_groups" ADD COLUMN "sticky_ttl_hours" integer DEFAULT 168 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_groups" ADD COLUMN "max_active_users_per_provider" integer;