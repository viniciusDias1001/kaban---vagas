import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dayStartMs, type AiConfig, type AiProvider } from '@kv/ai';
import { capsLeft, nextAllowedAt, withinWindow, type ApplySite, type BrowserSession } from '@kv/apply';
import type { DescriptionFetcher } from '@kv/connectors';
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  applicationById, applications, applyCountsSince, finishApplyCommand, nextApplyCommand, nextQueuedApplication, recoverApplications,
  recoverApplyCommands, saveApplyWorkerState, siteState, transitionApplication, type ApplicationRow, type Db,
} from '@kv/db';
import type { SettingsService } from '@kv/settings';
import { APPLY_SITE_IDS, APPLY_TIMING, type ApplyConfig, type ApplySiteId } from '@kv/shared';
import { needsHumanText, setNeedsHuman } from './board';
import { runApplyCommand } from './commands';
import { DAY_MS } from './day';
import { runOne } from './run';
import { sweepCandidates } from './sweep';

export interface ApplyQueueDeps {
  db: Db;
  settings: SettingsService;
  sites: () => ApplySite[];
  browser: BrowserSession;
  dataDir: string;
  ai: () => Promise<{ provider: AiProvider; config: AiConfig }>;
  fetchDescription: DescriptionFetcher;
  /** `applyAvailability(process.env)` e navegador encontrado; uma função é lida a cada verificação. */
  availability: Availability | (() => Availability);
  sweepMs?: number;
  humanPollMs?: number;
  now?: () => number;
  random?: () => number;
  log?: (msg: string) => void;
  /** Padrões de APPLY_TIMING; os testes encurtam. */
  humanWaitMs?: number;
  workTimeoutMs?: number;
  abortGraceMs?: number;
}

export interface Availability { available: boolean; reason: string | null }

export interface ApplyTickResult { commands: number; swept: number; started: boolean }

export interface ApplyQueue {
  tick(): Promise<ApplyTickResult>;
  recoverInterrupted(): Promise<void>;
  /** Resolve quando não há candidatura em andamento. */
  idle(): Promise<void>;
  inFlightId(): number | null;
}

const DEFAULT_HUMAN_POLL_MS = 2_000;
const DEFAULT_ABORT_GRACE_MS = 15_000;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A fila de candidaturas do worker: uma candidatura por vez, sem que `tick()` espere por ela.
 *
 * A cada verificação, nesta ordem:
 * 0. publica a disponibilidade (`saveApplyWorkerState`) na primeira verificação e sempre que ela muda, com o motivo no
 *    log quando indisponível;
 * 1. função indisponível (HOST não local, navegador não encontrado): cada comando do app termina em erro com o motivo, e
 *    nada mais. Disponível: roda os comandos pendentes do app,
 *    mesmo com a função desligada, para o dono conectar as contas antes (não com uma candidatura usando o navegador);
 * 2. sem candidatura em andamento, fecha o navegador parado há mais de `browserIdleMs`, menos com uma janela de login
 *    esperando o dono (até a conferência de sessão achar o dono conectado, ou `humanWaitMs` depois do `open_login`);
 * 3. uma vez por dia, ligada ou desligada, apaga as fotos com mais de `shotRetentionDays` dias e as tira da coluna
 *    `shots`; função desligada: para aqui;
 * 4. a cada `sweepMs`, dentro do horário, cria as candidaturas automáticas que cabem hoje (`sweepCandidates`);
 * 5. sem candidatura em andamento nem janela de login esperando, reivindica a próxima (`preparing`, guardada por
 *    `from: ['queued']`) fora dos sites pausados ou ainda no intervalo de ritmo, e fora dos sites sem limite sobrando
 *    (salvo uma linha que já abriu o formulário hoje); fora do horário só as manuais. O modo atual do site vale na
 *    reivindicação (um envio de verdade sem respostas aprovadas vira ensaio num site em ensaio). Começa uma e não espera.
 */
export function createApplyQueue(deps: ApplyQueueDeps): ApplyQueue {
  const { db, browser, availability } = deps;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const log = deps.log ?? (() => {});
  const sweepMs = deps.sweepMs ?? APPLY_TIMING.sweepMs;

  let inFlight: { id: number; done: Promise<void> } | null = null;
  let ticking = false;
  let lastSweep: number | null = null;
  let lastCleanupDay: number | null = null;
  /** O instante sorteado em que cada site pode abrir o próximo formulário, por último formulário/vaga registrados. */
  const pace = new Map<string, number>();
  const humanWaitMs = deps.humanWaitMs ?? APPLY_TIMING.humanWaitMs;
  /**
   * Janelas de login abertas por `open_login`, por site, com o instante do comando. Enquanto uma espera, o navegador não
   * fecha por ociosidade e nenhuma candidatura começa, em site nenhum (navegaria a página do dono para outro lugar).
   */
  const loginWaits = new Map<ApplySiteId, number>();
  /** Quando a última espera de login acabou: a ociosidade conta a partir daí. */
  let idleFrom = 0;

  function readyAt(site: ApplySiteId, last: { lastFormAt: number | null; lastViewAt: number | null }): number {
    const key = `${site}:${last.lastFormAt}:${last.lastViewAt}`;
    let at = pace.get(key);
    if (at === undefined) {
      const times = { formAt: last.lastFormAt, viewAt: last.lastViewAt };
      at = Math.max(nextAllowedAt(site, times, 'form', random), site === 'linkedin' ? nextAllowedAt(site, times, 'view', random) : 0);
      for (const k of pace.keys()) if (k.startsWith(`${site}:`)) pace.delete(k);
      pace.set(key, at);
    }
    return at;
  }

  async function runCommands(): Promise<number> {
    let n = 0;
    for (let command = await nextApplyCommand(db); command; command = await nextApplyCommand(db)) {
      const result = await runApplyCommand({ db, sites: deps.sites, browser, now }, command);
      if (command.kind === 'open_login' && result.ok && command.site) loginWaits.set(command.site, now());
      n += 1;
    }
    return n;
  }

  /**
   * Encerra as esperas de login que acabaram: a conferência de sessão do site (o comando `check_session`) achou o dono
   * conectado depois do `open_login`, passou `humanWaitMs` desde ele, ou a janela não está mais aberta.
   */
  async function endLoginWaits(): Promise<void> {
    const at = now();
    for (const [site, since] of loginWaits) {
      let over = !browser.isOpen() || at - since >= humanWaitMs;
      if (!over) {
        const state = await siteState(db, site);
        over = state.session === 'logged_in' && state.sessionCheckedAt !== null && state.sessionCheckedAt > since;
      }
      if (over) {
        loginWaits.delete(site);
        idleFrom = at;
      }
    }
  }

  /**
   * Sites de onde nada pode começar agora. `blocked`: não cadastrados, pausados ou no intervalo de ritmo. `capped`: sem
   * limite sobrando hoje (só uma linha que já abriu o formulário hoje sai deles).
   */
  async function blockedSites(
    cfg: ApplyConfig, sites: ApplySite[], at: number,
  ): Promise<{ blocked: ApplySiteId[]; capped: ApplySiteId[] }> {
    const counts = await applyCountsSince(db, dayStartMs(at, cfg.timeZone));
    const blocked = new Set<ApplySiteId>(APPLY_SITE_IDS.filter((id) => !sites.some((s) => s.id === id)));
    const capped: ApplySiteId[] = [];
    for (const site of sites) {
      const state = await siteState(db, site.id);
      const left = capsLeft(counts, cfg.dailyCaps, site.id);
      if (state.paused || readyAt(site.id, state) > at) blocked.add(site.id);
      else if (left.forms <= 0 || left.views <= 0) capped.push(site.id);
    }
    return { blocked: [...blocked], capped };
  }

  /**
   * A próxima na fila, nos sites sem limite sobrando hoje, que já abriu o formulário hoje: ela já ocupa a vaga dela no
   * dia (o limite do site e o total) e não conta de novo. Manuais primeiro, depois a mais antiga.
   */
  async function nextOpenedToday(sites: ApplySiteId[], dayStart: number, at: number): Promise<ApplicationRow | null> {
    const [row] = await db
      .select()
      .from(applications)
      .where(
        and(
          eq(applications.status, 'queued'),
          inArray(applications.site, sites),
          gte(applications.formOpenedAt, dayStart),
          or(isNull(applications.runAfter), lte(applications.runAfter, at)),
        ),
      )
      .orderBy(sql`(${applications.trigger} = 'manual') desc`, asc(applications.createdAt), asc(applications.id))
      .limit(1);
    return row ?? null;
  }

  function start(cfg: ApplyConfig, sites: ApplySite[], row: Parameters<typeof runOne>[1]): void {
    const done = runOne(
      {
        db, cfg, sites, browser, dataDir: deps.dataDir, ai: deps.ai, fetchDescription: deps.fetchDescription, now, log,
        humanPollMs: deps.humanPollMs ?? DEFAULT_HUMAN_POLL_MS, humanWaitMs: deps.humanWaitMs ?? APPLY_TIMING.humanWaitMs,
        workTimeoutMs: deps.workTimeoutMs ?? APPLY_TIMING.workTimeoutMs, abortGraceMs: deps.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS,
      },
      row,
    )
      .catch((e) => log(`candidatura ${row.id}: ${errorText(e)}`))
      .finally(() => {
        if (inFlight?.done === done) inFlight = null;
      });
    inFlight = { id: row.id, done };
  }

  async function startNext(cfg: ApplyConfig, within: boolean): Promise<boolean> {
    // O navegador tem uma página e um usuário por vez: com uma janela de login esperando o dono, nada começa em site
    // nenhum (navegaria a página dele para outro lugar).
    if (loginWaits.size > 0) return false;
    const sites = deps.sites();
    const at = now();
    const { blocked, capped } = await blockedSites(cfg, sites, at);
    const excludeSites = [...blocked, ...capped];
    // As manuais saem primeiro: se a primeira é automática, fora do horário não há o que começar.
    const startable = (r: ApplicationRow | null) => r !== null && (within || r.trigger === 'manual');
    let row = excludeSites.length < APPLY_SITE_IDS.length ? await nextQueuedApplication(db, { excludeSites }, at) : null;
    if (!startable(row) && capped.length > 0) row = (await nextOpenedToday(capped, dayStartMs(at, cfg.timeZone), at)) ?? row;
    if (!row || !startable(row)) return false;
    // O modo ATUAL do site vale quando a candidatura começa: uma linha criada como envio de verdade num site que voltou
    // ao ensaio vira ensaio, na mesma gravação que a reivindica. Só a que o dono mandou ("Enviar de verdade", com
    // respostas aprovadas) segue de verdade. O contrário nunca acontece: um ensaio não vira envio sozinho.
    const rehearse = row.mode === 'real' && cfg.siteModes[row.site] !== 'real' && row.approvedAnswers.length === 0;
    const claim = rehearse
      ? { status: 'preparing' as const, from: ['queued' as const], set: { mode: 'dry_run' as const }, message: 'O site está em modo ensaio: a candidatura vai como ensaio.' }
      : { status: 'preparing' as const, from: ['queued' as const] };
    if (!(await transitionApplication(db, row.id, claim, at))) return false;
    start(cfg, sites, { ...row, status: 'preparing', mode: rehearse ? 'dry_run' : row.mode });
    return true;
  }

  async function cleanupShots(at: number, timeZone: string): Promise<void> {
    const day = dayStartMs(at, timeZone);
    if (lastCleanupDay === day) return;
    lastCleanupDay = day;
    const cutoff = at - APPLY_TIMING.shotRetentionDays * DAY_MS;
    const root = join(deps.dataDir, 'shots');
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const path = join(root, dir.name);
      const removed = new Set<string>();
      for (const file of await readdir(path).catch(() => [] as string[])) {
        const filePath = join(path, file);
        const info = await stat(filePath).catch(() => null);
        if (info && info.mtimeMs < cutoff) {
          await rm(filePath, { force: true });
          removed.add(`shots/${dir.name}/${file}`); // o caminho relativo que `shotPath` grava
        }
      }
      if (removed.size > 0 && /^\d+$/.test(dir.name)) await dropShots(Number(dir.name), removed);
      if ((await readdir(path).catch(() => ['?'])).length === 0) await rm(path, { recursive: true, force: true });
    }
  }

  /** Tira da coluna `shots` da candidatura as fotos cujos arquivos foram apagados. */
  async function dropShots(id: number, removed: Set<string>): Promise<void> {
    const [row] = await db.select({ shots: applications.shots }).from(applications).where(eq(applications.id, id));
    if (!row) return;
    const kept = Object.fromEntries(Object.entries(row.shots).filter(([, rel]) => !removed.has(rel))) as typeof row.shots;
    if (Object.keys(kept).length === Object.keys(row.shots).length) return;
    await db.update(applications).set({ shots: kept }).where(eq(applications.id, id));
  }

  /** O último estado publicado (`available` e motivo), para publicar e registrar no log só quando muda. */
  let published: string | null = null;

  async function publish(current: Availability): Promise<void> {
    const key = JSON.stringify([current.available, current.reason]);
    if (key === published) return;
    await saveApplyWorkerState(db, current, now());
    if (!current.available) log(`candidaturas indisponíveis: ${current.reason ?? 'motivo desconhecido'}`);
    else if (published !== null) log('candidaturas disponíveis de novo');
    published = key;
  }

  /** Indisponível: cada comando do app termina em erro com o motivo (a tela de contas o mostra), sem tocar o navegador. */
  async function refuseCommands(reason: string): Promise<number> {
    let n = 0;
    for (let command = await nextApplyCommand(db); command; command = await nextApplyCommand(db)) {
      await finishApplyCommand(db, command.id, { ok: false, message: reason }, now());
      n += 1;
    }
    return n;
  }

  async function tick(): Promise<ApplyTickResult> {
    const result: ApplyTickResult = { commands: 0, swept: 0, started: false };
    if (ticking) return result;
    const current = typeof availability === 'function' ? availability() : availability;
    if (!current.available) {
      ticking = true;
      try {
        await publish(current);
        result.commands = await refuseCommands(current.reason ?? 'a candidatura automática está indisponível neste worker');
        return result;
      } finally {
        ticking = false;
      }
    }
    ticking = true;
    try {
      await publish(current);
      // O navegador é um só: com uma candidatura nele, os comandos esperam a próxima verificação.
      if (!inFlight) result.commands = await runCommands();
      await endLoginWaits();
      // Uma janela de login esperando o dono não fecha por ociosidade.
      const idleSince = Math.max(browser.lastUsedAt(), idleFrom);
      if (!inFlight && loginWaits.size === 0 && browser.isOpen() && now() - idleSince > APPLY_TIMING.browserIdleMs) await browser.close();

      const cfg = await deps.settings.applyConfig();
      // As fotos antigas saem também com a função desligada: o prazo de guarda vale sempre.
      await cleanupShots(now(), cfg.timeZone).catch((e) => log(`candidaturas: erro ao apagar fotos antigas: ${errorText(e)}`));
      if (!cfg.enabled) return result;
      const at = now();
      const within = withinWindow(at, cfg.window, cfg.timeZone);
      if (within && (lastSweep === null || at - lastSweep >= sweepMs)) {
        lastSweep = at;
        try {
          result.swept = await sweepCandidates(db, cfg, deps.sites(), at);
        } catch (e) {
          log(`candidaturas: erro na varredura: ${errorText(e)}`);
        }
      }
      if (!inFlight) result.started = await startNext(cfg, within);
      return result;
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    /**
     * Só no início do worker: o que ficou `running` é de um processo anterior. Comandos viram erro; candidaturas antes do
     * clique voltam à fila; uma encontrada em `submitting` nunca é reenviada: vai ao dono confirmar no site. Os PDFs que
     * uma execução morta deixou em `<pasta de dados>/resumes` são apagados (cada execução grava o seu de novo).
     */
    async recoverInterrupted() {
      await rm(join(deps.dataDir, 'resumes'), { recursive: true, force: true })
        .catch((e) => log(`candidaturas: não foi possível apagar os currículos deixados por uma execução anterior: ${errorText(e)}`));
      const commands = await recoverApplyCommands(db, now());
      if (commands > 0) log(`candidaturas: ${commands} comandos interrompidos marcados como erro`);
      const { requeued, unconfirmed } = await recoverApplications(db, now());
      if (requeued > 0) log(`candidaturas: ${requeued} interrompidas voltaram para a fila`);
      for (const id of unconfirmed) {
        const row = await applicationById(db, id);
        if (row) await setNeedsHuman(db, row.jobId, needsHumanText('confirm_submission', 'O app foi reiniciado durante o envio: confira no site se a candidatura chegou.'));
      }
      if (unconfirmed.length > 0) log(`candidaturas: ${unconfirmed.length} interrompidas durante o envio aguardam a sua conferência`);
    },
    async idle() {
      while (inFlight) await inFlight.done;
    },
    inFlightId: () => inFlight?.id ?? null,
  };
}
