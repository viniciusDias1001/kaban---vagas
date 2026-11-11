-- Segurança (Supabase): cada tabela abaixo recebe ENABLE ROW LEVEL SECURITY e nenhuma policy.
-- No Supabase, tabelas do schema "public" ficam acessíveis pela API REST gerada automaticamente,
-- usando a chave pública "anon". Com RLS habilitado e sem policies, essa API não lê nem escreve
-- nada; só o papel dono das tabelas — o usado pelo DATABASE_URL do app — tem acesso.
-- Não remova os ALTER TABLE ... ENABLE ROW LEVEL SECURITY.
CREATE TABLE "job_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"job_id" integer NOT NULL,
	"from_column" text,
	"to_column" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"company" text NOT NULL,
	"location" text NOT NULL,
	"country" text NOT NULL,
	"remote" boolean NOT NULL,
	"level" text,
	"stacks" text[] NOT NULL,
	"description" text NOT NULL,
	"posted_at" timestamp with time zone,
	"discovered_at" timestamp with time zone NOT NULL,
	"dedup_hash" text NOT NULL,
	"profile_id" integer,
	"board_column" text DEFAULT 'descobertas' NOT NULL,
	"position" double precision NOT NULL,
	"applied_by" text,
	"needs_human" boolean DEFAULT false NOT NULL,
	"needs_human_reason" text,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"profile_id" integer NOT NULL,
	"source" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_profiles" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_profiles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"stacks" text[] NOT NULL,
	"levels" text[] NOT NULL,
	"max_age_days" integer NOT NULL,
	"regions" text[] NOT NULL,
	"sources" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_profile_id_search_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."search_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_profile_id_search_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."search_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_events_job_idx" ON "job_events" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_url_idx" ON "jobs" USING btree ("url");--> statement-breakpoint
CREATE INDEX "jobs_dedup_idx" ON "jobs" USING btree ("dedup_hash");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_pending_idx" ON "runs" USING btree ("profile_id","source") WHERE "runs"."status" IN ('queued', 'running');