-- Segurança (Supabase): cada tabela abaixo recebe ENABLE ROW LEVEL SECURITY e nenhuma policy.
-- No Supabase, tabelas do schema "public" ficam acessíveis pela API REST gerada automaticamente,
-- usando a chave pública "anon". Com RLS habilitado e sem policies, essa API não lê nem escreve
-- nada; só o papel dono das tabelas — o usado pelo DATABASE_URL do app — tem acesso.
-- Não remova os ALTER TABLE ... ENABLE ROW LEVEL SECURITY.
CREATE TABLE "ai_keys" (
	"provider" text PRIMARY KEY NOT NULL,
	"sealed" "bytea" NOT NULL,
	"last4" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_tasks" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_tasks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"subject" text NOT NULL,
	"job_id" integer,
	"lang" text,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"run_after" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ai_usage_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"layer" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "profiles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"lang" text NOT NULL,
	"data" jsonb NOT NULL,
	"origin" text NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "job_ai" (
	"job_id" integer PRIMARY KEY NOT NULL,
	"language" text,
	"title_pt" text,
	"score" integer,
	"reason" text,
	"tier1_state" text,
	"tier1_profile_version" integer,
	"tier1_at" timestamp with time zone,
	"description_pt" text,
	"analysis" jsonb,
	"description_available" boolean DEFAULT true NOT NULL,
	"tier2_state" text,
	"tier2_profile_version" integer,
	"tier2_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_ai" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "resumes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "resumes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"lang" text NOT NULL,
	"file_name" text NOT NULL,
	"mime" text NOT NULL,
	"content" "bytea" NOT NULL,
	"extracted_text" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "resumes_size_check" CHECK (octet_length("resumes"."content") <= 5242880)
);
--> statement-breakpoint
ALTER TABLE "resumes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tailored_resumes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tailored_resumes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"job_id" integer NOT NULL,
	"lang" text NOT NULL,
	"content" jsonb NOT NULL,
	"profile_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tailored_resumes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "description_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_tasks" ADD CONSTRAINT "ai_tasks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_ai" ADD CONSTRAINT "job_ai_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tailored_resumes" ADD CONSTRAINT "tailored_resumes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_tasks_status_idx" ON "ai_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ai_tasks_job_idx" ON "ai_tasks" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tasks_pending_idx" ON "ai_tasks" USING btree ("type","subject") WHERE "ai_tasks"."status" IN ('queued', 'running', 'blocked_budget');--> statement-breakpoint
CREATE INDEX "ai_usage_created_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_lang_idx" ON "profiles" USING btree ("lang");--> statement-breakpoint
CREATE UNIQUE INDEX "resumes_lang_idx" ON "resumes" USING btree ("lang");--> statement-breakpoint
CREATE UNIQUE INDEX "tailored_resumes_job_idx" ON "tailored_resumes" USING btree ("job_id");