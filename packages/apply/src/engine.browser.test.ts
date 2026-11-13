import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnswerValue, ResolvedAnswer } from '@kv/shared';
import type { ApplyJob, ApplySite } from './types';
import { openFixture } from './testing';
import { siteFor } from './sites/index';
import { FAKE_SITE_ORIGIN, createFakeSite, fakeFixturePath } from './sites/fake';
import { runApplication, type EngineDeps, type EngineUpdate } from './engine';

const VARIANTS = ['form', 'two-steps', 'captcha', 'rejected', 'broken'];
const site: ApplySite = createFakeSite();
let page: Page;
let close: () => Promise<void>;
let resumePath: string;

const fakeJob = (variant = 'form'): ApplyJob => ({
  id: 1, source: 'fake', url: `${FAKE_SITE_ORIGIN}/jobs/1?variant=${variant}`, externalId: '1', company: 'Acme', title: 'Dev',
});

beforeAll(async () => {
  resumePath = join(tmpdir(), 'kv-apply-engine-resume.pdf');
  writeFileSync(resumePath, '%PDF-1.4 fictitious');
  const routes: Record<string, string> = {};
  for (const v of VARIANTS) routes[`${FAKE_SITE_ORIGIN}/jobs/1?variant=${v}`] = fakeFixturePath(v);
  ({ page, close } = await openFixture(routes));
});
afterAll(async () => { await close?.(); });

const VALUES: Record<string, AnswerValue> = {
  name: 'Maria Teste', email: 'maria@example.com', phone: null, resume: null, salary: '8000', years_ts: '5',
  why: 'Gosto do produto.', privacy: true,
};

let updates: EngineUpdate[];
function realDeps(over: Partial<EngineDeps> = {}): EngineDeps {
  updates = [];
  return {
    site, page, mode: 'real', resumePath, approved: [],
    resolve: async (questions) => {
      const answers = questions.map((q): ResolvedAnswer => ({
        questionId: q.id, value: VALUES[q.id] ?? null, source: 'rule', category: 'identity', basis: [], bankAnswerId: null,
      }));
      return { answers, pending: [], usedBankIds: [] };
    },
    report: async (u) => { updates.push(u); return true; },
    shot: async (kind) => `shots/${kind}.png`,
    waitHuman: async () => 'solved',
    ...over,
  };
}

describe('runApplication on the test site', () => {
  it('applies to the test site end to end', async () => {
    const res = await runApplication(siteFor(fakeJob(), [site])!.target, realDeps({ mode: 'real' }));
    expect(res).toMatchObject({ status: 'submitted', confirmation: expect.stringMatching(/Candidatura recebida/) });
    expect(updates.map((u) => u.status)).toEqual(['filling', 'submitting']);
    expect(await page.locator('#confirmation').count()).toBe(1);
  });

  it('walks the two-step form', async () => {
    const res = await runApplication(siteFor(fakeJob('two-steps'), [site])!.target, realDeps());
    expect(res).toMatchObject({ status: 'submitted', confirmation: expect.stringMatching(/Candidatura recebida/) });
    expect(res.status === 'submitted' && res.answers.map((a) => a.questionId)).toEqual(Object.keys(VALUES));
  });

  it('rehearses without sending and leaves no form behind', async () => {
    const res = await runApplication(siteFor(fakeJob(), [site])!.target, realDeps({ mode: 'dry_run' }));
    expect(res.status).toBe('dry_run_ready');
    expect(page.url()).toBe('about:blank');
  });

  it('gives the captcha back to the owner when nobody solves it', async () => {
    const res = await runApplication(siteFor(fakeJob('captcha'), [site])!.target, realDeps({ waitHuman: async () => 'timeout' }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'captcha' });
    expect(updates.map((u) => u.status)).toEqual(['filling', 'waiting_human']);
    expect(page.url()).toBe('about:blank');
  });

  it('hands a refused submit back to the owner', async () => {
    const res = await runApplication(siteFor(fakeJob('rejected'), [site])!.target, realDeps());
    expect(res).toMatchObject({ status: 'needs_human', reason: 'captcha' });
  });

  it('turns an unknown page into unsupported_form with a photo', async () => {
    const shots: string[] = [];
    const res = await runApplication(siteFor(fakeJob('broken'), [site])!.target, realDeps({
      shot: async (kind) => { shots.push(kind); return `shots/${kind}.png`; },
    }));
    expect(res).toMatchObject({ status: 'needs_human', reason: 'unsupported_form' });
    expect(shots).toEqual(['blocked']);
  });
});
