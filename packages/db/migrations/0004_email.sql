CREATE TABLE "alerts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"job_id" integer,
	"mail_message_id" integer,
	"reply_id" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"phone_sent_at" timestamp with time zone,
	"phone_attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"sealed" "bytea" NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mail_account" (
	"id" integer PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"uid_validity" bigint,
	"last_uid" bigint,
	"last_read_at" timestamp with time zone,
	"backfill_done" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"error" text,
	CONSTRAINT "mail_account_single_row" CHECK ("mail_account"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "mail_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mail_ignored" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail_ignored_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"message_id" text NOT NULL,
	"uid" bigint NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text NOT NULL,
	"subject" text NOT NULL,
	"company" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"promote" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mail_ignored_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "mail_ignored" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"message_id" text NOT NULL,
	"thread_key" text NOT NULL,
	"direction" text NOT NULL,
	"uid" bigint,
	"from_address" text NOT NULL,
	"from_name" text NOT NULL,
	"to_address" text NOT NULL,
	"reply_to" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"in_reply_to" text,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auto_submitted" boolean DEFAULT false NOT NULL,
	"list_id" boolean DEFAULT false NOT NULL,
	"backfill" boolean DEFAULT false NOT NULL,
	"corrected" boolean DEFAULT false NOT NULL,
	"force_classify" boolean DEFAULT false NOT NULL,
	"kind" text,
	"summary" text,
	"lang" text,
	"requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"job_id" integer,
	"linked_by" text,
	"classified_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mail_messages_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "mail_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mail_replies" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mail_replies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"message_id" integer NOT NULL,
	"origin" text NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"attach_resume" boolean DEFAULT false NOT NULL,
	"state" text NOT NULL,
	"approved_by" text,
	"out_message_id" text,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	CONSTRAINT "mail_replies_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "mail_replies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_events" ADD COLUMN "mail_message_id" integer;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_mail_message_id_mail_messages_id_fk" FOREIGN KEY ("mail_message_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_reply_id_mail_replies_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."mail_replies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_replies" ADD CONSTRAINT "mail_replies_message_id_mail_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."mail_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_messages_thread_idx" ON "mail_messages" USING btree ("thread_key");--> statement-breakpoint
CREATE INDEX "mail_messages_job_idx" ON "mail_messages" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_mail_message_id_mail_messages_id_fk" FOREIGN KEY ("mail_message_id") REFERENCES "public"."mail_messages"("id") ON DELETE set null ON UPDATE no action;