import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApplicationReason, ApplicationStatus, Column, EmailKind } from '@kv/shared';
import { closeDb, type Db } from './index';
import { appliedJobFacts, applyBlockers, mailFacts } from './dashboard';
import { applications, jobAi, jobEvents, jobs, mailMessages, mailReplies } from './schema';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

const MIN = 60_000;
let seq = 0;

async function seedJob(extra: Partial<typeof jobs.$inferInsert> = {}): Promise<number> {
  seq += 1;
  const url = `https://example.com/vaga/${seq}`;
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: url, url, title: 'Dev', company: 'Acme', location: 'Remoto', country: 'BR',
      remote: true, level: null, stacks: [], description: '', postedAt: null, discoveredAt: 500, dedupHash: url,
      profileId: null, position: seq, ...extra,
    })
    .returning({ id: jobs.id });
  return row.id;
}

async function event(jobId: number, toColumn: Column, at: number, extra: Partial<typeof jobEvents.$inferInsert> = {}) {
  await db.insert(jobEvents).values({ jobId, fromColumn: null, toColumn, actor: 'humano', createdAt: at, ...extra });
}

async function mail(extra: Partial<typeof mailMessages.$inferInsert> & { sentAt: number }): Promise<number> {
  seq += 1;
  const [row] = await db
    .insert(mailMessages)
    .values({
      messageId: `<m${seq}@example.com>`, threadKey: `t${seq}`, direction: 'in', fromAddress: 'rh@acme.example',
      fromName: 'Acme RH', toAddress: 'maria@example.com', subject: 'Sua candidatura', body: 'Olá', createdAt: extra.sentAt, ...extra,
    })
    .returning({ id: mailMessages.id });
  return row.id;
}

async function application(jobId: number, status: ApplicationStatus, extra: Partial<typeof applications.$inferInsert> = {}) {
  await db
    .insert(applications)
    .values({ jobId, site: 'greenhouse', status, trigger: 'auto', mode: 'real', createdAt: 900, ...extra });
}

describe('appliedJobFacts', () => {
  /** A: enviada pela IA e chamada para entrevista por e-mail; B: aplicada pelo dono e perdida; C: nunca aplicada. */
  async function seedStages() {
    const a = await seedJob({ column: 'entrevista', appliedBy: 'ia', source: 'greenhouse' });
    await db.insert(jobAi).values({ jobId: a, score: 85 });
    await application(a, 'submitted', { resumeLang: 'pt-BR', submittedAt: 1000 });
    await event(a, 'aplicada', 1000, { actor: 'ia' });
    const invite = await mail({ jobId: a, kind: 'entrevista', sentAt: 3000 });
    await event(a, 'entrevista', 3000, { actor: 'email', fromColumn: 'aplicada', mailMessageId: invite });

    const b = await seedJob({ column: 'perdida', appliedBy: null });
    await event(b, 'aplicada', 2000);
    await event(b, 'perdida', 5000, { fromColumn: 'aplicada' });

    await seedJob({ column: 'descobertas' });
    return { a, b };
  }

  it('lists one fact per applied job with its stages', async () => {
    const { a, b } = await seedStages();
    expect(await appliedJobFacts(db, null)).toEqual([
      {
        jobId: a, source: 'greenhouse', column: 'entrevista', appliedBy: 'ia', site: 'greenhouse', score: 85, resumeLang: 'pt-BR',
        appliedAt: 1000, firstResponseAt: 3000, interviewAt: 3000, offerAt: null, lostAt: null,
      },
      {
        jobId: b, source: 'gupy', column: 'perdida', appliedBy: 'humano', site: null, score: null, resumeLang: null,
        appliedAt: 2000, firstResponseAt: 5000, interviewAt: null, offerAt: null, lostAt: 5000,
      },
    ]);
  });

  it('keeps only jobs applied since the start of the period', async () => {
    const { b } = await seedStages();
    expect((await appliedJobFacts(db, 1500)).map((f) => f.jobId)).toEqual([b]);
    expect(await appliedJobFacts(db, 9000)).toEqual([]);
  });

  it('dates an application by its submission, and counts one that was not sent only by the card', async () => {
    // Enviada sem evento no quadro; ensaio (dry_run_ready) que o dono depois moveu para aplicada.
    const sent = await seedJob({ column: 'aplicada', appliedBy: 'ia' });
    await application(sent, 'submitted', { site: 'lever', resumeLang: 'en', submittedAt: 4000 });
    const rehearsed = await seedJob({ column: 'aplicada', appliedBy: 'humano' });
    await application(rehearsed, 'dry_run_ready', { resumeLang: 'en' });
    await event(rehearsed, 'aplicada', 4500);
    const onlyRehearsed = await seedJob({ column: 'selecionadas' });
    await application(onlyRehearsed, 'dry_run_ready');
    expect(await appliedJobFacts(db, null)).toEqual([
      expect.objectContaining({ jobId: sent, site: 'lever', resumeLang: 'en', appliedAt: 4000 }),
      expect.objectContaining({ jobId: rehearsed, site: null, resumeLang: null, appliedAt: 4500 }),
    ]);
  });

  it('does not count a receipt or a corrected mail as a response', async () => {
    const d = await seedJob({ column: 'aplicada', appliedBy: 'humano' });
    await event(d, 'aplicada', 1000);
    await mail({ jobId: d, kind: 'recebimento', sentAt: 1100 });
    await mail({ jobId: d, kind: null, sentAt: 1200 }); // ainda sem tipo
    await mail({ jobId: d, kind: 'entrevista', direction: 'out', sentAt: 1300 }); // enviada pelo app

    // E: reprovação lida por engano; o dono desfez o movimento (card volta para aplicada).
    const e = await seedJob({ column: 'aplicada', appliedBy: 'humano' });
    await event(e, 'aplicada', 1000);
    const wrong = await mail({ jobId: e, kind: 'reprovacao', corrected: true, sentAt: 2000 });
    await event(e, 'perdida', 2000, { actor: 'email', fromColumn: 'aplicada', mailMessageId: wrong });
    await event(e, 'aplicada', 2500, { actor: 'humano', fromColumn: 'perdida' });

    const facts = await appliedJobFacts(db, null);
    expect(facts.find((f) => f.jobId === d)!.firstResponseAt).toBeNull();
    expect(facts.find((f) => f.jobId === e)!).toMatchObject({ appliedAt: 1000, firstResponseAt: null, lostAt: null });
  });

  it('does not count an undone mail move whose mail was deleted', async () => {
    const f = await seedJob({ column: 'aplicada', appliedBy: 'humano' });
    await event(f, 'aplicada', 1000);
    // A mensagem foi apagada: a chave estrangeira soltou a ligação, e só `undone` diz que o movimento foi desfeito.
    await event(f, 'perdida', 2000, { actor: 'email', fromColumn: 'aplicada', mailMessageId: null, undone: true });
    await event(f, 'aplicada', 2500, { actor: 'humano', fromColumn: 'perdida' });
    expect((await appliedJobFacts(db, null)).find((x) => x.jobId === f)).toMatchObject({ appliedAt: 1000, firstResponseAt: null, lostAt: null });
  });

  it('takes the earlier of the first answering mail and the first move past Aplicada', async () => {
    const j = await seedJob({ column: 'oferta', appliedBy: 'humano' });
    await event(j, 'aplicada', 1000);
    await mail({ jobId: j, kind: 'pedido', sentAt: 1500 });
    await event(j, 'oferta', 4000, { fromColumn: 'aplicada' }); // oferta sem passar por entrevista
    expect((await appliedJobFacts(db, null))[0]).toMatchObject({ firstResponseAt: 1500, interviewAt: null, offerAt: 4000, lostAt: null });
  });

  it('reports lost only while the card is in Perdida', async () => {
    const j = await seedJob({ column: 'entrevista', appliedBy: 'humano' });
    await event(j, 'aplicada', 1000);
    await event(j, 'perdida', 2000, { fromColumn: 'aplicada' });
    const back = await mail({ jobId: j, kind: 'entrevista', sentAt: 3000 });
    await event(j, 'entrevista', 3000, { actor: 'email', fromColumn: 'perdida', mailMessageId: back });
    expect((await appliedJobFacts(db, null))[0]).toMatchObject({ firstResponseAt: 2000, interviewAt: 3000, lostAt: null });

    // Volta para perdida: vale o evento mais recente.
    await db.update(jobs).set({ column: 'perdida' });
    await event(j, 'perdida', 6000, { fromColumn: 'entrevista' });
    expect((await appliedJobFacts(db, null))[0]).toMatchObject({ lostAt: 6000 });
  });

  it('uses a fixed number of queries', async () => {
    let queries = 0;
    const logged = await createTestDb({ logQuery: () => void (queries += 1) });
    try {
      const seedMany = async (n: number) => {
        for (let i = 0; i < n; i += 1) {
          seq += 1;
          const url = `https://example.com/muitas/${seq}`;
          const [row] = await logged
            .insert(jobs)
            .values({
              source: 'gupy', externalId: url, url, title: 'Dev', company: 'Globex', location: 'Remoto', country: 'BR', remote: true,
              level: null, stacks: [], description: '', postedAt: null, discoveredAt: 500, dedupHash: url, profileId: null,
              position: seq, column: 'entrevista', appliedBy: 'humano',
            })
            .returning({ id: jobs.id });
          await logged.insert(jobEvents).values([
            { jobId: row.id, toColumn: 'aplicada', actor: 'humano', createdAt: 1000 + i },
            { jobId: row.id, toColumn: 'entrevista', actor: 'humano', createdAt: 2000 + i },
          ]);
        }
      };
      const count = async () => {
        queries = 0;
        const facts = await appliedJobFacts(logged, null);
        return { facts: facts.length, queries };
      };
      await seedMany(3);
      const few = await count();
      await seedMany(27);
      const many = await count();
      expect(few.facts).toBe(3);
      expect(many.facts).toBe(30);
      expect(many.queries).toBe(few.queries);
    } finally {
      await closeDb(logged);
    }
  });

  it('sends every time bound as a timestamp, never as a raw number', async () => {
    const params: unknown[][] = [];
    const logged = await createTestDb({ logQuery: (_q, p) => void params.push(p) });
    try {
      params.length = 0;
      await appliedJobFacts(logged, 1_700_000_000_000);
      await applyBlockers(logged, 1_700_000_000_000);
      await mailFacts(logged, 1_700_000_000_000);
      expect(params.flat()).not.toContain(1_700_000_000_000);
      expect(params.flat()).toContain(new Date(1_700_000_000_000).toISOString());
    } finally {
      await closeDb(logged);
    }
  });
});

describe('applyBlockers', () => {
  async function blocked(status: ApplicationStatus, reason: ApplicationReason | null, createdAt: number) {
    await application(await seedJob(), status, { reason, createdAt });
  }

  it('counts what blocks applications by reason', async () => {
    await blocked('needs_human', 'captcha', 1000);
    await blocked('needs_human', 'captcha', 2000);
    await blocked('skipped', 'closed', 3000);
    await blocked('failed', null, 3000);
    await blocked('submitted', null, 3000);
    expect(await applyBlockers(db, null)).toEqual([
      { kind: 'needs_human', reason: 'captcha', count: 2 }, { kind: 'skipped', reason: 'closed', count: 1 },
    ]);
  });

  it('keeps only applications created since the start of the period, most frequent first', async () => {
    await blocked('needs_human', 'captcha', 1000);
    await blocked('needs_human', 'captcha', 1000);
    await blocked('needs_human', 'login', 2000);
    await blocked('skipped', 'below_min_score', 2000);
    await blocked('skipped', 'below_min_score', 2500);
    expect(await applyBlockers(db, 1500)).toEqual([
      { kind: 'skipped', reason: 'below_min_score', count: 2 }, { kind: 'needs_human', reason: 'login', count: 1 },
    ]);
  });
});

describe('mailFacts', () => {
  async function seedMail() {
    const job = await seedJob({ column: 'aplicada' });
    const at = (kind: EmailKind | null, sentAt: number, extra: Partial<typeof mailMessages.$inferInsert> = {}) =>
      mail({ jobId: job, kind, sentAt, ...extra });
    const receipt1 = await at('recebimento', 10_000);
    await at('recebimento', 11_000);
    await at('reprovacao', 12_000);
    const invite = await at('entrevista', 13_000);
    const request = await at('pedido', 14_000);
    await at(null, 15_000);
    await at('oferta', 16_000, { corrected: true }); // corrigido: não conta
    await at('outro', 17_000, { direction: 'out' }); // enviado pelo app: não é recebido
    const old = await at('pedido', 1000); // antes do período nos testes com `since`

    const reply = (messageId: number, state: 'enviada' | 'descartada' | 'rascunho', extra: Partial<typeof mailReplies.$inferInsert> = {}) =>
      db.insert(mailReplies).values({
        messageId, origin: 'facts', toAddress: 'rh@acme.example', subject: 'Re: Sua candidatura', body: 'Segue', state, createdAt: 20_000,
        ...extra,
      });
    await reply(request, 'enviada', { approvedBy: 'auto', sentAt: 14_000 + 5 * MIN });
    await reply(invite, 'enviada', { approvedBy: 'owner', origin: 'ai', sentAt: 13_000 + 120 * MIN });
    await reply(receipt1, 'descartada');
    await reply(old, 'enviada', { approvedBy: 'auto', sentAt: 1000 + 30 * MIN });
  }

  it('summarises mail and replies of the period', async () => {
    await seedMail();
    expect(await mailFacts(db, 5000)).toEqual({
      received: { recebimento: 2, reprovacao: 1, entrevista: 1, oferta: 0, pedido: 1, outro: 0 }, waiting: 1,
      repliedAuto: 1, repliedApproved: 1, discarded: 1, replyMinutes: [5, 120],
    });
  });

  it('counts everything with no start', async () => {
    await seedMail();
    expect(await mailFacts(db, null)).toMatchObject({
      received: { recebimento: 2, reprovacao: 1, entrevista: 1, oferta: 0, pedido: 2, outro: 0 }, repliedAuto: 2, replyMinutes: [5, 30, 120],
    });
  });

  it('says zero for every kind when there is no mail', async () => {
    expect(await mailFacts(db, null)).toEqual({
      received: { recebimento: 0, reprovacao: 0, entrevista: 0, oferta: 0, pedido: 0, outro: 0 }, waiting: 0,
      repliedAuto: 0, repliedApproved: 0, discarded: 0, replyMinutes: [],
    });
  });
});
