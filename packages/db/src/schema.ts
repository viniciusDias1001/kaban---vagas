import { sql } from 'drizzle-orm';
import { boolean, doublePrecision, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { Actor, Column, Level, MaxAge, Region } from '@kv/shared';
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
