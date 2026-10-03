CREATE TABLE IF NOT EXISTS "time_block_calendar_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"time_block_id" uuid,
	"calendar_id" uuid NOT NULL,
	"external_id" varchar(500) NOT NULL,
	"timezone" varchar(100) NOT NULL,
	"last_synced_schedule" jsonb,
	"last_synced_at" timestamp,
	"sync_error" varchar(1000),
	"html_link" varchar(1000),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_block_calendar_links" ADD CONSTRAINT "time_block_calendar_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_block_calendar_links" ADD CONSTRAINT "time_block_calendar_links_time_block_id_time_blocks_id_fk" FOREIGN KEY ("time_block_id") REFERENCES "public"."time_blocks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_block_calendar_links" ADD CONSTRAINT "time_block_calendar_links_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "time_block_calendar_links_block_idx" ON "time_block_calendar_links" USING btree ("time_block_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "time_block_calendar_links_event_idx" ON "time_block_calendar_links" USING btree ("calendar_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_block_calendar_links_user_idx" ON "time_block_calendar_links" USING btree ("user_id");