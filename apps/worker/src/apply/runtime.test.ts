import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommands, applyWorkerState, closeDb, enqueueApplyCommand, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import type { SettingsService } from '@kv/settings';
import { browserProfileDir, browserUnavailableReason, fakeBrowserProfileDir } from '@kv/apply';
import { createApplyRuntime } from './runtime';

const sessions = vi.hoisted(() => ({ dirs: [] as string[] }));
vi.mock('@kv/apply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kv/apply')>();
  return {
    ...actual,
    createBrowserSession: (options: Parameters<typeof actual.createBrowserSession>[0]) => {
      sessions.dirs.push(options.userDataDir);
      return actual.createBrowserSession(options);
    },
  };
});

let db: Db;
const settings = { applyConfig: async () => ({ enabled: true }) } as unknown as SettingsService;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  sessions.dirs.length = 0;
  await resetTestDb(db);
});
afterAll(() => closeDb(db));

describe('createApplyRuntime', () => {
  it('runs nothing without a local HOST: each command ends with the reason, which the worker publishes', async () => {
    await enqueueApplyCommand(db, 'close_browser', null);
    const runtime = createApplyRuntime(db, settings, { env: { HOST: '0.0.0.0', FAKE_APPLY_SITE: '1', APPLY_DATA_DIR: 'x' } });
    expect(await runtime.tick()).toEqual({ commands: 1, swept: 0, started: false });
    const [command] = await db.select().from(applyCommands);
    expect(command).toMatchObject({ status: 'error', result: expect.stringContaining('endereço local') });
    expect(await applyWorkerState(db)).toMatchObject({ available: false, reason: command.result });
  });

  it('runs nothing when the chosen browser is not found, and says so', async () => {
    await enqueueApplyCommand(db, 'close_browser', null);
    const runtime = createApplyRuntime(db, settings, { env: { APPLY_BROWSER: 'C:\\nao\\existe\\navegador.exe', APPLY_DATA_DIR: 'x' } });
    expect(await runtime.tick()).toEqual({ commands: 1, swept: 0, started: false });
    expect(await applyWorkerState(db)).toMatchObject({ available: false, reason: expect.stringContaining('navegador') });
  });

  it('runs commands with the test site and a local HOST', async () => {
    await enqueueApplyCommand(db, 'close_browser', null);
    const runtime = createApplyRuntime(db, { applyConfig: async () => ({ enabled: false }) } as unknown as SettingsService, {
      env: { HOST: '127.0.0.1', FAKE_APPLY_SITE: '1', APPLY_DATA_DIR: 'x' },
    });
    expect(await runtime.tick()).toEqual({ commands: 1, swept: 0, started: false });
    await runtime.close();
  });

  it('opens the test browser on its own profile folder, never on the real one', async () => {
    const env = { HOST: '127.0.0.1', FAKE_APPLY_SITE: '1', APPLY_DATA_DIR: 'x' };
    const runtime = createApplyRuntime(db, settings, { env });
    await runtime.close();
    expect(sessions.dirs).toEqual([fakeBrowserProfileDir('x')]);
    expect(sessions.dirs).not.toContain(browserProfileDir('x'));
  });

  it('opens the real browser on the real profile folder', async () => {
    const runtime = createApplyRuntime(db, settings, { env: { HOST: '127.0.0.1', APPLY_BROWSER: 'chrome', APPLY_DATA_DIR: 'x' } });
    await runtime.close();
    expect(sessions.dirs).toEqual([browserProfileDir('x')]);
  });

  it('publishes the reason of the browser check when the chosen browser is missing, and is available otherwise', async () => {
    const missing = { HOST: '127.0.0.1', APPLY_BROWSER: 'C:\\nao\\existe\\navegador.exe', APPLY_DATA_DIR: 'x' };
    const reason = browserUnavailableReason(missing);
    expect(reason).toEqual(expect.any(String));
    await enqueueApplyCommand(db, 'close_browser', null);
    await createApplyRuntime(db, settings, { env: missing }).tick();
    expect(await applyWorkerState(db)).toMatchObject({ available: false, reason });

    await resetTestDb(db);
    await enqueueApplyCommand(db, 'close_browser', null);
    const ok = { HOST: '127.0.0.1', APPLY_BROWSER: 'chrome', APPLY_DATA_DIR: 'x' };
    expect(browserUnavailableReason(ok)).toBeNull();
    const off = { applyConfig: async () => ({ enabled: false }) } as unknown as SettingsService;
    await createApplyRuntime(db, off, { env: ok }).tick();
    expect(await applyWorkerState(db)).toMatchObject({ available: true, reason: null });
  });
});
