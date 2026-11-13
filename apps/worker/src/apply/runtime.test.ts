import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, enqueueApplyCommand, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import type { SettingsService } from '@kv/settings';
import { createApplyRuntime } from './runtime';

let db: Db;
const settings = { applyConfig: async () => ({ enabled: true }) } as unknown as SettingsService;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

describe('createApplyRuntime', () => {
  it('does nothing, not even commands, without a local HOST', async () => {
    await enqueueApplyCommand(db, 'close_browser', null);
    const runtime = createApplyRuntime(db, settings, { env: { HOST: '0.0.0.0', FAKE_APPLY_SITE: '1', APPLY_DATA_DIR: 'x' } });
    expect(await runtime.tick()).toEqual({ commands: 0, swept: 0, started: false });
  });

  it('does nothing when the chosen browser is not found', async () => {
    await enqueueApplyCommand(db, 'close_browser', null);
    const runtime = createApplyRuntime(db, settings, { env: { APPLY_BROWSER: 'C:\\nao\\existe\\navegador.exe', APPLY_DATA_DIR: 'x' } });
    expect(await runtime.tick()).toEqual({ commands: 0, swept: 0, started: false });
  });

  it('runs commands with the test site and a local HOST', async () => {
    await enqueueApplyCommand(db, 'close_browser', null);
    const runtime = createApplyRuntime(db, { applyConfig: async () => ({ enabled: false }) } as unknown as SettingsService, {
      env: { HOST: '127.0.0.1', FAKE_APPLY_SITE: '1', APPLY_DATA_DIR: 'x' },
    });
    expect(await runtime.tick()).toEqual({ commands: 1, swept: 0, started: false });
    await runtime.close();
  });
});
