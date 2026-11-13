import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeMailbox, deliverFakeMail } from './fake';
import {
  SMOKE_MAX_CLASSIFY, checkSmokeFolders, formatSmokeSummary, parseMailSmokeArgs, readRecentInbox, summarizeSmoke,
} from './smoke';
import { FOLDERS_HIDDEN_TEXT } from './gmail';
import { rawMail } from './testing';
import { MailFolderError, type Mailbox } from './types';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

describe('parseMailSmokeArgs', () => {
  it('refuses to run with CI set, whatever the arguments', () => {
    expect(parseMailSmokeArgs([], { CI: 'true' })).toEqual({ error: expect.stringContaining('não roda na CI') });
    expect(parseMailSmokeArgs(['--classify', '3'], { CI: '1' })).toHaveProperty('error');
  });

  it('reads nothing to classify without arguments, and ignores the bare -- that pnpm passes', () => {
    expect(parseMailSmokeArgs([], {})).toEqual({ classify: 0 });
    expect(parseMailSmokeArgs(['--'], {})).toEqual({ classify: 0 });
  });

  it('accepts --classify N from 1 to the cap', () => {
    expect(parseMailSmokeArgs(['--', '--classify', '5'], {})).toEqual({ classify: 5 });
    expect(parseMailSmokeArgs(['--classify', String(SMOKE_MAX_CLASSIFY)], {})).toEqual({ classify: SMOKE_MAX_CLASSIFY });
  });

  it('refuses a missing, zero, negative, fractional or too large count', () => {
    for (const value of [undefined, '0', '-1', '2.5', 'abc', String(SMOKE_MAX_CLASSIFY + 1)]) {
      const argv = value === undefined ? ['--classify'] : ['--classify', value];
      expect(parseMailSmokeArgs(argv, {}), `--classify ${value}`).toHaveProperty('error');
    }
  });

  it('refuses any other argument (there is no option that writes or sends)', () => {
    expect(parseMailSmokeArgs(['--send'], {})).toEqual({ error: expect.stringContaining('--send') });
    expect(parseMailSmokeArgs(['--classify', '2', '--yes'], {})).toEqual({ error: expect.stringContaining('--yes') });
  });
});

describe('readRecentInbox', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function fakeBox(): { box: Mailbox; folder: string } {
    dir = mkdtempSync(join(tmpdir(), 'kv-mail-smoke-'));
    return { box: createFakeMailbox(dir, { address: 'maria@example.com', password: 'qualquer' }), folder: dir };
  }

  it('reads every page of the last 30 days, oldest first, and leaves older mail out', async () => {
    const { box, folder } = fakeBox();
    deliverFakeMail(folder, { subject: 'antiga', date: NOW - 31 * DAY });
    for (let i = 0; i < 120; i++) deliverFakeMail(folder, { subject: `m${i}`, date: NOW - DAY + i });
    const { mails, truncated } = await readRecentInbox(box, NOW);
    expect(truncated).toBe(false);
    expect(mails).toHaveLength(120);
    expect(mails[0]!.subject).toBe('m0');
    expect(mails[119]!.subject).toBe('m119');
  });

  it('stops at the cap and says so', async () => {
    const { box, folder } = fakeBox();
    for (let i = 0; i < 60; i++) deliverFakeMail(folder, { subject: `m${i}`, date: NOW - DAY });
    const { mails, truncated } = await readRecentInbox(box, NOW, { max: 55 });
    expect(mails).toHaveLength(55);
    expect(truncated).toBe(true);
  });

  it('never sends or changes the mailbox while reading', async () => {
    const { box, folder } = fakeBox();
    deliverFakeMail(folder, { subject: 'uma', date: NOW - DAY });
    const calls: string[] = [];
    const spy = new Proxy(box, {
      get: (target, key: string) => {
        const value = target[key as keyof Mailbox];
        return typeof value === 'function' ? (...args: unknown[]) => { calls.push(key); return (value as (...a: unknown[]) => unknown).apply(target, args); } : value;
      },
    });
    await readRecentInbox(spy, NOW);
    expect(calls.every((c) => c === 'fetchInbox')).toBe(true);
  });
});

describe('checkSmokeFolders', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('reads the thread and searches Sent, both read-only, and says ok', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kv-mail-smoke-'));
    const folder = dir;
    const box = createFakeMailbox(dir, { address: 'maria@example.com', password: 'qualquer' });
    const mail = deliverFakeMail(folder, { subject: 'uma', date: NOW - DAY });
    const calls: string[] = [];
    const spy = new Proxy(box, {
      get: (target, key: string) => {
        const value = target[key as keyof Mailbox];
        return typeof value === 'function' ? (...args: unknown[]) => { calls.push(key); return (value as (...a: unknown[]) => unknown).apply(target, args); } : value;
      },
    });
    expect(await checkSmokeFolders(spy, mail.threadKey)).toEqual(['fio: ok', 'Enviados: ok']);
    expect(calls.sort()).toEqual(['fetchThread', 'sentExists']);
  });

  it('says which call failed, with the sentence of the error', async () => {
    const broken = {
      fetchThread: async () => { throw new MailFolderError(FOLDERS_HIDDEN_TEXT); },
      sentExists: async () => { throw new Error('linha 1\nlinha 2'); },
    } as unknown as Mailbox;
    expect(await checkSmokeFolders(broken, 't')).toEqual([`fio: falhou: ${FOLDERS_HIDDEN_TEXT}`, 'Enviados: falhou: linha 1']);
  });
});

describe('summarizeSmoke and formatSmokeSummary', () => {
  const ctx = {
    ownAddress: 'maria@example.com',
    knownThreads: new Set(['known@example.com']),
    companies: [{ company: 'Acme', title: 'Desenvolvedora React' }],
  };
  const mails = [
    rawMail({ uid: 1, messageId: 'a@x', threadKey: 'a@x', from: { address: 'joana@acme.com', name: 'Joana Lima' }, subject: 'Sua candidatura na Acme', text: 'Olá' }),
    rawMail({ uid: 2, messageId: 'b@x', threadKey: 'b@x', from: { address: 'no-reply@greenhouse.io', name: '' }, subject: 'Application received' }),
    rawMail({ uid: 3, messageId: 'c@x', threadKey: 'known@example.com', from: { address: 'pessoa@globex.com', name: 'Pessoa' }, subject: 'Re: conversa' }),
    rawMail({ uid: 4, messageId: 'd@x', threadKey: 'd@x', from: { address: 'fatura@acme.com', name: 'Acme' }, subject: 'Sua fatura', text: 'Valor', bulk: true }),
    rawMail({ uid: 5, messageId: 'e@x', threadKey: 'e@x', from: { address: 'news@loja.com', name: 'Loja' }, subject: 'Promoção', text: 'Compre' }),
    rawMail({ uid: 6, messageId: 'f@x', threadKey: 'f@x', from: { address: 'maria@example.com', name: 'Maria' }, subject: 'Nota para mim' }),
  ];

  it('counts what passes (by rule), what is ignored and what is outside the filter', () => {
    const s = summarizeSmoke(mails, ctx);
    expect(s.total).toBe(6);
    expect(s.passed.map((p) => [p.mail.uid, p.why])).toEqual([[1, 'company'], [2, 'ats'], [3, 'thread']]);
    expect(s.ignored).toBe(1);
    expect(s.outside).toBe(2);
  });

  it('prints only counts and, per passing mail, sender, subject and rule; never the text', () => {
    const lines = formatSmokeSummary(summarizeSmoke(mails, ctx));
    expect(lines.slice(0, 4)).toEqual([
      'Caixa de entrada, últimos 30 dias: 6 mensagem(ns).',
      'Passam no filtro: 3 (fio já guardado: 1; endereço de plataforma de recrutamento: 1; empresa do quadro com sinal de vaga: 1).',
      'Ignoradas (citam uma empresa do quadro, sem sinal de vaga): 1.',
      'Fora do filtro: 2.',
    ]);
    expect(lines).toContain('- Joana Lima <joana@acme.com> | Sua candidatura na Acme | regra: empresa do quadro com sinal de vaga');
    expect(lines).toContain('- no-reply@greenhouse.io | Application received | regra: endereço de plataforma de recrutamento');
    const all = lines.join('\n');
    expect(all).not.toContain('Sua fatura');
    expect(all).not.toContain('Promoção');
    expect(all).not.toContain('Olá');
  });

  it('says when the reading stopped at the cap, and prints no list when nothing passes', () => {
    const lines = formatSmokeSummary(summarizeSmoke([mails[4]!], ctx, true));
    expect(lines[0]).toBe('Caixa de entrada, últimos 30 dias: 1 mensagem(ns) (parou no teto de 1; há mais).');
    expect(lines).toHaveLength(4);
  });
});
