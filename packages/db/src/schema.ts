import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Actor, Column, Level, MaxAge, Region } from '@kv/shared';

export type RunStatus = 'queued' | 'running' | 'ok' | 'error';
export type RunTrigger = 'cron' | 'manual';

export const searchProfiles = sqliteTable('search_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  stacks: text('stacks', { mode: 'json' }).$type<string[]>().notNull(),
  levels: text('levels', { mode: 'json' }).$type<Level[]>().notNull(),
  maxAgeDays: integer('max_age_days').$type<MaxAge>().notNull(),
  regions: text('regions', { mode: 'json' }).$type<Region[]>().notNull(),
  sources: text('sources', { mode: 'json' }).$type<string[]>().notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  externalId: text('external_id').notNull(),
  url: text('url').notNull(),
  title: text('title').notNull(),
  company: text('company').notNull(),
  location: text('location').notNull(),
  country: text('country').$type<'BR' | 'INT'>().notNull(),
  remote: integer('remote', { mode: 'boolean' }).notNull(),
  level: text('level').$type<Level>(),
  stacks: text('stacks', { mode: 'json' }).$type<string[]>().notNull(),
  description: text('description').notNull(),
  postedAt: integer('posted_at'),
  discoveredAt: integer('discovered_at').notNull(),
  dedupHash: text('dedup_hash').notNull(),
  profileId: integer('profile_id').notNull(),
  column: text('board_column').$type<Column>().notNull().default('descobertas'),
  position: real('position').notNull(),
  appliedBy: text('applied_by').$type<'ia' | 'humano'>(),
  needsHuman: integer('needs_human', { mode: 'boolean' }).notNull().default(false),
  needsHumanReason: text('needs_human_reason'),
  notes: text('notes').notNull().default(''),
});

export const jobEvents = sqliteTable('job_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull(),
  fromColumn: text('from_column').$type<Column>(),
  toColumn: text('to_column').$type<Column>().notNull(),
  actor: text('actor').$type<Actor>().notNull(),
  createdAt: integer('created_at').notNull(),
});

export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  profileId: integer('profile_id').notNull(),
  source: text('source').notNull(),
  trigger: text('trigger').$type<RunTrigger>().notNull(),
  status: text('status').$type<RunStatus>().notNull(),
  found: integer('found').notNull().default(0),
  inserted: integer('inserted').notNull().default(0),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
});
