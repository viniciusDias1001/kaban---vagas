import { eq, inArray, sql } from 'drizzle-orm';
import {
  AiError, analyzeJob, dayStartMs, draftTailored, estimateAbortedUsage, estimateCostUsd, estimateInterruptedUsage, extractProfile,
  isTimeout, resolveTailored, scoreJobs, tailoredLangFor, toCorrections, translateProfile, violationCodes, type AiConfig,
  type AiProvider, type AiTier, type AiUsage, type TailoredCorrection,
} from '@kv/ai';
import { MAX_DESCRIPTION_CHARS, type DescriptionFetcher } from '@kv/connectors';
import {
  ESTIMATED_MODEL_SUFFIX, aiSpentSince, aiTasks, baseProfile, jobAi, jobs, profileFor, recordUsage, resumes, saveProfile,
  tailoredResumes, type AiTaskRow, type CandidateProfileRow, type Db,
} from '@kv/db';
import { otherLang, type AiLayer, type JobAnalysis } from '@kv/shared';
import type { UnitRunner } from './queue';
import { DraftBlockedError, ProfileChangedError, TaskCancelledError } from './task-errors';

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
  /** Tentativas por tarefa, contando a primeira: o mesmo valor da fila (padrão 3). A nova tentativa da camada 3 conta. */
  maxAttempts?: number;
}

type JobRow = typeof jobs.$inferSelect;
const LANG_NAMES = { 'pt-BR': 'português', en: 'inglês' } as const;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** O INSERT/UPDATE falhou porque a vaga foi apagada no meio da tarefa (chave estrangeira, SQLSTATE 23503)? */
export function isForeignKeyViolation(error: unknown): boolean {
  let cause: { code?: unknown; cause?: unknown } | undefined = error as typeof cause;
  for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause as typeof cause) if (cause.code === '23503') return true;
  return false;
}

/** Descrição no teto de MAX_DESCRIPTION_CHARS, sem cortar um par substituto (emoji) ao meio. */
function clipDescription(text: string): string {
  if (text.length <= MAX_DESCRIPTION_CHARS) return text;
  let end = MAX_DESCRIPTION_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end).trimEnd();
}

/** Palavras-chave da análise da camada 2 (as que a vaga pede), para o verificador da camada 3. */
const keywordsOf = (ai: { tier2State: 'ok' | 'error' | null; analysis: JobAnalysis | null } | undefined): string[] =>
  ai?.tier2State === 'ok' && ai.analysis ? [...ai.analysis.keywordsMissing, ...ai.analysis.keywordsPresent] : [];

/**
 * Erro que não adianta tentar de novo (falta um dado do usuário): usa o tipo `input`, que a fila não repete. Não é
 * `config`: esse tipo quer dizer "o provedor está indisponível" e faz a fila pausar a triagem em vez de marcar a vaga.
 */
const missing = (message: string) => new AiError('input', message);

const TIER_OF_TASK = { tier1: 'fast', tier2: 'strong', tier3: 'strong', profile_extract: 'strong', profile_translate: 'strong' } as const;
const LAYER_OF_TASK = { tier1: 'tier1', tier2: 'tier2', tier3: 'tier3', profile_extract: 'profile', profile_translate: 'profile' } as const;

/**
 * O que cada tipo de tarefa da fila de IA faz. Toda chamada ao provedor que foi cobrada grava uma linha em
 * `ai_usage` (provedor, modelo que respondeu, camada, tokens e custo estimado) ANTES de qualquer
 * verificação do resultado: uma resposta bloqueada pelo verificador também foi paga, e o mesmo vale para a
 * chamada que o provedor cobrou e depois recusou, cortou no teto de tokens ou devolveu fora do schema (o
 * `AiError` leva o uso). Chamada que falhou antes de qualquer resposta não grava nada, com uma exceção: a chamada
 * ABORTADA POR TEMPO. O provedor pode cobrá-la (a geração já estava em curso) e não informa o uso, então entra uma
 * linha ESTIMADA (entrada pelo tamanho do prompt, saída no teto da chamada; `model` com ESTIMATED_MODEL_SUFFIX),
 * para o limite de gasto do dia errar para o lado seguro.
 */
export function createExecutor(deps: ExecutorDeps): UnitRunner {
  return async (tasks, signal) => {
    const { provider, config } = await deps.ai();
    return bindExecutor(deps, provider, config)(tasks, signal);
  };
}

function bindExecutor(deps: ExecutorDeps, rawProvider: AiProvider, config: AiConfig): UnitRunner {
  const { db, fetchDescription, now = Date.now, log = () => {}, maxAttempts = 3 } = deps;

  /** O provedor em vigor, com a estimativa de uso anexada ao erro de uma chamada abortada por tempo. */
  const provider: AiProvider = {
    id: rawProvider.id,
    async generate(req) {
      try {
        return await rawProvider.generate(req);
      } catch (e) {
        if (e instanceof AiError && !e.usage && (isTimeout(e) || req.signal?.aborted)) {
          e.usage = estimateAbortedUsage(req);
          e.estimated = true;
        }
        throw e;
      }
    },
  };

  async function charge(layer: AiLayer, tier: AiTier, res: { usage: AiUsage; model: string }, estimated = false): Promise<void> {
    await recordUsage(db, {
      provider: provider.id,
      model: estimated ? `${res.model}${ESTIMATED_MODEL_SUFFIX}` : res.model,
      layer,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUsd: estimateCostUsd(res.model, res.usage, config.models[tier]),
      createdAt: now(),
    });
  }

  /**
   * Faz a chamada ao provedor e registra o uso, venha a resposta ou um erro que a carregue. Se gravar o uso
   * falhar depois de um erro, o erro do provedor é o que sobe (o do banco vai para o log).
   */
  async function billed<T extends { usage: AiUsage; model: string }>(layer: AiLayer, tier: AiTier, call: () => Promise<T>): Promise<T> {
    let res: T;
    try {
      res = await call();
    } catch (e) {
      if (e instanceof AiError && e.usage) {
        try {
          await charge(layer, tier, { usage: e.usage, model: e.model ?? config.models[tier] }, e.estimated === true);
        } catch (dbError) {
          log(`IA: não consegui registrar o uso de uma chamada que falhou (${layer}): ${errorText(dbError)}`);
        }
      }
      throw e;
    }
    await charge(layer, tier, res);
    return res;
  }

  /**
   * Grava o resultado de uma vaga. Se a vaga foi apagada enquanto a chamada ao modelo estava em curso, o
   * INSERT quebra a chave estrangeira: é um cancelamento limpo (o uso já foi registrado), não uma falha a repetir.
   * Devolve false nesse caso.
   */
  async function writeForJob(jobId: number, write: () => Promise<unknown>): Promise<boolean> {
    try {
      await write();
      return true;
    } catch (e) {
      if (!isForeignKeyViolation(e)) throw e;
      log(`IA: a vaga ${jobId} foi apagada durante a tarefa; o resultado foi descartado`);
      return false;
    }
  }

  /**
   * Das tarefas dadas, as que ainda existem. A linha some quando o usuário apaga os dados de IA no meio da chamada:
   * o resultado dessas é descartado em vez de recriar o que acabou de ser apagado.
   */
  async function stillWanted(ids: number[]): Promise<Set<number>> {
    if (ids.length === 0) return new Set();
    const rows = await db.select({ id: aiTasks.id }).from(aiTasks).where(inArray(aiTasks.id, ids));
    return new Set(rows.map((r) => r.id));
  }
  const cancelled = async (task: AiTaskRow) => !(await stillWanted([task.id])).has(task.id);

  /**
   * Grava o perfil produzido por uma tarefa, a menos que (conferido dentro do lock de gravação de perfil):
   * - a linha da tarefa tenha sido apagada (o usuário apagou os dados): `TaskCancelledError`;
   * - `changed(perfil atual)` diga que o usuário mexeu no perfil depois de a tarefa ser pedida: `ProfileChangedError`.
   */
  async function saveTaskProfile(
    task: AiTaskRow & { lang: NonNullable<AiTaskRow['lang']> },
    data: CandidateProfileRow['data'],
    origin: 'extraido' | 'traduzido',
    changed: (current: CandidateProfileRow) => boolean,
  ): Promise<void> {
    await saveProfile(db, task.lang, data, origin, now(), {
      guard: async (current, tx) => {
        const [alive] = await tx.select({ id: aiTasks.id }).from(aiTasks).where(eq(aiTasks.id, task.id));
        if (!alive) throw new TaskCancelledError();
        if (current && changed(current)) throw new ProfileChangedError();
      },
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
      const fetched = await fetchDescription({ source: job.source, externalId: job.externalId, url: job.url }, signal);
      const text = fetched ? clipDescription(fetched) : '';
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
      const res = await billed('tier1', 'fast', () => scoreJobs(provider, profile.data, rows, { signal }));
      const wanted = await stillWanted(tasks.map((t) => t.id));
      const wantedJobs = new Set(tasks.filter((t) => wanted.has(t.id)).map((t) => t.jobId));
      for (const r of res.data) {
        if (!wantedJobs.has(r.jobId)) continue;
        const values = {
          language: r.language, titlePt: r.titlePt, score: r.score, reason: r.reason, tier1State: 'ok' as const,
          tier1ProfileVersion: profile.version, tier1At: now(),
        };
        // Vaga apagada durante a chamada: as outras do lote continuam.
        await writeForJob(r.jobId, () =>
          db.insert(jobAi).values({ jobId: r.jobId, ...values }).onConflictDoUpdate({ target: jobAi.jobId, set: values }),
        );
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
    const res = await billed('tier2', 'strong', () => analyzeJob(provider, profile.data, job, { signal }));
    const values = {
      language: res.data.language, descriptionPt: res.data.descriptionPt, analysis: res.data.analysis,
      descriptionAvailable: available, tier2State: 'ok' as const, tier2ProfileVersion: profile.version, tier2At: now(),
    };
    if (await cancelled(task)) return;
    await writeForJob(job.id, () =>
      db.insert(jobAi).values({ jobId: job.id, ...values }).onConflictDoUpdate({ target: jobAi.jobId, set: values }),
    );
  }

  /**
   * A nova tentativa da camada 3 cabe? Conta como tentativa (nunca passa de `maxAttempts`) e respeita o limite
   * de gasto do dia: acima dele só com a confirmação do usuário (`confirmed`), como a própria fila.
   */
  async function mayCorrect(task: AiTaskRow): Promise<boolean> {
    if (task.attempts + 1 >= maxAttempts) return false;
    if (task.confirmed) return true;
    return (await aiSpentSince(db, dayStartMs(now(), config.budgetTimeZone))) < config.dailyBudgetUsd;
  }

  /**
   * Camada 3. Nada do modelo é gravado sem passar pelo verificador de não invenção, que recebe o nome e o título da
   * vaga e as palavras-chave da análise da camada 2 (quando existe).
   *
   * Rascunho bloqueado = chamada paga e sem resultado. A fila repetiria a mesma chamada às cegas (até três vezes);
   * aqui, em vez disso, há UMA nova tentativa dentro da tarefa, com os códigos e termos que o verificador achou
   * devolvidos ao modelo como dado. Ela conta como tentativa, respeita o limite de gasto (`mayCorrect`) e, se
   * também for bloqueada ou falhar, a tarefa termina com `DraftBlockedError` (que a fila não repete).
   */
  async function tier3(task: AiTaskRow, signal: AbortSignal): Promise<void> {
    const found = await jobOf(task);
    const [ai] = await db
      .select({ language: jobAi.language, tier2State: jobAi.tier2State, analysis: jobAi.analysis })
      .from(jobAi)
      .where(eq(jobAi.jobId, found.id));
    const lang = tailoredLangFor(ai?.language, found.country);
    const profile = await profileFor(db, lang);
    if (!profile) throw missing(`não há perfil em ${LANG_NAMES[lang]}: envie o currículo ou gere o perfil por tradução`);
    const { job } = await withDescription(found, signal);
    const context = { jobCompany: job.company, jobTitle: job.title, jobKeywords: keywordsOf(ai) };
    const draft = async (corrections?: TailoredCorrection[]) => {
      const res = await billed('tier3', 'strong', () => draftTailored(provider, profile.data, job, lang, { signal, corrections }));
      return resolveTailored(res.data, profile.data, lang, context);
    };

    let { resume, violations } = await draft();
    if (violations.length > 0) {
      const codes = violationCodes(violations);
      if (!(await mayCorrect(task))) throw new DraftBlockedError(codes);
      await db.update(aiTasks).set({ attempts: sql`${aiTasks.attempts} + 1` }).where(eq(aiTasks.id, task.id));
      try {
        ({ resume, violations } = await draft(toCorrections(violations)));
      } catch (e) {
        // Tempo esgotado e chave inválida mantêm o próprio erro; o resto vira "bloqueado" e a fila não repete.
        if (signal.aborted || (e instanceof AiError && e.kind === 'config')) throw e;
        throw new DraftBlockedError(codes);
      }
      if (violations.length > 0) throw new DraftBlockedError(violationCodes(violations));
    }
    const values = { lang, content: resume, profileVersion: profile.version, createdAt: now(), editedAt: null };
    if (await cancelled(task)) return;
    await writeForJob(job.id, () =>
      db
        .insert(tailoredResumes)
        .values({ jobId: job.id, ...values })
        .onConflictDoUpdate({ target: tailoredResumes.jobId, set: values }),
    );
  }

  async function profileExtract(task: AiTaskRow, signal: AbortSignal): Promise<void> {
    if (!task.lang) throw missing('tarefa de perfil sem idioma');
    const [resume] = await db.select({ text: resumes.extractedText }).from(resumes).where(eq(resumes.lang, task.lang));
    if (!resume) throw missing('o currículo deste idioma não existe mais');
    const res = await billed('profile', 'strong', () => extractProfile(provider, resume.text, { signal }));
    // Quem enviou o arquivo aceitou substituir o perfil que existia ATÉ ALI (a tela pede confirmação quando ele foi
    // editado). Uma edição salva depois do envio, com a leitura ainda na fila, não é sobrescrita.
    const lang = task.lang;
    await saveTaskProfile({ ...task, lang }, res.data, 'extraido', (current) => current.origin === 'editado' && current.updatedAt > task.createdAt);
  }

  async function profileTranslate(task: AiTaskRow, signal: AbortSignal): Promise<void> {
    if (!task.lang) throw missing('tarefa de perfil sem idioma');
    const source = await profileFor(db, otherLang(task.lang));
    if (!source) throw missing(`não há perfil em ${LANG_NAMES[otherLang(task.lang)]} para traduzir`);
    const lang = task.lang;
    const res = await billed('profile', 'strong', () => translateProfile(provider, source.data, lang, { signal }));
    // A API só aceita o pedido de tradução quando o destino não existe ou veio de tradução. Se agora ele é
    // "editado" ou "extraído", o usuário mexeu nele (editou ou enviou um currículo) com a tradução na fila.
    await saveTaskProfile({ ...task, lang }, res.data, 'traduzido', (current) => current.origin !== 'traduzido');
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
 * Para a opção `onInterrupted` da fila: uma tarefa ficou "running" porque o processo morreu (ou travou) no meio da
 * chamada ao provedor. A chamada pode ter sido cobrada e o uso se perdeu: grava uma linha ESTIMADA em `ai_usage`
 * (`estimateInterruptedUsage`: a maior entrada possível da tarefa e a saída no teto), para o limite de gasto do dia
 * não ignorar o que um worker que reinicia em laço estaria gastando. Nunca lança: sem configuração de IA (ou com o
 * banco fora do ar) só registra no log.
 */
export function createInterruptionRecorder(deps: Pick<ExecutorDeps, 'db' | 'ai' | 'now' | 'log'>) {
  const { db, now = Date.now, log = () => {} } = deps;
  return async (task: AiTaskRow): Promise<void> => {
    try {
      const { provider, config } = await deps.ai();
      const model = config.models[TIER_OF_TASK[task.type]];
      const usage = estimateInterruptedUsage(task.type);
      await recordUsage(db, {
        provider: provider.id, model: `${model}${ESTIMATED_MODEL_SUFFIX}`, layer: LAYER_OF_TASK[task.type],
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: estimateCostUsd(model, usage), createdAt: now(),
      });
    } catch (e) {
      log(`IA: não consegui registrar o uso estimado da tarefa interrompida ${task.id} (${task.type}): ${errorText(e)}`);
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
    try {
      await db.insert(jobAi).values({ jobId: task.jobId, ...set }).onConflictDoUpdate({ target: jobAi.jobId, set });
    } catch (e) {
      // A vaga foi apagada: não há onde marcar o desfecho (e nada a repetir).
      if (!isForeignKeyViolation(e)) throw e;
    }
  };
}
