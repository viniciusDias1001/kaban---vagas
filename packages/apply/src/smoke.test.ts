import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import type { PendingQuestion, Question, ResolvedAnswer } from '@kv/shared';
import { assertOutsideRepo, parseSmokeArgs, runSmoke, smokeAiMode, smokeJobFor, smokeShotPath, smokeSiteFor, type SmokeDeps } from './smoke';
import { greenhouseSite } from './sites/greenhouse';
import { SiteLayoutError, type ApplyJob, type ApplySite, type HumanGate, type StepRead } from './types';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const ok = ['--site', 'lever', '--job', 'https://jobs.lever.co/acme/6ed76ce8-4156-4b60-b120-403538bd66cd'];

const question = (id: string, label: string, required = true): Question => ({ id, label, help: '', kind: 'text', options: [], required, maxLength: null });
const name = question('name', 'Full name');
const visa = question('visa', 'Do you need a visa?');
const job: ApplyJob = { id: 0, source: 'lever', url: ok[3]!, externalId: '', company: 'Acme', title: 'Engineer' };

function stubSite(steps: StepRead[], opts: { gate?: HumanGate } = {}): ApplySite {
  const reads = [...steps];
  return {
    id: 'lever', needsLogin: false,
    match: vi.fn(() => ({ site: 'lever' as const, url: job.url, ref: {} })),
    sessionState: vi.fn(async () => 'logged_out' as const),
    open: vi.fn(async () => ({ kind: 'form' as const })),
    readStep: vi.fn(async () => reads.shift()!),
    fillStep: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    submit: vi.fn(async () => ({ confirmation: 'x' })),
    humanGate: vi.fn(async () => opts.gate ?? null),
    discard: vi.fn(async () => {}),
  };
}

const answerFor = (q: Question, value: ResolvedAnswer['value'], source: ResolvedAnswer['source']): ResolvedAnswer =>
  ({ questionId: q.id, value, source, category: 'identity', basis: [], bankAnswerId: null });

function setup() {
  const lines: string[] = [];
  const page = { screenshot: vi.fn(async () => Buffer.from('')) };
  const deps: SmokeDeps = {
    site: stubSite([]), job, page: page as unknown as Page,
    resolve: vi.fn(async (qs: Question[]) => ({
      answers: qs.filter((q) => q.id === 'name').map((q) => answerFor(q, 'Ana Souza', 'rule')),
      pending: qs.filter((q) => q.id !== 'name' && q.required).map((q): PendingQuestion => ({ question: q, category: 'personal', kind: 'unanswered', proposal: null })),
    })),
    resumePath: 'cv.pdf', shotPath: 'out.png', print: (l) => lines.push(l),
  };
  return { deps, lines, page };
}

describe('parseSmokeArgs', () => {
  it('parses the two required flags and the optional résumé', () => {
    expect(parseSmokeArgs(['--', ...ok], {})).toEqual({ site: 'lever', url: ok[3], resumePath: null });
    expect(parseSmokeArgs([...ok, '--resume', 'C:/cv.pdf'], {})).toMatchObject({ resumePath: 'C:/cv.pdf' });
  });
  it('refuses to run under CI', () => {
    expect(parseSmokeArgs(ok, { CI: 'true' })).toEqual({ error: expect.stringContaining('CI') });
  });
  it.each(['--submit', '--send', '--real', '--enviar', '--yes', '--mode=real'])('has no flag that submits: %s is an error', (flag) => {
    expect(parseSmokeArgs([...ok, flag], {})).toHaveProperty('error');
  });
  it('rejects an unknown site and a missing job', () => {
    expect(parseSmokeArgs(['--site', 'gupy', '--job', 'https://x.y'], {})).toHaveProperty('error');
    expect(parseSmokeArgs(['--site', 'lever'], {})).toHaveProperty('error');
  });
});

describe('paths', () => {
  it('names the screenshot by site and time, and refuses a path inside the repository', () => {
    expect(smokeShotPath('C:/dados', 'lever', new Date(2026, 10, 12, 10, 30, 5))).toBe(join('C:/dados', 'smoke', 'lever-20261112-103005.png'));
    expect(() => assertOutsideRepo(join(repoRoot, 'tmp', 'a.png'), repoRoot)).toThrow(/fora do repositório/);
    expect(() => assertOutsideRepo(join(repoRoot, '..', 'fora', 'a.png'), repoRoot)).not.toThrow();
  });
  it('does not call a directory named "..x" inside the repository outside of it, and refuses a sibling of the root as outside', () => {
    expect(() => assertOutsideRepo(join(repoRoot, '..x', 'a.png'), repoRoot)).toThrow(/fora do repositório/);
    expect(() => assertOutsideRepo(repoRoot.replace(/[\\/]+$/, '') + sep + '..', repoRoot)).not.toThrow();
  });
});

describe('smokeSiteFor', () => {
  it('finds the scripts that exist and nothing for linkedin yet', () => {
    expect(smokeSiteFor('lever')?.id).toBe('lever');
    expect(smokeSiteFor('greenhouse')?.id).toBe('greenhouse');
    expect(smokeSiteFor('linkedin')).toBeNull();
  });
});

describe('smokeJobFor', () => {
  it('takes the job id from gh_jid for a Greenhouse URL on a company domain, so the site script can match it', () => {
    const job = smokeJobFor('greenhouse', 'https://careers.acme.com/open?gh_jid=4567890');
    expect(job).toMatchObject({ source: 'greenhouse', externalId: 'acme-4567890', company: '' });
    expect(greenhouseSite.match(job)).toMatchObject({ ref: { board: 'acme', jobId: '4567890' } });
  });
  it('does not take a public-suffix part as the board: careers.acme.co.uk and acme.com.br guess "acme"', () => {
    expect(smokeJobFor('greenhouse', 'https://careers.acme.co.uk/x?gh_jid=11').externalId).toBe('acme-11');
    expect(smokeJobFor('greenhouse', 'https://www.acme.com.br/x?gh_jid=12').externalId).toBe('acme-12');
    expect(smokeJobFor('greenhouse', 'https://jobs.acme.org/x?gh_jid=13').externalId).toBe('acme-13');
  });
  it('leaves the id empty for a Greenhouse-hosted or Lever URL', () => {
    expect(smokeJobFor('greenhouse', 'https://job-boards.greenhouse.io/acme/jobs/123?gh_jid=123').externalId).toBe('');
    expect(smokeJobFor('lever', ok[3]!).externalId).toBe('');
  });
});

describe('smokeAiMode', () => {
  it('runs in review mode only with a provider and room in the budget, and says why otherwise in the line', () => {
    expect(smokeAiMode({ configured: true, withinBudget: true }).mode).toBe('review');
    expect(smokeAiMode({ configured: false, withinBudget: true })).toMatchObject({ mode: 'off', line: expect.stringContaining('não configurada') });
    expect(smokeAiMode({ configured: true, withinBudget: false })).toMatchObject({ mode: 'off', line: expect.stringContaining('limite diário') });
  });
});

describe('runSmoke', () => {
  it('fills every step, prints questions and answers, shoots, discards and never submits', async () => {
    const { deps, lines } = setup();
    const site = stubSite([{ questions: [name], isLast: false }, { questions: [visa], isLast: true }]);
    expect(await runSmoke({ ...deps, site })).toMatchObject({ outcome: 'pending', steps: 2, shotPath: 'out.png' });
    expect([site.fillStep, site.next, site.discard, site.submit].map((f) => vi.mocked(f).mock.calls.length)).toEqual([2, 1, 1, 0]);
    for (const shown of [name.label, 'Ana Souza', 'SEM RESPOSTA']) expect(lines.join('\n')).toContain(shown);
  });

  it('prints a model proposal as a proposal, never fills it, and reports pending', async () => {
    const { deps, lines } = setup();
    const site = stubSite([{ questions: [visa], isLast: true }]);
    const resolve = vi.fn(async () => ({
      answers: [] as ResolvedAnswer[],
      pending: [{
        question: visa, category: 'profile_fact', kind: 'confirm_proposal',
        proposal: { bankAnswerId: null, bankQuestion: null, bankAnswer: null, value: 'No', source: 'profile', basis: [] },
      } satisfies PendingQuestion],
    }));
    expect(await runSmoke({ ...deps, site, resolve })).toMatchObject({ outcome: 'pending' });
    expect(lines.join('\n')).toContain('PROPOSTA (aguarda a sua aprovação): No');
    expect(lines.join('\n')).not.toContain('SEM RESPOSTA');
    expect(vi.mocked(site.fillStep).mock.calls[0]![1]).toEqual([]);
  });

  it('reports filled when every required question has an answer', async () => {
    const { deps } = setup();
    const site = stubSite([{ questions: [name], isLast: true }]);
    expect(await runSmoke({ ...deps, site })).toMatchObject({ outcome: 'filled', steps: 1 });
  });

  it('stops at a human gate without reading or filling', async () => {
    const { deps, page } = setup();
    const site = stubSite([{ questions: [name], isLast: true }], { gate: 'captcha' });
    expect(await runSmoke({ ...deps, site })).toMatchObject({ outcome: 'gate', detail: 'captcha' });
    expect([site.readStep, site.discard].map((f) => vi.mocked(f).mock.calls.length)).toEqual([0, 1]);
    expect(page.screenshot).toHaveBeenCalledTimes(1);
  });

  it('prints why a job is unavailable and ends', async () => {
    const { deps, lines } = setup();
    const site = stubSite([]);
    vi.mocked(site.open).mockResolvedValue({ kind: 'unavailable', reason: 'closed' });
    expect(await runSmoke({ ...deps, site })).toMatchObject({ outcome: 'unavailable', detail: 'closed', shotPath: null });
    expect(lines.join('\n')).toContain('closed');
    expect(site.discard).toHaveBeenCalledTimes(1);
  });

  it('discards even when a step throws', async () => {
    const { deps } = setup();
    const site = stubSite([{ questions: [name], isLast: true }]);
    vi.mocked(site.fillStep).mockRejectedValue(new SiteLayoutError('x'));
    await expect(runSmoke({ ...deps, site })).rejects.toBeInstanceOf(SiteLayoutError);
    expect(site.discard).toHaveBeenCalledTimes(1);
  });

  it('stops at step 12 without calling next, so the photo shows the filled step 12', async () => {
    const { deps, lines, page } = setup();
    const site = stubSite([]);
    vi.mocked(site.readStep).mockResolvedValue({ questions: [name], isLast: false });
    expect(await runSmoke({ ...deps, site })).toMatchObject({ steps: 12, shotPath: 'out.png' });
    expect([site.fillStep, site.next].map((f) => vi.mocked(f).mock.calls.length)).toEqual([12, 11]);
    expect(vi.mocked(page.screenshot).mock.invocationCallOrder[0]!).toBeGreaterThan(vi.mocked(site.fillStep).mock.invocationCallOrder[11]!);
    expect(lines.join('\n')).toContain('Parei na etapa 12');
  });

  it('reports pending and fills nothing when the resolver returns nothing for a required question', async () => {
    const { deps } = setup();
    const site = stubSite([{ questions: [visa], isLast: true }]);
    const resolve = vi.fn(async () => ({ answers: [] as ResolvedAnswer[], pending: [] as PendingQuestion[] }));
    expect(await runSmoke({ ...deps, site, resolve })).toMatchObject({ outcome: 'pending' });
    expect(vi.mocked(site.fillStep).mock.calls[0]![1]).toEqual([]);
  });

  it('answers "unavailable" and opens nothing when the site does not match the job (match returns null)', async () => {
    const { deps } = setup();
    const site = stubSite([]);
    vi.mocked(site.match).mockReturnValue(null);
    expect(await runSmoke({ ...deps, site })).toMatchObject({ outcome: 'unavailable', steps: 0, shotPath: null });
    expect([site.open, site.discard].map((f) => vi.mocked(f).mock.calls.length)).toEqual([0, 0]);
  });

  it('discards even when open throws', async () => {
    const { deps } = setup();
    const site = stubSite([]);
    vi.mocked(site.open).mockRejectedValue(new Error('net'));
    await expect(runSmoke({ ...deps, site })).rejects.toThrow('net');
    expect(site.discard).toHaveBeenCalledTimes(1);
  });

  it('has no code path that submits: the bare word is absent from the code lines of both files', () => {
    for (const file of ['packages/apply/src/smoke.ts', 'scripts/apply-smoke.ts']) {
      const code = readFileSync(join(repoRoot, file), 'utf8').split('\n')
        .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
        .map((l) => l.replace(/\s\/\/.*$/, ''));
      expect(code.filter((l) => /\bsubmit\b/i.test(l)), file).toEqual([]);
    }
  });
});
