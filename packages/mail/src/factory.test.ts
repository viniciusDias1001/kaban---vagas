import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliverFakeMail } from './fake';
import { fakeMailDir, mailboxFor } from './factory';

const creds = { address: 'maria@example.com', password: 'senha-de-app' };
let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'kv-factory-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

describe('mailboxFor', () => {
  it('keeps the fake mailbox under the data folder', () => {
    expect(fakeMailDir(dataDir)).toBe(join(dataDir, 'fake-mail'));
  });

  it('uses the fake mailbox only with FAKE_MAIL=1', async () => {
    deliverFakeMail(fakeMailDir(dataDir), { subject: 'convite' });
    const fake = mailboxFor({ FAKE_MAIL: '1' }, dataDir, creds);
    expect((await fake.fetchInbox({ uidValidity: null, afterUid: null, since: 0, limit: 50 })).mails.map((m) => m.subject)).toEqual(['convite']);

    // Sem FAKE_MAIL=1 vem o Gmail; nenhum método de rede é chamado aqui.
    expect(fake.constructor.name).not.toBe('GmailMailbox');
    for (const env of [{}, { FAKE_MAIL: '0' }, { FAKE_MAIL: 'true' }]) {
      const real = mailboxFor(env, dataDir, creds);
      expect(real.constructor.name).toBe('GmailMailbox');
      // Fechar uma caixa que nunca abriu conexão não fala com ninguém e não lança.
      await expect(real.close()).resolves.toBeUndefined();
    }
  });
});
