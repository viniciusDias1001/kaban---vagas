/**
 * Peças de teste da fila de e-mail: um banco PGlite novo com a caixa conectada, a caixa falsa numa pasta temporária e
 * vagas aplicadas. Nenhuma toca servidor de e-mail. Só os testes importam este arquivo.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeMailbox, deliverFakeMail, type Mailbox, type RawMail } from '@kv/mail';
import { closeDb, jobEvents, jobs, saveMailAccount, type Db } from '@kv/db';
import { createTestDb } from '@kv/db/testing';

/** 12:00 em São Paulo, sexta-feira 13/11/2026: o relógio fixo dos testes da fila de e-mail. */
export const MAIL_NOW = Date.UTC(2026, 10, 13, 15, 0, 0);
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** Endereço da caixa conectada (fictício). */
export const OWNER_ADDRESS = 'maria@example.com';
/** A caixa da bancada foi conectada uma hora antes de `MAIL_NOW`. */
export const CONNECTED_AT = MAIL_NOW - HOUR;

let seq = 0;

/**
 * Banco novo com a caixa conectada em `CONNECTED_AT`, e a caixa falsa numa pasta temporária. `deliver` põe uma
 * mensagem na Caixa de entrada (data padrão `MAIL_NOW`); `seedAppliedJob` cria um card em Aplicada desde `appliedAt`.
 * Feche com `close()`.
 */
export async function mailTestBed(): Promise<{
  db: Db;
  dir: string;
  mailbox: Mailbox;
  deliver: (m: Partial<RawMail>) => RawMail;
  seedAppliedJob: (company: string, title: string, appliedAt: number) => Promise<number>;
  close: () => Promise<void>;
}> {
  const db = await createTestDb();
  const dir = await mkdtemp(join(tmpdir(), 'kv-mail-'));
  await saveMailAccount(db, OWNER_ADDRESS, CONNECTED_AT);
  const mailbox = createFakeMailbox(dir, { address: OWNER_ADDRESS, password: 'senha-de-teste' });

  const deliver = (m: Partial<RawMail>): RawMail => deliverFakeMail(dir, { to: [OWNER_ADDRESS], date: MAIL_NOW, ...m });

  const seedAppliedJob = async (company: string, title: string, appliedAt: number): Promise<number> => {
    seq += 1;
    const url = `https://vagas.example.test/mail-${seq}`;
    const [job] = await db
      .insert(jobs)
      .values({
        source: 'fake', externalId: `mail-${seq}`, url, title, company, location: 'São Paulo, SP', country: 'BR', remote: true,
        stacks: [], description: `Vaga de ${title}.`, postedAt: null, discoveredAt: appliedAt - DAY, dedupHash: url,
        profileId: null, position: seq, column: 'aplicada',
      })
      .returning({ id: jobs.id });
    await db.insert(jobEvents).values({ jobId: job!.id, fromColumn: 'selecionadas', toColumn: 'aplicada', actor: 'humano', createdAt: appliedAt });
    return job!.id;
  };

  const close = async (): Promise<void> => {
    await closeDb(db);
    await rm(dir, { recursive: true, force: true });
  };

  return { db, dir, mailbox, deliver, seedAppliedJob, close };
}
