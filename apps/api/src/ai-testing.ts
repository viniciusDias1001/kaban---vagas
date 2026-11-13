import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobs, type Db } from '@kv/db';
import { FAKE_TELEGRAM_CHAT_ID, createFakeMailbox, createFakeNotifier, fakeMailDir } from '@kv/mail';
import { extractResumeText } from '@kv/resume';
import type { AiContextOptions } from './ai-context';

/** Apoio dos testes das rotas de IA (não é importado por código de produção). */

/** Ambiente com o provedor falso ligado. */
export const FAKE_ENV = { AI_PROVIDER: 'fake' };
/** Ambiente sem nenhuma configuração de IA. */
export const NO_AI_ENV = {};
/** APP_SECRET de teste (um valor qualquer com 32 caracteres ou mais). */
export const TEST_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres-0001';

/**
 * Contexto de teste: provedor falso (pelo ambiente), extração na própria thread, relógio fixo. Com o relógio
 * fixo o cache do serviço de configurações nunca vence sozinho: só as gravações feitas pelo serviço o renovam. A caixa de
 * e-mail e o aviso no celular são os falsos, em arquivos dentro da pasta de dados de teste: nenhum teste abre conexão de rede.
 */
export const testAi = (over: AiContextOptions = {}): AiContextOptions => {
  // Nunca a pasta de dados de verdade do dono: "Apagar todos os dados de IA" remove pastas dentro dela.
  const dataDir = over.dataDir ?? TEST_DATA_DIR;
  return {
    env: FAKE_ENV,
    extractResume: extractResumeText,
    now: () => Date.UTC(2026, 10, 11, 15, 0, 0),
    dataDir,
    mailbox: (creds) => createFakeMailbox(fakeMailDir(dataDir), creds),
    phoneNotifier: () => createFakeNotifier(fakeMailDir(dataDir)),
    findPhoneChat: async () => FAKE_TELEGRAM_CHAT_ID,
    ...over,
  };
};

/** Pasta de dados padrão dos testes da API (na pasta temporária do sistema). */
export const TEST_DATA_DIR = join(tmpdir(), 'kv-api-test-data');

export async function seedJob(db: Db, over: Partial<typeof jobs.$inferInsert> = {}) {
  const [row] = await db
    .insert(jobs)
    .values({
      source: 'gupy', externalId: '1', url: `https://example.com/${Math.random()}`, title: 'Dev React',
      company: 'Acme Fictícia', location: 'SP', country: 'BR', remote: false, stacks: ['react'], description: 'd',
      postedAt: null, discoveredAt: 1, dedupHash: String(Math.random()), profileId: null, column: 'descobertas',
      position: 0, ...over,
    })
    .returning();
  return row;
}

/** Corpo multipart com um arquivo no campo `file`, para `app.inject`. */
export function upload(content: Buffer, fileName = 'cv.pdf', clientType = 'application/octet-stream') {
  const boundary = 'kvTestBoundary';
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${clientType}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}
