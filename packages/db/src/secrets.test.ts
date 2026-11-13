import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, deleteSecretRow, saveSecretRow, secretRow, type Db } from './index';
import { createTestDb, resetTestDb } from './testing';

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

describe('secret rows', () => {
  it('saves, replaces, reads and deletes a sealed secret by name', async () => {
    expect(await secretRow(db, 'mail_password')).toBeNull();
    await saveSecretRow(db, 'mail_password', Buffer.from([1, 2, 3]), 1000);
    const first = await secretRow(db, 'mail_password');
    expect(Buffer.from(first!.sealed)).toEqual(Buffer.from([1, 2, 3]));
    expect(first!.updatedAt).toBe(1000);
    await saveSecretRow(db, 'mail_password', Buffer.from([9, 8]), 2000);
    const second = await secretRow(db, 'mail_password');
    expect(Buffer.from(second!.sealed)).toEqual(Buffer.from([9, 8]));
    expect(second!.updatedAt).toBe(2000);
    expect(await secretRow(db, 'telegram_bot_token')).toBeNull();
    await deleteSecretRow(db, 'mail_password');
    expect(await secretRow(db, 'mail_password')).toBeNull();
  });

  it('keeps each name in its own row', async () => {
    await saveSecretRow(db, 'mail_password', Buffer.from([1]));
    await saveSecretRow(db, 'telegram_bot_token', Buffer.from([2]));
    await deleteSecretRow(db, 'mail_password');
    expect(Buffer.from((await secretRow(db, 'telegram_bot_token'))!.sealed)).toEqual(Buffer.from([2]));
  });
});
