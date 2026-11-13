import { describe, expect, it } from 'vitest';
import { EXPERIENCE_SECTIONS } from '@kv/shared/client';
import { ProfileWireSchema, VIOLATION_CODES, withProfileDefaults, type CandidateProfile, type AiTaskDto, type JobAiSummaryDto, type Violation, type ViolationCode } from '@kv/shared';
import {
  VIOLATION_LABELS, blankItem, cardTitle, drawerTitle, editableProfile, formatUsd, isPending, languageBadge, layerMessage, parsePdfFailure, pdfBlockers,
  pollMs, profileDirty, rebaseDraft, resumeFileProblem, SECTION_OPTIONS, skillGroupOptions, retryNote, scoreTone, scoringPauseText, sortByScore, taskErrorText, toScoreMap, violationPlace, violationView,
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
    expect(layerMessage('queued', task({ attempts: 1 }))).toBe('Nova tentativa agendada.');
    expect(layerMessage('running', task())).toBe('Processando...');
    expect(layerMessage('stale', null)).toMatch(/versão anterior do seu perfil/);
    expect(layerMessage('blocked_budget', task())).toMatch(/limite de gasto/);
    expect(layerMessage('error', task({ error: 'limite de taxa' }))).toBe('Limite de taxa.');
    expect(layerMessage('error', null)).toBe('Falhou, sem detalhe.');
    expect(layerMessage('ok', null)).toBe('Pronto.');
  });
});

describe('drawer title', () => {
  it('puts the translated title first and keeps the original for a second line, like the card', () => {
    expect(drawerTitle('Senior React Engineer', 'Engenheira React Sênior')).toEqual({ title: 'Engenheira React Sênior', original: 'Senior React Engineer' });
    expect(drawerTitle('Dev React', ' dev react ')).toEqual({ title: 'Dev React', original: null });
    expect(drawerTitle('Dev React', null)).toEqual({ title: 'Dev React', original: null });
    expect(drawerTitle('Dev React', undefined)).toEqual({ title: 'Dev React', original: null });
    expect(drawerTitle('Dev React', '   ')).toEqual({ title: 'Dev React', original: null });
  });
});

describe('task error text', () => {
  it('shows the stored message as one clean sentence, whatever its prefix, punctuation or number of attempts', () => {
    expect(taskErrorText(null)).toBe('Falhou, sem detalhe.');
    expect(taskErrorText('   ')).toBe('Falhou, sem detalhe.');
    expect(taskErrorText('falha de rede')).toBe('Falha de rede.');
    expect(taskErrorText('não há perfil em inglês: envie o currículo')).toBe('Não há perfil em inglês: envie o currículo.');
    // As mensagens fixas do worker já são frases completas, com "; " dentro dos parênteses: ficam como estão.
    const blocked =
      'A IA propôs um currículo com informações que não estão no seu perfil (números que não estão no perfil; termos que não estão no perfil) e o resultado foi descartado. ' +
      'Confira se o perfil tem tudo o que você quer destacar, edite-o se faltar algo, e peça a adaptação de novo.';
    expect(taskErrorText(blocked)).toBe(blocked);
    expect(taskErrorText('Tente de novo?')).toBe('Tente de novo?');
    expect(layerMessage('error', task({ error: blocked, attempts: 2 }))).toBe(blocked);
  });

  it('says a retry is scheduled without counting attempts, and only for a queued task', () => {
    expect(layerMessage('queued', task({ attempts: 2 }))).toBe('Nova tentativa agendada.');
    expect(retryNote(task({ status: 'queued', attempts: 1 }))).toBe('Nova tentativa agendada.');
    // "running" já conta a tentativa em curso: a primeira execução não é uma nova tentativa.
    expect(retryNote(task({ status: 'running', attempts: 1 }))).toBe('');
    expect(retryNote(task({ status: 'queued', attempts: 0 }))).toBe('');
    expect(retryNote(undefined)).toBe('');
  });
});

describe('verifier violations', () => {
  const violation = (over: Partial<Violation>): Violation => ({ code: 'novel_term', path: 'summary', message: 'm', ...over });

  it('has a label and an explanation for every violation code the API can send', () => {
    expect(Object.keys(VIOLATION_LABELS).sort()).toEqual([...VIOLATION_CODES].sort());
    for (const code of VIOLATION_CODES) {
      expect(VIOLATION_LABELS[code].label.trim(), code).not.toBe('');
      expect(VIOLATION_LABELS[code].help.trim().length, code).toBeGreaterThan(20);
    }
    expect(new Set(VIOLATION_CODES.map((c) => VIOLATION_LABELS[c].label)).size).toBe(VIOLATION_CODES.length);
  });

  it('describes a violation with label, offending term and place', () => {
    expect(violationView(violation({ detail: 'Kubernetes', path: 'experiences[0].achievements[1].text' }))).toEqual({
      label: VIOLATION_LABELS.novel_term.label, help: VIOLATION_LABELS.novel_term.help, term: 'Kubernetes', place: 'Experiência 1, realização 2',
    });
    expect(violationView(violation({ code: 'unrelated_text', path: 'experiences[2].achievements[0].text' }))).toMatchObject({
      label: VIOLATION_LABELS.unrelated_text.label, term: null, place: 'Experiência 3, realização 1',
    });
    expect(violationView(violation({ code: 'limit', path: 'summary' }))).toMatchObject({ label: VIOLATION_LABELS.limit.label, place: 'Resumo' });
    expect(violationView(violation({ code: 'foreign_company', detail: 'Acme Fictícia' })).term).toBe('Acme Fictícia');
  });

  it('shows numbers the way a person writes them and hides internal identities', () => {
    expect(violationView(violation({ code: 'new_number', detail: '40' })).term).toBe('40');
    expect(violationView(violation({ code: 'new_number', detail: 'd:2018-3' })).term).toBe('03/2018');
    expect(violationView(violation({ code: 'new_number', detail: 'q:tens' })).term).toBeNull();
    expect(violationView(violation({ detail: '   ' })).term).toBeNull();
    expect(violationView(violation({ detail: 'x'.repeat(500) })).term).toHaveLength(121);
  });

  it('names the place for every list of the draft and gives up politely on an unknown path', () => {
    expect([
      'experiences[1]', 'experiences[0].achievements[3]', 'experiences', 'educationIds[0]', 'skillIds[4]', 'languageIds[1]',
      'certificationIds[0]', 'linkIds[2]', 'skillIds', 'algo.novo[9]', '',
    ].map(violationPlace)).toEqual([
      'Experiência 2', 'Experiência 1, realização 4', 'Experiências', 'Formação 1', 'Habilidade 5', 'Idioma 2', 'Certificação 1', 'Link 3',
      'Habilidades', null, null,
    ]);
  });

  it('falls back to the message of the API for a code this build does not know', () => {
    const view = violationView({ code: 'futuro' as ViolationCode, path: 'summary', message: 'algo novo divergiu' });
    expect(view).toEqual({ label: 'Divergência', help: 'Algo novo divergiu.', term: null, place: 'Resumo' });
  });
});

describe('pdf warnings and download failures', () => {
  it('tells which characters cannot be printed and whether the text is too long', () => {
    expect(pdfBlockers({ unsupportedCharacters: [], tooLong: false })).toBeNull();
    expect(pdfBlockers(undefined)).toBeNull();
    expect(pdfBlockers({ unsupportedCharacters: ['😀', 'ก'], tooLong: false })).toEqual({
      characters: ['"😀" (U+1F600)', '"ก" (U+0E01)'], more: 0, tooLong: false,
    });
    expect(pdfBlockers({ unsupportedCharacters: [], tooLong: true })).toEqual({ characters: [], more: 0, tooLong: true });
    const many = pdfBlockers({ unsupportedCharacters: Array.from({ length: 30 }, (_, i) => String.fromCodePoint(0x4e00 + i)), tooLong: false });
    expect(many?.characters).toHaveLength(12);
    expect(many?.more).toBe(18);
  });

  it('reads a 409 verification_failed with its violations', () => {
    const body = JSON.stringify({
      error: 'verification_failed',
      message: 'O currículo não confere mais com o seu perfil e não pode virar PDF: summary: o número "40" não está no perfil. Revise.',
      violations: [{ code: 'new_number', path: 'summary', message: 'o número "40" não está no perfil', detail: '40' }, { code: 1 }, null, 'x'],
    });
    expect(parsePdfFailure(409, body)).toEqual({
      title: 'O currículo não confere mais com o seu perfil e não pode virar PDF.',
      hint: 'Revise o texto e salve, ou adapte o currículo de novo.',
      violations: [{ code: 'new_number', path: 'summary', message: 'o número "40" não está no perfil', detail: '40' }],
      characters: [],
    });
  });

  it('reads 409 profile_missing and 422 pdf_unavailable with the characters', () => {
    expect(parsePdfFailure(409, JSON.stringify({ error: 'profile_missing', message: 'o perfil deste idioma não existe mais' }))).toEqual({
      title: 'O perfil deste idioma não existe mais.',
      hint: 'Envie o currículo ou gere o perfil de novo em Meu perfil e adapte o currículo outra vez.',
      violations: [], characters: [],
    });
    const glyph = parsePdfFailure(422, JSON.stringify({
      error: 'pdf_unavailable', code: 'unsupported_characters',
      message: 'O PDF não pode ser gerado: a fonte do documento não tem o caractere "😀" (U+1F600). Edite o currículo e troque ou remova esses caracteres.',
      characters: ['😀', 7],
    }));
    expect(glyph).toMatchObject({ title: expect.stringContaining('O PDF não pode ser gerado'), violations: [], characters: ['"😀" (U+1F600)'] });
    const long = parsePdfFailure(422, JSON.stringify({
      error: 'pdf_unavailable', code: 'too_long',
      message: 'O currículo tem texto demais para virar PDF (90000 caracteres; o limite é 60000). Encurte o resumo e as realizações.',
    }));
    expect(long).toMatchObject({ title: expect.stringContaining('texto demais'), characters: [], hint: null });
  });

  it('never shows a proxy page, an unknown body or a 5xx detail', () => {
    expect(parsePdfFailure(502, '<html>Bad Gateway</html>').title).toBe('A API falhou ao responder (erro 502). Tente de novo em instantes.');
    expect(parsePdfFailure(404, JSON.stringify({ error: 'not_found', message: 'esta vaga ainda não tem currículo adaptado' })).title)
      .toBe('Esta vaga ainda não tem currículo adaptado.');
    expect(parsePdfFailure(409, '{"error":"verification_failed","violations":"x"}')).toMatchObject({
      violations: [], title: expect.stringContaining('não confere'),
    });
    expect(parsePdfFailure(0, '').title).toMatch(/Não foi possível falar com a API/);
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

describe('editableProfile and profileDirty', () => {
  /** Como um perfil gravado antes do modelo de currículo. */
  const old: CandidateProfile = {
    contact: { name: 'Maria Exemplo da Silva', email: 'maria@exemplo.test', phone: '', location: 'São Paulo, SP' }, summary: 'Pessoa fictícia.',
    experiences: [{ id: 'exp_aaaaaaa1', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora', start: '2021-03', end: '', location: '', achievements: [] }],
    education: [], skills: [{ id: 'skill_aaaaaaa1', name: 'React' }], languages: [], certifications: [], links: [],
  };
  it('opens a profile stored before the change without marking it as edited', () => {
    const draft = editableProfile(old);
    expect(ProfileWireSchema.safeParse(draft).success).toBe(true);
    expect(old).not.toHaveProperty('headline'); // a entrada não foi tocada
    expect(profileDirty(draft, old)).toBe(false);
    expect(profileDirty(draft, withProfileDefaults(old))).toBe(false); // a versão completa do mesmo perfil não conta como edição
    expect(profileDirty({ ...draft, headline: 'Tech Lead' }, old)).toBe(true);
  });
});

describe('blankItem', () => {
  it('creates items the API accepts as new (empty id, every field present)', () => {
    const wire = {
      contact: { name: '', email: '', phone: '', location: '' }, headline: '', summary: '',
      experiences: [{ ...blankItem.experience(), achievements: [blankItem.achievement()] }],
      education: [blankItem.education()], skills: [blankItem.skill()], languages: [blankItem.language()],
      certifications: [blankItem.certification()], links: [blankItem.link()],
    };
    expect(ProfileWireSchema.safeParse(wire).success).toBe(true);
    expect(blankItem.skill()).not.toBe(blankItem.skill());
  });
});

describe('scoringPauseText', () => {
  it('says what the provider answered, how many jobs wait and what resumes the scoring', () => {
    const text = scoringPauseText({ message: 'a chave de API da OpenAI é inválida ou não tem permissão', retryAt: Date.UTC(2026, 10, 11, 15, 30), tasks: 12 });
    expect(text.reason).toBe('O provedor de IA respondeu: A chave de API da OpenAI é inválida ou não tem permissão.');
    expect(text.next).toContain('12 vagas aguardam a nota.');
    expect(text.next).toMatch(/Nova tentativa automática às \d{2}:\d{2}/);
    expect(text.next).toContain('Testar conexão');
    expect(scoringPauseText({ message: '', retryAt: 0, tasks: 1 }).next).toContain('1 vaga aguarda a nota.');
  });
});

describe('rebaseDraft (the profile editor when the server version changes)', () => {
  it('keeps the draft when the version is the one it is based on', () => {
    expect(rebaseDraft({ dirty: true, version: 7 }, 7)).toBe('keep');
    expect(rebaseDraft({ dirty: false, version: 7 }, 7)).toBe('keep');
  });

  it('follows the server when nothing is pending, and asks when there are unsaved changes', () => {
    expect(rebaseDraft({ dirty: false, version: 7 }, 8)).toBe('adopt');
    expect(rebaseDraft({ dirty: true, version: 7 }, 8)).toBe('conflict');
  });
});

describe('profile editor layout options', () => {
  it('suggests the groups in use once, in order, skipping empty ones', () => {
    expect(skillGroupOptions([{ group: 'Front-end' }, { group: '' }, { group: 'Dados' }, { group: 'Front-end' }, { group: ' Dados ' }])).toEqual(['Front-end', 'Dados']);
    expect(SECTION_OPTIONS.map((o) => o.value)).toEqual([...EXPERIENCE_SECTIONS]);
  });
});
