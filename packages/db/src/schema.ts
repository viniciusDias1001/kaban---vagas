import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, index, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type {
  Actor, AiLayer, AiProviderId, AiTaskStatus, AiTaskType, CandidateProfile, Column, JobAnalysis, Level, MaxAge, ProfileOrigin, Region,
  ResumeLang, TailoredResume,
} from '@kv/shared';
import { bytea } from './bytea';
import { epochMs } from './epoch-ms';

export type RunStatus = 'queued' | 'running' | 'ok' | 'error';
export type RunTrigger = 'cron' | 'manual';

/*
 * RLS habilitado em todas as tabelas, sem policies: no Supabase, tabelas do schema `public` ficam
 * expostas pela API REST automática (chave anon). Com RLS e nenhuma policy, só o papel dono usado
 * pelo DATABASE_URL lê e escreve.
 */

export const searchProfiles = pgTable('search_profiles', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  stacks: text('stacks').array().$type<string[]>().notNull(),
  levels: text('levels').array().$type<Level[]>().notNull(),
  maxAgeDays: integer('max_age_days').$type<MaxAge>().notNull(),
  regions: text('regions').array().$type<Region[]>().notNull(),
  sources: text('sources').array().$type<string[]>().notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: epochMs('created_at').notNull(),
}).enableRLS();

export const jobs = pgTable(
  'jobs',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    company: text('company').notNull(),
    location: text('location').notNull(),
    country: text('country').$type<'BR' | 'INT'>().notNull(),
    remote: boolean('remote').notNull(),
    level: text('level').$type<Level>(),
    stacks: text('stacks').array().$type<string[]>().notNull(),
    description: text('description').notNull(),
    postedAt: epochMs('posted_at'),
    discoveredAt: epochMs('discovered_at').notNull(),
    dedupHash: text('dedup_hash').notNull(),
    /** Nulo quando o perfil que encontrou a vaga foi apagado: a vaga continua no quadro. */
    profileId: integer('profile_id').references(() => searchProfiles.id, { onDelete: 'set null' }),
    column: text('board_column').$type<Column>().notNull().default('descobertas'),
    position: doublePrecision('position').notNull(),
    appliedBy: text('applied_by').$type<'ia' | 'humano'>(),
    needsHuman: boolean('needs_human').notNull().default(false),
    needsHumanReason: text('needs_human_reason'),
    notes: text('notes').notNull().default(''),
    /** Quando a descrição foi buscada sob demanda (LinkedIn e Indeed não a entregam na busca). */
    descriptionFetchedAt: epochMs('description_fetched_at'),
  },
  (t) => [uniqueIndex('jobs_url_idx').on(t.url), index('jobs_dedup_idx').on(t.dedupHash)],
).enableRLS();

export const jobEvents = pgTable(
  'job_events',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    fromColumn: text('from_column').$type<Column>(),
    toColumn: text('to_column').$type<Column>().notNull(),
    actor: text('actor').$type<Actor>().notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [index('job_events_job_idx').on(t.jobId)],
).enableRLS();

export const runs = pgTable(
  'runs',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    profileId: integer('profile_id')
      .notNull()
      .references(() => searchProfiles.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    trigger: text('trigger').$type<RunTrigger>().notNull(),
    status: text('status').$type<RunStatus>().notNull(),
    found: integer('found').notNull().default(0),
    inserted: integer('inserted').notNull().default(0),
    error: text('error'),
    createdAt: epochMs('created_at').notNull(),
    startedAt: epochMs('started_at'),
    finishedAt: epochMs('finished_at'),
  },
  (t) => [
    index('runs_status_idx').on(t.status),
    /** No máximo um run pendente por (perfil, fonte): é o que torna `enqueueRuns` idempotente. */
    uniqueIndex('runs_pending_idx')
      .on(t.profileId, t.source)
      .where(sql`${t.status} IN ('queued', 'running')`),
  ],
).enableRLS();

// ---------------------------------------------------------------------------------------------
// IA de perfil (sub-projeto 2)
// ---------------------------------------------------------------------------------------------

/** Currículo original, um por idioma. O arquivo fica guardado como veio e nunca é alterado. */
export const resumes = pgTable(
  'resumes',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    lang: text('lang').$type<ResumeLang>().notNull(),
    fileName: text('file_name').notNull(),
    mime: text('mime').notNull(),
    /** Nunca selecione esta coluna em listagens: são até 5 MiB por linha. */
    content: bytea('content').notNull(),
    extractedText: text('extracted_text').notNull(),
    uploadedAt: epochMs('uploaded_at').notNull(),
  },
  (t) => [
    uniqueIndex('resumes_lang_idx').on(t.lang),
    // Mesmo valor de LIMITS.resumeBytes (5 MiB); a API recusa antes, este é o cinto de segurança.
    check('resumes_size_check', sql`octet_length(${t.content}) <= 5242880`),
  ],
).enableRLS();

/**
 * Perfil estruturado do candidato, um por idioma. A tabela se chama `profiles` (spec); no código é
 * `candidateProfiles` para não confundir com `searchProfiles`. `version` é um contador único para os
 * dois idiomas: cada gravação recebe `max(version) + 1` (ver `saveProfile`).
 */
export const candidateProfiles = pgTable(
  'profiles',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    lang: text('lang').$type<ResumeLang>().notNull(),
    data: jsonb('data').$type<CandidateProfile>().notNull(),
    origin: text('origin').$type<ProfileOrigin>().notNull(),
    version: integer('version').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [uniqueIndex('profiles_lang_idx').on(t.lang)],
).enableRLS();

/** Resultado das camadas 1 e 2 de cada vaga. `tierN_state` guarda só o desfecho; "na fila" vem de ai_tasks. */
export const jobAi = pgTable('job_ai', {
  jobId: integer('job_id')
    .primaryKey()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  language: text('language'),
  titlePt: text('title_pt'),
  score: integer('score'),
  reason: text('reason'),
  tier1State: text('tier1_state').$type<'ok' | 'error'>(),
  tier1ProfileVersion: integer('tier1_profile_version'),
  tier1At: epochMs('tier1_at'),
  descriptionPt: text('description_pt'),
  analysis: jsonb('analysis').$type<JobAnalysis>(),
  /** false quando a vaga não tinha descrição e a busca sob demanda falhou. */
  descriptionAvailable: boolean('description_available').notNull().default(true),
  tier2State: text('tier2_state').$type<'ok' | 'error'>(),
  tier2ProfileVersion: integer('tier2_profile_version'),
  tier2At: epochMs('tier2_at'),
}).enableRLS();

/** Currículo adaptado, um por vaga, já resolvido (campos copiados do perfil) e editável. */
export const tailoredResumes = pgTable(
  'tailored_resumes',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    jobId: integer('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    lang: text('lang').$type<ResumeLang>().notNull(),
    content: jsonb('content').$type<TailoredResume>().notNull(),
    profileVersion: integer('profile_version').notNull(),
    createdAt: epochMs('created_at').notNull(),
    editedAt: epochMs('edited_at'),
  },
  (t) => [uniqueIndex('tailored_resumes_job_idx').on(t.jobId)],
).enableRLS();

/**
 * Fila de IA. `subject` é a chave do alvo (`job:<id>` ou `lang:<idioma>`), sempre preenchida, para o
 * índice único parcial não depender de coluna nula.
 */
export const aiTasks = pgTable(
  'ai_tasks',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    type: text('type').$type<AiTaskType>().notNull(),
    subject: text('subject').notNull(),
    jobId: integer('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
    lang: text('lang').$type<ResumeLang>(),
    status: text('status').$type<AiTaskStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** O usuário aceitou gastar acima do limite do dia nesta tarefa. */
    confirmed: boolean('confirmed').notNull().default(false),
    error: text('error'),
    createdAt: epochMs('created_at').notNull(),
    /** Não iniciar antes disto (espera entre tentativas). */
    runAfter: epochMs('run_after'),
    startedAt: epochMs('started_at'),
    finishedAt: epochMs('finished_at'),
  },
  (t) => [
    index('ai_tasks_status_idx').on(t.status),
    index('ai_tasks_job_idx').on(t.jobId),
    /** No máximo uma tarefa pendente por (tipo, alvo), como `runs_pending_idx`: torna `enqueueAiTask` idempotente. */
    uniqueIndex('ai_tasks_pending_idx')
      .on(t.type, t.subject)
      .where(sql`${t.status} IN ('queued', 'running', 'blocked_budget')`),
  ],
).enableRLS();

/** Uma linha por chamada bem-sucedida ao provedor. `cost_usd` é estimativa (tabela de preços do @kv/ai). */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    layer: text('layer').$type<AiLayer>().notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: doublePrecision('cost_usd').notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [index('ai_usage_created_idx').on(t.createdAt)],
).enableRLS();

/**
 * Configurações não secretas gravadas pela aba Configurações: uma linha por chave (`provider`,
 * `modelFast`, `dailyBudgetUsd`...). O valor é validado na leitura; ausente = vale o ambiente ou o padrão.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: epochMs('updated_at').notNull(),
}).enableRLS();

/**
 * Chave de API de cada provedor, CIFRADA (AES-256-GCM, ver @kv/settings). `sealed` é opaco para o banco:
 * versão + nonce + tag + texto cifrado. `last4` são os quatro últimos caracteres, a única parte que a
 * tela mostra. Nunca há chave em texto puro nesta tabela.
 */
export const aiKeys = pgTable('ai_keys', {
  provider: text('provider').$type<AiProviderId>().primaryKey(),
  sealed: bytea('sealed').notNull(),
  last4: text('last4').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
}).enableRLS();
