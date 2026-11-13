import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { createFakeProvider, parseOutput, readBlock, readTask, type AiConfig, type AiProvider } from '@kv/ai';
import {
  applications, applicationForJob, applyCommands, applyCountsSince, closeDb, createApplication, enqueueApplyCommand, jobEvents, jobs,
  nextApplyCommand, nextQueuedApplication, recordUsage, requestCancel, saveApplyAnswer, siteState, transitionApplication,
  updateSiteState, usageByLayer,
  type Db,
} from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import type { SettingsService } from '@kv/settings';
import { APPLY_DEFAULTS, type AnswerRecord, type ApplyConfig, type ApplyMode } from '@kv/shared';
import { nextMidnight } from './day';
import { createApplyQueue, type ApplyQueue, type ApplyQueueDeps } from './queue';
import {
  BASIC_QUESTIONS, HOUR, MOTIVATION, NOON, createFakeBrowser, createRecordingSite, seedJob, seedProfile, type FakeSite,
} from './test-helpers';

// Para o teste da reivindicação: um gancho entre a leitura da próxima candidatura e a reivindicação dela.
vi.mock('@kv/db', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@kv/db')>();
  return { ...mod, nextQueuedApplication: vi.fn(mod.nextQueuedApplication) };
});

const TZ = 'America/Sao_Paulo';
const MIN = 60_000;

let db: Db;
let version: number;
let site: FakeSite;
let browser: ReturnType<typeof createFakeBrowser>;
let dataDir: string;
let clock: { now: number };
let tasks: string[];
/** Respostas do modelo trocadas por tarefa (`apply_gate`, `apply_classify`...); o resto é o provedor falso. */
let overrides: Record<string, (data: Record<string, unknown>) => unknown>;
/** Chamado antes de cada chamada ao modelo, com a tarefa. */
let beforeCall: (task: string) => Promise<void>;
let aiConfig: AiConfig;

/** Provedor falso com o modelo de preço conhecido (o custo entra no limite diário) e respostas trocáveis por tarefa. */
function countingProvider(): AiProvider {
  const fake = createFakeProvider();
  return {
    id: 'fake',
    async generate(req) {
      const task = readTask(req.prompt) ?? '';
      tasks.push(task);
      await beforeCall(task);
      const model = aiConfig.models[req.tier];
      const usage = { inputTokens: 1_000, outputTokens: 100 };
      const override = overrides[task];
      if (override) return { data: parseOutput(req.schema, override(readBlock(req.prompt, 'dados') ?? {})), model, usage };
      return { ...(await fake.generate(req)), model };
    },
  };
}

const baseCfg = (): ApplyConfig => ({
  enabled: true, minScore: 70, siteModes: { linkedin: 'dry_run', greenhouse: 'dry_run', lever: 'real', fake: 'dry_run' },
  dailyCaps: { ...APPLY_DEFAULTS.dailyCaps }, companyCap: 2, window: { start: '08:00', end: '21:00' }, resumeMode: 'tailored',
  aiAnswers: 'review', blockedCompanies: [], blockedTerms: [], timeZone: TZ,
});
let cfg: ApplyConfig;

function queue(o: {
  enabled?: boolean; mode?: ApplyMode; availability?: ApplyQueueDeps['availability']; cfg?: Partial<ApplyConfig>;
  sites?: FakeSite[]; deps?: Partial<ApplyQueueDeps>;
} = {}): ApplyQueue {
  cfg = { ...baseCfg(), ...o.cfg };
  if (o.enabled !== undefined) cfg.enabled = o.enabled;
  if (o.mode) cfg.siteModes = { ...cfg.siteModes, fake: o.mode };
  const provider = countingProvider();
  return createApplyQueue({
    db, settings: { applyConfig: async () => cfg } as unknown as SettingsService, sites: () => o.sites ?? [site], browser, dataDir,
    ai: async () => ({ provider, config: aiConfig }), fetchDescription: async () => null,
    availability: o.availability ?? { available: true, reason: null }, sweepMs: 0, humanPollMs: 5, humanWaitMs: 60,
    now: () => clock.now, random: () => 0.5, ...o.deps,
  });
}

async function runUntilIdle(q: ApplyQueue): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const r = await q.tick();
    await q.idle();
    if (!r.started && r.swept === 0 && r.commands === 0) return;
  }
  throw new Error('a fila não parou');
}

const jobRow = async (id: number) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];
const lastEvent = async (id: number) =>
  (await db.select().from(jobEvents).where(eq(jobEvents.jobId, id)).orderBy(desc(jobEvents.id)).limit(1))[0];
const spend = (usd: number) =>
  recordUsage(db, { provider: 'fake', model: 'x', layer: 'tier1', inputTokens: 0, outputTokens: 0, costUsd: usd, createdAt: clock.now });
const candidate = (o: Parameters<typeof seedJob>[1] = {}) => seedJob(db, { version, ...o });
const answerTasks = () => tasks.filter((t) => t === 'apply_open' || t === 'apply_facts');

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  version = await seedProfile(db);
  site = createRecordingSite();
  browser = createFakeBrowser();
  dataDir = await mkdtemp(join(tmpdir(), 'kv-apply-'));
  clock = { now: NOON };
  tasks = [];
  overrides = {};
  beforeCall = async () => {};
  aiConfig = {
    provider: 'fake', apiKey: 'fake', models: { fast: 'gpt-6-luna', strong: 'gpt-6.1-sol' }, dailyBudgetUsd: 100, budgetTimeZone: TZ,
  };
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});
afterAll(() => closeDb(db));

describe('the switches', () => {
  it('does nothing when the feature is unavailable and only commands when it is off', async () => {
    await candidate();
    expect(await queue({ availability: { available: false, reason: 'x' } }).tick()).toEqual({ commands: 0, swept: 0, started: false });
    await enqueueApplyCommand(db, 'check_session', 'fake');
    expect(await queue({ enabled: false }).tick()).toEqual({ commands: 1, swept: 0, started: false });
    expect(await db.select().from(applications)).toEqual([]);
    expect(site.calls).toEqual(['sessionState']);
  });

  it('closes a browser left idle', async () => {
    const q = queue({ enabled: false });
    await browser.page();
    browser.usedAt = Date.now() - 6 * MIN;
    clock.now = Date.now();
    await q.tick();
    expect(browser.calls).toContain('close');
  });
});

describe('one application', () => {
  it('applies to a job at or above the minimum and moves the card', async () => {
    const { id: jobId } = await candidate();
    await runUntilIdle(queue({ enabled: true, mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({
      status: 'submitted', gateScore: 80, resumeFileName: expect.stringMatching(/^Curriculo_/), confirmation: 'Candidatura recebida',
      cancelRequested: false, attempts: 0,
    });
    expect(await jobRow(jobId)).toMatchObject({ column: 'aplicada', appliedBy: 'ia', needsHuman: false });
    expect(await lastEvent(jobId)).toMatchObject({ toColumn: 'aplicada', actor: 'ia' });
    expect(site.calls).toEqual(['open', 'readStep', 'fillStep', 'submit']);
    expect((await applicationForJob(db, jobId))!.shots).toEqual({ filled: 'shots/1/filled.jpg', confirmation: 'shots/1/confirmation.jpg' });
  });

  it('skips a job the gate scores below the minimum and leaves the card where it is', async () => {
    overrides.apply_gate = () => ({ score: 69, reason: 'fraca', eligible: true, ineligibleReason: '' });
    const { id: jobId } = await candidate();
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'skipped', reason: 'below_min_score', gateScore: 69 });
    expect(await jobRow(jobId)).toMatchObject({ column: 'descobertas', appliedBy: null });
    expect(site.calls).toEqual([]);
  });

  it('skips a job the gate finds not eligible', async () => {
    overrides.apply_gate = () => ({ score: 90, reason: 'boa', eligible: false, ineligibleReason: 'exige cidadania' });
    const { id: jobId } = await candidate();
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'skipped', reason: 'not_eligible', detail: 'exige cidadania' });
  });

  it('skips a blocked company without calling the model', async () => {
    const { id: jobId } = await candidate({ company: 'Acme Ltda' });
    await runUntilIdle(queue({ mode: 'real', cfg: { blockedCompanies: ['Acme'] } }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'skipped', reason: 'blocked', detail: 'Acme' });
    expect(tasks).toEqual([]);
  });

  it('stays in rehearsal when the site is in rehearsal mode', async () => {
    const { id: jobId } = await candidate();
    await runUntilIdle(queue({ mode: 'dry_run' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'dry_run_ready', mode: 'dry_run' });
    expect(await jobRow(jobId)).toMatchObject({ column: 'selecionadas', appliedBy: null });
    expect(site.calls).toEqual(['open', 'readStep', 'fillStep', 'discard']);
  });

  it('marks the card applied by the owner when the site says so', async () => {
    const { id: jobId } = await candidate({ variant: 'already' });
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'skipped', reason: 'already_applied' });
    expect(await jobRow(jobId)).toMatchObject({ column: 'aplicada', appliedBy: 'humano' });
  });

  it('records usage in the apply layer', async () => {
    await candidate();
    await runUntilIdle(queue({ mode: 'real' }));
    const usage = await usageByLayer(db, 0);
    expect(usage.apply).toBeGreaterThan(0);
    expect(usage.tier3).toBe(0);
  });

  it('starts nothing when the owner cancels between the read and the claim', async () => {
    const { id: jobId } = await candidate();
    const real = (await vi.importActual<typeof import('@kv/db')>('@kv/db')).nextQueuedApplication;
    vi.mocked(nextQueuedApplication).mockImplementationOnce(async (...args) => {
      const row = await real(...args);
      if (row) await requestCancel(db, row.jobId);
      return row;
    });
    const q = queue({ mode: 'real', cfg: { minScore: 70 } });
    const r = await q.tick();
    await q.idle();
    expect(r).toMatchObject({ swept: 1, started: false });
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'cancelled' });
    expect(site.calls).toEqual([]);
  });
});

describe('crash recovery', () => {
  it('never resends an application that was mid-submit when the worker died', async () => {
    const { id: jobId } = await candidate();
    const id = (await createApplication(db, { jobId, site: 'fake', trigger: 'auto', mode: 'real' }, NOON))!;
    await transitionApplication(db, id, { status: 'submitting' });
    const q = queue({ enabled: true, mode: 'real' });
    await q.recoverInterrupted();
    await runUntilIdle(q);
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'needs_human', reason: 'confirm_submission' });
    expect(site.calls).not.toContain('submit');
    expect((await jobRow(jobId)).needsHuman).toBe(true);
  });

  it('requeues an application that was being filled when the worker died', async () => {
    const { id: jobId } = await candidate();
    const id = (await createApplication(db, { jobId, site: 'fake', trigger: 'auto', mode: 'real' }, NOON))!;
    await transitionApplication(db, id, { status: 'filling' });
    const q = queue({ mode: 'real' });
    await q.recoverInterrupted();
    await runUntilIdle(q);
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'submitted' });
  });

  it('turns commands left running into errors', async () => {
    await enqueueApplyCommand(db, 'check_session', 'fake');
    await nextApplyCommand(db);
    await queue().recoverInterrupted();
    expect((await db.select().from(applyCommands))[0]).toMatchObject({ status: 'error' });
  });
});

describe('answers', () => {
  it('stops on a required question, then finishes once the owner answered and reuses the answer on the next job', async () => {
    site.variants.form = { questions: [...BASIC_QUESTIONS, { ...BASIC_QUESTIONS[0], id: 'salary', label: 'Pretensão salarial mensal (R$)' }] };
    const q = queue({ mode: 'real' });
    const { id: job1 } = await candidate();
    await runUntilIdle(q); // a vaga 1 para em needs_human question
    const app1 = (await applicationForJob(db, job1))!;
    expect(app1).toMatchObject({ status: 'needs_human', reason: 'question', pendingQuestions: [expect.objectContaining({ kind: 'unanswered' })] });
    expect((await jobRow(job1)).needsHuman).toBe(true);
    await saveApplyAnswer(db, { question: 'Pretensão salarial mensal (R$)', answer: '20000', kind: 'text', scope: 'always', scopeValue: null, country: null });
    await transitionApplication(db, app1.id, { status: 'queued', set: { pendingQuestions: [] } });
    const { id: job2 } = await candidate();
    await runUntilIdle(q);
    expect((await applicationForJob(db, job1))!.status).toBe('submitted');
    expect((await applicationForJob(db, job2))!.status).toBe('submitted'); // sem parar
    const answers = (await applicationForJob(db, job2))!.answers;
    expect(answers.find((a) => a.questionId === 'salary')).toMatchObject({ value: '20000', source: 'bank' });
  });

  describe('answers proposed by the model', () => {
    beforeEach(() => {
      site.variants.form = { questions: [...BASIC_QUESTIONS, MOTIVATION] };
      overrides.apply_classify = (data) => ({
        items: (data.questions as { questionId: string }[]).map((x) => ({ questionId: x.questionId, category: 'open' })),
      });
    });

    it('off: never asks the model for an answer and stops for the owner', async () => {
      const { id: jobId } = await candidate();
      await runUntilIdle(queue({ mode: 'real', cfg: { aiAnswers: 'off' } }));
      expect(await applicationForJob(db, jobId)).toMatchObject({
        status: 'needs_human', reason: 'question', pendingQuestions: [expect.objectContaining({ kind: 'unanswered' })],
      });
      expect(answerTasks()).toEqual([]);
    });

    it('review: stops with the proposal for the owner to confirm', async () => {
      const { id: jobId } = await candidate();
      await runUntilIdle(queue({ mode: 'real', cfg: { aiAnswers: 'review' } }));
      expect(await applicationForJob(db, jobId)).toMatchObject({
        status: 'needs_human', reason: 'question',
        pendingQuestions: [expect.objectContaining({ kind: 'confirm_proposal', proposal: expect.objectContaining({ source: 'written' }) })],
      });
      expect(answerTasks()).toEqual(['apply_open']);
      expect(site.calls).not.toContain('submit');
    });

    it('auto: sends the verified answer', async () => {
      const { id: jobId } = await candidate();
      await runUntilIdle(queue({ mode: 'real', cfg: { aiAnswers: 'auto' } }));
      const row = (await applicationForJob(db, jobId))!;
      expect(row.status).toBe('submitted');
      expect(row.answers.find((a) => a.questionId === 'why')).toMatchObject({ source: 'written' });
    });

    it('auto: a text that fails the check twice goes to the owner', async () => {
      overrides.apply_open = () => ({ text: 'Trabalhei 10 anos na Empresa Inventada.' });
      const { id: jobId } = await candidate();
      await runUntilIdle(queue({ mode: 'real', cfg: { aiAnswers: 'auto' } }));
      expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'needs_human', reason: 'question' });
      expect(answerTasks()).toEqual(['apply_open', 'apply_open']);
    });

    const approvedWhy: AnswerRecord = {
      questionId: 'why', value: 'Texto aprovado pelo dono.', source: 'written', category: 'open', basis: [], bankAnswerId: null,
      label: MOTIVATION.label, help: MOTIVATION.help, kind: MOTIVATION.kind, options: [], required: true,
    };
    /** O ensaio aprovado inteiro: as perguntas das regras e a resposta escrita. */
    const approvedAll: AnswerRecord[] = [
      ...BASIC_QUESTIONS.map((x): AnswerRecord => ({
        questionId: x.id, value: x.kind === 'file' ? 'Curriculo.pdf' : 'valor do ensaio', source: 'rule', category: x.kind === 'file' ? 'file' : 'identity',
        basis: [], bankAnswerId: null, label: x.label, help: x.help, kind: x.kind, options: [], required: x.required,
      })),
      approvedWhy,
    ];

    it('repeats an answer the owner approved in a rehearsal, without a pending question', async () => {
      const { id: jobId } = await candidate();
      const id = (await createApplication(db, { jobId, site: 'fake', trigger: 'manual', mode: 'real' }, NOON))!;
      await db.update(applications).set({ approvedAnswers: approvedAll }).where(eq(applications.id, id));
      await runUntilIdle(queue({ mode: 'real', cfg: { aiAnswers: 'review' } }));
      const row = (await applicationForJob(db, jobId))!;
      expect(row.status).toBe('submitted');
      expect(row.answers.find((a) => a.questionId === 'why')).toMatchObject({ value: 'Texto aprovado pelo dono.', source: 'written' });
      expect(answerTasks()).toEqual([]);
    });

    it('does not use approved answers outside a real run', async () => {
      const { id: jobId } = await candidate();
      const id = (await createApplication(db, { jobId, site: 'fake', trigger: 'manual', mode: 'dry_run' }, NOON))!;
      await db.update(applications).set({ approvedAnswers: approvedAll }).where(eq(applications.id, id));
      await runUntilIdle(queue({ cfg: { aiAnswers: 'review' } }));
      expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'needs_human', reason: 'question' });
    });

    it('rehearses again when the form gained a required question the owner did not approve', async () => {
      site.variants.form = { questions: [...BASIC_QUESTIONS, MOTIVATION, { ...MOTIVATION, id: 'extra', label: 'Conte um desafio que você superou' }] };
      overrides.apply_open = () => ({ text: 'Pessoa fictícia para testes: desenvolvedora front-end com foco em React.' });
      const { id: jobId } = await candidate();
      const id = (await createApplication(db, { jobId, site: 'fake', trigger: 'manual', mode: 'real' }, NOON))!;
      const earlier = clock.now - HOUR;
      await db.update(applications).set({ approvedAnswers: approvedAll, formOpenedAt: earlier }).where(eq(applications.id, id));
      await runUntilIdle(queue({ mode: 'real', cfg: { aiAnswers: 'auto' } }));
      const row = (await applicationForJob(db, jobId))!;
      expect(row).toMatchObject({ status: 'dry_run_ready', mode: 'real', formOpenedAt: earlier });
      expect((await applyCountsSince(db, earlier - 1)).forms.fake).toBe(1);
      expect((await jobRow(jobId)).column).toBe('selecionadas');
      expect(site.calls).not.toContain('submit');
    });
  });
});

describe('the daily AI limit', () => {
  it('waits for tomorrow when the AI budget is spent', async () => {
    aiConfig.dailyBudgetUsd = 1;
    await spend(1.0); // limite diário 1.00
    const { id: jobId } = await candidate();
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({
      status: 'queued', detail: 'limite diário de IA atingido', runAfter: nextMidnight(NOON, TZ), attempts: 0,
    });
    expect(nextMidnight(NOON, TZ)).toBe(Date.UTC(2026, 10, 12, 3, 0));
    expect(tasks).toEqual([]);
  });

  it('makes a manual application wait too', async () => {
    aiConfig.dailyBudgetUsd = 1;
    await spend(1.0);
    const { id: jobId } = await candidate();
    await createApplication(db, { jobId, site: 'fake', trigger: 'manual', mode: 'real' }, NOON);
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'queued', detail: 'limite diário de IA atingido', attempts: 0 });
    expect(tasks).toEqual([]);
  });

  it('stops in the middle of the answers, discards the form and waits for tomorrow without spending an attempt', async () => {
    site.variants.form = { questions: [...BASIC_QUESTIONS, MOTIVATION] };
    overrides.apply_classify = (data) => ({
      items: (data.questions as { questionId: string }[]).map((x) => ({ questionId: x.questionId, category: 'open' })),
    });
    beforeCall = async (task) => {
      if (task === 'apply_classify') await spend(1_000);
    };
    const { id: jobId } = await candidate();
    await runUntilIdle(queue({ mode: 'real', cfg: { aiAnswers: 'auto' } }));
    expect(await applicationForJob(db, jobId)).toMatchObject({
      status: 'queued', detail: 'limite diário de IA atingido', runAfter: nextMidnight(NOON, TZ), attempts: 0,
    });
    expect(site.calls).toEqual(['open', 'readStep', 'discard']);
    expect(answerTasks()).toEqual([]);
    expect((await siteState(db, 'fake')).consecutiveFailures).toBe(0);
  });
});

describe('limits and working hours', () => {
  it('does not count yesterday and starts nothing automatic outside working hours', async () => {
    // 15 formulários fake abertos ontem às 23:59 no fuso; agora 08:00: ainda cabem 15
    for (let i = 0; i < 15; i++) {
      const { id: jobId } = await seedJob(db, { score: null });
      const id = (await createApplication(db, { jobId, site: 'fake', trigger: 'auto', mode: 'real' }, 0))!;
      await db.update(applications).set({ status: 'submitted', formOpenedAt: Date.UTC(2026, 10, 11, 2, 59) }).where(eq(applications.id, id));
    }
    await candidate();
    clock.now = Date.UTC(2026, 10, 11, 11, 0);
    const q = queue({ mode: 'real' });
    expect(await q.tick()).toMatchObject({ swept: 1, started: true });
    await q.idle();

    // agora 07:59: a automática não começa; a manual começa
    clock.now = Date.UTC(2026, 10, 12, 10, 59);
    const auto = await candidate();
    const manual = await candidate();
    await createApplication(db, { jobId: auto.id, site: 'fake', trigger: 'auto', mode: 'real' }, clock.now);
    await createApplication(db, { jobId: manual.id, site: 'fake', trigger: 'manual', mode: 'real' }, clock.now + 1);
    expect(await q.tick()).toMatchObject({ swept: 0, started: true });
    await q.idle();
    expect(await q.tick()).toMatchObject({ started: false });
    expect((await applicationForJob(db, manual.id))!.status).toBe('submitted');
    expect((await applicationForJob(db, auto.id))!.status).toBe('queued');
  });

  it('respects the per-company cap', async () => {
    // 2 candidaturas da Acme nos últimos 30 dias: a terceira fica em queued para amanhã
    for (const days of [3, 20]) {
      const { id: jobId } = await seedJob(db, { score: null, company: 'ACME' });
      const id = (await createApplication(db, { jobId, site: 'fake', trigger: 'auto', mode: 'real' }, 0))!;
      await db.update(applications).set({ status: 'submitted', formOpenedAt: NOON - days * 86_400_000 }).where(eq(applications.id, id));
    }
    const { id: jobId } = await candidate({ company: 'Acme' });
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'queued', runAfter: nextMidnight(NOON, TZ) });
    expect(site.calls).toEqual([]);
    expect(tasks).toEqual([]);
  });

  it('starts nothing on a site whose daily cap is used up', async () => {
    const { id: jobId } = await candidate();
    await createApplication(db, { jobId, site: 'fake', trigger: 'manual', mode: 'real' }, NOON);
    const q = queue({ mode: 'real', cfg: { dailyCaps: { ...APPLY_DEFAULTS.dailyCaps, fake: 0 } } });
    expect(await q.tick()).toMatchObject({ started: false });
  });
});

describe('the state of a site', () => {
  it('pauses a site after three unknown layouts in a row and keeps the others running', async () => {
    const lever = createRecordingSite({ id: 'lever' });
    for (let i = 0; i < 3; i++) await candidate({ variant: 'layout', score: 95 - i });
    await candidate({ variant: 'layout', score: 80 });
    const { id: leverJob } = await candidate({ source: 'lever', score: 75 });
    await runUntilIdle(queue({ mode: 'real', sites: [site, lever] }));
    expect(await siteState(db, 'fake')).toMatchObject({ paused: true, pauseReason: 'brake', consecutiveFailures: 3 });
    expect(site.calls.filter((c) => c === 'open')).toHaveLength(3);
    expect((await applicationForJob(db, leverJob))!.status).toBe('submitted');
    const rows = await db.select().from(applications).where(eq(applications.site, 'fake'));
    expect(rows.filter((r) => r.status === 'queued')).toHaveLength(1);
  });

  it('pauses a site at once on a restriction page', async () => {
    const { id: jobId } = await candidate({ variant: 'restricted' });
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'needs_human', reason: 'restricted' });
    expect(await siteState(db, 'fake')).toMatchObject({ paused: true, pauseReason: 'restricted' });
  });

  it('marks the owner as away after two missed waits', async () => {
    site.variants.captcha = { gate: () => 'captcha' };
    await candidate({ variant: 'captcha' });
    await candidate({ variant: 'captcha' });
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await siteState(db, 'fake')).toMatchObject({ paused: true, pauseReason: 'owner_away', humanTimeouts: 2 });
    const rows = await db.select().from(applications);
    expect(rows.map((r) => [r.status, r.reason, r.waitingGate])).toEqual([
      ['needs_human', 'captcha', null], ['needs_human', 'captcha', null],
    ]);
    expect(browser.calls).toContain('front');
  });

  it('a submit resets the streaks', async () => {
    await siteState(db, 'fake');
    await updateSiteState(db, 'fake', { consecutiveFailures: 2, consecutiveRejections: 2, humanTimeouts: 1 });
    await candidate();
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await siteState(db, 'fake')).toMatchObject({ consecutiveFailures: 0, consecutiveRejections: 0, humanTimeouts: 0 });
  });

  it('counts every stop after the click in its own streak', async () => {
    for (let i = 0; i < 3; i++) await candidate({ variant: 'refused' });
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await siteState(db, 'fake')).toMatchObject({ paused: true, pauseReason: 'brake', consecutiveRejections: 3, consecutiveFailures: 0 });
    const rows = await db.select().from(applications);
    expect(rows.every((r) => r.status === 'needs_human' && r.reason === 'confirm_submission')).toBe(true);
    const jobsRows = await db.select().from(jobs);
    expect(jobsRows.every((j) => j.needsHuman)).toBe(true);
  });
});

describe('waiting for the owner', () => {
  it('keeps the row in submitting with the gate set during a wait after the click, and a timeout asks to confirm', async () => {
    let gate: 'captcha' | null = null;
    const seen: unknown[] = [];
    site.variants.form = {
      gate: () => gate,
      submit: async () => {
        gate = 'captcha';
        throw new Error('o site pediu captcha');
      },
    };
    const { id: jobId } = await candidate();
    const originalGate = site.humanGate;
    site.humanGate = async (page) => {
      const row = await applicationForJob(db, jobId);
      if (row?.status === 'submitting' && row.waitingGate) seen.push({ status: row.status, waitingGate: row.waitingGate });
      return originalGate(page);
    };
    await runUntilIdle(queue({ mode: 'real' }));
    expect(seen[0]).toEqual({ status: 'submitting', waitingGate: 'captcha' });
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'needs_human', reason: 'confirm_submission', waitingGate: null });
    expect(site.calls.filter((c) => c === 'submit')).toHaveLength(1);
  });

  it('does not count the wait for the owner in the work time', async () => {
    let solveAt = 0;
    site.variants.form = { gate: () => (Date.now() < solveAt ? 'captcha' : null) };
    const orig = site.open;
    site.open = async (page, target) => {
      if (solveAt === 0) solveAt = Date.now() + 150;
      return orig(page, target);
    };
    const { id: jobId } = await candidate();
    await runUntilIdle(queue({ mode: 'real', deps: { workTimeoutMs: 100, humanWaitMs: 2_000 } }));
    expect((await applicationForJob(db, jobId))!.status).toBe('submitted');
  });
});

describe('cancelling', () => {
  it('records a submit that completed after the owner moved the card, and moves it to aplicada', async () => {
    const { id: jobId } = await candidate();
    site.variants.form = {
      submit: async () => {
        await db.update(jobs).set({ column: 'descobertas' }).where(eq(jobs.id, jobId));
        await requestCancel(db, jobId);
        return { confirmation: 'Candidatura recebida' };
      },
    };
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'submitted', cancelRequested: false });
    expect(await jobRow(jobId)).toMatchObject({ column: 'aplicada', appliedBy: 'ia' });
  });

  it('honours a cancel requested before the click', async () => {
    const { id: jobId } = await candidate();
    site.variants.form = {
      readStep: async () => {
        await requestCancel(db, jobId);
      },
    };
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'cancelled', cancelRequested: false });
    expect(site.calls).not.toContain('submit');
    expect(site.calls).toContain('discard');
  });

  it('a cancel wins over a stop for the owner', async () => {
    const { id: jobId } = await candidate({ variant: 'layout' });
    const orig = site.readStep;
    site.readStep = async (page) => {
      await requestCancel(db, jobId);
      return orig(page);
    };
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'cancelled', cancelRequested: false });
  });
});

describe('errors', () => {
  it('retries a transient error after 5 and 30 minutes, then fails', async () => {
    const { id: jobId } = await candidate({ variant: 'net' });
    const q = queue({ mode: 'real' });
    await runUntilIdle(q);
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'queued', attempts: 1, runAfter: NOON + 5 * MIN });
    clock.now = NOON + 5 * MIN;
    await runUntilIdle(q);
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'queued', attempts: 2, runAfter: NOON + 35 * MIN });
    clock.now = NOON + 35 * MIN;
    await runUntilIdle(q);
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'failed', attempts: 3, detail: 'net::ERR_CONNECTION_RESET' });
    expect((await siteState(db, 'fake')).consecutiveFailures).toBe(0);
  });

  it('aborts work that runs past the time limit, discards the form and counts a transient error', async () => {
    let release!: () => void;
    site.variants.form = { readStep: () => new Promise<void>((resolve) => { release = resolve; }) };
    const origDiscard = site.discard;
    site.discard = async (page) => {
      release?.();
      return origDiscard(page);
    };
    const { id: jobId } = await candidate();
    await runUntilIdle(queue({ mode: 'real', deps: { workTimeoutMs: 50, abortGraceMs: 1_000 } }));
    const row = (await applicationForJob(db, jobId))!;
    expect(row).toMatchObject({ status: 'queued', attempts: 1, runAfter: NOON + 5 * MIN });
    expect(row.detail).toMatch(/passou de/);
    expect(site.calls).toContain('discard');
    expect(site.calls).not.toContain('submit');
  });
});

describe('the site mode when an application starts', () => {
  const approved: AnswerRecord[] = BASIC_QUESTIONS.map((x): AnswerRecord => ({
    questionId: x.id, value: x.kind === 'file' ? 'Curriculo.pdf' : 'valor do ensaio', source: 'rule', category: x.kind === 'file' ? 'file' : 'identity',
    basis: [], bankAnswerId: null, label: x.label, help: x.help, kind: x.kind, options: [], required: x.required,
  }));
  const queuedRow = async (mode: ApplyMode, extra: Partial<typeof applications.$inferInsert> = {}) => {
    const { id: jobId } = await candidate();
    const id = (await createApplication(db, { jobId, site: 'fake', trigger: 'auto', mode }, NOON))!;
    if (Object.keys(extra).length > 0) await db.update(applications).set(extra).where(eq(applications.id, id));
    return jobId;
  };

  it('rehearses a row queued for real when the site went back to rehearsal', async () => {
    const jobId = await queuedRow('real');
    await runUntilIdle(queue({ mode: 'dry_run' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'dry_run_ready', mode: 'dry_run' });
    expect(site.calls).not.toContain('submit');
  });

  it('keeps sending for real a row the owner sent himself', async () => {
    const jobId = await queuedRow('real', { approvedAnswers: approved });
    await runUntilIdle(queue({ mode: 'dry_run' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'submitted', mode: 'real' });
  });

  it('never turns a rehearsal into a real send when the site went real', async () => {
    const jobId = await queuedRow('dry_run');
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'dry_run_ready', mode: 'dry_run' });
    expect(site.calls).not.toContain('submit');
  });
});

describe('an abandoned run', () => {
  it('closes the page it held and gives the next application a new one', async () => {
    let release!: () => void;
    site.variants.hang = { readStep: () => new Promise<void>((resolve) => { release = resolve; }) };
    const opened: { isClosed(): boolean }[] = [];
    const origOpen = site.open;
    site.open = async (page, target) => {
      opened.push(page);
      return origOpen(page, target);
    };
    const { id: hungJob } = await candidate({ variant: 'hang', score: 95 });
    const { id: nextJob } = await candidate({ score: 80 });
    await runUntilIdle(queue({ mode: 'real', deps: { workTimeoutMs: 50, abortGraceMs: 20 } }));
    expect(await applicationForJob(db, hungJob)).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await applicationForJob(db, nextJob)).toMatchObject({ status: 'submitted' });
    expect(opened).toHaveLength(2);
    expect(opened[1]).not.toBe(opened[0]);
    expect(opened[0].isClosed()).toBe(true);
    expect(opened[1].isClosed()).toBe(false);

    // O motor abandonado acorda tarde: a página dele está fechada e a linha não muda.
    const before = await applicationForJob(db, hungJob);
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(await applicationForJob(db, hungJob)).toEqual(before);
    expect(site.calls.filter((c) => c === 'fillStep')).toHaveLength(1);
  });
});

describe('the login window', () => {
  beforeEach(() => {
    site = createRecordingSite({ needsLogin: true });
    site.sessions = 'logged_out';
    clock.now = Date.now(); // o navegador de mentira marca o uso com o relógio real
  });
  const manualRow = async () => {
    const { id: jobId } = await candidate({ score: null });
    await createApplication(db, { jobId, site: 'fake', trigger: 'manual', mode: 'real' }, clock.now);
    return jobId;
  };

  it('stays open and holds the site until the session check says logged in', async () => {
    const jobId = await manualRow();
    const q = queue({ mode: 'real', deps: { humanWaitMs: 20 * MIN } });
    await enqueueApplyCommand(db, 'open_login', 'fake', clock.now);
    expect(await q.tick()).toMatchObject({ commands: 1, started: false });

    clock.now += 6 * MIN;
    browser.usedAt = clock.now - 6 * MIN;
    expect(await q.tick()).toMatchObject({ started: false });
    expect(browser.calls).not.toContain('close');

    site.sessions = 'logged_in';
    await enqueueApplyCommand(db, 'check_session', 'fake', clock.now);
    expect(await q.tick()).toMatchObject({ commands: 1, started: true });
    await q.idle();
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'submitted' });
  });

  it('gives up the hold once the wait is over, and the window closes when idle after that', async () => {
    const jobId = await manualRow();
    const q = queue({ mode: 'real', deps: { humanWaitMs: 10 * MIN } });
    const opened = clock.now;
    await enqueueApplyCommand(db, 'open_login', 'fake', clock.now);
    await q.tick();

    clock.now = opened + 9 * MIN;
    browser.usedAt = opened;
    expect(await q.tick()).toMatchObject({ started: false });
    expect(browser.calls).not.toContain('close');

    // A espera acabou: a candidatura começa (e encontra o site deslogado).
    clock.now = opened + 11 * MIN;
    expect(await q.tick()).toMatchObject({ started: true });
    await q.idle();
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'needs_human', reason: 'login' });
    expect(browser.calls).not.toContain('close');

    clock.now = opened + 17 * MIN;
    browser.usedAt = opened + 11 * MIN;
    await q.tick();
    expect(browser.calls).toContain('close');
  });
});

describe('the daily cap and a form already opened today', () => {
  for (const caps of [{ fake: 1 }, { total: 1 }]) {
    it(`runs today an application that opened its form today, with the cap reached (${Object.keys(caps)[0]})`, async () => {
      const opened = await candidate({ score: null });
      const waiting = await candidate({ score: null });
      const id = (await createApplication(db, { jobId: opened.id, site: 'fake', trigger: 'auto', mode: 'real' }, NOON))!;
      await transitionApplication(db, id, { status: 'needs_human', reason: 'question', set: { formOpenedAt: NOON - HOUR, viewedAt: NOON - HOUR } }, NOON);
      await createApplication(db, { jobId: waiting.id, site: 'fake', trigger: 'auto', mode: 'real' }, NOON);
      const q = queue({ mode: 'real', cfg: { dailyCaps: { ...APPLY_DEFAULTS.dailyCaps, ...caps } } });
      expect(await q.tick()).toMatchObject({ started: false });

      // O dono respondeu a pergunta: a candidatura volta à fila e roda hoje, sem contar de novo.
      await transitionApplication(db, id, { status: 'queued', set: { pendingQuestions: [] } }, NOON);
      expect(await q.tick()).toMatchObject({ started: true });
      await q.idle();
      expect(await applicationForJob(db, opened.id)).toMatchObject({ status: 'submitted', formOpenedAt: NOON - HOUR });
      expect(await q.tick()).toMatchObject({ started: false });
      expect((await applicationForJob(db, waiting.id))!.status).toBe('queued');
      expect((await applyCountsSince(db, NOON - 2 * HOUR)).forms.fake).toBe(1);
    });
  }
});

describe('old photos', () => {
  it('deletes the files past the retention and drops them from the row', async () => {
    const { id: jobId } = await candidate({ score: null });
    const id = (await createApplication(db, { jobId, site: 'fake', trigger: 'auto', mode: 'real' }, NOON))!;
    const shots = { filled: `shots/${id}/filled.jpg`, confirmation: `shots/${id}/confirmation.jpg` };
    await transitionApplication(db, id, { status: 'submitted', set: { shots } }, NOON);
    await mkdir(join(dataDir, 'shots', String(id)), { recursive: true });
    for (const rel of Object.values(shots)) await writeFile(join(dataDir, rel), 'jpeg');
    const old = (NOON - 100 * 86_400_000) / 1000;
    await utimes(join(dataDir, shots.filled), old, old);
    const recent = (NOON - 86_400_000) / 1000;
    await utimes(join(dataDir, shots.confirmation), recent, recent);

    await queue().tick();
    expect(existsSync(join(dataDir, shots.filled))).toBe(false);
    expect(existsSync(join(dataDir, shots.confirmation))).toBe(true);
    expect((await applicationForJob(db, jobId))!.shots).toEqual({ confirmation: shots.confirmation });
  });
});

describe('a row that comes back to the queue', () => {
  it('reuses the score the gate already gave, against the current minimum', async () => {
    const pass = await candidate({ score: null });
    const fail = await candidate({ score: null });
    for (const [job, gateScore] of [[pass.id, 80], [fail.id, 72]] as const) {
      const id = (await createApplication(db, { jobId: job, site: 'fake', trigger: 'auto', mode: 'real' }, NOON))!;
      await db.update(applications).set({ gateScore }).where(eq(applications.id, id));
    }
    await runUntilIdle(queue({ mode: 'real', cfg: { minScore: 75 } }));
    expect(tasks).not.toContain('apply_gate');
    expect(await applicationForJob(db, pass.id)).toMatchObject({ status: 'submitted', gateScore: 80 });
    expect(await applicationForJob(db, fail.id)).toMatchObject({ status: 'skipped', reason: 'below_min_score', gateScore: 72 });
  });

  it('stops for the owner when the site with login is logged out', async () => {
    site = createRecordingSite({ needsLogin: true });
    site.sessions = 'logged_out';
    const { id: jobId } = await candidate();
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'needs_human', reason: 'login' });
    expect(site.calls).toEqual(['sessionState']);
    expect(await siteState(db, 'fake')).toMatchObject({ session: 'logged_out', sessionCheckedAt: NOON });
    expect((await jobRow(jobId)).needsHuman).toBe(true);
  });

  it('waits for the midnight of the AI budget time zone when the budget is spent', async () => {
    aiConfig.dailyBudgetUsd = 1;
    aiConfig.budgetTimeZone = 'UTC';
    await spend(1.0);
    const { id: jobId } = await candidate();
    await runUntilIdle(queue({ mode: 'real' }));
    expect(await applicationForJob(db, jobId)).toMatchObject({ status: 'queued', runAfter: Date.UTC(2026, 10, 12, 0, 0) });
  });
});

describe('database parameters', () => {
  // PGlite aceita um número cru onde o Postgres de verdade espera um timestamptz; aqui se confere o que vai ao driver.
  it('never sends a bare millisecond number as a query parameter', async () => {
    const seen: unknown[][] = [];
    const logged = await createTestDb({ logQuery: (_q, params) => void seen.push(params) });
    const original = db;
    try {
      db = logged;
      version = await seedProfile(db);
      await candidate();
      await candidate({ variant: 'net', company: 'Outra' });
      await candidate({ variant: 'captcha' });
      site.variants.captcha = { gate: () => 'captcha' };
      seen.length = 0;
      const q = queue({ mode: 'real' });
      await q.recoverInterrupted();
      await runUntilIdle(q);
      const statuses = (await db.select().from(applications)).map((r) => r.status).sort();
      expect(statuses).toEqual(['needs_human', 'queued', 'submitted']);
      const bare = seen.flat().filter((p) => typeof p === 'number' && p >= 1e11);
      expect(bare).toEqual([]);
      expect(seen.flat().some((p) => typeof p === 'string' && /^2026-11-1\dT/.test(p))).toBe(true);
    } finally {
      db = original;
      await closeDb(logged);
    }
  });
});
