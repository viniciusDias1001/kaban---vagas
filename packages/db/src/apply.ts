import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type {
  ApplicationDto, ApplicationEventDto, ApplicationFilter, ApplicationListItemDto, ApplicationReason, ApplicationStatus, ApplyMode,
  ApplySiteId, ApplyTrigger, ApplyWorkerState, JobListItemDto,
} from '@kv/shared';
import { APPLICATION_FILTERS, APPLICATION_FILTER_STATUSES, APPLY_SITE_IDS, applicationFilterOf, isAppliedOrLater } from '@kv/shared';
import type { Db } from './client';
import { applicationEvents as eventsTable, applications, applyAnswers, applyCommands, applySites, candidateProfiles, jobAi, jobs, settings } from './schema';

export type ApplicationRow = typeof applications.$inferSelect;
export type ApplyCommandRow = typeof applyCommands.$inferSelect;
export type ApplySiteRow = typeof applySites.$inferSelect;
export type ApplyCommandKind = 'open_login' | 'check_session' | 'logout' | 'close_browser';

/** Estados dos quais a candidatura não sai sozinha: ganham `finished_at`. */
const FINAL_STATUSES: readonly ApplicationStatus[] = ['submitted', 'dry_run_ready', 'skipped', 'failed', 'cancelled'];
/** Em andamento no worker (a fila `queued` fica de fora: ainda não começou). */
const RUNNING_STATUSES = ['preparing', 'filling', 'waiting_human', 'submitting'] as const;

/** Cria em `queued` e grava o primeiro evento. Devolve null se a vaga já tem candidatura. */
export async function createApplication(
  db: Db,
  input: { jobId: number; site: ApplySiteId; trigger: ApplyTrigger; mode: ApplyMode },
  now: number = Date.now(),
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(applications)
      .values({ ...input, status: 'queued', createdAt: now })
      .onConflictDoNothing()
      .returning({ id: applications.id });
    if (!row) return null;
    await tx.insert(eventsTable).values({ applicationId: row.id, status: 'queued', message: null, createdAt: now });
    return row.id;
  });
}

export interface Transition {
  status: ApplicationStatus;
  /** Só grava se o estado atual está na lista (a leitura e a escrita são na mesma transação travada); senão devolve false. */
  from?: readonly ApplicationStatus[];
  /**
   * Não grava (devolve false) se o dono pediu o cancelamento: o pedido é lido na mesma transação travada, então um
   * cancelamento gravado antes da escrita sempre vence (o `submitting` antes do clique final usa isto).
   */
  unlessCancelled?: true;
  reason?: ApplicationReason | null;
  detail?: string | null;
  /** Texto do evento na linha do tempo. */
  message?: string | null;
  set?: Partial<
    Pick<
      ApplicationRow,
      | 'mode' | 'gateScore' | 'finishedAt' | 'resumeLang' | 'resumeFileName' | 'resumePdf' | 'answers' | 'pendingQuestions' | 'confirmation'
      | 'contactEmail' | 'shots' | 'attempts' | 'cancelRequested' | 'waitingGate' | 'runAfter' | 'viewedAt' | 'formOpenedAt' | 'trigger'
    >
  >;
}

async function writeTransition(tx: Db, row: ApplicationRow, t: Transition, now: number): Promise<void> {
  await tx
    .update(applications)
    .set({
      ...t.set,
      status: t.status,
      // Quem sai de um estado de espera não carrega o motivo anterior: só fica o que a transição declara.
      reason: t.reason ?? null,
      detail: t.detail ?? null,
      ...(row.startedAt === null && (RUNNING_STATUSES as readonly string[]).includes(t.status) ? { startedAt: now } : {}),
      ...(t.status === 'submitted' ? { submittedAt: now } : {}),
      ...(FINAL_STATUSES.includes(t.status) ? { finishedAt: now } : {}),
    })
    .where(eq(applications.id, row.id));
  await tx.insert(eventsTable).values({ applicationId: row.id, status: t.status, message: t.message ?? null, createdAt: now });
}

/**
 * Grava o estado e um evento na mesma transação. Preenche `started_at` na primeira entrada num estado em execução
 * (`preparing`, `filling`, `waiting_human`, `submitting`), se ainda estiver vazio, `submitted_at` em `submitted` e `finished_at` em estado final. Devolve false, sem gravar, se a linha está em `submitted`
 * (ou não existe).
 */
export async function transitionApplication(db: Db, id: number, t: Transition, now: number = Date.now()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(applications).where(eq(applications.id, id)).for('update');
    if (!row || row.status === 'submitted') return false;
    if (t.from && !t.from.includes(row.status)) return false;
    if (t.unlessCancelled && row.cancelRequested) return false;
    await writeTransition(tx, row, t, now);
    return true;
  });
}

/**
 * A próxima: `queued` com `run_after` vencido e site fora de `excludeSites`; manuais primeiro, depois a mais antiga.
 * A leitura não trava a linha: quem a pega deve reivindicá-la com
 * `transitionApplication(db, id, { status: 'preparing', from: ['queued'] })` e pulá-la se isso devolver false (o dono pode
 * ter cancelado entre a leitura e a gravação).
 */
export async function nextQueuedApplication(
  db: Db,
  opts: { excludeSites: ApplySiteId[] },
  now: number = Date.now(),
): Promise<ApplicationRow | null> {
  const conditions = [
    eq(applications.status, 'queued'),
    sql`(${applications.runAfter} is null or ${applications.runAfter} <= ${sql.param(now, applications.runAfter)})`,
  ];
  if (opts.excludeSites.length > 0) conditions.push(sql`${applications.site} not in ${opts.excludeSites}`);
  const [row] = await db
    .select()
    .from(applications)
    .where(and(...conditions))
    .orderBy(sql`(${applications.trigger} = 'manual') desc`, asc(applications.createdAt), asc(applications.id))
    .limit(1);
  return row ?? null;
}

export async function applicationForJob(db: Db, jobId: number): Promise<ApplicationRow | null> {
  const [row] = await db.select().from(applications).where(eq(applications.jobId, jobId));
  return row ?? null;
}

export async function applicationById(db: Db, id: number): Promise<ApplicationRow | null> {
  const [row] = await db.select().from(applications).where(eq(applications.id, id));
  return row ?? null;
}

export async function listApplicationEvents(db: Db, id: number): Promise<ApplicationEventDto[]> {
  const rows = await db
    .select({ status: eventsTable.status, message: eventsTable.message, at: eventsTable.createdAt })
    .from(eventsTable)
    .where(eq(eventsTable.applicationId, id))
    .orderBy(asc(eventsTable.createdAt), asc(eventsTable.id));
  return rows;
}

/** Teto de linhas de `listApplications` (por filtro). */
export const APPLICATION_LIST_LIMIT = 200;

/**
 * Mais novas primeiro, até 200 (`APPLICATION_LIST_LIMIT`), do filtro da aba (`filter`), de um estado ou de um site. Não
 * seleciona o PDF. As contagens verdadeiras de cada filtro vêm de `applicationFilterCounts`.
 */
export async function listApplications(
  db: Db,
  filter: { filter?: ApplicationFilter; status?: ApplicationStatus; site?: ApplySiteId },
): Promise<ApplicationListItemDto[]> {
  const conditions = [];
  if (filter.filter) conditions.push(inArray(applications.status, [...APPLICATION_FILTER_STATUSES[filter.filter]]));
  if (filter.status) conditions.push(eq(applications.status, filter.status));
  if (filter.site) conditions.push(eq(applications.site, filter.site));
  return db
    .select({
      id: applications.id,
      jobId: applications.jobId,
      jobTitle: jobs.title,
      company: jobs.company,
      site: applications.site,
      status: applications.status,
      reason: applications.reason,
      detail: applications.detail,
      mode: applications.mode,
      gateScore: applications.gateScore,
      pendingCount: sql<number>`jsonb_array_length(${applications.pendingQuestions})::int`.mapWith(Number),
      createdAt: applications.createdAt,
      submittedAt: applications.submittedAt,
    })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(applications.createdAt), desc(applications.id))
    .limit(APPLICATION_LIST_LIMIT);
}

/** Quantas candidaturas há em cada filtro da aba, contadas no banco sobre todas as linhas. */
export async function applicationFilterCounts(db: Db): Promise<Record<ApplicationFilter, number>> {
  const rows = await db
    .select({ status: applications.status, n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(applications)
    .groupBy(applications.status);
  const counts = Object.fromEntries(APPLICATION_FILTERS.map((f) => [f, 0])) as Record<ApplicationFilter, number>;
  for (const r of rows) counts[applicationFilterOf(r.status)] += r.n;
  return counts;
}

/**
 * Colunas de um item do quadro: tudo o que o card usa. Ficam de fora a descrição (o campo mais pesado, só lido no
 * detalhe da vaga) e o `dedupHash` (interno do worker).
 */
const { description: _description, dedupHash: _dedupHash, ...JOB_LIST_COLUMNS } = getTableColumns(jobs);

/**
 * As vagas do quadro (`GET /jobs`), com o estado da candidatura de cada uma (null sem candidatura), na ordem do quadro
 * (posição, id). `where` filtra pela tabela `jobs`.
 */
export async function listJobItems(db: Db, where?: SQL): Promise<JobListItemDto[]> {
  return db
    .select({ ...JOB_LIST_COLUMNS, applicationStatus: applications.status })
    .from(jobs)
    .leftJoin(applications, eq(applications.jobId, jobs.id))
    .where(where)
    .orderBy(asc(jobs.position), asc(jobs.id));
}

/** Sem os bytes do PDF: só `hasResume`. */
export function toApplicationDto(row: ApplicationRow, events: ApplicationEventDto[]): ApplicationDto {
  return {
    id: row.id, jobId: row.jobId, site: row.site, status: row.status, reason: row.reason, detail: row.detail,
    trigger: row.trigger, mode: row.mode, gateScore: row.gateScore, resumeLang: row.resumeLang,
    resumeFileName: row.resumeFileName, hasResume: row.resumePdf !== null, answers: row.answers,
    pendingQuestions: row.pendingQuestions, confirmation: row.confirmation,
    shots: Object.keys(row.shots) as ApplicationDto['shots'], attempts: row.attempts, createdAt: row.createdAt,
    startedAt: row.startedAt, submittedAt: row.submittedAt, finishedAt: row.finishedAt, cancelRequested: row.cancelRequested, events,
  };
}

export interface ApplyCounts {
  forms: Record<ApplySiteId, number>;
  views: Record<ApplySiteId, number>;
  total: number;
}

/** Formulários abertos (`form_opened_at`) e vagas abertas (`viewed_at`) desde `since`, por site. */
export async function applyCountsSince(db: Db, since: number): Promise<ApplyCounts> {
  const rows = await db
    .select({
      site: applications.site,
      forms: sql<number>`count(*) filter (where ${applications.formOpenedAt} >= ${sql.param(since, applications.formOpenedAt)})::int`.mapWith(Number),
      views: sql<number>`count(*) filter (where ${applications.viewedAt} >= ${sql.param(since, applications.viewedAt)})::int`.mapWith(Number),
    })
    .from(applications)
    .groupBy(applications.site);
  const zero = () => Object.fromEntries(APPLY_SITE_IDS.map((s) => [s, 0])) as Record<ApplySiteId, number>;
  const counts: ApplyCounts = { forms: zero(), views: zero(), total: 0 };
  for (const r of rows) {
    counts.forms[r.site] = r.forms;
    counts.views[r.site] = r.views;
    counts.total += r.forms;
  }
  return counts;
}

const normalizedCompany = (value: unknown) => sql`lower(regexp_replace(btrim(${value}), '\\s+', ' ', 'g'))`;

/** Candidaturas com formulário aberto para a empresa (nome sem diferença de caixa e espaços) desde `since`. */
export async function companyFormsSince(db: Db, company: string, since: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .where(and(gte(applications.formOpenedAt, since), sql`${normalizedCompany(jobs.company)} = ${normalizedCompany(company)}`));
  return row.n;
}

export interface ApplyCandidate {
  jobId: number; source: string; url: string; externalId: string; company: string; title: string; score: number;
}

/**
 * Vagas para a varredura: coluna `descobertas`, sem `applied_by`, sem linha em `applications`, descobertas a partir de
 * `discoveredAfter`, com nota da camada 1 em estado `ok`, da versão atual do perfil (`max(profiles.version)`, como em
 * `saveProfile`) e >= `minScore`. Nota mais alta primeiro.
 */
export async function applyCandidates(
  db: Db,
  opts: { minScore: number; discoveredAfter: number; limit: number },
): Promise<ApplyCandidate[]> {
  const rows = await db
    .select({
      jobId: jobs.id, source: jobs.source, url: jobs.url, externalId: jobs.externalId, company: jobs.company,
      title: jobs.title, score: jobAi.score,
    })
    .from(jobs)
    .innerJoin(jobAi, eq(jobAi.jobId, jobs.id))
    .where(
      and(
        eq(jobs.column, 'descobertas'),
        sql`${jobs.appliedBy} is null`,
        sql`not exists (select 1 from ${applications} where ${applications.jobId} = ${jobs.id})`,
        gte(jobs.discoveredAt, opts.discoveredAfter),
        eq(jobAi.tier1State, 'ok'),
        sql`${jobAi.tier1ProfileVersion} = (select max(${candidateProfiles.version}) from ${candidateProfiles})`,
        gte(jobAi.score, opts.minScore),
      ),
    )
    .orderBy(desc(jobAi.score), asc(jobs.id))
    .limit(opts.limit);
  return rows.map((r) => ({ ...r, score: r.score! }));
}

/**
 * No início do worker: `preparing`, `filling` e `waiting_human` voltam a `queued`, ou viram `cancelled` se o dono pediu o
 * cancelamento (o pedido estava pendente, não velho); `submitting` vira `needs_human` com `confirm_submission`, com ou
 * sem pedido (o clique pode ter acontecido).
 */
export async function recoverApplications(db: Db, now: number = Date.now()): Promise<{ requeued: number; unconfirmed: number[] }> {
  const stuck = await db
    .select({ id: applications.id, status: applications.status, cancelRequested: applications.cancelRequested })
    .from(applications)
    .where(inArray(applications.status, [...RUNNING_STATUSES]))
    .orderBy(asc(applications.id));
  let requeued = 0;
  const unconfirmed: number[] = [];
  for (const { id, status, cancelRequested } of stuck) {
    if (status === 'submitting') {
      // O clique final pode ter acontecido: nunca refazer, o dono confere no site.
      const ok = await transitionApplication(
        db, id,
        {
          status: 'needs_human', reason: 'confirm_submission', set: { waitingGate: null, cancelRequested: false },
          message: 'O app foi reiniciado durante o envio: confira no site se a candidatura foi enviada.',
        },
        now,
      );
      if (ok) unconfirmed.push(id);
    } else if (cancelRequested) {
      await transitionApplication(
        db, id,
        { status: 'cancelled', set: { waitingGate: null, cancelRequested: false }, message: 'Cancelada pelo dono.' },
        now,
      );
    } else {
      const ok = await transitionApplication(
        db, id,
        { status: 'queued', set: { waitingGate: null, runAfter: null, cancelRequested: false }, message: 'O app foi reiniciado: voltou para a fila.' },
        now,
      );
      if (ok) requeued += 1;
    }
  }
  return { requeued, unconfirmed };
}

/**
 * O dono moveu o card: `queued`, `needs_human` e `dry_run_ready` viram `cancelled` na hora; `preparing`, `filling`,
 * `waiting_human` e `submitting` ganham `cancel_requested` (o worker para). `submitted`, `skipped`, `failed` e `cancelled`
 * ficam como estão. Devolve se havia o que cancelar. Trava a vaga e depois a candidatura.
 */
export async function requestCancel(db: Db, jobId: number, now: number = Date.now()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).for('update');
    if (!job) return false;
    const [row] = await tx.select().from(applications).where(eq(applications.jobId, jobId)).for('update');
    if (!row) return false;
    if (row.status === 'queued' || row.status === 'needs_human' || row.status === 'dry_run_ready') {
      await writeTransition(tx, row, { status: 'cancelled', message: 'Cancelada pelo dono.' }, now);
      return true;
    }
    if ((RUNNING_STATUSES as readonly string[]).includes(row.status)) {
      await tx.update(applications).set({ cancelRequested: true }).where(eq(applications.id, row.id));
      return true;
    }
    return false;
  });
}

/**
 * Pedido da API ao worker. Devolve o id, ou null se já há um igual pendente (índice único parcial). Comando sem site
 * (`close_browser`) grava `''` na coluna, que não aceita nulo e precisa de valor para o índice único valer.
 */
export async function enqueueApplyCommand(
  db: Db,
  kind: ApplyCommandKind,
  site: ApplySiteId | null,
  now: number = Date.now(),
): Promise<number | null> {
  const [row] = await db
    .insert(applyCommands)
    .values({ kind, site: (site ?? '') as ApplySiteId, status: 'queued', createdAt: now })
    .onConflictDoNothing()
    .returning({ id: applyCommands.id });
  return row?.id ?? null;
}

/**
 * No início do worker: todo comando `running` ficou para trás (o índice único parcial o manteria bloqueando o mesmo tipo e
 * site para sempre) e vira `error`. Devolve quantos.
 */
export async function recoverApplyCommands(db: Db, now: number = Date.now()): Promise<number> {
  const rows = await db
    .update(applyCommands)
    .set({ status: 'error', result: 'interrompido: o worker reiniciou', finishedAt: now })
    .where(eq(applyCommands.status, 'running'))
    .returning({ id: applyCommands.id });
  return rows.length;
}

/** O mais antigo na fila, marcado `running`. */
export async function nextApplyCommand(db: Db): Promise<ApplyCommandRow | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(applyCommands)
      .where(eq(applyCommands.status, 'queued'))
      .orderBy(asc(applyCommands.id))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!row) return null;
    const [running] = await tx.update(applyCommands).set({ status: 'running' }).where(eq(applyCommands.id, row.id)).returning();
    return running;
  });
}

export async function finishApplyCommand(
  db: Db,
  id: number,
  result: { ok: boolean; message?: string },
  now: number = Date.now(),
): Promise<void> {
  await db
    .update(applyCommands)
    .set({ status: result.ok ? 'ok' : 'error', result: result.message ?? null, finishedAt: now })
    .where(eq(applyCommands.id, id));
}

/**
 * Chave da linha de `settings` onde o worker publica se a candidatura automática pode rodar nele. Não é uma configuração
 * da tela (o serviço de configurações ignora chaves que não conhece) e sobrevive a "Apagar todos os dados de IA".
 */
const WORKER_STATE_KEY = 'applyWorkerState';

/** O worker publica a disponibilidade (no início e quando muda); a API a mostra em `GET /apply/status`. */
export async function saveApplyWorkerState(
  db: Db, state: { available: boolean; reason: string | null }, now: number = Date.now(),
): Promise<void> {
  const value = { available: state.available, reason: state.reason, seenAt: now };
  await db
    .insert(settings)
    .values({ key: WORKER_STATE_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

/** O que o worker publicou da última vez; null se nenhum worker publicou (ou a linha não tem a forma esperada). */
export async function applyWorkerState(db: Db): Promise<ApplyWorkerState | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, WORKER_STATE_KEY));
  const v = row?.value as Partial<ApplyWorkerState> | undefined;
  if (!v || typeof v.available !== 'boolean' || typeof v.seenAt !== 'number' || !(v.reason === null || typeof v.reason === 'string')) {
    return null;
  }
  return { available: v.available, reason: v.reason, seenAt: v.seenAt };
}

/** Lê o estado do site, criando a linha com os padrões na primeira vez. */
export async function siteState(db: Db, site: ApplySiteId): Promise<ApplySiteRow> {
  await db.insert(applySites).values({ site }).onConflictDoNothing();
  const [row] = await db.select().from(applySites).where(eq(applySites.site, site));
  return row;
}

export async function updateSiteState(db: Db, site: ApplySiteId, patch: Partial<Omit<ApplySiteRow, 'site'>>): Promise<void> {
  await db.insert(applySites).values({ site }).onConflictDoNothing();
  if (Object.keys(patch).length === 0) return;
  await db.update(applySites).set(patch).where(eq(applySites.site, site));
}

/**
 * Apaga o banco de respostas e esvazia o conteúdo das candidaturas: respostas, pendências, PDF, fotos (a coluna; os
 * arquivos em `<pasta de dados>/shots` e `/resumes` são da rota), e-mail, confirmação, detalhe e os textos dos eventos.
 * Estado e datas ficam, menos nas que esperavam perguntas do dono: sem as pendências não há o que responder, então viram
 * `cancelled` e a marca "precisa de você" do card sai. Trava as vagas antes das candidaturas.
 */
export async function deleteApplyData(db: Db, now: number = Date.now()): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(applyAnswers);
    await tx.update(eventsTable).set({ message: null });
    const questionWait = and(eq(applications.status, 'needs_human'), eq(applications.reason, 'question'));
    const waitingJobs = (await tx.select({ jobId: applications.jobId }).from(applications).where(questionWait)).map((r) => r.jobId);
    if (waitingJobs.length > 0) {
      await tx.update(jobs).set({ needsHuman: false, needsHumanReason: null }).where(inArray(jobs.id, waitingJobs));
    }
    const waiting = await tx.select().from(applications).where(questionWait).orderBy(asc(applications.id)).for('update');
    await tx
      .update(applications)
      .set({
        answers: [], approvedAnswers: [], pendingQuestions: [], resumePdf: null, shots: {}, contactEmail: null, confirmation: null,
        detail: null,
      });
    for (const row of waiting) {
      await writeTransition(
        tx, row,
        { status: 'cancelled', message: 'Os dados de IA foram apagados: a candidatura foi cancelada.', set: { cancelRequested: false, waitingGate: null } },
        now,
      );
    }
  });
}

/** A linha da candidatura travada até o fim da transação (`db` é a transação). Null se não existe. Traz o PDF: não use em listagens. */
export async function lockApplication(db: Db, id: number): Promise<ApplicationRow | null> {
  const [row] = await db.select().from(applications).where(eq(applications.id, id)).for('update');
  return row ?? null;
}

export type JobRow = typeof jobs.$inferSelect;

/**
 * A vaga e a candidatura travadas, nesta ordem (`db` é a transação): a ordem dos locks é uma só em todo lugar, a vaga
 * primeiro (a rota que move o card trava a vaga e depois a candidatura). Null se a candidatura não existe.
 */
export async function lockApplicationWithJob(db: Db, id: number): Promise<{ row: ApplicationRow; job: JobRow } | null> {
  const [ref] = await db.select({ jobId: applications.jobId }).from(applications).where(eq(applications.id, id));
  if (!ref) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, ref.jobId)).for('update');
  if (!job) return null;
  const row = await lockApplication(db, id);
  return row ? { row, job } : null;
}

/** O dono já se candidatou a esta vaga: o card está em Aplicada ou depois, ou `applied_by` está preenchido. */
export function jobAlreadyApplied(job: Pick<JobRow, 'column' | 'appliedBy'>): boolean {
  return isAppliedOrLater(job.column) || job.appliedBy !== null;
}

const APPLIED_BY_OWNER_MESSAGE = 'Você marcou esta vaga como aplicada.';

/**
 * O dono moveu o card para Aplicada ou depois (ou disse "Já apliquei por conta própria"): uma candidatura em `queued`,
 * `needs_human` (qualquer motivo, `confirm_submission` também) ou `dry_run_ready` vira `skipped` com `already_applied`, sem
 * pendências, e a marca "precisa de você" do card sai; uma em andamento só ganha o pedido de cancelamento. As demais ficam
 * como estão. Trava a vaga e depois a candidatura. Devolve se havia o que mudar.
 */
export async function settleAppliedByOwner(db: Db, jobId: number, now: number = Date.now()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).for('update');
    if (!job) return false;
    const [row] = await tx.select().from(applications).where(eq(applications.jobId, jobId)).for('update');
    if (!row) return false;
    if (row.status === 'queued' || row.status === 'needs_human' || row.status === 'dry_run_ready') {
      await writeTransition(
        tx, row,
        {
          status: 'skipped', reason: 'already_applied', message: APPLIED_BY_OWNER_MESSAGE,
          set: { pendingQuestions: [], cancelRequested: false, waitingGate: null, runAfter: null },
        },
        now,
      );
      await tx.update(jobs).set({ needsHuman: false, needsHumanReason: null }).where(eq(jobs.id, jobId));
      return true;
    }
    if ((RUNNING_STATUSES as readonly string[]).includes(row.status)) {
      await tx.update(applications).set({ cancelRequested: true }).where(eq(applications.id, row.id));
      return true;
    }
    return false;
  });
}

/** Quantas candidaturas esperam na fila, quantas esperam o dono e quantas estão em andamento. */
export async function applicationQueueCounts(db: Db): Promise<{ queued: number; needsHuman: number; running: number }> {
  const [row] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${applications.status} = 'queued')::int`.mapWith(Number),
      needsHuman: sql<number>`count(*) filter (where ${applications.status} = 'needs_human')::int`.mapWith(Number),
      running: sql<number>`count(*) filter (where ${applications.status} in ('preparing', 'filling', 'waiting_human', 'submitting'))::int`.mapWith(Number),
    })
    .from(applications);
  return row;
}

/**
 * A candidatura parada numa espera ao vivo (captcha, código, login), se houver: `waiting_gate` preenchido com o estado
 * `waiting_human` (antes do clique de envio) ou `submitting` (depois dele, o estado gravado não muda durante a espera).
 */
export async function waitingApplication(db: Db): Promise<{ applicationId: number; jobId: number; gate: string } | null> {
  const [row] = await db
    .select({ applicationId: applications.id, jobId: applications.jobId, gate: applications.waitingGate })
    .from(applications)
    .where(and(isNotNull(applications.waitingGate), inArray(applications.status, ['waiting_human', 'submitting'])))
    .orderBy(asc(applications.id))
    .limit(1);
  return row ? { ...row, gate: row.gate ?? 'unknown' } : null;
}

export type RetryOutcome = 'queued' | 'not_found' | 'sent' | 'in_progress' | 'already_applied' | 'confirm_submission' | 'not_retryable';

/**
 * Botão "Tentar de novo": `needs_human`, `failed`, `skipped` e `cancelled` voltam a `queued` (sem espera e sem tentativas
 * gastas; uma pulada pela conferência, `below_min_score` ou `not_eligible`, volta como manual). Nunca copia nada para `approved_answers`. `submitted` é recusada (`sent`), uma linha em andamento também
 * (`in_progress`), uma vaga que o dono já aplicou (`already_applied`: card em Aplicada ou depois, ou `applied_by`
 * preenchido) também, e uma parada em `confirm_submission` nunca volta por botão: depois do clique ninguém sabe se o site
 * recebeu. Trava a vaga e depois a candidatura.
 */
export async function retryApplication(db: Db, id: number, now: number = Date.now()): Promise<RetryOutcome> {
  return db.transaction(async (tx) => {
    const locked = await lockApplicationWithJob(tx, id);
    if (!locked) return 'not_found';
    const { row, job } = locked;
    if (row.status === 'submitted') return 'sent';
    if ((RUNNING_STATUSES as readonly string[]).includes(row.status)) return 'in_progress';
    if (jobAlreadyApplied(job)) return 'already_applied';
    if (row.status === 'needs_human' && row.reason === 'confirm_submission') return 'confirm_submission';
    if (!['needs_human', 'failed', 'skipped', 'cancelled'].includes(row.status)) return 'not_retryable';
    // Tentar de novo uma vaga que a conferência pulou é a mesma decisão de "Aplicar com IA": volta como manual.
    const gateSkipped = row.status === 'skipped' && (row.reason === 'below_min_score' || row.reason === 'not_eligible');
    await writeTransition(
      tx, row,
      {
        status: 'queued', message: 'O dono pediu para tentar de novo.',
        set: {
          runAfter: null, attempts: 0, cancelRequested: false, waitingGate: null, finishedAt: null,
          ...(gateSkipped ? { trigger: 'manual' as const } : {}),
        },
      },
      now,
    );
    await tx.update(jobs).set({ needsHuman: false, needsHumanReason: null }).where(eq(jobs.id, row.jobId));
    return 'queued';
  });
}

async function approveRow(tx: Db, row: ApplicationRow, now: number): Promise<void> {
  // Um único UPDATE: estado, modo e as respostas aprovadas (as que o dono viu no ensaio) mudam juntos.
  await tx
    .update(applications)
    .set({
      status: 'queued', mode: 'real', approvedAnswers: row.answers, reason: null, detail: null, runAfter: null,
      attempts: 0, cancelRequested: false, finishedAt: null,
    })
    .where(eq(applications.id, row.id));
  await tx.insert(eventsTable).values({
    applicationId: row.id, status: 'queued', message: 'O dono aprovou o ensaio e pediu o envio de verdade.', createdAt: now,
  });
}

/**
 * "Enviar de verdade": só de `dry_run_ready` e de uma vaga que o dono ainda não aplicou (`already_applied`). As respostas
 * do ensaio viram `approved_answers`. Trava a vaga e depois a candidatura.
 */
export async function sendRehearsal(
  db: Db, id: number, now: number = Date.now(),
): Promise<'queued' | 'not_found' | 'not_rehearsal' | 'already_applied'> {
  return db.transaction(async (tx) => {
    const locked = await lockApplicationWithJob(tx, id);
    if (!locked) return 'not_found';
    const { row, job } = locked;
    if (row.status !== 'dry_run_ready') return 'not_rehearsal';
    if (jobAlreadyApplied(job)) return 'already_applied';
    await approveRow(tx, row, now);
    return 'queued';
  });
}

/**
 * "Enviar todos os ensaios": o mesmo de `sendRehearsal` para exatamente as candidaturas de `ids` (as que a tela listou)
 * que ainda estão em `dry_run_ready` e cuja vaga o dono não aplicou. Devolve quantas foram para a fila e quantas ficaram
 * de fora (não existem, saíram do ensaio, vaga já aplicada). Trava as vagas e depois as candidaturas.
 */
export async function sendAllRehearsals(
  db: Db, ids: number[], now: number = Date.now(),
): Promise<{ queued: number; skipped: number }> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return { queued: 0, skipped: 0 };
  return db.transaction(async (tx) => {
    const refs = await tx.select({ jobId: applications.jobId }).from(applications).where(inArray(applications.id, wanted));
    const lockedJobs = refs.length === 0 ? [] : await tx
      .select()
      .from(jobs)
      .where(inArray(jobs.id, refs.map((r) => r.jobId)))
      .orderBy(asc(jobs.id))
      .for('update');
    const jobById = new Map(lockedJobs.map((j) => [j.id, j]));
    const rows = await tx
      .select()
      .from(applications)
      .where(and(inArray(applications.id, wanted), eq(applications.status, 'dry_run_ready')))
      .orderBy(asc(applications.id))
      .for('update');
    let queued = 0;
    for (const row of rows) {
      const job = jobById.get(row.jobId);
      if (!job || jobAlreadyApplied(job)) continue;
      await approveRow(tx, row, now);
      queued += 1;
    }
    return { queued, skipped: wanted.length - queued };
  });
}

/**
 * Candidaturas paradas em `needs_human` por `question` (exceto `exceptId`) voltam à fila, com a marca "precisa de você"
 * desligada: uma resposta nova pode servir a elas. Mantêm `approved_answers` e `mode`. Devolve os ids.
 */
export async function requeueQuestionWaits(db: Db, exceptId: number, now: number = Date.now()): Promise<number[]> {
  const waiting = and(eq(applications.status, 'needs_human'), eq(applications.reason, 'question'), sql`${applications.id} <> ${exceptId}`);
  const candidates = await db.select({ jobId: applications.jobId }).from(applications).where(waiting);
  if (candidates.length === 0) return [];
  // A vaga primeiro, depois a candidatura (a ordem de todo lugar). Uma vaga ou linha que outra ação do dono já travou
  // (outro PUT de respostas, que recoloca a linha dele na fila; uma mudança de card, que a cancela) fica de fora:
  // pular evita o impasse entre as duas.
  const lockedJobs = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(inArray(jobs.id, candidates.map((c) => c.jobId)))
    .orderBy(asc(jobs.id))
    .for('update', { skipLocked: true });
  if (lockedJobs.length === 0) return [];
  const rows = await db
    .select()
    .from(applications)
    .where(and(waiting, inArray(applications.jobId, lockedJobs.map((j) => j.id))))
    .orderBy(asc(applications.id))
    .for('update', { skipLocked: true });
  for (const row of rows) {
    await writeTransition(db, row, { status: 'queued', message: 'Uma resposta nova foi salva: voltou para a fila.', set: { runAfter: null, cancelRequested: false } }, now);
  }
  if (rows.length > 0) {
    await db
      .update(jobs)
      .set({ needsHuman: false, needsHumanReason: null })
      .where(inArray(jobs.id, rows.map((r) => r.jobId)));
  }
  return rows.map((r) => r.id);
}

/**
 * O dono respondeu parte (ou todas) das perguntas: grava o que sobrou em `pending_questions`. Se não resta pergunta
 * obrigatória, a candidatura volta a `queued` sem pendências e a marca "precisa de você" sai; senão fica em `needs_human`.
 * Devolve se voltou à fila. Chame dentro da transação que gravou as respostas, depois das gravações.
 */
export async function settlePendingQuestions(
  db: Db,
  row: ApplicationRow,
  remaining: ApplicationRow['pendingQuestions'],
  now: number = Date.now(),
): Promise<boolean> {
  if (remaining.some((p) => p.question.required)) {
    await db.update(applications).set({ pendingQuestions: remaining }).where(eq(applications.id, row.id));
    return false;
  }
  await writeTransition(
    db, row,
    { status: 'queued', message: 'O dono respondeu as perguntas.', set: { pendingQuestions: [], runAfter: null, cancelRequested: false } },
    now,
  );
  await db.update(jobs).set({ needsHuman: false, needsHumanReason: null }).where(eq(jobs.id, row.jobId));
  return true;
}
