ALTER TABLE "job_events" ADD COLUMN "undone" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "job_events_mail_message_idx" ON "job_events" USING btree ("mail_message_id");--> statement-breakpoint
ALTER TABLE "mail_replies" ADD CONSTRAINT "mail_replies_ai_not_auto" CHECK ("mail_replies"."origin" <> 'ai' OR "mail_replies"."approved_by" IS DISTINCT FROM 'auto');--> statement-breakpoint
UPDATE "job_events" SET "undone" = true FROM "mail_messages" WHERE "job_events"."mail_message_id" = "mail_messages"."id" AND "job_events"."actor" = 'email' AND "mail_messages"."corrected";