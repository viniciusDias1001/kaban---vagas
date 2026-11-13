-- Segurança (Supabase): cada tabela abaixo recebe ENABLE ROW LEVEL SECURITY e nenhuma policy.
-- No Supabase, tabelas do schema "public" ficam acessíveis pela API REST gerada automaticamente,
-- usando a chave pública "anon". Com RLS habilitado e sem policies, essa API não lê nem escreve
-- nada; só o papel dono das tabelas — o usado pelo DATABASE_URL do app — tem acesso.
-- Não remova os ALTER TABLE ... ENABLE ROW LEVEL SECURITY.
CREATE TABLE "application_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "application_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"application_id" integer NOT NULL,
	"status" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "applications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "applications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"job_id" integer NOT NULL,
	"site" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"detail" text,
	"trigger" text NOT NULL,
	"mode" text NOT NULL,
	"gate_score" integer,
	"resume_lang" text,
	"resume_file_name" text,
	"resume_pdf" "bytea",
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confirmation" text,
	"contact_email" text,
	"shots" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"waiting_gate" text,
	"run_after" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"form_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "applications_pdf_size_check" CHECK (octet_length("applications"."resume_pdf") <= 2097152)
);
--> statement-breakpoint
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "apply_answers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "apply_answers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"question" text NOT NULL,
	"normalized" text NOT NULL,
	"key" text,
	"answer" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"scope" text DEFAULT 'always' NOT NULL,
	"scope_value" text,
	"country" text,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apply_answers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "apply_commands" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "apply_commands_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"site" text NOT NULL,
	"status" text NOT NULL,
	"result" text,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "apply_commands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "apply_sites" (
	"site" text PRIMARY KEY NOT NULL,
	"session" text DEFAULT 'unknown' NOT NULL,
	"session_checked_at" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"pause_reason" text,
	"paused_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_rejections" integer DEFAULT 0 NOT NULL,
	"human_timeouts" integer DEFAULT 0 NOT NULL,
	"last_form_at" timestamp with time zone,
	"last_view_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "apply_sites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_events_application_idx" ON "application_events" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_job_idx" ON "applications" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "apply_answers_normalized_idx" ON "apply_answers" USING btree ("normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "apply_answers_key_idx" ON "apply_answers" USING btree ("key","country");--> statement-breakpoint
CREATE UNIQUE INDEX "apply_commands_pending_idx" ON "apply_commands" USING btree ("kind","site") WHERE "apply_commands"."status" IN ('queued', 'running');