import type { CandidateProfile, ProfileWire, TailoredDraft, Tier1Result, Tier2Output } from '@kv/shared';
import { AiError, parseOutput, withUsage } from './errors';
import { readBlock, readTask } from './prompts';
import type { AiProvider } from './types';

/**
 * Provedor falso e determinístico, para testes unitários e e2e (`AI_PROVIDER=fake`, ou escolhido na aba
 * Configurações quando `AI_ALLOW_FAKE=1`). Não usa rede: lê
 * os blocos <tarefa>, <perfil> e <dados> que `buildPrompt` escreveu e calcula a resposta a partir deles.
 *
 * Marcadores que simulam um modelo comprometido por injeção de prompt (basta aparecerem nos dados da vaga):
 * - FAKE_AI_COMPROMISED: a camada 3 devolve uma habilidade inexistente e um número/empresa inventados
 *   (estrutura válida; quem barra é o verificador);
 * - FAKE_AI_EXTRA_FIELD: a camada 3 devolve um campo "company" a mais (quem barra é o schema).
 *
 * Formato de currículo que a extração falsa entende (o mesmo do arquivo de exemplo de @kv/resume/testing):
 *   linha 1: nome; linha 2: resumo; a linha com "@": contato, separado por " • " (e-mail e, por último, local);
 *   seções "Experiência"/"Experience" (linhas "Cargo | Empresa | início | fim" seguidas de "- realização"),
 *   "Formação"/"Education" ("Curso | Instituição | início | fim"), "Habilidades"/"Skills" (lista com vírgulas)
 *   e "Idiomas"/"Languages" ("Nome (nível)", com vírgulas).
 */
export function createFakeProvider(): AiProvider {
  return {
    id: 'fake',
    async generate(req) {
      if (req.signal?.aborted) throw new AiError('transient', 'chamada cancelada (tempo esgotado)');
      // "Testar conexão" não passa por buildPrompt: prompt fixo, resposta fixa.
      if (req.prompt.startsWith('Teste de conexão')) {
        return { data: parseOutput(req.schema, { ok: true }), model: `fake-${req.tier}`, usage: { inputTokens: 12, outputTokens: 4 } };
      }
      const task = readTask(req.prompt);
      const data = readBlock<Record<string, unknown>>(req.prompt, 'dados');
      const profile = readBlock<unknown>(req.system, 'perfil');
      if (!task || !data) throw new AiError('other', 'provedor falso: prompt sem <tarefa> ou <dados>');
      const raw = respond(task, data, profile);
      const model = `fake-${req.tier}`;
      const usage = {
        inputTokens: Math.ceil((req.system.length + req.prompt.length) / 4),
        outputTokens: Math.ceil(JSON.stringify(raw).length / 4),
      };
      try {
        return { data: parseOutput(req.schema, raw), model, usage };
      } catch (e) {
        // Como nos provedores de verdade: a saída inválida também foi "cobrada".
        throw withUsage(e, { usage, model });
      }
    },
  };
}

interface FakeJob {
  jobId?: number;
  title: string;
  company: string;
  location: string;
  excerpt?: string;
  description?: string;
}

function respond(task: string, data: Record<string, unknown>, profile: unknown): unknown {
  switch (task) {
    case 'profile_extract':
      return extract(String(data.text ?? ''));
    case 'profile_translate':
      return translate(data.profile as ProfileWire, String(data.target));
    case 'tier1':
      return { results: (data.jobs as FakeJob[]).map((job) => score(job, skillNames(profile))) };
    case 'tier2':
      return analyze(data.job as FakeJob, skillNames(profile));
    case 'tier3':
      return tailor(profile as CandidateProfile, JSON.stringify(data));
    default:
      throw new AiError('other', `provedor falso: tarefa desconhecida "${task}"`);
  }
}

/** Aceita o perfil completo (skills: {name}[]) e o resumido da camada 1 (skills: string[]). */
function skillNames(profile: unknown): string[] {
  const skills = (profile as { skills?: unknown[] } | null)?.skills ?? [];
  return skills.map((k) => (typeof k === 'string' ? k : String((k as { name?: string }).name ?? '')));
}

const isEnglish = (text: string) => /\b(the|and|with|developer|engineer|you|our)\b/i.test(text) && !/\b(vaga|para|com|você|nossa)\b/i.test(text);

function matched(job: FakeJob, skills: string[]): string[] {
  const text = `${job.title} ${job.excerpt ?? ''} ${job.description ?? ''}`.toLowerCase();
  return skills.filter((name) => name !== '' && text.includes(name.toLowerCase()));
}

function score(job: FakeJob, skills: string[]): Tier1Result {
  const hits = matched(job, skills);
  const english = isEnglish(`${job.title} ${job.excerpt ?? ''}`);
  return {
    jobId: job.jobId ?? 0,
    language: english ? 'en' : 'pt',
    titlePt: english ? `[pt] ${job.title}` : job.title,
    score: Math.min(100, 40 + 30 * hits.length),
    reason: `${hits.length} habilidade(s) do perfil aparecem na vaga.`,
  };
}

function analyze(job: FakeJob, skills: string[]): Tier2Output {
  const hits = matched(job, skills);
  const description = job.description ?? '';
  const english = isEnglish(`${job.title} ${description}`);
  return {
    language: english ? 'en' : 'pt',
    descriptionPt: english && description ? `[pt] ${description}` : '',
    analysis: {
      strengths: hits.map((name) => `Experiência com ${name}`),
      gaps: hits.length === 0 ? ['Nenhuma habilidade do perfil aparece na vaga'] : [],
      keywordsPresent: hits,
      keywordsMissing: [],
      interviewTopics: [`Rever a descrição da vaga da ${job.company}`],
      likelyQuestions: ['Conte sobre um projeto recente.'],
    },
  };
}

function tailor(profile: CandidateProfile, dataJson: string): TailoredDraft & Record<string, unknown> {
  const draft: TailoredDraft = {
    summary: profile.summary,
    experiences: profile.experiences.map((e) => ({
      id: e.id,
      achievements: e.achievements.map((a) => ({ sourceId: a.id, text: a.text })),
    })),
    educationIds: profile.education.map((e) => e.id),
    skillIds: profile.skills.map((k) => k.id),
    languageIds: profile.languages.map((l) => l.id),
    certificationIds: profile.certifications.map((c) => c.id),
    linkIds: profile.links.map((l) => l.id),
  };
  if (dataJson.includes('FAKE_AI_COMPROMISED')) {
    draft.skillIds.push('skill_zzzzzzzz');
    draft.summary += ' Trabalhei 10 anos na Empresa Inventada.';
  }
  if (dataJson.includes('FAKE_AI_EXTRA_FIELD')) return { ...draft, company: 'Empresa Inventada' };
  return draft;
}

function translate(profile: ProfileWire, target: string): ProfileWire {
  const tag = (text: string) => (text ? `[${target}] ${text}` : text);
  return {
    ...profile,
    summary: tag(profile.summary),
    experiences: profile.experiences.map((e) => ({
      ...e,
      title: tag(e.title),
      achievements: e.achievements.map((a) => ({ ...a, text: tag(a.text) })),
    })),
    education: profile.education.map((e) => ({ ...e, degree: tag(e.degree) })),
  };
}

const SECTIONS: Record<string, 'experience' | 'education' | 'skills' | 'languages'> = {
  experiência: 'experience', experience: 'experience', formação: 'education', education: 'education',
  habilidades: 'skills', skills: 'skills', idiomas: 'languages', languages: 'languages',
};

function extract(text: string): ProfileWire {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: ProfileWire = {
    contact: { name: lines[0] ?? '', email: '', phone: '', location: '' },
    summary: lines[1] ?? '',
    experiences: [], education: [], skills: [], languages: [], certifications: [], links: [],
  };
  let section: (typeof SECTIONS)[string] | null = null;
  for (const line of lines.slice(2)) {
    const heading = SECTIONS[line.toLowerCase()];
    if (heading) {
      section = heading;
      continue;
    }
    const cells = line.split(' | ').map((c) => c.trim());
    if (section === null && line.includes('@')) {
      const parts = line.split(' • ').map((p) => p.trim());
      out.contact.email = parts.find((p) => p.includes('@')) ?? '';
      out.contact.location = parts.length > 1 ? parts[parts.length - 1] : '';
    } else if (section === 'experience' && cells.length === 4) {
      out.experiences.push({ id: '', title: cells[0], company: cells[1], start: cells[2], end: cells[3], location: '', achievements: [] });
    } else if (section === 'experience' && line.startsWith('- ')) {
      out.experiences.at(-1)?.achievements.push({ id: '', text: line.slice(2) });
    } else if (section === 'education' && cells.length === 4) {
      out.education.push({ id: '', degree: cells[0], institution: cells[1], start: cells[2], end: cells[3] });
    } else if (section === 'skills') {
      out.skills.push(...line.split(',').map((name) => ({ id: '', name: name.trim() })).filter((k) => k.name));
    } else if (section === 'languages') {
      for (const item of line.split(',')) {
        const m = /^(.*?)\s*\((.*)\)$/.exec(item.trim());
        out.languages.push({ id: '', name: m ? m[1] : item.trim(), level: m ? m[2] : '' });
      }
    }
  }
  return out;
}
