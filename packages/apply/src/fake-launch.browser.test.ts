import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeLaunch } from './browser';
import { FAKE_SITE_ORIGIN } from './sites/fake';

let dir: string;
let context: BrowserContext;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kv-fake-launch-'));
  context = await fakeLaunch()(dir);
});
afterAll(async () => {
  await context?.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('fakeLaunch', () => {
  it('serves the default form and other variants from FAKE_SITE_ORIGIN', async () => {
    const page = await context.newPage();
    await page.goto(`${FAKE_SITE_ORIGIN}/jobs/1`);
    expect(await page.locator('form[data-fake-form]').count()).toBe(1);
    await page.goto(`${FAKE_SITE_ORIGIN}/jobs/1?variant=closed`);
    expect(await page.locator('#closed').count()).toBe(1);
    expect(await page.locator('form').count()).toBe(0);
  });
  it('answers 404 for an unknown variant', async () => {
    const page = await context.newPage();
    const res = await page.goto(`${FAKE_SITE_ORIGIN}/jobs/1?variant=nope`);
    expect(res?.status()).toBe(404);
  });
  it('aborts requests to any other origin', async () => {
    const page = await context.newPage();
    await expect(page.goto('http://example.com/')).rejects.toThrow();
    await expect(page.goto('http://apply.fake.test.evil.test/jobs/1')).rejects.toThrow();
  });
});
