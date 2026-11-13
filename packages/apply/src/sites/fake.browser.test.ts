import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedAnswer } from '@kv/shared';
import type { ApplyJob, ApplySite } from '../types';
import { SiteLayoutError, SubmitRejectedError } from '../types';
import { openFixture } from '../testing';
import { FAKE_SITE_ORIGIN, createFakeSite, fakeFixturePath } from './fake';

const VARIANTS = ['form', 'two-steps', 'closed', 'already-applied', 'captcha', 'rejected', 'broken'];
const site: ApplySite = createFakeSite();
let page: Page;
let close: () => Promise<void>;
let resume: string;

function target(variant: string) {
  const job: ApplyJob = { id: 1, source: 'fake', url: `${FAKE_SITE_ORIGIN}/jobs/1?variant=${variant}`, externalId: '1', company: 'Acme', title: 'Dev' };
  const t = site.match(job);
  if (!t) throw new Error('fake site must match');
  return t;
}

beforeAll(async () => {
  resume = join(tmpdir(), 'kv-apply-fake-resume.pdf');
  writeFileSync(resume, '%PDF-1.4 fictitious');
  const routes: Record<string, string> = {};
  for (const v of VARIANTS) routes[`${FAKE_SITE_ORIGIN}/jobs/1?variant=${v}`] = fakeFixturePath(v);
  ({ page, close } = await openFixture(routes));
});
afterAll(async () => { await close?.(); });

const a = (questionId: string, value: ResolvedAnswer['value']): ResolvedAnswer =>
  ({ questionId, value, source: 'rule', category: 'identity', basis: [], bankAnswerId: null });
const answers = [
  a('name', 'Maria Teste'), a('email', 'maria@example.com'), a('resume', null), a('salary', '8000'),
  a('years_ts', '5'), a('why', 'Gosto do produto.'), a('privacy', true),
];

describe('fake site', () => {
  it('reads the eight questions of the form in order', async () => {
    expect(await site.open(page, target('form'))).toEqual({ kind: 'form' });
    const step = await site.readStep(page);
    expect(step.isLast).toBe(true);
    expect(step.questions.map((q) => [q.kind, q.required])).toEqual([
      ['text', true], ['text', true], ['text', false], ['file', true], ['text', true], ['number', true], ['longtext', false], ['boolean', true]]);
    expect(step.questions.map((q) => q.label)).toEqual([
      'Nome completo', 'E-mail', 'Telefone', 'Currículo', 'Pretensão salarial mensal (R$)',
      'Anos de experiência com TypeScript', 'Por que você quer trabalhar aqui?', 'Li e aceito a política de privacidade']);
    expect(step.questions[6].maxLength).toBe(600);
  });
  it('fills, submits and reports the confirmation', async () => {
    await site.open(page, target('form'));
    await site.fillStep(page, answers, { resumePath: resume });
    expect(await page.inputValue('[name=name]')).toBe('Maria Teste');
    const { confirmation } = await site.submit(page);
    expect(confirmation).toMatch(/Candidatura recebida/);
  });
  it('walks the two-step variant', async () => {
    await site.open(page, target('two-steps'));
    const first = await site.readStep(page);
    expect(first.isLast).toBe(false);
    expect(first.questions).toHaveLength(4);
    await site.fillStep(page, answers, { resumePath: resume });
    await site.next(page);
    const second = await site.readStep(page);
    expect(second.isLast).toBe(true);
    expect(second.questions).toHaveLength(4);
    await site.fillStep(page, answers, { resumePath: resume });
    expect((await site.submit(page)).confirmation).toMatch(/Candidatura recebida/);
  });
  it('reports closed and already applied without a form', async () => {
    expect(await site.open(page, target('closed'))).toEqual({ kind: 'unavailable', reason: 'closed' });
    expect(await site.open(page, target('already-applied'))).toEqual({ kind: 'unavailable', reason: 'already_applied' });
  });
  it('sees the captcha gate until it is solved', async () => {
    await site.open(page, target('captcha'));
    expect(await site.humanGate(page)).toBe('captcha');
    await page.getByRole('button', { name: 'Não sou um robô' }).click();
    expect(await site.humanGate(page)).toBeNull();
  });
  it('throws SubmitRejectedError when the site refuses without a challenge', async () => {
    await site.open(page, target('rejected'));
    await site.fillStep(page, answers, { resumePath: resume });
    await expect(site.submit(page)).rejects.toBeInstanceOf(SubmitRejectedError);
    expect(await site.humanGate(page)).toBeNull();
  });
  it('throws SiteLayoutError on an unknown page', async () => {
    await site.open(page, target('broken'));
    await expect(site.readStep(page)).rejects.toBeInstanceOf(SiteLayoutError);
  });
  it('discards without sending', async () => {
    await site.open(page, target('form'));
    await site.fillStep(page, answers, { resumePath: resume });
    await site.discard(page);
    expect(page.url()).toBe('about:blank');
    expect(await page.locator('form').count()).toBe(0);
    expect(await page.content()).not.toMatch(/Candidatura recebida/);
  });
  it('blocks the network outside the fixtures', async () => {
    await expect(page.goto('http://example.com/')).rejects.toThrow();
  });
});
