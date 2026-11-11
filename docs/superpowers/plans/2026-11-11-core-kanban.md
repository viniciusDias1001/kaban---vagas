# Core Kanban de Vagas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App local em que perfis de busca alimentam, via worker horário, um kanban de vagas vindas de nove fontes.

**Architecture:** Monorepo pnpm em TypeScript com três processos (`web`, `api`, `worker`) e um SQLite compartilhado em modo WAL. A API enfileira execuções na tabela `runs`; o worker as consome e grava vagas novas. Conectores são módulos isolados atrás de uma interface única.

**Tech Stack:** Node 24, pnpm workspaces, TypeScript, tsx, Vitest, Zod, Drizzle ORM + better-sqlite3, Fastify, cheerio, Playwright, React + Vite, Tailwind v4, Motion, dnd-kit, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-11-11-core-kanban-design.md`

**Desvios conscientes do spec:**

- `jobs` ganha a coluna `country` (`BR` | `INT`), necessária para o filtro de região.
- O campo `column` é gravado no banco como `board_column` (evita palavra reservada do SQL).
- Agendamento horário usa `setTimeout` alinhado à hora cheia em vez de `node-cron` (uma dependência a menos).
- LinkedIn e Indeed entregam `description` vazia: a busca pública não traz o texto e buscar o detalhe de cada vaga multiplicaria as requisições e o risco de bloqueio. O sub-projeto 2 busca a descrição sob demanda.
- Tabelas são criadas por DDL idempotente na abertura do banco, sem drizzle-kit.

**Convenções:**

- Todos os comandos rodam na raiz do repositório, em Git Bash.
- Pacotes internos usam o escopo `@kv/` e exportam o código-fonte TypeScript direto (`exports` aponta para `src/index.ts`); não há etapa de build para api e worker.
- Fixtures de conectores são gravadas da fonte real. **A fixture é a verdade:** se um teste de mapper falhar por nome de campo, abra a fixture e corrija o mapper.
- Mensagens de commit terminam com `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Estrutura de arquivos

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.config.ts, .gitignore
scripts/record-fixture.mjs        grava fixture de uma URL
scripts/install-worker.mjs        registra o worker como tarefa do sistema
packages/shared/src/
  schemas.ts    enums e schemas Zod (filtros, vaga normalizada, inputs da API)
  dto.ts        tipos de resposta da API usados pelo web
  index.ts
packages/db/src/
  schema.ts     tabelas Drizzle
  client.ts     openDb + DDL
  queue.ts      enqueueRuns
  index.ts
packages/connectors/src/
  types.ts      interface Connector
  http.ts       fetchText, fetchJson, sleep
  text.ts       stripHtml, fold, hasTerm
  filter.ts     detectLevel, detectStacks, matchesFilters
  normalize.ts  keepValid, toMs, queriesFor
  remotive.ts remoteok.ts arbeitnow.ts himalayas.ts gupy.ts
  greenhouse.ts lever.ts linkedin.ts indeed.ts fake.ts
  index.ts      registro
packages/connectors/fixtures/     respostas gravadas
apps/worker/src/
  dedup.ts      dedupHash
  runner.ts     executeRun, insertNewJobs
  scheduler.ts  isDue, enqueueAllActive, processQueue, scheduleHourly
  index.ts      processo
apps/api/src/
  app.ts        buildApp
  routes/profiles.ts jobs.ts runs.ts meta.ts
  index.ts      processo
apps/web/
  index.html, vite.config.ts, playwright.config.ts
  src/main.tsx, index.css, api.ts, toast.ts, position.ts, App.tsx
  src/components/StatsBar.tsx Board.tsx JobCard.tsx JobDrawer.tsx ProfilesPage.tsx HealthPanel.tsx
  e2e/board.spec.ts
```

---

### Task 1: Scaffold do monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`

- [ ] **Step 1: Criar `package.json`**

```json
{
  "name": "kanban-vagas",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -n api,worker,web -c blue,magenta,green \"pnpm --filter @kv/api dev\" \"pnpm --filter @kv/worker dev\" \"pnpm --filter @kv/web dev\"",
    "test": "vitest run",
    "typecheck": "pnpm -r exec tsc --noEmit",
    "e2e": "pnpm --filter @kv/web exec playwright test",
    "worker:install": "node scripts/install-worker.mjs"
  },
  "pnpm": {
    "onlyBuiltDependencies": ["esbuild"]
  }
}
```

- [ ] **Step 2: Criar `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 3: Criar `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "esModuleInterop": true
  }
}
```

- [ ] **Step 4: Criar `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Criar `.gitignore`**

```
node_modules/
dist/
data/
*.db
*.db-shm
*.db-wal
worker.cmd
test-results/
playwright-report/
.env
```

- [ ] **Step 6: Instalar ferramentas da raiz**

Run: `pnpm add -Dw typescript tsx vitest concurrently @types/node`
Expected: termina sem erro e cria `pnpm-lock.yaml`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo"
```

---

### Task 2: `@kv/shared` — schemas e DTOs

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/schemas.ts`, `packages/shared/src/dto.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/schemas.test.ts`

- [ ] **Step 1: Criar `packages/shared/package.json` e `tsconfig.json`**

```json
{
  "name": "@kv/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Run: `pnpm --filter @kv/shared add zod`

- [ ] **Step 2: Escrever o teste que falha — `packages/shared/src/schemas.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema, ProfileInputSchema } from './schemas';

describe('ProfileInputSchema', () => {
  const valid = {
    name: 'React Pleno',
    stacks: ['react'],
    levels: ['pleno'],
    maxAgeDays: 7,
    regions: ['remoto'],
    sources: ['gupy'],
  };

  it('accepts a valid profile and defaults active to true', () => {
    expect(ProfileInputSchema.parse(valid).active).toBe(true);
  });

  it('rejects an unsupported max age', () => {
    expect(() => ProfileInputSchema.parse({ ...valid, maxAgeDays: 5 })).toThrow();
  });

  it('rejects a profile without sources', () => {
    expect(() => ProfileInputSchema.parse({ ...valid, sources: [] })).toThrow();
  });
});

describe('NormalizedJobSchema', () => {
  it('rejects a job without company', () => {
    const job = {
      source: 'x', externalId: '1', url: 'https://a.b/c', title: 'Dev', company: '',
      location: '', country: 'BR', remote: false, stacks: [], description: '', postedAt: null,
    };
    expect(NormalizedJobSchema.safeParse(job).success).toBe(false);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test packages/shared`
Expected: FAIL — não encontra `./schemas`.

- [ ] **Step 4: Implementar `packages/shared/src/schemas.ts`**

```ts
import { z } from 'zod';

export const COLUMNS = ['descobertas', 'selecionadas', 'aplicada', 'entrevista', 'oferta', 'arquivada'] as const;
export const ColumnSchema = z.enum(COLUMNS);
export type Column = z.infer<typeof ColumnSchema>;

export const COLUMN_LABELS: Record<Column, string> = {
  descobertas: 'Descobertas',
  selecionadas: 'Selecionadas',
  aplicada: 'Aplicada',
  entrevista: 'Entrevista',
  oferta: 'Oferta',
  arquivada: 'Arquivada',
};

export const LEVELS = ['junior', 'pleno', 'senior'] as const;
export const LevelSchema = z.enum(LEVELS);
export type Level = z.infer<typeof LevelSchema>;

export const REGIONS = ['brasil', 'exterior', 'remoto'] as const;
export const RegionSchema = z.enum(REGIONS);
export type Region = z.infer<typeof RegionSchema>;

export const MAX_AGES = [1, 3, 7, 30] as const;
export const MaxAgeSchema = z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(30)]);
export type MaxAge = z.infer<typeof MaxAgeSchema>;

export const SearchFiltersSchema = z.object({
  stacks: z.array(z.string().min(1)),
  levels: z.array(LevelSchema),
  maxAgeDays: MaxAgeSchema,
  regions: z.array(RegionSchema),
});
export type SearchFilters = z.infer<typeof SearchFiltersSchema>;

export const ProfileInputSchema = SearchFiltersSchema.extend({
  name: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
  active: z.boolean().default(true),
});
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

/** Para PATCH: todos os campos opcionais e sem default em `active`. */
export const ProfilePatchSchema = SearchFiltersSchema.extend({
  name: z.string().min(1),
  sources: z.array(z.string().min(1)).min(1),
  active: z.boolean(),
}).partial();
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

export const NormalizedJobSchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string(),
  country: z.enum(['BR', 'INT']),
  remote: z.boolean(),
  stacks: z.array(z.string()),
  description: z.string(),
  postedAt: z.number().nullable(),
});
export type NormalizedJob = z.infer<typeof NormalizedJobSchema>;

export const JobPatchSchema = z.object({
  column: ColumnSchema.optional(),
  position: z.number().optional(),
  notes: z.string().optional(),
});
export type JobPatch = z.infer<typeof JobPatchSchema>;

export const RunRequestSchema = z.object({ profileId: z.number().int().positive() });
```

- [ ] **Step 5: Implementar `packages/shared/src/dto.ts`**

```ts
import type { Column, Level, ProfileInput } from './schemas';

export type Actor = 'ia' | 'humano' | 'sistema';

export interface JobDto {
  id: number;
  source: string;
  externalId: string;
  url: string;
  title: string;
  company: string;
  location: string;
  country: 'BR' | 'INT';
  remote: boolean;
  level: Level | null;
  stacks: string[];
  description: string;
  postedAt: number | null;
  discoveredAt: number;
  profileId: number;
  column: Column;
  position: number;
  appliedBy: 'ia' | 'humano' | null;
  needsHuman: boolean;
  needsHumanReason: string | null;
  notes: string;
}

export interface JobEventDto {
  id: number;
  jobId: number;
  fromColumn: Column | null;
  toColumn: Column;
  actor: Actor;
  createdAt: number;
}

export interface JobDetailDto {
  job: JobDto;
  events: JobEventDto[];
}

export interface ProfileDto extends ProfileInput {
  id: number;
  createdAt: number;
}

export interface SourceDto {
  id: string;
  name: string;
}

export interface SourceHealth {
  source: string;
  name: string;
  status: 'ok' | 'error' | 'never';
  found: number;
  inserted: number;
  error: string | null;
  finishedAt: number | null;
}

export interface HealthDto {
  sources: SourceHealth[];
  lastFinishedAt: number | null;
}

export interface StatsDto {
  total: number;
  appliedByAi: number;
  appliedByHuman: number;
  needsHuman: number;
}
```

- [ ] **Step 6: Implementar `packages/shared/src/index.ts`**

```ts
export * from './schemas';
export * from './dto';
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm test packages/shared`
Expected: PASS, 4 testes.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(shared): add zod schemas and API DTOs"
```

---

### Task 3: `@kv/db` — schema, cliente e fila

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/src/schema.ts`, `packages/db/src/client.ts`, `packages/db/src/queue.ts`, `packages/db/src/index.ts`
- Test: `packages/db/src/db.test.ts`

- [ ] **Step 1: Criar `packages/db/package.json` e `tsconfig.json`**

```json
{
  "name": "@kv/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Run:
```bash
pnpm --filter @kv/db add drizzle-orm better-sqlite3 "@kv/shared@workspace:*"
pnpm --filter @kv/db add -D @types/better-sqlite3
```
Expected: `better-sqlite3` instala com binário pré-compilado (sem erro de node-gyp).

- [ ] **Step 2: Escrever o teste que falha — `packages/db/src/db.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { enqueueRuns, openDb, runs, searchProfiles } from './index';

function seedProfile(db: ReturnType<typeof openDb>) {
  return db
    .insert(searchProfiles)
    .values({
      name: 'React', stacks: ['react', 'node'], levels: ['pleno'], maxAgeDays: 7,
      regions: ['remoto'], sources: ['gupy', 'remotive'], active: true, createdAt: 1,
    })
    .returning()
    .get();
}

describe('openDb', () => {
  it('creates tables and round-trips JSON columns', () => {
    const db = openDb(':memory:');
    const profile = seedProfile(db);
    const read = db.select().from(searchProfiles).where(eq(searchProfiles.id, profile.id)).get();
    expect(read?.stacks).toEqual(['react', 'node']);
    expect(read?.active).toBe(true);
  });
});

describe('enqueueRuns', () => {
  it('queues one run per source and skips sources already pending', () => {
    const db = openDb(':memory:');
    const profile = seedProfile(db);
    expect(enqueueRuns(db, profile, 'manual')).toBe(2);
    expect(enqueueRuns(db, profile, 'cron')).toBe(0);
    const rows = db.select().from(runs).all();
    expect(rows.map((r) => r.source).sort()).toEqual(['gupy', 'remotive']);
    expect(rows.every((r) => r.status === 'queued' && r.trigger === 'manual')).toBe(true);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test packages/db`
Expected: FAIL — não encontra `./index`.

- [ ] **Step 4: Implementar `packages/db/src/schema.ts`**

```ts
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
```

- [ ] **Step 5: Implementar `packages/db/src/client.ts`**

```ts
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

const DDL = `
CREATE TABLE IF NOT EXISTS search_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stacks TEXT NOT NULL,
  levels TEXT NOT NULL,
  max_age_days INTEGER NOT NULL,
  regions TEXT NOT NULL,
  sources TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT NOT NULL,
  country TEXT NOT NULL,
  remote INTEGER NOT NULL,
  level TEXT,
  stacks TEXT NOT NULL,
  description TEXT NOT NULL,
  posted_at INTEGER,
  discovered_at INTEGER NOT NULL,
  dedup_hash TEXT NOT NULL,
  profile_id INTEGER NOT NULL,
  board_column TEXT NOT NULL DEFAULT 'descobertas',
  position REAL NOT NULL,
  applied_by TEXT,
  needs_human INTEGER NOT NULL DEFAULT 0,
  needs_human_reason TEXT,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_url_idx ON jobs (url);
CREATE INDEX IF NOT EXISTS jobs_dedup_idx ON jobs (dedup_hash);
CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  from_column TEXT,
  to_column TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);
`;

export function defaultDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  return resolve(fileURLToPath(new URL('../../../data/kanban.db', import.meta.url)));
}

export function openDb(path: string = defaultDbPath()) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.exec(DDL);
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof openDb>;
```

- [ ] **Step 6: Implementar `packages/db/src/queue.ts`**

```ts
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { runs, type RunTrigger } from './schema';

/** Enfileira um run por fonte do perfil; ignora fontes que já têm run pendente. Devolve quantos enfileirou. */
export function enqueueRuns(db: Db, profile: { id: number; sources: string[] }, trigger: RunTrigger): number {
  const pending = db
    .select({ source: runs.source })
    .from(runs)
    .where(and(eq(runs.profileId, profile.id), inArray(runs.status, ['queued', 'running'])))
    .all()
    .map((r) => r.source);
  const todo = profile.sources.filter((s) => !pending.includes(s));
  for (const source of todo) {
    db.insert(runs).values({ profileId: profile.id, source, trigger, status: 'queued', createdAt: Date.now() }).run();
  }
  return todo.length;
}
```

- [ ] **Step 7: Implementar `packages/db/src/index.ts`**

```ts
export * from './schema';
export * from './client';
export * from './queue';
```

- [ ] **Step 8: Rodar e ver passar**

Run: `pnpm test packages/db`
Expected: PASS, 2 testes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(db): add sqlite schema, client and run queue"
```

---

### Task 4: `@kv/connectors` — base (texto, filtro, normalização)

**Files:**
- Create: `packages/connectors/package.json`, `packages/connectors/tsconfig.json`, `packages/connectors/src/types.ts`, `http.ts`, `text.ts`, `filter.ts`, `normalize.ts`, `scripts/record-fixture.mjs`
- Test: `packages/connectors/src/text.test.ts`, `packages/connectors/src/filter.test.ts`

- [ ] **Step 1: Criar `packages/connectors/package.json` e `tsconfig.json`**

```json
{
  "name": "@kv/connectors",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "scripts"] }
```

Run: `pnpm --filter @kv/connectors add cheerio playwright "@kv/shared@workspace:*"`

- [ ] **Step 2: Escrever os testes que falham**

`packages/connectors/src/text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fold, hasTerm, stripHtml } from './text';

describe('stripHtml', () => {
  it('removes tags, decodes entities and keeps paragraph breaks', () => {
    expect(stripHtml('<p>Oi &amp; tchau</p><p>x</p>')).toBe('Oi & tchau\nx');
  });
  it('handles entity-escaped html', () => {
    expect(stripHtml('&lt;p&gt;Hello&lt;/p&gt;')).toBe('Hello');
  });
});

describe('fold', () => {
  it('lowercases and strips accents', () => {
    expect(fold('Sênior')).toBe('senior');
  });
});

describe('hasTerm', () => {
  it('matches whole terms only', () => {
    expect(hasTerm('Senior JavaScript Engineer', 'java')).toBe(false);
    expect(hasTerm('Java Developer', 'java')).toBe(true);
    expect(hasTerm('Dev C# / .NET', 'c#')).toBe(true);
    expect(hasTerm('Dev C# / .NET', '.net')).toBe(true);
  });
});
```

`packages/connectors/src/filter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { NormalizedJob, SearchFilters } from '@kv/shared';
import { detectLevel, detectStacks, matchesFilters } from './filter';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

const job = (over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  source: 't', externalId: '1', url: 'https://a.b/1', title: 'Desenvolvedor React Pleno', company: 'Acme',
  location: 'São Paulo', country: 'BR', remote: false, stacks: ['react'], description: '', postedAt: NOW - DAY,
  ...over,
});
const filters = (over: Partial<SearchFilters> = {}): SearchFilters => ({
  stacks: [], levels: [], maxAgeDays: 7, regions: [], ...over,
});

describe('detectLevel', () => {
  it('detects levels in pt and en', () => {
    expect(detectLevel('Desenvolvedor Sênior')).toBe('senior');
    expect(detectLevel('Sr. Backend Engineer')).toBe('senior');
    expect(detectLevel('Dev Júnior')).toBe('junior');
    expect(detectLevel('Engenheiro Pleno')).toBe('pleno');
    expect(detectLevel('Software Engineer')).toBeNull();
  });
});

describe('detectStacks', () => {
  it('finds known stacks without partial matches', () => {
    expect(detectStacks('Senior JavaScript and Node engineer')).toEqual(['node', 'javascript']);
  });
});

describe('matchesFilters', () => {
  it('passes with empty filters', () => {
    expect(matchesFilters(job(), filters(), NOW)).toBe(true);
  });
  it('rejects jobs older than max age but keeps unknown dates', () => {
    expect(matchesFilters(job({ postedAt: NOW - 8 * DAY }), filters(), NOW)).toBe(false);
    expect(matchesFilters(job({ postedAt: null }), filters(), NOW)).toBe(true);
  });
  it('requires at least one stack', () => {
    expect(matchesFilters(job(), filters({ stacks: ['python'] }), NOW)).toBe(false);
    expect(matchesFilters(job(), filters({ stacks: ['python', 'react'] }), NOW)).toBe(true);
  });
  it('rejects a detected level outside the filter, keeps undetected', () => {
    expect(matchesFilters(job(), filters({ levels: ['senior'] }), NOW)).toBe(false);
    expect(matchesFilters(job({ title: 'Desenvolvedor React' }), filters({ levels: ['senior'] }), NOW)).toBe(true);
  });
  it('matches regions', () => {
    expect(matchesFilters(job(), filters({ regions: ['exterior'] }), NOW)).toBe(false);
    expect(matchesFilters(job(), filters({ regions: ['brasil'] }), NOW)).toBe(true);
    expect(matchesFilters(job({ country: 'INT', remote: true }), filters({ regions: ['remoto'] }), NOW)).toBe(true);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test packages/connectors`
Expected: FAIL — módulos não existem.

- [ ] **Step 4: Implementar `packages/connectors/src/types.ts`**

```ts
import type { NormalizedJob, SearchFilters } from '@kv/shared';

export interface Connector {
  id: string;
  name: string;
  search(filters: SearchFilters): Promise<NormalizedJob[]>;
}
```

- [ ] **Step 5: Implementar `packages/connectors/src/http.ts`**

```ts
export const USER_AGENT = 'Mozilla/5.0 (compatible; kanban-vagas/0.1)';

export async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/html', ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

export async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
```

- [ ] **Step 6: Implementar `packages/connectors/src/text.ts`**

```ts
const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);
}

export function stripHtml(html: string): string {
  const noTags = decodeEntities(html)
    .replace(/<(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(noTags)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Minúsculas e sem acentos, para comparar texto. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Verdadeiro se `term` aparece em `text` como termo inteiro (não como parte de outra palavra). */
export function hasTerm(text: string, term: string): boolean {
  return new RegExp(`(?<![a-z0-9])${escapeRe(fold(term))}(?![a-z0-9])`).test(fold(text));
}
```

- [ ] **Step 7: Implementar `packages/connectors/src/filter.ts`**

```ts
import type { Level, NormalizedJob, SearchFilters } from '@kv/shared';
import { fold, hasTerm } from './text';

const DAY = 86_400_000;

const SENIOR = /(?<![a-z])(sr|senior|staff|principal|lead|especialista|specialist)(?![a-z])/;
const JUNIOR = /(?<![a-z])(jr|junior|estagio|estagiario|intern|internship|trainee|entry)(?![a-z])/;
const PLENO = /(?<![a-z])(pl|pleno|mid|midlevel)(?![a-z])/;

export function detectLevel(title: string): Level | null {
  const t = fold(title);
  if (SENIOR.test(t)) return 'senior';
  if (JUNIOR.test(t)) return 'junior';
  if (PLENO.test(t)) return 'pleno';
  return null;
}

export const KNOWN_STACKS = [
  'react', 'react native', 'node', 'typescript', 'javascript', 'python', 'java', 'go', 'rust', 'php', 'ruby',
  'c#', '.net', 'angular', 'vue', 'next.js', 'aws', 'docker', 'kubernetes', 'sql', 'postgres', 'mongodb',
  'flutter', 'kotlin', 'swift',
];

export function detectStacks(text: string): string[] {
  return KNOWN_STACKS.filter((s) => hasTerm(text, s));
}

export function matchesFilters(job: NormalizedJob, f: SearchFilters, now: number = Date.now()): boolean {
  if (job.postedAt !== null && now - job.postedAt > f.maxAgeDays * DAY) return false;
  if (f.stacks.length > 0) {
    const hay = `${job.title} ${job.stacks.join(' ')} ${job.description}`;
    if (!f.stacks.some((s) => hasTerm(hay, s))) return false;
  }
  if (f.levels.length > 0) {
    const level = detectLevel(job.title);
    if (level && !f.levels.includes(level)) return false;
  }
  if (f.regions.length > 0) {
    const ok =
      (f.regions.includes('remoto') && job.remote) ||
      (f.regions.includes('brasil') && job.country === 'BR') ||
      (f.regions.includes('exterior') && job.country === 'INT');
    if (!ok) return false;
  }
  return true;
}
```

- [ ] **Step 8: Implementar `packages/connectors/src/normalize.ts`**

```ts
import { NormalizedJobSchema, type NormalizedJob, type SearchFilters } from '@kv/shared';
import { detectStacks } from './filter';

/** Descarta vagas que não passam no schema (ex.: sem empresa ou sem URL válida). */
export function keepValid(jobs: NormalizedJob[]): NormalizedJob[] {
  return jobs.filter((j) => NormalizedJobSchema.safeParse(j).success);
}

/** Converte data ISO, epoch em segundos ou epoch em ms para epoch em ms. */
export function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Termos de busca enviados às fontes que aceitam palavra-chave. */
export function queriesFor(filters: SearchFilters): string[] {
  return filters.stacks.length > 0 ? filters.stacks.slice(0, 3) : ['developer'];
}

/** Stacks detectadas no texto mais o termo que originou a busca. */
export function stacksWithQuery(text: string, query?: string): string[] {
  const found = detectStacks(text);
  if (query && query !== 'developer' && !found.includes(query.toLowerCase())) found.push(query.toLowerCase());
  return found;
}
```

- [ ] **Step 9: Criar `scripts/record-fixture.mjs`**

```js
// Uso: node scripts/record-fixture.mjs <url> <arquivo-saida> [chave-do-array] [n]
// Grava a resposta de <url>. Se for JSON, corta o array (raiz ou em <chave>) para n itens.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, out, key = '', n = '5'] = process.argv.slice(2);
if (!url || !out) {
  console.error('uso: node scripts/record-fixture.mjs <url> <saida> [chave] [n]');
  process.exit(1);
}
const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; kanban-vagas/0.1)' } });
const text = await res.text();
let body = text;
try {
  const json = JSON.parse(text);
  const trim = (a) => a.slice(0, Number(n));
  if (Array.isArray(json)) body = JSON.stringify(trim(json), null, 1);
  else if (key && Array.isArray(json[key])) body = JSON.stringify({ ...json, [key]: trim(json[key]) }, null, 1);
  else body = JSON.stringify(json, null, 1);
} catch {
  // não é JSON: grava como veio
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, body);
console.log(res.status, out, `${body.length} bytes`);
```

- [ ] **Step 10: Rodar e ver passar**

Run: `pnpm test packages/connectors`
Expected: PASS, 11 testes.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(connectors): add connector interface, text and filter helpers"
```

---

### Task 5: Conectores Remotive e RemoteOK

**Files:**
- Create: `packages/connectors/src/remotive.ts`, `packages/connectors/src/remoteok.ts`, `packages/connectors/fixtures/remotive.json`, `packages/connectors/fixtures/remoteok.json`
- Test: `packages/connectors/src/remotive.test.ts`, `packages/connectors/src/remoteok.test.ts`

- [ ] **Step 1: Gravar as fixtures**

```bash
node scripts/record-fixture.mjs "https://remotive.com/api/remote-jobs?search=react" packages/connectors/fixtures/remotive.json jobs 5
node scripts/record-fixture.mjs "https://remoteok.com/api" packages/connectors/fixtures/remoteok.json "" 6
```
Expected: duas linhas começando com `200`. Abra os arquivos e confirme que `remotive.json` tem `jobs` com itens e que `remoteok.json` é um array cujo primeiro item é um aviso legal (sem `position`).

- [ ] **Step 2: Escrever os testes que falham**

`packages/connectors/src/remotive.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapRemotive } from './remotive';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/remotive.json', import.meta.url), 'utf8'));

describe('mapRemotive', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapRemotive(fixture, 'react');
    expect(jobs.length).toBe(fixture.jobs.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('remotive');
      expect(j.remote).toBe(true);
      expect(j.stacks).toContain('react');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });
});
```

`packages/connectors/src/remoteok.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapRemoteOk } from './remoteok';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/remoteok.json', import.meta.url), 'utf8'));

describe('mapRemoteOk', () => {
  it('skips the legal notice and maps real jobs', () => {
    const real = fixture.filter((x: { position?: string }) => x.position);
    const jobs = mapRemoteOk(fixture);
    expect(jobs.length).toBe(real.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('remoteok');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test packages/connectors/src/remot`
Expected: FAIL — módulos não existem.

- [ ] **Step 4: Implementar `packages/connectors/src/remotive.ts`**

```ts
import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { keepValid, queriesFor, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  tags?: string[];
  publication_date: string;
  candidate_required_location?: string;
  description?: string;
}

export function mapRemotive(data: { jobs: RemotiveJob[] }, query?: string): NormalizedJob[] {
  return keepValid(
    data.jobs.map((j) => ({
      source: 'remotive',
      externalId: String(j.id),
      url: j.url,
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || 'Remote',
      country: 'INT' as const,
      remote: true,
      stacks: stacksWithQuery(`${j.title} ${(j.tags ?? []).join(' ')}`, query),
      description: stripHtml(j.description ?? ''),
      postedAt: toMs(j.publication_date),
    })),
  );
}

export const remotive: Connector = {
  id: 'remotive',
  name: 'Remotive',
  async search(filters) {
    const out: NormalizedJob[] = [];
    for (const q of queriesFor(filters)) {
      const data = await fetchJson<{ jobs: RemotiveJob[] }>(
        `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}`,
      );
      out.push(...mapRemotive(data, q));
    }
    return out;
  },
};
```

- [ ] **Step 5: Implementar `packages/connectors/src/remoteok.ts`**

```ts
import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { keepValid, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface RemoteOkItem {
  id?: string | number;
  position?: string;
  company?: string;
  tags?: string[];
  description?: string;
  location?: string;
  url?: string;
  epoch?: number;
  date?: string;
}

export function mapRemoteOk(items: RemoteOkItem[]): NormalizedJob[] {
  return keepValid(
    items
      .filter((x) => x.position)
      .map((j) => ({
        source: 'remoteok',
        externalId: String(j.id ?? ''),
        url: j.url ?? '',
        title: j.position ?? '',
        company: j.company ?? '',
        location: j.location || 'Remote',
        country: 'INT' as const,
        remote: true,
        stacks: stacksWithQuery(`${j.position} ${(j.tags ?? []).join(' ')}`),
        description: stripHtml(j.description ?? ''),
        postedAt: toMs(j.epoch ?? j.date),
      })),
  );
}

export const remoteok: Connector = {
  id: 'remoteok',
  name: 'RemoteOK',
  async search() {
    return mapRemoteOk(await fetchJson<RemoteOkItem[]>('https://remoteok.com/api'));
  },
};
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm test packages/connectors/src/remot`
Expected: PASS, 2 testes. Se falhar por campo ausente, compare com a fixture e ajuste o mapper.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(connectors): add Remotive and RemoteOK"
```

---

### Task 6: Conectores Arbeitnow e Himalayas

**Files:**
- Create: `packages/connectors/src/arbeitnow.ts`, `packages/connectors/src/himalayas.ts`, `packages/connectors/fixtures/arbeitnow.json`, `packages/connectors/fixtures/himalayas.json`
- Test: `packages/connectors/src/arbeitnow.test.ts`, `packages/connectors/src/himalayas.test.ts`

- [ ] **Step 1: Gravar as fixtures**

```bash
node scripts/record-fixture.mjs "https://www.arbeitnow.com/api/job-board-api" packages/connectors/fixtures/arbeitnow.json data 5
node scripts/record-fixture.mjs "https://himalayas.app/jobs/api?limit=5" packages/connectors/fixtures/himalayas.json jobs 5
```
Expected: duas linhas com `200`; `arbeitnow.json` tem `data[]`, `himalayas.json` tem `jobs[]`.

- [ ] **Step 2: Escrever os testes que falham**

`packages/connectors/src/arbeitnow.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapArbeitnow } from './arbeitnow';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/arbeitnow.json', import.meta.url), 'utf8'));

describe('mapArbeitnow', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapArbeitnow(fixture);
    expect(jobs.length).toBe(fixture.data.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('arbeitnow');
      expect(j.country).toBe('INT');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });
});
```

`packages/connectors/src/himalayas.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapHimalayas } from './himalayas';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/himalayas.json', import.meta.url), 'utf8'));

describe('mapHimalayas', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapHimalayas(fixture);
    expect(jobs.length).toBe(fixture.jobs.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('himalayas');
      expect(j.remote).toBe(true);
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test packages/connectors/src/arbeitnow packages/connectors/src/himalayas`
Expected: FAIL — módulos não existem.

- [ ] **Step 4: Implementar `packages/connectors/src/arbeitnow.ts`**

```ts
import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { keepValid, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface ArbeitnowJob {
  slug: string;
  company_name: string;
  title: string;
  description?: string;
  remote?: boolean;
  url: string;
  tags?: string[];
  location?: string;
  created_at: number;
}

export function mapArbeitnow(data: { data: ArbeitnowJob[] }): NormalizedJob[] {
  return keepValid(
    data.data.map((j) => ({
      source: 'arbeitnow',
      externalId: j.slug,
      url: j.url,
      title: j.title,
      company: j.company_name,
      location: j.location ?? '',
      country: 'INT' as const,
      remote: Boolean(j.remote),
      stacks: stacksWithQuery(`${j.title} ${(j.tags ?? []).join(' ')}`),
      description: stripHtml(j.description ?? ''),
      postedAt: toMs(j.created_at),
    })),
  );
}

export const arbeitnow: Connector = {
  id: 'arbeitnow',
  name: 'Arbeitnow',
  async search() {
    return mapArbeitnow(await fetchJson<{ data: ArbeitnowJob[] }>('https://www.arbeitnow.com/api/job-board-api'));
  },
};
```

- [ ] **Step 5: Implementar `packages/connectors/src/himalayas.ts`**

```ts
import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { keepValid, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface HimalayasJob {
  guid: string;
  title: string;
  companyName: string;
  description?: string;
  pubDate: number;
  applicationLink?: string;
  locationRestrictions?: string[];
  categories?: string[];
}

export function mapHimalayas(data: { jobs: HimalayasJob[] }): NormalizedJob[] {
  return keepValid(
    data.jobs.map((j) => ({
      source: 'himalayas',
      externalId: j.guid,
      url: j.applicationLink || j.guid,
      title: j.title,
      company: j.companyName,
      location: (j.locationRestrictions ?? []).join(', ') || 'Worldwide',
      country: 'INT' as const,
      remote: true,
      stacks: stacksWithQuery(`${j.title} ${(j.categories ?? []).join(' ')}`),
      description: stripHtml(j.description ?? ''),
      postedAt: toMs(j.pubDate),
    })),
  );
}

export const himalayas: Connector = {
  id: 'himalayas',
  name: 'Himalayas',
  async search() {
    const out: NormalizedJob[] = [];
    for (const offset of [0, 20, 40]) {
      const data = await fetchJson<{ jobs: HimalayasJob[] }>(`https://himalayas.app/jobs/api?limit=20&offset=${offset}`);
      out.push(...mapHimalayas(data));
    }
    return out;
  },
};
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm test packages/connectors/src/arbeitnow packages/connectors/src/himalayas`
Expected: PASS, 2 testes. Se falhar por campo ausente, compare com a fixture e ajuste o mapper.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(connectors): add Arbeitnow and Himalayas"
```

---

### Task 7: Conector Gupy

**Files:**
- Create: `packages/connectors/src/gupy.ts`, `packages/connectors/fixtures/gupy.json`
- Test: `packages/connectors/src/gupy.test.ts`

- [ ] **Step 1: Gravar a fixture**

```bash
node scripts/record-fixture.mjs "https://portal.api.gupy.io/api/v1/jobs?jobName=react&limit=5&offset=0" packages/connectors/fixtures/gupy.json data 5
```
Expected: `200`; arquivo com `data[]`.

- [ ] **Step 2: Escrever o teste que falha — `packages/connectors/src/gupy.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapGupy } from './gupy';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/gupy.json', import.meta.url), 'utf8'));

describe('mapGupy', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapGupy(fixture, 'react');
    expect(jobs.length).toBe(fixture.data.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('gupy');
      expect(j.country).toBe('BR');
      expect(j.stacks).toContain('react');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test packages/connectors/src/gupy`
Expected: FAIL — módulo não existe.

- [ ] **Step 4: Implementar `packages/connectors/src/gupy.ts`**

```ts
import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { keepValid, queriesFor, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface GupyJob {
  id: number;
  name: string;
  description?: string;
  careerPageName: string;
  publishedDate: string;
  isRemoteWork?: boolean;
  city?: string;
  state?: string;
  jobUrl: string;
}

export function mapGupy(data: { data: GupyJob[] }, query?: string): NormalizedJob[] {
  return keepValid(
    data.data.map((j) => ({
      source: 'gupy',
      externalId: String(j.id),
      url: j.jobUrl,
      title: j.name,
      company: j.careerPageName,
      location: [j.city, j.state].filter(Boolean).join(', ') || 'Brasil',
      country: 'BR' as const,
      remote: Boolean(j.isRemoteWork),
      stacks: stacksWithQuery(j.name, query),
      description: stripHtml(j.description ?? ''),
      postedAt: toMs(j.publishedDate),
    })),
  );
}

export const gupy: Connector = {
  id: 'gupy',
  name: 'Gupy',
  async search(filters) {
    const out: NormalizedJob[] = [];
    for (const q of queriesFor(filters)) {
      const term = q === 'developer' ? 'desenvolvedor' : q;
      const data = await fetchJson<{ data: GupyJob[] }>(
        `https://portal.api.gupy.io/api/v1/jobs?jobName=${encodeURIComponent(term)}&limit=50&offset=0`,
      );
      out.push(...mapGupy(data, q));
    }
    return out;
  },
};
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test packages/connectors/src/gupy`
Expected: PASS. Se falhar por campo ausente, compare com a fixture e ajuste o mapper.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(connectors): add Gupy"
```

---

### Task 8: Conectores Greenhouse e Lever

**Files:**
- Create: `packages/connectors/src/greenhouse.ts`, `packages/connectors/src/lever.ts`, `packages/connectors/fixtures/greenhouse.json`, `packages/connectors/fixtures/lever.json`
- Test: `packages/connectors/src/greenhouse.test.ts`, `packages/connectors/src/lever.test.ts`

- [ ] **Step 1: Gravar as fixtures**

```bash
node scripts/record-fixture.mjs "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs?content=true" packages/connectors/fixtures/greenhouse.json jobs 5
node scripts/record-fixture.mjs "https://api.lever.co/v0/postings/palantir?mode=json" packages/connectors/fixtures/lever.json "" 5
```
Expected: duas linhas com `200`. Se um board responder `404`, troque o token por outro da lista padrão do conector (Step 4 e 5), regrave e remova o token morto da lista padrão.

- [ ] **Step 2: Escrever os testes que falham**

`packages/connectors/src/greenhouse.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapGreenhouse } from './greenhouse';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/greenhouse.json', import.meta.url), 'utf8'));

describe('mapGreenhouse', () => {
  it('maps every fixture job to a valid normalized job', () => {
    const jobs = mapGreenhouse(fixture, 'gitlab');
    expect(jobs.length).toBe(fixture.jobs.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('greenhouse');
      expect(j.description).not.toMatch(/<\w+[^>]*>/);
    }
  });
});
```

`packages/connectors/src/lever.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { mapLever } from './lever';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/lever.json', import.meta.url), 'utf8'));

describe('mapLever', () => {
  it('maps every fixture posting to a valid normalized job', () => {
    const jobs = mapLever(fixture, 'palantir');
    expect(jobs.length).toBe(fixture.length);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('lever');
      expect(j.company).toBe('Palantir');
      expect(j.postedAt).toBeGreaterThan(1_500_000_000_000);
    }
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test packages/connectors/src/greenhouse packages/connectors/src/lever`
Expected: FAIL — módulos não existem.

- [ ] **Step 4: Implementar `packages/connectors/src/greenhouse.ts`**

```ts
import type { NormalizedJob } from '@kv/shared';
import { fetchJson } from './http';
import { keepValid, stacksWithQuery, toMs } from './normalize';
import { stripHtml } from './text';
import type { Connector } from './types';

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  updated_at?: string;
  first_published?: string;
  content?: string;
  company_name?: string;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function boardList(envName: string, defaults: string[]): string[] {
  const raw = process.env[envName];
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : defaults;
}

export function mapGreenhouse(data: { jobs: GreenhouseJob[] }, board: string): NormalizedJob[] {
  return keepValid(
    data.jobs.map((j) => {
      const location = j.location?.name ?? '';
      return {
        source: 'greenhouse',
        externalId: `${board}-${j.id}`,
        url: j.absolute_url,
        title: j.title,
        company: j.company_name || capitalize(board),
        location,
        country: /bra[sz]il/i.test(location) ? ('BR' as const) : ('INT' as const),
        remote: /remote|remoto/i.test(location),
        stacks: stacksWithQuery(j.title),
        description: stripHtml(j.content ?? ''),
        postedAt: toMs(j.first_published ?? j.updated_at),
      };
    }),
  );
}

export const greenhouse: Connector = {
  id: 'greenhouse',
  name: 'Greenhouse',
  async search() {
    const boards = boardList('GREENHOUSE_BOARDS', ['gitlab', 'stripe', 'cloudflare', 'figma']);
    const results = await Promise.allSettled(
      boards.map(async (b) =>
        mapGreenhouse(
          await fetchJson<{ jobs: GreenhouseJob[] }>(`https://boards-api.greenhouse.io/v1/boards/${b}/jobs?content=true`),
          b,
        ),
      ),
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<NormalizedJob[]> => r.status === 'fulfilled');
    if (ok.length === 0) throw new Error('Greenhouse: nenhum board respondeu');
    return ok.flatMap((r) => r.value);
  },
};
```

- [ ] **Step 5: Implementar `packages/connectors/src/lever.ts`**

```ts
import type { NormalizedJob } from '@kv/shared';
import { boardList } from './greenhouse';
import { fetchJson } from './http';
import { keepValid, stacksWithQuery, toMs } from './normalize';
import type { Connector } from './types';

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt: number;
  descriptionPlain?: string;
  workplaceType?: string;
  categories?: { location?: string };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function mapLever(postings: LeverPosting[], company: string): NormalizedJob[] {
  return keepValid(
    postings.map((j) => {
      const location = j.categories?.location ?? '';
      return {
        source: 'lever',
        externalId: j.id,
        url: j.hostedUrl,
        title: j.text,
        company: capitalize(company),
        location,
        country: /bra[sz]il/i.test(location) ? ('BR' as const) : ('INT' as const),
        remote: j.workplaceType === 'remote' || /remote|remoto/i.test(location),
        stacks: stacksWithQuery(j.text),
        description: (j.descriptionPlain ?? '').trim(),
        postedAt: toMs(j.createdAt),
      };
    }),
  );
}

export const lever: Connector = {
  id: 'lever',
  name: 'Lever',
  async search() {
    const companies = boardList('LEVER_COMPANIES', ['palantir', 'spotify']);
    const results = await Promise.allSettled(
      companies.map(async (c) =>
        mapLever(await fetchJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${c}?mode=json`), c),
      ),
    );
    const ok = results.filter((r): r is PromiseFulfilledResult<NormalizedJob[]> => r.status === 'fulfilled');
    if (ok.length === 0) throw new Error('Lever: nenhuma empresa respondeu');
    return ok.flatMap((r) => r.value);
  },
};
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm test packages/connectors/src/greenhouse packages/connectors/src/lever`
Expected: PASS, 2 testes. Se falhar por campo ausente, compare com a fixture e ajuste o mapper.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(connectors): add Greenhouse and Lever"
```

---

### Task 9: Conector LinkedIn (busca pública, sem login)

**Files:**
- Create: `packages/connectors/src/linkedin.ts`, `packages/connectors/fixtures/linkedin.html`
- Test: `packages/connectors/src/linkedin.test.ts`

- [ ] **Step 1: Gravar a fixture**

```bash
node scripts/record-fixture.mjs "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=react&location=Brazil&f_TPR=r604800&start=0" packages/connectors/fixtures/linkedin.html
```
Expected: `200` e um HTML com vários `<li>` contendo `base-search-card__title`. Se vier `429` ou HTML vazio, espere um minuto e repita.

- [ ] **Step 2: Escrever o teste que falha — `packages/connectors/src/linkedin.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { parseLinkedin } from './linkedin';

const html = readFileSync(new URL('../fixtures/linkedin.html', import.meta.url), 'utf8');

describe('parseLinkedin', () => {
  it('extracts valid jobs from the guest search html', () => {
    const jobs = parseLinkedin(html, { country: 'BR', remote: false, query: 'react' });
    expect(jobs.length).toBeGreaterThan(3);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('linkedin');
      expect(j.externalId).toMatch(/^\d+$/);
      expect(j.url).not.toContain('?');
      expect(j.stacks).toContain('react');
    }
  });

  it('returns an empty list for html without cards', () => {
    expect(parseLinkedin('<html></html>', { country: 'BR', remote: false, query: 'react' })).toEqual([]);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test packages/connectors/src/linkedin`
Expected: FAIL — módulo não existe.

- [ ] **Step 4: Implementar `packages/connectors/src/linkedin.ts`**

```ts
import { load } from 'cheerio';
import type { NormalizedJob } from '@kv/shared';
import { fetchText, sleep } from './http';
import { keepValid, queriesFor, stacksWithQuery, toMs } from './normalize';
import type { Connector } from './types';

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

interface ParseContext {
  country: 'BR' | 'INT';
  remote: boolean;
  query: string;
}

export function parseLinkedin(html: string, ctx: ParseContext): NormalizedJob[] {
  const $ = load(html);
  const jobs = $('li')
    .toArray()
    .map((li) => {
      const el = $(li);
      const urn = el.find('[data-entity-urn]').attr('data-entity-urn') ?? '';
      const title = el.find('.base-search-card__title').text().trim();
      const href = el.find('a.base-card__full-link').attr('href') ?? '';
      return {
        source: 'linkedin',
        externalId: urn.split(':').pop() ?? '',
        url: href.split('?')[0],
        title,
        company: el.find('.base-search-card__subtitle').text().trim(),
        location: el.find('.job-search-card__location').text().trim(),
        country: ctx.country,
        remote: ctx.remote,
        stacks: stacksWithQuery(title, ctx.query),
        description: '',
        postedAt: toMs(el.find('time').attr('datetime')),
      };
    });
  return keepValid(jobs);
}

export const linkedin: Connector = {
  id: 'linkedin',
  name: 'LinkedIn',
  async search(filters) {
    const targets: { location: string; country: 'BR' | 'INT'; remote: boolean }[] = [];
    if (filters.regions.length === 0 || filters.regions.includes('brasil')) {
      targets.push({ location: 'Brazil', country: 'BR', remote: false });
    }
    if (filters.regions.includes('exterior') || filters.regions.includes('remoto')) {
      targets.push({ location: 'Worldwide', country: 'INT', remote: !filters.regions.includes('exterior') });
    }
    const out: NormalizedJob[] = [];
    for (const t of targets) {
      for (const q of queriesFor(filters)) {
        const params = new URLSearchParams({
          keywords: q,
          location: t.location,
          f_TPR: `r${filters.maxAgeDays * 86_400}`,
          start: '0',
        });
        if (t.remote) params.set('f_WT', '2');
        out.push(...parseLinkedin(await fetchText(`${BASE}?${params}`), { ...t, query: q }));
        await sleep(1500);
      }
    }
    return out;
  },
};
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test packages/connectors/src/linkedin`
Expected: PASS, 2 testes. Se nenhum card for extraído, abra a fixture, localize as classes atuais do título, empresa, local e link, e ajuste os seletores.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(connectors): add LinkedIn guest search"
```

---

### Task 10: Conector Indeed (Playwright, sem login)

**Files:**
- Create: `packages/connectors/src/indeed.ts`, `packages/connectors/scripts/record-indeed.ts`, `packages/connectors/fixtures/indeed.html`
- Test: `packages/connectors/src/indeed.test.ts`

- [ ] **Step 1: Instalar o Chromium do Playwright**

Run: `pnpm --filter @kv/connectors exec playwright install chromium`
Expected: download concluído.

- [ ] **Step 2: Escrever o teste que falha — `packages/connectors/src/indeed.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NormalizedJobSchema } from '@kv/shared';
import { parseIndeed } from './indeed';

const html = readFileSync(new URL('../fixtures/indeed.html', import.meta.url), 'utf8');

describe('parseIndeed', () => {
  it('extracts valid jobs from a results page', () => {
    const jobs = parseIndeed(html, { domain: 'br.indeed.com', country: 'BR', query: 'react' });
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(NormalizedJobSchema.safeParse(j).success).toBe(true);
      expect(j.source).toBe('indeed');
      expect(j.url).toBe(`https://br.indeed.com/viewjob?jk=${j.externalId}`);
      expect(j.postedAt).toBeNull();
    }
  });

  it('returns an empty list for a page without results', () => {
    expect(parseIndeed('<html></html>', { domain: 'br.indeed.com', country: 'BR', query: 'react' })).toEqual([]);
  });
});
```

- [ ] **Step 3: Implementar `packages/connectors/src/indeed.ts`**

```ts
import { load } from 'cheerio';
import type { NormalizedJob } from '@kv/shared';
import { keepValid, queriesFor, stacksWithQuery } from './normalize';
import type { Connector } from './types';

interface ParseContext {
  domain: string;
  country: 'BR' | 'INT';
  query: string;
}

export function parseIndeed(html: string, ctx: ParseContext): NormalizedJob[] {
  const $ = load(html);
  const jobs = $('div.job_seen_beacon')
    .toArray()
    .map((card) => {
      const el = $(card);
      const link = el.find('h2.jobTitle a').first();
      const jk = link.attr('data-jk') ?? '';
      const title = (link.find('span').first().text() || link.text()).trim();
      const location = el.find('[data-testid="text-location"]').text().trim();
      return {
        source: 'indeed',
        externalId: jk,
        url: `https://${ctx.domain}/viewjob?jk=${jk}`,
        title,
        company: el.find('[data-testid="company-name"]').text().trim(),
        location,
        country: ctx.country,
        remote: /remot/i.test(location),
        stacks: stacksWithQuery(title, ctx.query),
        description: '',
        postedAt: null,
      };
    });
  return keepValid(jobs);
}

/** Abre a página de resultados em um Chromium e devolve o HTML. Lança se o Indeed bloquear. */
export async function fetchIndeedHtml(url: string): Promise<string> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: process.env.INDEED_HEADFUL !== '1' });
  try {
    const page = await browser.newPage({ locale: 'pt-BR' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try {
      await page.waitForSelector('div.job_seen_beacon', { timeout: 20_000 });
    } catch {
      throw new Error('Indeed bloqueou o acesso ou mudou o layout');
    }
    return await page.content();
  } finally {
    await browser.close();
  }
}

export const indeed: Connector = {
  id: 'indeed',
  name: 'Indeed',
  async search(filters) {
    const targets: { domain: string; country: 'BR' | 'INT' }[] = [];
    if (filters.regions.length === 0 || filters.regions.includes('brasil')) {
      targets.push({ domain: 'br.indeed.com', country: 'BR' });
    }
    if (filters.regions.includes('exterior') || filters.regions.includes('remoto')) {
      targets.push({ domain: 'www.indeed.com', country: 'INT' });
    }
    const out: NormalizedJob[] = [];
    for (const t of targets) {
      for (const q of queriesFor(filters)) {
        const url = `https://${t.domain}/jobs?q=${encodeURIComponent(q)}&fromage=${filters.maxAgeDays}`;
        out.push(...parseIndeed(await fetchIndeedHtml(url), { ...t, query: q }));
      }
    }
    return out;
  },
};
```

- [ ] **Step 4: Criar `packages/connectors/scripts/record-indeed.ts` e gravar a fixture**

```ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchIndeedHtml } from '../src/indeed';

const html = await fetchIndeedHtml('https://br.indeed.com/jobs?q=react&fromage=7');
const out = fileURLToPath(new URL('../fixtures/indeed.html', import.meta.url));
writeFileSync(out, html);
console.log('gravado', out, `${html.length} bytes`);
```

Run: `pnpm --filter @kv/connectors exec tsx scripts/record-indeed.ts`
Expected: `gravado ... indeed.html`.

Se lançar "Indeed bloqueou o acesso", repita com janela visível: `INDEED_HEADFUL=1 pnpm --filter @kv/connectors exec tsx scripts/record-indeed.ts`.

Se continuar bloqueado, grave esta fixture mínima em `packages/connectors/fixtures/indeed.html` e siga; o conector fica registrado como frágil e o painel "Saúde das fontes" mostrará o erro em produção:

```html
<html><body>
<div class="job_seen_beacon">
  <h2 class="jobTitle"><a data-jk="abc123def456" href="/rc/clk?jk=abc123def456"><span title="Desenvolvedor React">Desenvolvedor React</span></a></h2>
  <span data-testid="company-name">Acme Tecnologia</span>
  <div data-testid="text-location">Remoto</div>
</div>
<div class="job_seen_beacon">
  <h2 class="jobTitle"><a data-jk="fff999eee888" href="/rc/clk?jk=fff999eee888"><span title="Pessoa Engenheira Frontend">Pessoa Engenheira Frontend</span></a></h2>
  <span data-testid="company-name">Beta S.A.</span>
  <div data-testid="text-location">São Paulo, SP</div>
</div>
</body></html>
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test packages/connectors/src/indeed`
Expected: PASS, 2 testes. Com fixture real e zero vagas extraídas, ajuste os seletores olhando o HTML gravado.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(connectors): add Indeed via headless browser"
```

---

### Task 11: Registro de conectores e conector fake

**Files:**
- Create: `packages/connectors/src/fake.ts`, `packages/connectors/src/index.ts`
- Test: `packages/connectors/src/index.test.ts`

- [ ] **Step 1: Escrever o teste que falha — `packages/connectors/src/index.test.ts`**

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { getConnector, getConnectors } from './index';

afterEach(() => {
  delete process.env.FAKE_CONNECTORS;
});

describe('connector registry', () => {
  it('lists the nine real connectors with unique ids', () => {
    const ids = getConnectors().map((c) => c.id);
    expect(ids).toEqual([
      'gupy', 'remotive', 'remoteok', 'greenhouse', 'lever', 'arbeitnow', 'himalayas', 'linkedin', 'indeed',
    ]);
  });

  it('finds a connector by id', () => {
    expect(getConnector('gupy')?.name).toBe('Gupy');
    expect(getConnector('nope')).toBeUndefined();
  });

  it('exposes only the fake connector when FAKE_CONNECTORS=1', async () => {
    process.env.FAKE_CONNECTORS = '1';
    const list = getConnectors();
    expect(list.map((c) => c.id)).toEqual(['fake']);
    const jobs = await list[0].search({ stacks: [], levels: [], maxAgeDays: 7, regions: [] });
    expect(jobs[0].title).toBe('Fake React Developer');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test packages/connectors/src/index`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `packages/connectors/src/fake.ts`**

```ts
import type { Connector } from './types';

/** Conector determinístico para testes e2e. Ativado por FAKE_CONNECTORS=1. */
export const fake: Connector = {
  id: 'fake',
  name: 'Fake',
  async search() {
    return [
      {
        source: 'fake', externalId: 'fake-1', url: 'https://example.com/jobs/fake-1',
        title: 'Fake React Developer', company: 'Fake Corp', location: 'Remoto', country: 'BR',
        remote: true, stacks: ['react'], description: 'Vaga de teste com React.', postedAt: Date.now(),
      },
      {
        source: 'fake', externalId: 'fake-2', url: 'https://example.com/jobs/fake-2',
        title: 'Fake Node Engineer', company: 'Fake Corp', location: 'Remoto', country: 'BR',
        remote: true, stacks: ['node'], description: 'Vaga de teste com Node.', postedAt: Date.now(),
      },
    ];
  },
};
```

- [ ] **Step 4: Implementar `packages/connectors/src/index.ts`**

```ts
import { arbeitnow } from './arbeitnow';
import { fake } from './fake';
import { greenhouse } from './greenhouse';
import { gupy } from './gupy';
import { himalayas } from './himalayas';
import { indeed } from './indeed';
import { lever } from './lever';
import { linkedin } from './linkedin';
import { remoteok } from './remoteok';
import { remotive } from './remotive';
import type { Connector } from './types';

export type { Connector } from './types';
export { detectLevel, detectStacks, matchesFilters } from './filter';

const REAL: Connector[] = [gupy, remotive, remoteok, greenhouse, lever, arbeitnow, himalayas, linkedin, indeed];

export function getConnectors(): Connector[] {
  return process.env.FAKE_CONNECTORS === '1' ? [fake] : REAL;
}

export function getConnector(id: string): Connector | undefined {
  return getConnectors().find((c) => c.id === id);
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test packages/connectors`
Expected: PASS em todos os arquivos do pacote.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(connectors): add registry and fake connector"
```

---

### Task 12: Worker — dedup e runner

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/dedup.ts`, `apps/worker/src/runner.ts`
- Test: `apps/worker/src/dedup.test.ts`, `apps/worker/src/runner.test.ts`

- [ ] **Step 1: Criar `apps/worker/package.json` e `tsconfig.json`**

```json
{
  "name": "@kv/worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts"
  }
}
```

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Run: `pnpm --filter @kv/worker add drizzle-orm "@kv/db@workspace:*" "@kv/connectors@workspace:*" "@kv/shared@workspace:*"`

- [ ] **Step 2: Escrever os testes que falham**

`apps/worker/src/dedup.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dedupHash } from './dedup';

describe('dedupHash', () => {
  it('ignores case, accents and extra spaces', () => {
    const a = dedupHash({ company: 'Acme  Tecnologia', title: 'Desenvolvedor Sênior', location: 'São Paulo' });
    const b = dedupHash({ company: 'acme tecnologia', title: 'desenvolvedor senior', location: 'sao paulo' });
    expect(a).toBe(b);
  });
  it('differs when the title differs', () => {
    const a = dedupHash({ company: 'Acme', title: 'Dev React', location: '' });
    const b = dedupHash({ company: 'Acme', title: 'Dev Node', location: '' });
    expect(a).not.toBe(b);
  });
});
```

`apps/worker/src/runner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Connector } from '@kv/connectors';
import { enqueueRuns, jobEvents, jobs, openDb, runs, searchProfiles, type Db } from '@kv/db';
import type { NormalizedJob } from '@kv/shared';
import { executeRun } from './runner';

const job = (n: number, over: Partial<NormalizedJob> = {}): NormalizedJob => ({
  source: 'a', externalId: String(n), url: `https://example.com/${n}`, title: `React Developer ${n}`,
  company: 'Acme', location: 'Remoto', country: 'BR', remote: true, stacks: ['react'], description: '',
  postedAt: Date.now(), ...over,
});

function setup(sources: string[]) {
  const db = openDb(':memory:');
  const profile = db
    .insert(searchProfiles)
    .values({
      name: 'P', stacks: ['react'], levels: [], maxAgeDays: 7, regions: [], sources, active: true, createdAt: 1,
    })
    .returning()
    .get();
  enqueueRuns(db, profile, 'manual');
  return { db, profile };
}

const runFor = (db: Db, source: string) => db.select().from(runs).where(eq(runs.source, source)).get()!;

describe('executeRun', () => {
  it('inserts new jobs into descobertas and records the run', async () => {
    const { db } = setup(['a']);
    const a: Connector = { id: 'a', name: 'A', search: async () => [job(1), job(2)] };
    await executeRun(db, runFor(db, 'a').id, [a]);

    const rows = db.select().from(jobs).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.column === 'descobertas')).toBe(true);
    expect(db.select().from(jobEvents).all()).toHaveLength(2);
    expect(runFor(db, 'a')).toMatchObject({ status: 'ok', found: 2, inserted: 2 });
  });

  it('does not insert the same job twice', async () => {
    const { db, profile } = setup(['a']);
    const a: Connector = { id: 'a', name: 'A', search: async () => [job(1)] };
    await executeRun(db, runFor(db, 'a').id, [a]);
    enqueueRuns(db, profile, 'manual');
    const second = db.select().from(runs).where(eq(runs.status, 'queued')).get()!;
    await executeRun(db, second.id, [a]);

    expect(db.select().from(jobs).all()).toHaveLength(1);
    expect(db.select().from(runs).where(eq(runs.id, second.id)).get()).toMatchObject({ found: 1, inserted: 0 });
  });

  it('treats the same company and title from another source as duplicate', async () => {
    const { db } = setup(['a', 'b']);
    const a: Connector = { id: 'a', name: 'A', search: async () => [job(1)] };
    const b: Connector = {
      id: 'b', name: 'B',
      search: async () => [job(1, { source: 'b', url: 'https://other.com/x' })],
    };
    await executeRun(db, runFor(db, 'a').id, [a, b]);
    await executeRun(db, runFor(db, 'b').id, [a, b]);
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('applies the profile filters', async () => {
    const { db } = setup(['a']);
    const a: Connector = {
      id: 'a', name: 'A',
      search: async () => [job(1), job(2, { title: 'Python Developer', stacks: ['python'] })],
    };
    await executeRun(db, runFor(db, 'a').id, [a]);
    expect(db.select().from(jobs).all().map((j) => j.title)).toEqual(['React Developer 1']);
  });

  it('records an error without throwing, leaving other sources unaffected', async () => {
    const { db } = setup(['a', 'b']);
    const a: Connector = { id: 'a', name: 'A', search: async () => { throw new Error('boom'); } };
    const b: Connector = { id: 'b', name: 'B', search: async () => [job(1, { source: 'b' })] };
    await executeRun(db, runFor(db, 'a').id, [a, b], { retries: 0 });
    await executeRun(db, runFor(db, 'b').id, [a, b]);

    expect(runFor(db, 'a')).toMatchObject({ status: 'error', error: 'boom' });
    expect(runFor(db, 'b').status).toBe('ok');
    expect(db.select().from(jobs).all()).toHaveLength(1);
  });

  it('retries once before failing', async () => {
    const { db } = setup(['a']);
    let calls = 0;
    const a: Connector = {
      id: 'a', name: 'A',
      search: async () => { calls++; if (calls === 1) throw new Error('flaky'); return [job(1)]; },
    };
    await executeRun(db, runFor(db, 'a').id, [a]);
    expect(calls).toBe(2);
    expect(runFor(db, 'a').status).toBe('ok');
  });

  it('fails a run whose connector exceeds the timeout', async () => {
    const { db } = setup(['a']);
    const a: Connector = { id: 'a', name: 'A', search: () => new Promise(() => {}) };
    await executeRun(db, runFor(db, 'a').id, [a], { timeoutMs: 20, retries: 0 });
    expect(runFor(db, 'a').status).toBe('error');
    expect(runFor(db, 'a').error).toContain('timeout');
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test apps/worker`
Expected: FAIL — módulos não existem.

- [ ] **Step 4: Implementar `apps/worker/src/dedup.ts`**

```ts
import { createHash } from 'node:crypto';

const fold = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Mesma empresa + título + local = mesma vaga, venha de onde vier. */
export function dedupHash(job: { company: string; title: string; location: string }): string {
  return createHash('sha1').update(`${fold(job.company)}|${fold(job.title)}|${fold(job.location)}`).digest('hex');
}
```

- [ ] **Step 5: Implementar `apps/worker/src/runner.ts`**

```ts
import { eq, or } from 'drizzle-orm';
import { detectLevel, matchesFilters, type Connector } from '@kv/connectors';
import { jobEvents, jobs, runs, searchProfiles, type Db } from '@kv/db';
import type { NormalizedJob, SearchFilters } from '@kv/shared';
import { dedupHash } from './dedup';

export interface RunOptions {
  timeoutMs?: number;
  retries?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout após ${ms} ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function searchWithRetry(connector: Connector, filters: SearchFilters, timeoutMs: number, retries: number) {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(connector.search(filters), timeoutMs);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Grava as vagas ainda não vistas na coluna descobertas. Devolve quantas inseriu. */
export function insertNewJobs(db: Db, profileId: number, found: NormalizedJob[]): number {
  const now = Date.now();
  let inserted = 0;
  found.forEach((job, i) => {
    const hash = dedupHash(job);
    const dup = db.select({ id: jobs.id }).from(jobs).where(or(eq(jobs.url, job.url), eq(jobs.dedupHash, hash))).get();
    if (dup) return;
    const row = db
      .insert(jobs)
      .values({
        ...job,
        level: detectLevel(job.title),
        discoveredAt: now,
        dedupHash: hash,
        profileId,
        column: 'descobertas',
        position: -now + i,
      })
      .returning({ id: jobs.id })
      .get();
    db.insert(jobEvents)
      .values({ jobId: row.id, fromColumn: null, toColumn: 'descobertas', actor: 'sistema', createdAt: now })
      .run();
    inserted++;
  });
  return inserted;
}

/** Executa um run enfileirado. Nunca lança: falhas ficam registradas na linha do run. */
export async function executeRun(db: Db, runId: number, connectors: Connector[], opts: RunOptions = {}): Promise<void> {
  const { timeoutMs = 60_000, retries = 1 } = opts;
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return;
  db.update(runs).set({ status: 'running', startedAt: Date.now() }).where(eq(runs.id, runId)).run();
  try {
    const profile = db.select().from(searchProfiles).where(eq(searchProfiles.id, run.profileId)).get();
    if (!profile) throw new Error(`perfil ${run.profileId} não existe`);
    const connector = connectors.find((c) => c.id === run.source);
    if (!connector) throw new Error(`conector desconhecido: ${run.source}`);
    const filters: SearchFilters = {
      stacks: profile.stacks,
      levels: profile.levels,
      maxAgeDays: profile.maxAgeDays,
      regions: profile.regions,
    };
    const all = await searchWithRetry(connector, filters, timeoutMs, retries);
    const found = all.filter((j) => matchesFilters(j, filters));
    const inserted = insertNewJobs(db, profile.id, found);
    db.update(runs)
      .set({ status: 'ok', found: found.length, inserted, finishedAt: Date.now() })
      .where(eq(runs.id, runId))
      .run();
  } catch (e) {
    db.update(runs)
      .set({ status: 'error', error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() })
      .where(eq(runs.id, runId))
      .run();
  }
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm test apps/worker`
Expected: PASS, 9 testes.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(worker): add dedup and run executor"
```

---

### Task 13: Worker — agendador e processo

**Files:**
- Create: `apps/worker/src/scheduler.ts`, `apps/worker/src/index.ts`
- Test: `apps/worker/src/scheduler.test.ts`

- [ ] **Step 1: Escrever o teste que falha — `apps/worker/src/scheduler.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { Connector } from '@kv/connectors';
import { jobs, openDb, runs, searchProfiles, type Db } from '@kv/db';
import { enqueueAllActive, failStaleRuns, isDue, msUntilNextHour, processQueue } from './scheduler';

const HOUR = 3_600_000;

function addProfile(db: Db, active: boolean, sources = ['a']) {
  return db
    .insert(searchProfiles)
    .values({ name: 'P', stacks: [], levels: [], maxAgeDays: 7, regions: [], sources, active, createdAt: 1 })
    .returning()
    .get();
}

const connector: Connector = {
  id: 'a', name: 'A',
  search: async () => [{
    source: 'a', externalId: '1', url: 'https://example.com/1', title: 'Dev', company: 'Acme', location: '',
    country: 'BR', remote: true, stacks: [], description: '', postedAt: null,
  }],
};

describe('isDue', () => {
  it('is due with no successful run, and not due right after one', () => {
    const db = openDb(':memory:');
    const now = 10 * HOUR;
    expect(isDue(db, now)).toBe(true);
    db.insert(runs)
      .values({ profileId: 1, source: 'a', trigger: 'cron', status: 'ok', createdAt: now, finishedAt: now - 60_000 })
      .run();
    expect(isDue(db, now)).toBe(false);
    expect(isDue(db, now + HOUR)).toBe(true);
  });
});

describe('enqueueAllActive', () => {
  it('queues runs only for active profiles', () => {
    const db = openDb(':memory:');
    addProfile(db, true, ['a', 'b']);
    addProfile(db, false);
    expect(enqueueAllActive(db)).toBe(2);
    expect(db.select().from(runs).all().every((r) => r.trigger === 'cron')).toBe(true);
  });
});

describe('processQueue', () => {
  it('executes every queued run', async () => {
    const db = openDb(':memory:');
    addProfile(db, true);
    enqueueAllActive(db);
    expect(await processQueue(db, [connector])).toBe(1);
    expect(db.select().from(runs).all()[0].status).toBe('ok');
    expect(db.select().from(jobs).all()).toHaveLength(1);
    expect(await processQueue(db, [connector])).toBe(0);
  });
});

describe('failStaleRuns', () => {
  it('marks runs left in running state as error', () => {
    const db = openDb(':memory:');
    db.insert(runs).values({ profileId: 1, source: 'a', trigger: 'cron', status: 'running', createdAt: 1 }).run();
    failStaleRuns(db);
    expect(db.select().from(runs).all()[0]).toMatchObject({ status: 'error', error: 'worker reiniciado' });
  });
});

describe('msUntilNextHour', () => {
  it('returns the distance to the next full hour', () => {
    expect(msUntilNextHour(new Date('2026-11-11T10:15:00.000Z').getTime())).toBe(45 * 60_000);
    expect(msUntilNextHour(new Date('2026-11-11T10:00:00.000Z').getTime())).toBe(HOUR);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test apps/worker/src/scheduler`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `apps/worker/src/scheduler.ts`**

```ts
import { and, eq, gt } from 'drizzle-orm';
import type { Connector } from '@kv/connectors';
import { enqueueRuns, runs, searchProfiles, type Db } from '@kv/db';
import { executeRun } from './runner';

const HOUR = 3_600_000;

/** Verdadeiro se nenhum run terminou com sucesso na última hora. */
export function isDue(db: Db, now: number = Date.now()): boolean {
  const recent = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.status, 'ok'), gt(runs.finishedAt, now - HOUR)))
    .get();
  return !recent;
}

/** Enfileira um run por fonte de cada perfil ativo. Devolve quantos enfileirou. */
export function enqueueAllActive(db: Db): number {
  const profiles = db.select().from(searchProfiles).where(eq(searchProfiles.active, true)).all();
  return profiles.reduce((total, p) => total + enqueueRuns(db, p, 'cron'), 0);
}

/** Executa em paralelo todos os runs na fila. Devolve quantos executou. */
export async function processQueue(db: Db, connectors: Connector[]): Promise<number> {
  const queued = db.select({ id: runs.id }).from(runs).where(eq(runs.status, 'queued')).all();
  await Promise.all(queued.map((r) => executeRun(db, r.id, connectors)));
  return queued.length;
}

/** Runs que ficaram em "running" de um processo anterior viram erro. */
export function failStaleRuns(db: Db): void {
  db.update(runs)
    .set({ status: 'error', error: 'worker reiniciado', finishedAt: Date.now() })
    .where(eq(runs.status, 'running'))
    .run();
}

export function msUntilNextHour(now: number = Date.now()): number {
  return HOUR - (now % HOUR);
}

/** Chama `fn` a cada hora cheia, para sempre. */
export function scheduleHourly(fn: () => void): void {
  setTimeout(() => {
    fn();
    scheduleHourly(fn);
  }, msUntilNextHour());
}
```

- [ ] **Step 4: Implementar `apps/worker/src/index.ts`**

```ts
import { getConnectors } from '@kv/connectors';
import { openDb } from '@kv/db';
import { enqueueAllActive, failStaleRuns, isDue, processQueue, scheduleHourly } from './scheduler';

const POLL_MS = 5_000;
const db = openDb();
const log = (msg: string) => console.log(`[worker ${new Date().toISOString()}] ${msg}`);

failStaleRuns(db);

if (isDue(db)) log(`busca inicial: ${enqueueAllActive(db)} runs enfileirados`);

scheduleHourly(() => log(`busca horária: ${enqueueAllActive(db)} runs enfileirados`));

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const done = await processQueue(db, getConnectors());
    if (done > 0) log(`${done} runs executados`);
  } catch (e) {
    log(`erro na fila: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    busy = false;
  }
}, POLL_MS);

log('worker iniciado; busca a cada hora cheia, fila verificada a cada 5 s');
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test apps/worker`
Expected: PASS, 14 testes.

- [ ] **Step 6: Fumaça do processo**

Run: `DB_PATH=./data/smoke.db FAKE_CONNECTORS=1 timeout 8 pnpm --filter @kv/worker start; rm -f data/smoke.db*`
Expected: imprime `worker iniciado` e encerra pelo timeout sem stack trace.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(worker): add hourly scheduler and queue loop"
```

---

### Task 14: API

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/app.ts`, `apps/api/src/routes/profiles.ts`, `apps/api/src/routes/jobs.ts`, `apps/api/src/routes/runs.ts`, `apps/api/src/routes/meta.ts`, `apps/api/src/index.ts`
- Test: `apps/api/src/app.test.ts`

- [ ] **Step 1: Criar `apps/api/package.json` e `tsconfig.json`**

```json
{
  "name": "@kv/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts"
  }
}
```

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Run: `pnpm --filter @kv/api add fastify @fastify/cors zod drizzle-orm "@kv/db@workspace:*" "@kv/connectors@workspace:*" "@kv/shared@workspace:*"`

- [ ] **Step 2: Escrever o teste que falha — `apps/api/src/app.test.ts`**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { jobs, openDb, runs, type Db } from '@kv/db';
import { buildApp } from './app';

const profileBody = {
  name: 'React Pleno', stacks: ['react'], levels: ['pleno'], maxAgeDays: 7, regions: ['remoto'],
  sources: ['gupy', 'remotive'],
};

let db: Db;
let app: ReturnType<typeof buildApp>;

function seedJob(over: Partial<typeof jobs.$inferInsert> = {}) {
  return db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: '1', url: `https://example.com/${Math.random()}`, title: 'Dev React',
      company: 'Acme', location: 'SP', country: 'BR', remote: false, stacks: ['react'], description: 'd',
      postedAt: null, discoveredAt: 1, dedupHash: String(Math.random()), profileId: 1, column: 'descobertas',
      position: 0, ...over,
    })
    .returning()
    .get();
}

beforeEach(() => {
  db = openDb(':memory:');
  app = buildApp(db);
});

describe('profiles', () => {
  it('creates, lists, updates and deletes', async () => {
    const created = await app.inject({ method: 'POST', url: '/profiles', payload: profileBody });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    expect((await app.inject({ method: 'GET', url: '/profiles' })).json()).toHaveLength(1);

    const patched = await app.inject({ method: 'PATCH', url: `/profiles/${id}`, payload: { active: false } });
    expect(patched.json().active).toBe(false);

    expect((await app.inject({ method: 'DELETE', url: `/profiles/${id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/profiles' })).json()).toHaveLength(0);
  });

  it('rejects invalid input with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/profiles', payload: { ...profileBody, maxAgeDays: 5 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation');
  });
});

describe('jobs', () => {
  it('lists ordered by position and filters by column and text', async () => {
    seedJob({ title: 'B', position: 2 });
    seedJob({ title: 'A', position: 1 });
    seedJob({ title: 'Python Dev', position: 3, column: 'aplicada' });

    const all = (await app.inject({ method: 'GET', url: '/jobs' })).json();
    expect(all.map((j: { title: string }) => j.title)).toEqual(['A', 'B', 'Python Dev']);

    const col = (await app.inject({ method: 'GET', url: '/jobs?column=aplicada' })).json();
    expect(col).toHaveLength(1);

    const q = (await app.inject({ method: 'GET', url: '/jobs?q=python' })).json();
    expect(q).toHaveLength(1);
  });

  it('moves a job, records the event and marks human application', async () => {
    const job = seedJob();
    const res = await app.inject({
      method: 'PATCH', url: `/jobs/${job.id}`, payload: { column: 'aplicada', position: 5 },
    });
    expect(res.json()).toMatchObject({ column: 'aplicada', position: 5, appliedBy: 'humano' });

    const detail = (await app.inject({ method: 'GET', url: `/jobs/${job.id}` })).json();
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({ fromColumn: 'descobertas', toColumn: 'aplicada', actor: 'humano' });
  });

  it('saves notes without creating an event', async () => {
    const job = seedJob();
    await app.inject({ method: 'PATCH', url: `/jobs/${job.id}`, payload: { notes: 'ligar amanhã' } });
    const detail = (await app.inject({ method: 'GET', url: `/jobs/${job.id}` })).json();
    expect(detail.job.notes).toBe('ligar amanhã');
    expect(detail.events).toHaveLength(0);
  });

  it('returns 404 for an unknown job', async () => {
    expect((await app.inject({ method: 'GET', url: '/jobs/999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: '/jobs/999', payload: {} })).statusCode).toBe(404);
  });
});

describe('runs', () => {
  it('queues one run per source of the profile', async () => {
    const id = (await app.inject({ method: 'POST', url: '/profiles', payload: profileBody })).json().id;
    const res = await app.inject({ method: 'POST', url: '/runs', payload: { profileId: id } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: 2 });
    expect(db.select().from(runs).all()).toHaveLength(2);
  });

  it('returns 404 when the profile does not exist', async () => {
    expect((await app.inject({ method: 'POST', url: '/runs', payload: { profileId: 42 } })).statusCode).toBe(404);
  });

  it('reports the latest finished run per source', async () => {
    db.insert(runs).values([
      { profileId: 1, source: 'gupy', trigger: 'cron', status: 'ok', found: 3, inserted: 1, createdAt: 1, finishedAt: 10 },
      { profileId: 1, source: 'gupy', trigger: 'cron', status: 'error', error: 'HTTP 500', createdAt: 2, finishedAt: 20 },
    ]).run();
    const health = (await app.inject({ method: 'GET', url: '/runs/health' })).json();
    const gupy = health.sources.find((s: { source: string }) => s.source === 'gupy');
    expect(gupy).toMatchObject({ status: 'error', error: 'HTTP 500', finishedAt: 20 });
    expect(health.sources.find((s: { source: string }) => s.source === 'lever').status).toBe('never');
    expect(health.lastFinishedAt).toBe(20);
  });
});

describe('meta', () => {
  it('lists sources', async () => {
    const sources = (await app.inject({ method: 'GET', url: '/sources' })).json();
    expect(sources).toHaveLength(9);
    expect(sources[0]).toEqual({ id: 'gupy', name: 'Gupy' });
  });

  it('counts jobs for the stats bar', async () => {
    seedJob({ appliedBy: 'ia', column: 'aplicada' });
    seedJob({ appliedBy: 'humano', column: 'aplicada' });
    seedJob({ needsHuman: true });
    const stats = (await app.inject({ method: 'GET', url: '/stats' })).json();
    expect(stats).toEqual({ total: 3, appliedByAi: 1, appliedByHuman: 1, needsHuman: 1 });
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test apps/api`
Expected: FAIL — não encontra `./app`.

- [ ] **Step 4: Implementar `apps/api/src/app.ts`**

```ts
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import type { Db } from '@kv/db';
import { jobRoutes } from './routes/jobs';
import { metaRoutes } from './routes/meta';
import { profileRoutes } from './routes/profiles';
import { runRoutes } from './routes/runs';

export function buildApp(db: Db) {
  const app = Fastify();
  app.register(cors, { origin: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: 'validation', message });
    }
    return reply.code(err.statusCode ?? 500).send({ error: 'internal', message: err.message });
  });

  profileRoutes(app, db);
  jobRoutes(app, db);
  runRoutes(app, db);
  metaRoutes(app, db);
  return app;
}
```

- [ ] **Step 5: Implementar `apps/api/src/routes/profiles.ts`**

```ts
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { searchProfiles, type Db } from '@kv/db';
import { ProfileInputSchema, ProfilePatchSchema } from '@kv/shared';

const notFound = { error: 'not_found', message: 'perfil não encontrado' };
const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

export function profileRoutes(app: FastifyInstance, db: Db) {
  app.get('/profiles', () => db.select().from(searchProfiles).orderBy(desc(searchProfiles.id)).all());

  app.post('/profiles', (req, reply) => {
    const input = ProfileInputSchema.parse(req.body);
    const row = db.insert(searchProfiles).values({ ...input, createdAt: Date.now() }).returning().get();
    return reply.code(201).send(row);
  });

  app.patch('/profiles/:id', (req, reply) => {
    const id = idOf(req);
    const patch = ProfilePatchSchema.parse(req.body);
    const existing = db.select().from(searchProfiles).where(eq(searchProfiles.id, id)).get();
    if (!existing) return reply.code(404).send(notFound);
    if (Object.keys(patch).length > 0) {
      db.update(searchProfiles).set(patch).where(eq(searchProfiles.id, id)).run();
    }
    return db.select().from(searchProfiles).where(eq(searchProfiles.id, id)).get();
  });

  app.delete('/profiles/:id', (req, reply) => {
    db.delete(searchProfiles).where(eq(searchProfiles.id, idOf(req))).run();
    return reply.code(204).send();
  });
}
```

O PATCH usa `ProfilePatchSchema` (sem default em `active`) para não reativar um perfil ao editar outro campo.

- [ ] **Step 6: Implementar `apps/api/src/routes/jobs.ts`**

```ts
import { and, asc, eq, like, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { jobEvents, jobs, type Db } from '@kv/db';
import { ColumnSchema, JobPatchSchema } from '@kv/shared';

const notFound = { error: 'not_found', message: 'vaga não encontrada' };
const idOf = (req: { params: unknown }) => Number((req.params as { id: string }).id);

export function jobRoutes(app: FastifyInstance, db: Db) {
  app.get('/jobs', (req) => {
    const query = req.query as { column?: string; profile?: string; source?: string; q?: string };
    const where: SQL[] = [];
    if (query.column) where.push(eq(jobs.column, ColumnSchema.parse(query.column)));
    if (query.profile) where.push(eq(jobs.profileId, Number(query.profile)));
    if (query.source) where.push(eq(jobs.source, query.source));
    if (query.q) {
      const term = `%${query.q}%`;
      where.push(or(like(jobs.title, term), like(jobs.company, term))!);
    }
    return db.select().from(jobs).where(and(...where)).orderBy(asc(jobs.position)).all();
  });

  app.get('/jobs/:id', (req, reply) => {
    const id = idOf(req);
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return reply.code(404).send(notFound);
    const events = db.select().from(jobEvents).where(eq(jobEvents.jobId, id)).orderBy(asc(jobEvents.id)).all();
    return { job, events };
  });

  app.patch('/jobs/:id', (req, reply) => {
    const id = idOf(req);
    const patch = JobPatchSchema.parse(req.body);
    const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
    if (!job) return reply.code(404).send(notFound);

    const set: Partial<typeof jobs.$inferInsert> = {};
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.position !== undefined) set.position = patch.position;
    if (patch.column && patch.column !== job.column) {
      set.column = patch.column;
      if (patch.column === 'aplicada' && !job.appliedBy) set.appliedBy = 'humano';
      db.insert(jobEvents)
        .values({ jobId: id, fromColumn: job.column, toColumn: patch.column, actor: 'humano', createdAt: Date.now() })
        .run();
    }
    if (Object.keys(set).length > 0) db.update(jobs).set(set).where(eq(jobs.id, id)).run();
    return db.select().from(jobs).where(eq(jobs.id, id)).get();
  });
}
```

- [ ] **Step 7: Implementar `apps/api/src/routes/runs.ts`**

```ts
import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getConnectors } from '@kv/connectors';
import { enqueueRuns, runs, searchProfiles, type Db } from '@kv/db';
import { RunRequestSchema, type HealthDto } from '@kv/shared';

export function runRoutes(app: FastifyInstance, db: Db) {
  app.post('/runs', (req, reply) => {
    const { profileId } = RunRequestSchema.parse(req.body);
    const profile = db.select().from(searchProfiles).where(eq(searchProfiles.id, profileId)).get();
    if (!profile) return reply.code(404).send({ error: 'not_found', message: 'perfil não encontrado' });
    return reply.code(202).send({ queued: enqueueRuns(db, profile, 'manual') });
  });

  app.get('/runs/health', (): HealthDto => {
    const finished = db
      .select()
      .from(runs)
      .where(inArray(runs.status, ['ok', 'error']))
      .orderBy(desc(runs.id))
      .limit(500)
      .all();
    const latest = new Map<string, (typeof finished)[number]>();
    for (const r of finished) if (!latest.has(r.source)) latest.set(r.source, r);
    return {
      sources: getConnectors().map((c) => {
        const r = latest.get(c.id);
        return {
          source: c.id,
          name: c.name,
          status: r ? (r.status as 'ok' | 'error') : 'never',
          found: r?.found ?? 0,
          inserted: r?.inserted ?? 0,
          error: r?.error ?? null,
          finishedAt: r?.finishedAt ?? null,
        };
      }),
      lastFinishedAt: finished[0]?.finishedAt ?? null,
    };
  });
}
```

- [ ] **Step 8: Implementar `apps/api/src/routes/meta.ts`**

```ts
import type { FastifyInstance } from 'fastify';
import { getConnectors } from '@kv/connectors';
import { jobs, type Db } from '@kv/db';
import type { SourceDto, StatsDto } from '@kv/shared';

export function metaRoutes(app: FastifyInstance, db: Db) {
  app.get('/sources', (): SourceDto[] => getConnectors().map((c) => ({ id: c.id, name: c.name })));

  app.get('/stats', (): StatsDto => {
    const rows = db.select({ appliedBy: jobs.appliedBy, needsHuman: jobs.needsHuman }).from(jobs).all();
    return {
      total: rows.length,
      appliedByAi: rows.filter((r) => r.appliedBy === 'ia').length,
      appliedByHuman: rows.filter((r) => r.appliedBy === 'humano').length,
      needsHuman: rows.filter((r) => r.needsHuman).length,
    };
  });
}
```

- [ ] **Step 9: Implementar `apps/api/src/index.ts`**

```ts
import { openDb } from '@kv/db';
import { buildApp } from './app';

const port = Number(process.env.API_PORT ?? 3333);
const app = buildApp(openDb());

app.listen({ port, host: '127.0.0.1' }).then(
  () => console.log(`[api] http://127.0.0.1:${port}`),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
```

- [ ] **Step 10: Rodar e ver passar**

Run: `pnpm test apps/api`
Expected: PASS, 11 testes.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(api): add profiles, jobs, runs and stats routes"
```

---

### Task 15: Web — scaffold, cliente da API e cálculo de posição

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/main.tsx`, `apps/web/src/index.css`, `apps/web/src/api.ts`, `apps/web/src/toast.ts`, `apps/web/src/position.ts`, `apps/web/src/App.tsx`
- Test: `apps/web/src/position.test.ts`

- [ ] **Step 1: Criar `apps/web/package.json` e `tsconfig.json`**

```json
{
  "name": "@kv/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  }
}
```

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node", "vite/client"] },
  "include": ["src", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

Run:
```bash
pnpm --filter @kv/web add react react-dom @tanstack/react-query @dnd-kit/core motion "@kv/shared@workspace:*"
pnpm --filter @kv/web add -D vite @vitejs/plugin-react tailwindcss @tailwindcss/vite @types/react @types/react-dom @playwright/test
```

- [ ] **Step 2: Escrever o teste que falha — `apps/web/src/position.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { computePosition } from './position';

const col = [
  { id: 1, position: 10 },
  { id: 2, position: 20 },
  { id: 3, position: 30 },
];

describe('computePosition', () => {
  it('returns 0 for an empty column', () => {
    expect(computePosition([], null)).toBe(0);
  });
  it('appends to the end when dropped on the column', () => {
    expect(computePosition(col, null)).toBe(31);
  });
  it('goes before the first card', () => {
    expect(computePosition(col, 1)).toBe(9);
  });
  it('goes between neighbours', () => {
    expect(computePosition(col, 2)).toBe(15);
    expect(computePosition(col, 3)).toBe(25);
  });
  it('appends when the target card is unknown', () => {
    expect(computePosition(col, 99)).toBe(31);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test apps/web`
Expected: FAIL — não encontra `./position`.

- [ ] **Step 4: Implementar `apps/web/src/position.ts`**

```ts
export interface Positioned {
  id: number;
  position: number;
}

/**
 * Posição de um card solto em uma coluna.
 * `column`: cards da coluna em ordem crescente, sem o card arrastado.
 * `beforeId`: card antes do qual soltar; null = fim da coluna.
 */
export function computePosition(column: Positioned[], beforeId: number | null): number {
  if (column.length === 0) return 0;
  const last = column[column.length - 1].position;
  if (beforeId === null) return last + 1;
  const i = column.findIndex((c) => c.id === beforeId);
  if (i === -1) return last + 1;
  if (i === 0) return column[0].position - 1;
  return (column[i - 1].position + column[i].position) / 2;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test apps/web`
Expected: PASS, 5 testes.

- [ ] **Step 6: Criar `apps/web/index.html`**

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="/logo.png" />
    <title>Kanban de Vagas</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Criar `apps/web/vite.config.ts`**

```ts
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT ?? 3333}`,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
```

- [ ] **Step 8: Criar `apps/web/src/index.css`**

```css
@import "tailwindcss";

@theme {
  --color-bg: #0b0d12;
  --color-surface: #141821;
  --color-surface-2: #1c2230;
  --color-line: #262d3d;
  --color-ink: #e8ecf4;
  --color-muted: #8b95a9;
  --color-accent: #7c9cff;
  --color-ok: #4ade80;
  --color-warn: #fbbf24;
  --color-bad: #f87171;
}

html,
body,
#root {
  height: 100%;
}

body {
  background: var(--color-bg);
  color: var(--color-ink);
  font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif;
}
```

- [ ] **Step 9: Criar `apps/web/src/toast.ts`**

```ts
import { useSyncExternalStore } from 'react';

export interface Toast {
  text: string;
  tone: 'error' | 'info';
}

let current: Toast | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

const emit = () => listeners.forEach((l) => l());

export function showToast(text: string, tone: Toast['tone'] = 'error') {
  current = { text, tone };
  emit();
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    emit();
  }, 4000);
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
```

- [ ] **Step 10: Criar `apps/web/src/api.ts`**

```ts
import type {
  HealthDto, JobDetailDto, JobDto, JobPatch, ProfileDto, ProfileInput, SourceDto, StatsDto,
} from '@kv/shared';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(body.message ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const api = {
  jobs: (q = '') => http<JobDto[]>(`/jobs${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  job: (id: number) => http<JobDetailDto>(`/jobs/${id}`),
  patchJob: (id: number, patch: JobPatch) => http<JobDto>(`/jobs/${id}`, json('PATCH', patch)),
  profiles: () => http<ProfileDto[]>('/profiles'),
  createProfile: (input: ProfileInput) => http<ProfileDto>('/profiles', json('POST', input)),
  updateProfile: (id: number, patch: Partial<ProfileInput>) => http<ProfileDto>(`/profiles/${id}`, json('PATCH', patch)),
  deleteProfile: (id: number) => http<void>(`/profiles/${id}`, { method: 'DELETE' }),
  runNow: (profileId: number) => http<{ queued: number }>('/runs', json('POST', { profileId })),
  health: () => http<HealthDto>('/runs/health'),
  stats: () => http<StatsDto>('/stats'),
  sources: () => http<SourceDto[]>('/sources'),
};
```

- [ ] **Step 11: Criar `apps/web/src/main.tsx`**

```tsx
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { showToast } from './toast';

const onError = (e: Error) => showToast(e.message);
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [ ] **Step 12: Criar `apps/web/src/App.tsx` (casca; as telas entram nas próximas tasks)**

```tsx
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { api } from './api';
import { useToast } from './toast';

type View = 'quadro' | 'perfis' | 'fontes';
const VIEWS: { id: View; label: string }[] = [
  { id: 'quadro', label: 'Quadro' },
  { id: 'perfis', label: 'Perfis de busca' },
  { id: 'fontes', label: 'Saúde das fontes' },
];
const TWO_HOURS = 2 * 3_600_000;

export function App() {
  const [view, setView] = useState<View>('quadro');
  const toast = useToast();
  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });
  const stale = !!health?.lastFinishedAt && Date.now() - health.lastFinishedAt > TWO_HOURS;

  return (
    <div className="flex h-full flex-col">
      <header
        className="border-b border-line bg-surface bg-cover bg-center"
        style={{ backgroundImage: 'linear-gradient(rgba(20,24,33,.88), rgba(20,24,33,.96)), url(/header-bg.jpg)' }}
      >
        <div className="flex items-center gap-6 px-6 py-3">
          <div className="flex items-center gap-2">
            <img
              src="/logo.png" alt="" className="h-8 w-8 rounded"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <h1 className="text-lg font-semibold">Kanban de Vagas</h1>
          </div>
          <nav className="flex gap-1">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={`rounded px-3 py-1.5 text-sm transition-colors ${
                  view === v.id ? 'bg-accent text-bg' : 'text-muted hover:text-ink'
                }`}
              >
                {v.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {stale && (
        <div role="alert" className="bg-warn/15 px-6 py-2 text-sm text-warn">
          O worker não termina uma busca há mais de 2 horas. Confira se ele está rodando (<code>pnpm dev</code>).
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-hidden">
        {view === 'quadro' && <p className="p-6 text-muted">Quadro em construção.</p>}
        {view === 'perfis' && <p className="p-6 text-muted">Perfis em construção.</p>}
        {view === 'fontes' && <p className="p-6 text-muted">Fontes em construção.</p>}
      </main>

      <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}
            className={`fixed bottom-6 left-1/2 -translate-x-1/2 rounded-lg px-4 py-2 text-sm text-bg shadow-lg ${
              toast.tone === 'error' ? 'bg-bad' : 'bg-accent'
            }`}
          >
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

- [ ] **Step 13: Verificar no navegador**

Run: `pnpm dev`
Expected: três processos sobem; `http://localhost:5173` mostra o cabeçalho com três abas sobre fundo escuro, sem erro no console além do 404 de `/logo.png` e `/header-bg.jpg` (os assets entram na Task 19). Encerre com Ctrl+C.

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(web): scaffold app shell, API client and position helper"
```

---

### Task 16: Web — quadro, cards, contadores e drawer

**Files:**
- Create: `apps/web/src/components/StatsBar.tsx`, `apps/web/src/components/JobCard.tsx`, `apps/web/src/components/Board.tsx`, `apps/web/src/components/JobDrawer.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Criar `apps/web/src/components/StatsBar.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { api } from '../api';

function Counter({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className={`h-7 overflow-hidden text-xl font-semibold tabular-nums ${tone}`}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={value} className="block"
            initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -14, opacity: 0 }}
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function StatsBar() {
  const { data } = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 15_000 });
  return (
    <div className="flex gap-3" data-testid="stats">
      <Counter label="Vagas" value={data?.total ?? 0} tone="text-ink" />
      <Counter label="Aplicadas pela IA" value={data?.appliedByAi ?? 0} tone="text-accent" />
      <Counter label="Aplicadas por você" value={data?.appliedByHuman ?? 0} tone="text-ok" />
      <Counter label="Precisam de você" value={data?.needsHuman ?? 0} tone="text-warn" />
    </div>
  );
}
```

- [ ] **Step 2: Criar `apps/web/src/components/JobCard.tsx`**

```tsx
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { motion } from 'motion/react';
import type { JobDto } from '@kv/shared';

const DAY = 86_400_000;

export function ageLabel(postedAt: number | null, now: number = Date.now()): string {
  if (postedAt === null) return 'data n/d';
  const days = Math.floor((now - postedAt) / DAY);
  if (days <= 0) return 'hoje';
  return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

export function JobCardBody({ job }: { job: JobDto }) {
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium leading-snug">{job.title}</h3>
        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-muted">{job.source}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {job.company} · {job.remote ? 'Remoto' : job.location || 'Local n/d'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {job.level && <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">{job.level}</span>}
        {job.stacks.slice(0, 3).map((s) => (
          <span key={s} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink">{s}</span>
        ))}
        {job.needsHuman && <span className="rounded bg-warn/20 px-1.5 py-0.5 text-[10px] text-warn">precisa de você</span>}
        <span className="ml-auto text-[10px] text-muted">{ageLabel(job.postedAt)}</span>
      </div>
    </>
  );
}

export function JobCard({ job, onOpen }: { job: JobDto; onOpen: (id: number) => void }) {
  const drag = useDraggable({ id: job.id });
  const drop = useDroppable({ id: `card:${job.id}` });
  const setRef = (el: HTMLElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  };

  return (
    <motion.article
      ref={setRef}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: drag.isDragging ? 0.35 : 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      data-testid="job-card"
      onClick={() => onOpen(job.id)}
      className={`cursor-grab rounded-lg border bg-surface p-3 shadow-sm ${
        drop.isOver && !drag.isDragging ? 'border-accent' : 'border-line'
      }`}
      {...drag.listeners}
      {...drag.attributes}
    >
      <JobCardBody job={job} />
    </motion.article>
  );
}
```

- [ ] **Step 3: Criar `apps/web/src/components/Board.tsx`**

```tsx
import {
  DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { COLUMNS, COLUMN_LABELS, type Column, type JobDto } from '@kv/shared';
import { api } from '../api';
import { computePosition } from '../position';
import { JobCard, JobCardBody } from './JobCard';
import { StatsBar } from './StatsBar';

function ColumnView({ column, jobs, onOpen }: { column: Column; jobs: JobDto[]; onOpen: (id: number) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column}` });
  return (
    <section
      ref={setNodeRef}
      data-testid={`column-${column}`}
      className={`flex w-72 shrink-0 flex-col rounded-xl border bg-surface-2/40 ${isOver ? 'border-accent' : 'border-line'}`}
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-sm font-semibold">{COLUMN_LABELS[column]}</h2>
        <span className="text-xs text-muted">{jobs.length}</span>
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {jobs.map((j) => (
          <JobCard key={j.id} job={j} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

export function Board({ onOpen }: { onOpen: (id: number) => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);
  const { data: jobs = [], isSuccess } = useQuery({
    queryKey: ['jobs', q],
    queryFn: () => api.jobs(q),
    refetchInterval: 15_000,
  });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const move = useMutation({
    mutationFn: (v: { id: number; column: Column; position: number }) =>
      api.patchJob(v.id, { column: v.column, position: v.position }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['jobs'] });
      qc.setQueryData<JobDto[]>(['jobs', q], (old = []) =>
        old.map((j) => (j.id === v.id ? { ...j, column: v.column, position: v.position } : j)),
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const byColumn = useMemo(() => {
    const map = Object.fromEntries(COLUMNS.map((c) => [c, [] as JobDto[]])) as Record<Column, JobDto[]>;
    for (const j of [...jobs].sort((a, b) => a.position - b.position)) map[j.column].push(j);
    return map;
  }, [jobs]);

  function onDragStart(e: DragStartEvent) {
    setActiveId(Number(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    if (!e.over) return;
    const id = Number(e.active.id);
    const over = String(e.over.id);
    let column: Column;
    let beforeId: number | null = null;
    if (over.startsWith('col:')) {
      column = over.slice(4) as Column;
    } else {
      beforeId = Number(over.slice(5));
      if (beforeId === id) return;
      const target = jobs.find((j) => j.id === beforeId);
      if (!target) return;
      column = target.column;
    }
    const others = byColumn[column].filter((j) => j.id !== id);
    move.mutate({ id, column, position: computePosition(others, beforeId) });
  }

  const active = jobs.find((j) => j.id === activeId);
  const empty = isSuccess && jobs.length === 0 && q === '';

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <StatsBar />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filtrar por título ou empresa"
          aria-label="Filtrar vagas"
          className="w-72 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </div>

      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <img
            src="/empty.png" alt="" className="h-48"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
          <p className="text-muted">
            Nenhuma vaga ainda. Crie um perfil em <strong>Perfis de busca</strong> e clique em <strong>Buscar agora</strong>.
          </p>
        </div>
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
            {COLUMNS.map((c) => (
              <ColumnView key={c} column={c} jobs={byColumn[c]} onOpen={onOpen} />
            ))}
          </div>
          <DragOverlay>
            {active && (
              <article className="w-68 rotate-2 cursor-grabbing rounded-lg border border-accent bg-surface p-3 shadow-xl">
                <JobCardBody job={active} />
              </article>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Criar `apps/web/src/components/JobDrawer.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { COLUMN_LABELS } from '@kv/shared';
import { api } from '../api';

const ACTOR_LABEL = { ia: 'IA', humano: 'Você', sistema: 'Sistema' } as const;

function DrawerContent({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['job', id], queryFn: () => api.job(id) });
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (data) setNotes(data.job.notes);
  }, [data]);
  const save = useMutation({
    mutationFn: () => api.patchJob(id, { notes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job', id] }),
  });

  if (!data) return <p className="p-6 text-muted">Carregando…</p>;
  const { job, events } = data;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-4 border-b border-line p-5">
        <div>
          <h2 className="text-lg font-semibold">{job.title}</h2>
          <p className="text-sm text-muted">
            {job.company} · {job.remote ? 'Remoto' : job.location || 'Local n/d'} · {job.source}
          </p>
        </div>
        <button onClick={onClose} aria-label="Fechar" className="rounded px-2 py-1 text-muted hover:text-ink">✕</button>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        <a
          href={job.url} target="_blank" rel="noreferrer"
          className="inline-block rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-bg"
        >
          Abrir vaga original ↗
        </a>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Análise IA</h3>
          <p className="rounded-lg border border-dashed border-line p-3 text-sm text-muted">
            Disponível quando o módulo de IA for instalado: pontos fortes do seu perfil para esta vaga e o que revisar antes da entrevista.
          </p>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Notas</h3>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== job.notes && save.mutate()}
            rows={4}
            aria-label="Notas"
            className="w-full rounded-lg border border-line bg-surface-2 p-3 text-sm outline-none focus:border-accent"
          />
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Descrição</h3>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink/90">
            {job.description || 'Esta fonte não entrega a descrição na busca. Abra a vaga original para ler.'}
          </p>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">Histórico</h3>
          <ul className="space-y-1 text-sm text-muted">
            {events.map((e) => (
              <li key={e.id}>
                {new Date(e.createdAt).toLocaleString('pt-BR')} — {ACTOR_LABEL[e.actor]}:{' '}
                {e.fromColumn ? `${COLUMN_LABELS[e.fromColumn]} → ` : ''}
                {COLUMN_LABELS[e.toColumn]}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

export function JobDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  return (
    <AnimatePresence>
      {id !== null && (
        <>
          <motion.div
            key="backdrop" className="fixed inset-0 bg-black/50" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          />
          <motion.aside
            key="drawer" role="dialog" aria-label="Detalhe da vaga"
            className="fixed right-0 top-0 h-full w-full max-w-xl border-l border-line bg-surface shadow-2xl"
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 400, damping: 40 }}
          >
            <DrawerContent id={id} onClose={onClose} />
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
```

- [ ] **Step 5: Ligar no `apps/web/src/App.tsx`**

Adicione os imports:

```tsx
import { Board } from './components/Board';
import { JobDrawer } from './components/JobDrawer';
```

Adicione o estado logo abaixo de `const [view, setView] = useState<View>('quadro');`:

```tsx
  const [openJob, setOpenJob] = useState<number | null>(null);
```

Troque a linha `{view === 'quadro' && <p className="p-6 text-muted">Quadro em construção.</p>}` por:

```tsx
        {view === 'quadro' && <Board onOpen={setOpenJob} />}
```

Adicione logo depois de `</main>`:

```tsx
      <JobDrawer id={openJob} onClose={() => setOpenJob(null)} />
```

- [ ] **Step 6: Verificar no navegador**

Run: `FAKE_CONNECTORS=1 DB_PATH=./data/dev-fake.db pnpm dev`

Em outro terminal, crie um perfil e dispare a busca:

```bash
curl -s -X POST http://127.0.0.1:3333/profiles -H "content-type: application/json" -d '{"name":"Teste","stacks":[],"levels":[],"maxAgeDays":7,"regions":[],"sources":["fake"]}'
curl -s -X POST http://127.0.0.1:3333/runs -H "content-type: application/json" -d '{"profileId":1}'
```

Expected em `http://localhost:5173`: em até 20 s aparecem dois cards em Descobertas; arrastar um para Aplicada move o card e o contador "Aplicadas por você" vai a 1; clicar em um card abre o drawer com histórico; recarregar mantém as posições. Encerre com Ctrl+C e rode `rm -f data/dev-fake.db*`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): add kanban board, stats bar and job drawer"
```

---

### Task 17: Web — perfis de busca e saúde das fontes

**Files:**
- Create: `apps/web/src/components/ProfilesPage.tsx`, `apps/web/src/components/HealthPanel.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Criar `apps/web/src/components/ProfilesPage.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { LEVELS, MAX_AGES, REGIONS, type Level, type MaxAge, type ProfileInput, type Region } from '@kv/shared';
import { api } from '../api';
import { showToast } from '../toast';

const LEVEL_LABEL: Record<Level, string> = { junior: 'Júnior', pleno: 'Pleno', senior: 'Sênior' };
const REGION_LABEL: Record<Region, string> = { brasil: 'Brasil', exterior: 'Exterior', remoto: 'Remoto' };
const AGE_LABEL: Record<MaxAge, string> = { 1: 'Últimas 24 h', 3: 'Últimos 3 dias', 7: 'Últimos 7 dias', 30: 'Últimos 30 dias' };

const EMPTY: ProfileInput = { name: '', stacks: [], levels: [], maxAgeDays: 7, regions: [], sources: [], active: true };

function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

function Checks<T extends string>(props: {
  legend: string; options: readonly T[]; label: (o: T) => string; value: T[]; onChange: (v: T[]) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1 text-xs text-muted">{props.legend}</legend>
      <div className="flex flex-wrap gap-2">
        {props.options.map((o) => (
          <label key={o} className="flex cursor-pointer items-center gap-1.5 rounded border border-line bg-surface-2 px-2 py-1 text-sm">
            <input type="checkbox" checked={props.value.includes(o)} onChange={() => props.onChange(toggle(props.value, o))} />
            {props.label(o)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ProfilesPage() {
  const qc = useQueryClient();
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
  const { data: sources = [] } = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  const [form, setForm] = useState<ProfileInput>(EMPTY);
  const [stacksText, setStacksText] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['profiles'] });

  const create = useMutation({
    mutationFn: api.createProfile,
    onSuccess: () => {
      setForm(EMPTY);
      setStacksText('');
      refresh();
    },
  });
  const setActive = useMutation({
    mutationFn: (v: { id: number; active: boolean }) => api.updateProfile(v.id, { active: v.active }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.deleteProfile, onSuccess: refresh });
  const runNow = useMutation({
    mutationFn: api.runNow,
    onSuccess: (r) =>
      showToast(r.queued > 0 ? `Busca enfileirada em ${r.queued} fontes` : 'Já existe uma busca em andamento', 'info'),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const stacks = stacksText.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    create.mutate({ ...form, stacks });
  }

  const sourceName = (id: string) => sources.find((s) => s.id === id)?.name ?? id;

  return (
    <div className="grid h-full grid-cols-[24rem_1fr] gap-6 overflow-y-auto p-6">
      <form onSubmit={submit} className="space-y-4 self-start rounded-xl border border-line bg-surface p-5">
        <h2 className="font-semibold">Novo perfil de busca</h2>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Nome</span>
          <input
            required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="React Pleno remoto"
            className="w-full rounded border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Stacks (separadas por vírgula)</span>
          <input
            value={stacksText} onChange={(e) => setStacksText(e.target.value)} placeholder="react, node, typescript"
            className="w-full rounded border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </label>
        <Checks legend="Nível" options={LEVELS} label={(l) => LEVEL_LABEL[l]} value={form.levels} onChange={(levels) => setForm({ ...form, levels })} />
        <Checks legend="Região" options={REGIONS} label={(r) => REGION_LABEL[r]} value={form.regions} onChange={(regions) => setForm({ ...form, regions })} />
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Vaga aberta há no máximo</span>
          <select
            value={form.maxAgeDays} onChange={(e) => setForm({ ...form, maxAgeDays: Number(e.target.value) as MaxAge })}
            className="w-full rounded border border-line bg-surface-2 px-3 py-2 text-sm"
          >
            {MAX_AGES.map((a) => (
              <option key={a} value={a}>{AGE_LABEL[a]}</option>
            ))}
          </select>
        </label>
        <Checks
          legend="Fontes" options={sources.map((s) => s.id)} label={sourceName}
          value={form.sources} onChange={(s) => setForm({ ...form, sources: s })}
        />
        <button
          type="submit" disabled={create.isPending || form.sources.length === 0}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg disabled:opacity-50"
        >
          Salvar perfil
        </button>
      </form>

      <section className="space-y-3">
        <h2 className="font-semibold">Perfis</h2>
        {profiles.length === 0 && <p className="text-sm text-muted">Nenhum perfil ainda.</p>}
        {profiles.map((p) => (
          <article key={p.id} data-testid="profile" className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="font-medium">{p.name}</h3>
                <p className="text-xs text-muted">
                  {p.stacks.join(', ') || 'qualquer stack'} · {p.levels.map((l) => LEVEL_LABEL[l]).join(', ') || 'qualquer nível'} ·{' '}
                  {p.regions.map((r) => REGION_LABEL[r]).join(', ') || 'qualquer região'} · {AGE_LABEL[p.maxAgeDays]}
                </p>
                <p className="mt-1 text-xs text-muted">Fontes: {p.sources.map(sourceName).join(', ')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox" checked={p.active}
                    onChange={(e) => setActive.mutate({ id: p.id, active: e.target.checked })}
                  />
                  Ativo
                </label>
                <button
                  onClick={() => runNow.mutate(p.id)}
                  className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-bg"
                >
                  Buscar agora
                </button>
                <button
                  onClick={() => confirm(`Excluir o perfil "${p.name}"?`) && remove.mutate(p.id)}
                  className="rounded-lg border border-line px-3 py-1.5 text-sm text-bad"
                >
                  Excluir
                </button>
              </div>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Criar `apps/web/src/components/HealthPanel.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

const STATUS = {
  ok: { label: 'OK', tone: 'bg-ok/20 text-ok' },
  error: { label: 'Erro', tone: 'bg-bad/20 text-bad' },
  never: { label: 'Nunca rodou', tone: 'bg-surface-2 text-muted' },
} as const;

export function HealthPanel() {
  const { data } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 15_000 });

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="mb-1 font-semibold">Saúde das fontes</h2>
      <p className="mb-4 text-sm text-muted">
        Última execução de cada conector. LinkedIn e Indeed dependem de páginas públicas e podem falhar por bloqueio.
      </p>
      <table className="w-full max-w-4xl overflow-hidden rounded-xl border border-line bg-surface text-sm">
        <thead className="bg-surface-2 text-left text-xs text-muted">
          <tr>
            <th className="px-4 py-2">Fonte</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Encontradas</th>
            <th className="px-4 py-2">Novas</th>
            <th className="px-4 py-2">Última execução</th>
            <th className="px-4 py-2">Erro</th>
          </tr>
        </thead>
        <tbody>
          {(data?.sources ?? []).map((s) => (
            <tr key={s.source} className="border-t border-line" data-testid={`health-${s.source}`}>
              <td className="px-4 py-2 font-medium">{s.name}</td>
              <td className="px-4 py-2">
                <span className={`rounded px-2 py-0.5 text-xs ${STATUS[s.status].tone}`}>{STATUS[s.status].label}</span>
              </td>
              <td className="px-4 py-2 tabular-nums">{s.found}</td>
              <td className="px-4 py-2 tabular-nums">{s.inserted}</td>
              <td className="px-4 py-2 text-muted">
                {s.finishedAt ? new Date(s.finishedAt).toLocaleString('pt-BR') : '—'}
              </td>
              <td className="px-4 py-2 text-bad">{s.error ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Ligar no `apps/web/src/App.tsx`**

Adicione os imports:

```tsx
import { HealthPanel } from './components/HealthPanel';
import { ProfilesPage } from './components/ProfilesPage';
```

Troque as duas linhas de placeholder por:

```tsx
        {view === 'perfis' && <ProfilesPage />}
        {view === 'fontes' && <HealthPanel />}
```

- [ ] **Step 4: Verificar tipos e testes**

Run: `pnpm typecheck && pnpm test`
Expected: sem erros de tipo; todos os testes passam.

- [ ] **Step 5: Verificar no navegador**

Run: `pnpm dev`
Expected: em "Perfis de busca", criar um perfil com stack `react`, fonte Remotive, e clicar "Buscar agora" mostra o toast azul; em até 30 s o Quadro mostra vagas reais; "Saúde das fontes" mostra Remotive como OK. Encerre com Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): add search profiles and source health screens"
```

---

### Task 18: Teste e2e

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/board.spec.ts`

- [ ] **Step 1: Criar `apps/web/playwright.config.ts`**

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const dbPath = join(tmpdir(), `kanban-vagas-e2e-${Date.now()}.db`);

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  use: { baseURL: 'http://localhost:5173' },
  webServer: {
    command: 'pnpm dev',
    cwd: '../..',
    url: 'http://localhost:5173',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { FAKE_CONNECTORS: '1', DB_PATH: dbPath },
  },
});
```

- [ ] **Step 2: Criar `apps/web/e2e/board.spec.ts`**

```ts
import { expect, test } from '@playwright/test';

test('profile search fills the board and a moved card persists', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Perfis de busca' }).click();
  await page.getByPlaceholder('React Pleno remoto').fill('E2E');
  await page.getByPlaceholder('react, node, typescript').fill('react');
  await page.getByLabel('Fake').check();
  await page.getByRole('button', { name: 'Salvar perfil' }).click();
  await expect(page.getByTestId('profile')).toHaveCount(1);

  await page.getByRole('button', { name: 'Buscar agora' }).click();
  await page.getByRole('button', { name: 'Quadro' }).click();

  const discovered = page.getByTestId('column-descobertas');
  const selected = page.getByTestId('column-selecionadas');
  const card = discovered.getByTestId('job-card').filter({ hasText: 'Fake React Developer' });
  await expect(card).toBeVisible({ timeout: 45_000 });
  await expect(discovered.getByTestId('job-card')).toHaveCount(1);

  const from = (await card.boundingBox())!;
  const to = (await selected.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 15 });
  await page.mouse.up();

  await expect(selected.getByTestId('job-card')).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('column-selecionadas').getByTestId('job-card')).toHaveCount(1);
  await expect(page.getByTestId('column-descobertas').getByTestId('job-card')).toHaveCount(0);

  await page.getByTestId('column-selecionadas').getByTestId('job-card').click();
  await expect(page.getByRole('dialog')).toContainText('Descobertas → Selecionadas');
});
```

O perfil filtra por `react`, então só a vaga "Fake React Developer" entra; "Fake Node Engineer" é descartada pelo filtro, o que também cobre o critério de filtro por stack.

- [ ] **Step 3: Instalar o navegador do teste e rodar**

Run:
```bash
pnpm --filter @kv/web exec playwright install chromium
pnpm e2e
```
Expected: `1 passed`. Garanta que nenhum `pnpm dev` esteja rodando antes (a porta 5173 é estrita).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(web): add end-to-end board flow"
```

---

### Task 19: Assets visuais com Higgsfield

**Files:**
- Create: `apps/web/public/logo.png`, `apps/web/public/empty.png`, `apps/web/public/header-bg.jpg`

- [ ] **Step 1: Carregar a skill**

Invoque a skill `higgsfield-generate` e siga o fluxo dela para geração de imagens. Se a CLI do Higgsfield não estiver autenticada, pare e peça ao usuário para autenticar; não substitua por outra ferramenta.

- [ ] **Step 2: Gerar as três imagens**

Paleta do app: fundo `#0b0d12`, superfície `#141821`, acento `#7c9cff`.

| Arquivo | Formato | Prompt |
|---|---|---|
| `logo.png` | 1:1, fundo transparente ou `#141821` | "Minimal flat app icon: three vertical rounded kanban columns with a small card sliding from the left column to the right, periwinkle blue #7c9cff on dark navy #141821, geometric, no text, crisp edges, centered" |
| `empty.png` | 4:3, fundo `#0b0d12` | "Flat vector illustration of an empty kanban board with a friendly magnifying glass scanning for job cards, dark navy background #0b0d12, periwinkle blue #7c9cff accents, soft glow, minimal, no text" |
| `header-bg.jpg` | 21:9 | "Abstract dark navy background, subtle flowing gradient mesh with faint periwinkle blue light streaks, very low contrast, no objects, no text, suitable behind a UI header" |

Salve os resultados em `apps/web/public/` com exatamente esses nomes. Redimensione `logo.png` para 256×256 e `empty.png` para no máximo 800 px de largura.

- [ ] **Step 3: Verificar no navegador**

Run: `pnpm dev`
Expected: logo no cabeçalho e na aba do navegador, textura sutil atrás do cabeçalho; com o banco vazio (`DB_PATH=./data/empty.db`), a ilustração aparece no Quadro. Texto do cabeçalho continua legível. Encerre com Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add apps/web/public
git commit -m "feat(web): add generated logo, empty state and header art"
```

---

### Task 20: Instalação do worker, README e verificação final

**Files:**
- Create: `scripts/install-worker.mjs`
- Modify: `README.md`

- [ ] **Step 1: Criar `scripts/install-worker.mjs`**

```js
// Registra o worker para iniciar com o sistema, sem depender da UI aberta.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASK = 'KanbanVagasWorker';

if (process.platform === 'win32') {
  const cmdPath = join(root, 'worker.cmd');
  writeFileSync(cmdPath, '@echo off\r\ncd /d "%~dp0"\r\npnpm --filter @kv/worker start\r\n');
  execFileSync('schtasks', ['/Create', '/TN', TASK, '/SC', 'ONLOGON', '/TR', `"${cmdPath}"`, '/F'], { stdio: 'inherit' });
  console.log(`Tarefa "${TASK}" criada: o worker inicia a cada logon.`);
  console.log(`Iniciar agora:  schtasks /Run /TN ${TASK}`);
  console.log(`Remover:        schtasks /Delete /TN ${TASK} /F`);
} else {
  console.log('No Linux e macOS, use o pm2:');
  console.log('  npm install -g pm2');
  console.log(`  cd "${root}" && pm2 start "pnpm --filter @kv/worker start" --name kanban-vagas-worker`);
  console.log('  pm2 save && pm2 startup');
}
```

- [ ] **Step 2: Testar a instalação (Windows)**

Run: `pnpm worker:install && schtasks //Query //TN KanbanVagasWorker`
Expected: a consulta lista a tarefa `KanbanVagasWorker`. Depois remova para não deixar um worker duplicado durante o desenvolvimento: `schtasks //Delete //TN KanbanVagasWorker //F`.

- [ ] **Step 3: Substituir `README.md`**

````markdown
# Kanban de Vagas

Kanban local e open source para organizar sua busca de emprego. Você cria perfis de busca (stack, nível, região, idade da vaga), um worker coleta vagas de nove fontes a cada hora, e você acompanha tudo em um quadro.

## Começar

Requisitos: Node 24+ e pnpm 10+.

```bash
pnpm install
pnpm --filter @kv/connectors exec playwright install chromium   # só para a fonte Indeed
pnpm dev
```

Abra http://localhost:5173, crie um perfil em **Perfis de busca** e clique em **Buscar agora**.

`pnpm dev` sobe três processos: `web` (porta 5173), `api` (porta 3333) e `worker`. Os dados ficam em `data/kanban.db`.

## Worker sempre ligado

O worker busca a cada hora cheia enquanto estiver rodando. Para ele iniciar com o sistema, sem a interface aberta:

```bash
pnpm worker:install
```

No Windows isso cria a tarefa agendada `KanbanVagasWorker`. Em Linux e macOS o comando mostra as instruções para o pm2.

## Fontes

| Fonte | Região | Método |
|---|---|---|
| Gupy | Brasil | API pública |
| Remotive | Remoto global | API pública |
| RemoteOK | Remoto global | Feed público |
| Greenhouse | Exterior | API pública por empresa |
| Lever | Exterior | API pública por empresa |
| Arbeitnow | Europa / remoto | API pública |
| Himalayas | Remoto global | API pública |
| LinkedIn | Brasil / exterior | Busca pública, sem login |
| Indeed | Brasil / exterior | Navegador headless, sem login |

Greenhouse e Lever consultam uma lista de empresas. Para trocar, defina `GREENHOUSE_BOARDS` e `LEVER_COMPANIES` com os identificadores separados por vírgula.

**LinkedIn e Indeed:** estes conectores leem páginas públicas, sem usar sua conta. Não há API oficial; eles podem parar de funcionar ou ser bloqueados a qualquer momento, e o uso automatizado pode contrariar os termos desses sites. Ative por sua conta e risco. A tela **Saúde das fontes** mostra quando um conector falha; os demais continuam funcionando.

## Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `DB_PATH` | `data/kanban.db` | Caminho do SQLite |
| `API_PORT` | `3333` | Porta da API |
| `GREENHOUSE_BOARDS` | `gitlab,stripe,cloudflare,figma` | Empresas no Greenhouse |
| `LEVER_COMPANIES` | `palantir,spotify` | Empresas no Lever |
| `FAKE_CONNECTORS` | — | `1` troca as fontes por um conector de teste |

## Desenvolvimento

```bash
pnpm test        # testes unitários
pnpm typecheck   # tipos
pnpm e2e         # teste de ponta a ponta (pare o pnpm dev antes)
```

Estrutura:

```
apps/web              interface React
apps/api              API Fastify
apps/worker           busca agendada
packages/connectors   uma fonte por arquivo
packages/db           schema e acesso ao SQLite
packages/shared       tipos e validação
```

### Adicionar uma fonte

1. Grave uma resposta real: `node scripts/record-fixture.mjs <url> packages/connectors/fixtures/<fonte>.json`.
2. Crie `packages/connectors/src/<fonte>.ts` exportando um `Connector` e uma função de mapeamento pura.
3. Teste o mapeamento contra a fixture (veja `remotive.test.ts`).
4. Registre o conector em `packages/connectors/src/index.ts`.

## Roadmap

- Currículo em PT-BR e inglês, adaptado por IA para cada vaga.
- Análise da descrição da vaga com pontos para a entrevista.
- Candidatura automática, com contador do que a IA aplicou e do que precisa de você.
- Glassdoor e mais fontes internacionais.

## Licença

Veja `LICENSE`.
````

- [ ] **Step 4: Verificação final contra os critérios de aceite**

Run: `pnpm typecheck && pnpm test && pnpm e2e`
Expected: zero erros de tipo, todos os testes unitários passam, e2e `1 passed`.

Run: `rm -rf data && pnpm dev`, e confira manualmente:

1. Os três processos sobem sem erro (critério 1).
2. Crie um perfil com `react`, regiões Brasil e Remoto, fontes Gupy, Remotive e LinkedIn; clique "Buscar agora"; vagas aparecem em menos de dois minutos (critério 3).
3. Clique "Buscar agora" de novo depois de terminar; a contagem de vagas não dobra (critério 4).
4. Em "Saúde das fontes", cada fonte usada aparece como OK ou Erro; se alguma estiver em erro, as outras ainda entregaram vagas (critério 5).
5. Arraste um card para Selecionadas, recarregue; ele continua lá e o histórico no drawer mostra o movimento (critério 6).
6. Pare e suba o worker de novo (`pnpm dev`): o log mostra `worker iniciado` e não dispara busca inicial se a última terminou há menos de uma hora (critério 2, junto com o teste `isDue`).

Anote no commit qualquer fonte que tenha ficado em erro nesta verificação.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: add README and worker install script"
```

---

### Task 21: CI (GitHub Actions)

**Files:**
- Create: `.github/workflows/ci.yml`

Workflow `CI` em `push` e `pull_request`, um job em `ubuntu-latest`:

1. `actions/checkout`, `pnpm/action-setup` (versão lida de `packageManager` no `package.json` raiz — adicionar o campo), `actions/setup-node` com Node 24 e cache pnpm.
2. `pnpm install --frozen-lockfile`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm --filter @kv/web exec playwright install --with-deps chromium`
6. `pnpm e2e`; em falha, publicar `apps/web/playwright-report` e `test-results` como artefato.

Os testes unitários não usam rede (fixtures). Verificação: validar o YAML e rodar localmente a mesma sequência de comandos.

### Task 22: Container único e configuração Railway

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `railway.json`, `scripts/start-prod.mjs`
- Modify: `apps/api/src/app.ts` (servir `apps/web/dist` quando existir), `apps/api/src/index.ts` (host e porta por variável), `README.md`

- Um container: build do web (`pnpm --filter @kv/web build`), depois `scripts/start-prod.mjs` sobe API e worker como processos filhos e encerra o container se um deles cair.
- A API escuta em `HOST` (padrão `127.0.0.1`; `0.0.0.0` no container) e `PORT` (Railway) ou `API_PORT`; serve os arquivos estáticos do web e as rotas da API sob `/api` além das rotas atuais, para o web buildado funcionar sem o proxy do Vite.
- `DB_PATH=/data/kanban.db`, com volume do Railway montado em `/data`.
- Indeed desligado no container (sem Chromium na imagem); o conector reporta erro claro em "Saúde das fontes".
- `railway.json`: builder Dockerfile, healthcheck em `/api/stats`, política de restart.
- **Não gerar domínio público nem fazer deploy nesta task.** README explica o deploy e avisa que o app não tem login.
- Verificação: `docker build` e `docker run` locais com volume, se o Docker estiver disponível; senão, `node scripts/start-prod.mjs` local com o web buildado e `curl` nas rotas.
