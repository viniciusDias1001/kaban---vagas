import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { applyCommands, closeDb, enqueueApplyCommand, nextApplyCommand, siteState, type Db } from '@kv/db';
import { createTestDb, resetTestDb } from '@kv/db/testing';
import { runApplyCommand } from './commands';
import { NOON, createFakeBrowser, createRecordingSite } from './test-helpers';

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(() => resetTestDb(db));
afterAll(() => closeDb(db));

async function run(kind: 'open_login' | 'check_session' | 'logout' | 'close_browser', site = createRecordingSite(), browser = createFakeBrowser()) {
  await enqueueApplyCommand(db, kind, kind === 'close_browser' ? null : 'fake', NOON);
  const command = (await nextApplyCommand(db))!;
  await runApplyCommand({ db, sites: () => [site], browser, now: () => NOON }, command);
  const [row] = await db.select().from(applyCommands).where(eq(applyCommands.id, command.id));
  return { row, site, browser };
}

describe('runApplyCommand', () => {
  it('stores the session state it finds', async () => {
    const { row } = await run('check_session');
    expect(row).toMatchObject({ status: 'ok', finishedAt: NOON });
    expect(await siteState(db, 'fake')).toMatchObject({ session: 'logged_in', sessionCheckedAt: NOON });
  });

  it('refuses open_login for a site without login', async () => {
    const { row, browser } = await run('open_login');
    expect(row).toMatchObject({ status: 'error' });
    expect(row.result).toMatch(/login/);
    expect(browser.open).toBe(false);
  });

  it('opens the login page and brings the window to the front', async () => {
    const site = createRecordingSite({ needsLogin: true });
    const visited: string[] = [];
    const browser = createFakeBrowser();
    const page = await browser.page();
    Object.assign(page, { goto: async (url: string) => void visited.push(url) });
    const { row } = await run('open_login', site, browser);
    expect(row).toMatchObject({ status: 'ok' });
    expect(visited).toEqual(['https://www.fake.test/entrar']);
    expect(browser.calls).toContain('front');
  });

  it('clears the cookies of the site on logout and marks it logged out', async () => {
    const site = createRecordingSite({ needsLogin: true });
    const browser = createFakeBrowser();
    const page = await browser.page();
    const cleared: unknown[] = [];
    Object.assign(page, { context: () => ({ clearCookies: async (filter: unknown) => void cleared.push(filter) }) });
    const { row } = await run('logout', site, browser);
    expect(row).toMatchObject({ status: 'ok' });
    expect(cleared).toEqual([{ domain: /(^|\.)fake\.test$/ }]);
    expect(await siteState(db, 'fake')).toMatchObject({ session: 'logged_out', sessionCheckedAt: NOON });
  });

  it('closes the browser', async () => {
    const { row, browser } = await run('close_browser');
    expect(row).toMatchObject({ status: 'ok' });
    expect(browser.calls).toContain('close');
  });

  it('ends in error for a site that is not registered', async () => {
    await enqueueApplyCommand(db, 'check_session', 'linkedin', NOON);
    const command = (await nextApplyCommand(db))!;
    await runApplyCommand({ db, sites: () => [createRecordingSite()], browser: createFakeBrowser(), now: () => NOON }, command);
    const [row] = await db.select().from(applyCommands).where(eq(applyCommands.id, command.id));
    expect(row).toMatchObject({ status: 'error' });
  });
});
