import { eq, inArray } from 'drizzle-orm';
import {
  AiError, analyzeJob, describeViolations, draftTailored, estimateCostUsd, extractProfile, resolveTailored, scoreJobs,
  tailoredLangFor, translateProfile, type AiConfig, type AiProvider, type AiTier, type AiUsage,
} from '@kv/ai';
import type { DescriptionFetcher } from '@kv/connectors';
import {
  baseProfile, jobAi, jobs, profileFor, recordUsage, resumes, saveProfile, tailoredResumes, type AiTaskRow, type Db,
} from '@kv/db';
import { otherLang, type AiLayer } from '@kv/shared';
import type { UnitRunner } from './queue';

export interface ExecutorDeps {
  db: Db;
  /**
   * Provedor e configuração em vigor, resolvidos a CADA unidade de trabalho (o serviço de configurações
   * decifra a chave na hora). O provedor montado aqui, com a chave dentro, vive só até a unidade terminar:
   * trocar de provedor ou de chave na tela vale na tarefa seguinte, e nada fica guardado entre tarefas.
   * Lança AiError('config') quando a IA não está configurada.
   */
  ai: () => Promise<{ provider: AiProvider; config: AiConfig }>;
  /** Descrição sob demanda (LinkedIn e Indeed): `fetchJobDescription` de @kv/connectors. */
  fetchDescription: DescriptionFetcher;
  now?: () => number;
  log?: (msg: string) => void;
}

type JobRow = typeof jobs.$inferSelect;
const LANG_NAMES = { 'pt-BR': 'português', en: 'inglês' } as const;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Erro que não adianta tentar de novo (falta um dado do usuário): usa o tipo `config`, que a fila não repete. */
const missing = (message: string) => new AiError('config', message);

/**
 * O que cada tipo de tarefa da fila de IA faz. Toda chamada ao provedor que dá certo grava uma linha em
 * `ai_usage` (provedor, modelo que respondeu, camada, tokens e custo estimado) ANTES de qualquer
 * verificação do resultado: uma resposta bloqueada pelo verificador também foi paga.
 */
export function createExecutor(deps: ExecutorDeps): UnitRunner {
  return async (tasks, signal) => {
    const { provider, config } = await deps.ai();
    return bindExecutor(deps, provider, config)(tasks, signal);
  };
}

function bindExecutor(deps: ExecutorDeps, provider: AiProvider, config: AiConfig): UnitRunner {
  const { db, fetchDescription, now = Date.now, log = () => {} } = deps;

  async function charge(layer: AiLayer, tier: AiTier, res: { usage: AiUsage; model: string }): Promise<void> {
    await recordUsage(db, {
      provider: provider.id,
      model: res.model,
      layer,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: estimateCostUsd(res.model, res.usage, config.models[tier]),
      createdAt: now(),
    });
  }

  async function jobOf(task: AiTaskRow): Promise<JobRow> {
    const [job] = task.jobId === null ? [] : await db.select().from(jobs).where(eq(jobs.id, task.jobId));
    if (!job) throw missing('a vaga não existe mais');
    return job;
  }

  /**
   * Garante a descrição da vaga. LinkedIn e Indeed não a entregam na busca: aqui ela é buscada uma vez,
   * com as regras de acesso do Core, e gravada na vaga. Se a busca falha (bloqueio, vaga encerrada,
   * Indeed sem navegador no container), a análise segue só com título, empresa e local.
   */
  async function withDescription(job: JobRow, signal: AbortSignal): Promise<{ job: JobRow; available: boolean }> {
    if (job.description.trim()) return { job, available: true };
    try {
      const text = await fetchDescription({ source: job.source, externalId: job.externalId, url: job.url }, signal);
      if (!text) return { job, available: false };
      await db.update(jobs).set({ description: text, descriptionFetchedAt: now() }).where(eq(jobs.id, job.id));
      return { job: { ...job, description: text }, available: true };
    } catch (e) {
      log(`IA: descrição da vaga ${job.id} (${job.source}) indisponível: ${errorText(e)}`);
      return { job, available: false };
    }
  }

  /** Camada 1, em lote. Devolve as tarefas cuja vaga ficou sem resultado. */
  async function tier1(tasks: AiTaskRow[], signal: AbortSignal): Promise<Map<number, unknown>> {
    const profile = await baseProfile(db);
    if (!profile) throw missing('não há perfil: envie um currículo em Meu perfil');
    const ids = tasks.flatMap((t) => (t.jobId === null ? [] : [t.jobId]));
    const rows = await db.select().from(jobs).where(inArray(jobs.id, ids));
    const failures = new Map<number, unknown>();
    if (rows.length > 0) {
      const res = await scoreJobs(provider, profile.data, rows, { signal });
      await charge('tier1', 'fast', res);
      for (const r of res.data) {
        const values = {
          language: r.language, titlePt: r.titlePt, score: r.score, reason: r.reason, tier1State: 'ok' as const,
          tier1ProfileVersion: profile.version, tier1At: now(),
        };
        await db.insert(jobAi).values({ jobId: r.jobId, ...values }).onConflictDoUpdate({ target: jobAi.jobId, set: values });
      }
      const scored = new Set(res.data.map((r) => r.jobId));
      for (const task of tasks) {
        if (task.jobId === null || !scored.has(task.jobId)) {
          failures.set(task.id, new AiError('invalid_output', 'o modelo não devolveu um resultado válido para esta vaga'));
        }
      }
    } else {
      for (const task of tasks) failures.set(task.id, missing('a vaga não existe mais'));
    }
    return failures;
  }

  async function tier2(task: AiTaskRow, signal: AbortSignal): Promise<void> {
    const profile = await baseProfile(db);
    if (!profile) throw missing('não há perfil: envie um currículo em Meu perfil');
    const { job, available } = await withDescription(await jobOf(task), signal);
    const res = await analyzeJob(provider, profile.data, job, { signal });
    await charge('tier2', 'strong', res);
    const values = {
      language: res.data.language, descriptionPt: res.data.descriptionPt, analysis: res.data.analysis,
      descriptionAvailable: available, tier2State: 'ok' as const, tier2ProfileVersion: profile.version, tier2At: now(),
    };
    await db.insert(jobAi).values({ jobId: job.id, ...values }).onConflictDoUpdate({ target: jobAi.jobId, set: values });
  }

  async function tier3(task: AiTaskRow, signal: AbortSignal): Promise<void> {
    const found = await jobOf(task);
    const [ai] = await db.select({ language: jobAi.language }).from(jobAi).where(eq(jobAi.jobId, found.id));
    const lang = tailoredLangFor(ai?.language, found.country);
    const profile = await profileFor(db, lang);
    if (!profile) throw missing(`não há perfil em ${LANG_NAMES[lang]}: envie o currículo ou gere o perfil por tradução`);
    const { job } = await withDescription(found, signal);
    const res = await draftTailored(provider, profile.data, job, lang, { signal });
    await charge('tier3', 'strong', res);
    // Nada do modelo é gravado sem passar pelo verificador de não invenção.
    const { resume, violations } = resolveTailored(res.data, profile.data, lang, { jobCompany: job.company });
    if (violations.length > 0) {
      throw new AiError('invalid_output', `verificação de não invenção bloqueou o resultado: ${describeViolations(violations)}`);
    }
    const values = { lang, content: resume, profileVersion: profile.version, createdAt: now(), editedAt: null };
    await db
      .insert(tailoredResumes)
      .values({ jobId: job.id, ...values })
      .onConflictDoUpdate({ target: tailoredResumes.jobId, set: values });
  }

  async function profileExtract(task: AiTaskRow, signal: AbortSignal): Promise<void> {
    if (!task.lang) throw missing('tarefa de perfil sem idioma');
    const [resume] = await db.select({ text: resumes.extractedText }).from(resumes).where(eq(resumes.lang, task.lang));
    if (!resume) throw missing('o currículo deste idioma não existe mais');
    const res = await extractProfile(provider, resume.text, { signal });
    await charge('profile', 'strong', res);
    await saveProfile(db, task.lang, res.data, 'extraido', now());
  }

  async function profileTranslate(task: AiTaskRow, signal: AbortSignal): Promise<void> {
    if (!task.lang) throw missing('tarefa de perfil sem idioma');
    const source = await profileFor(db, otherLang(task.lang));
    if (!source) throw missing(`não há perfil em ${LANG_NAMES[otherLang(task.lang)]} para traduzir`);
    const res = await translateProfile(provider, source.data, task.lang, { signal });
    await charge('profile', 'strong', res);
    await saveProfile(db, task.lang, res.data, 'traduzido', now());
  }

  return async (tasks, signal) => {
    const [first] = tasks;
    switch (first.type) {
      case 'tier1':
        return tier1(tasks, signal);
      case 'tier2':
        return tier2(first, signal);
      case 'tier3':
        return tier3(first, signal);
      case 'profile_extract':
        return profileExtract(first, signal);
      case 'profile_translate':
        return profileTranslate(first, signal);
    }
  };
}

/**
 * Para a opção `onFailed` da fila: quando a camada 1 ou a 2 falha de vez, grava o desfecho na vaga. É o
 * que impede a varredura de vagas novas de enfileirar a mesma vaga para sempre.
 */
export function createFailureRecorder(db: Db) {
  return async (task: AiTaskRow): Promise<void> => {
    if (task.jobId === null || (task.type !== 'tier1' && task.type !== 'tier2')) return;
    const set = task.type === 'tier1' ? { tier1State: 'error' as const } : { tier2State: 'error' as const };
    await db.insert(jobAi).values({ jobId: task.jobId, ...set }).onConflictDoUpdate({ target: jobAi.jobId, set });
  };
}
