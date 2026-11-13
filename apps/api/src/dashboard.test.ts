import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applications, closeDb, jobEvents, mailMessages, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import type { Column } from '@kv/shared';
import { buildApp } from './app';
import { seedJob, testAi } from './ai-testing';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);
let db: Db;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await resetTestDb(db);
  app = buildApp(db, { ai: testAi({ now: () => NOW }) });
});
afterAll(() => closeDb(db));

const get = (url: string) => app.inject({ method: 'GET', url });
const event = (jobId: number, toColumn: Column, at: number, extra: Partial<typeof jobEvents.$inferInsert> = {}) =>
  db.insert(jobEvents).values({ jobId, fromColumn: null, toColumn, actor: 'humano', createdAt: at, ...extra });

describe('GET /dashboard', () => {
  it('answers with the default period and refuses an unknown one', async () => {
    expect((await get('/dashboard')).json()).toMatchObject({ period: '30', applied: { total: 0 } });
    expect((await get('/dashboard?period=365')).statusCode).toBe(400);
  });

  it('leaves out a job applied before the period even if it answered inside it', async () => {
    const job = await seedJob(db, { column: 'entrevista' });
    await event(job.id, 'aplicada', NOW - 40 * DAY);
    await event(job.id, 'entrevista', NOW - 2 * DAY);
    expect((await get('/dashboard?period=30')).json()).toMatchObject({ applied: { total: 0 }, responded: { n: 0, of: 0 } });
    expect((await get('/dashboard?period=90')).json()).toMatchObject({ applied: { total: 1 }, interviews: { n: 1, of: 1 } });
    expect((await get('/dashboard?period=all')).json()).toMatchObject({ period: 'all', since: null, applied: { total: 1 } });
  });

  it('drops an undone rejection from every number', async () => {
    const job = await seedJob(db, { column: 'perdida' });
    await event(job.id, 'aplicada', NOW - 5 * DAY);
    const [msg] = await db
      .insert(mailMessages)
      .values({
        messageId: '<r1@example.com>', threadKey: 't1', direction: 'in', fromAddress: 'rh@acme.example', fromName: 'Acme RH',
        toAddress: 'maria@example.com', subject: 'Retorno', body: 'Olá', sentAt: NOW - DAY, createdAt: NOW - DAY,
        kind: 'reprovacao', jobId: job.id, corrected: true,
      })
      .returning({ id: mailMessages.id });
    await event(job.id, 'perdida', NOW - DAY, { actor: 'email', mailMessageId: msg.id });
    const dto = (await get('/dashboard?period=30')).json();
    expect(dto.rejections.n).toBe(0);
    expect(dto.funnel.lost).toBe(0);
    expect(dto.email.received.reprovacao).toBe(0);
    expect(dto.applied.total).toBe(1);
  });

  it('counts blockers of the period', async () => {
    const job = await seedJob(db);
    await db.insert(applications).values({
      jobId: job.id, site: 'greenhouse', status: 'skipped', reason: 'closed', trigger: 'auto', mode: 'real', createdAt: NOW - DAY,
    });
    expect((await get('/dashboard')).json().blockers).toEqual([{ kind: 'skipped', reason: 'closed', count: 1 }]);
  });
});
