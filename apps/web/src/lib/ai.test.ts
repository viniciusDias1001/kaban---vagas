import { describe, expect, it } from 'vitest';
import { ProfileWireSchema, type AiTaskDto, type JobAiSummaryDto } from '@kv/shared';
import {
  blankItem, cardTitle, formatUsd, isPending, languageBadge, layerMessage, pollMs, resumeFileProblem, scoreTone,
  sortByScore, toScoreMap,
} from './ai';

const summary = (jobId: number, score: number | null, titlePt: string | null = null): JobAiSummaryDto => ({
  jobId, score, titlePt, language: 'en', reason: 'r', stale: false,
});
const task = (over: Partial<AiTaskDto> = {}): AiTaskDto => ({
  id: 1, type: 'tier2', status: 'queued', attempts: 0, error: null, jobId: 1, lang: null, createdAt: 1, finishedAt: null, ...over,
});

describe('sortByScore', () => {
  it('orders by score, highest first, keeping board order for ties and unscored jobs last', () => {
    const jobs = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
    const scores = toScoreMap([summary(2, 90), summary(3, 40), summary(4, 90), summary(5, null)]);
    expect(sortByScore(jobs, scores).map((j) => j.id)).toEqual([2, 4, 3, 1, 5]);
    expect(jobs.map((j) => j.id)).toEqual([1, 2, 3, 4, 5]);
    expect(sortByScore(jobs, toScoreMap([])).map((j) => j.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('card helpers', () => {
  it('shows the translated title and keeps the original for the tooltip, only when they differ', () => {
    expect(cardTitle('Senior React Engineer', summary(1, 80, 'Engenheira React Sênior'))).toEqual({
      title: 'Engenheira React Sênior', original: 'Senior React Engineer',
    });
    expect(cardTitle('Dev React', summary(1, 80, ' dev react '))).toEqual({ title: 'Dev React', original: null });
    expect(cardTitle('Dev React', summary(1, 80, null))).toEqual({ title: 'Dev React', original: null });
    expect(cardTitle('Dev React', undefined)).toEqual({ title: 'Dev React', original: null });
  });

  it('labels the language and the score band', () => {
    expect([languageBadge('pt'), languageBadge('en-US'), languageBadge(null), languageBadge('')]).toEqual(['PT', 'EN', null, null]);
    expect([100, 75, 74, 50, 49, 0].map(scoreTone)).toEqual(['high', 'high', 'mid', 'mid', 'low', 'low']);
  });
});

describe('layer state helpers', () => {
  it('polls only while something is queued or running', () => {
    expect(isPending('queued') && isPending('running')).toBe(true);
    expect(['none', 'ok', 'stale', 'error', 'blocked_budget'].some((s) => isPending(s as never))).toBe(false);
    expect(pollMs('ok', 'running')).toBe(2_000);
    expect(pollMs('ok', undefined, 'blocked_budget')).toBe(false);
    expect(pollMs()).toBe(false);
  });

  it('describes every state, including retries, budget and the error text', () => {
    expect(layerMessage('none', null)).toBe('Ainda não processado.');
    expect(layerMessage('queued', task())).toBe('Na fila.');
    expect(layerMessage('queued', task({ attempts: 1 }))).toBe('Nova tentativa agendada (tentativa 2 de 3).');
    expect(layerMessage('running', task())).toBe('Processando...');
    expect(layerMessage('stale', null)).toMatch(/versão anterior do seu perfil/);
    expect(layerMessage('blocked_budget', task())).toMatch(/limite de gasto/);
    expect(layerMessage('error', task({ error: 'limite de taxa' }))).toBe('Falhou: limite de taxa');
    expect(layerMessage('error', null)).toBe('Falhou.');
    expect(layerMessage('ok', null)).toBe('Pronto.');
  });
});

describe('formatUsd', () => {
  it('formats small amounts without rounding them to zero', () => {
    expect(formatUsd(0.0042)).toMatch(/0,0042/);
    expect(formatUsd(1)).toMatch(/1,00/);
    expect(formatUsd(0)).toMatch(/0,00/);
  });
});

describe('resumeFileProblem', () => {
  it('accepts pdf and docx up to 5 MiB and explains the refusals', () => {
    expect(resumeFileProblem({ name: 'cv.pdf', size: 1000 })).toBeNull();
    expect(resumeFileProblem({ name: 'CV.DOCX', size: 5 * 1024 * 1024 })).toBeNull();
    expect(resumeFileProblem({ name: 'cv.doc', size: 1000 })).toMatch(/PDF ou DOCX/);
    expect(resumeFileProblem({ name: 'cv.pdf', size: 5 * 1024 * 1024 + 1 })).toMatch(/5 MB/);
    expect(resumeFileProblem({ name: 'cv.pdf', size: 0 })).toMatch(/vazio/);
  });
});

describe('blankItem', () => {
  it('creates items the API accepts as new (empty id, every field present)', () => {
    const wire = {
      contact: { name: '', email: '', phone: '', location: '' }, summary: '',
      experiences: [{ ...blankItem.experience(), achievements: [blankItem.achievement()] }],
      education: [blankItem.education()], skills: [blankItem.skill()], languages: [blankItem.language()],
      certifications: [blankItem.certification()], links: [blankItem.link()],
    };
    expect(ProfileWireSchema.safeParse(wire).success).toBe(true);
    expect(blankItem.skill()).not.toBe(blankItem.skill());
  });
});
