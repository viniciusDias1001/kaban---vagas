import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dayStartMs, type AiConfig, type AiProvider } from '@kv/ai';
import { capsLeft, nextAllowedAt, withinWindow, type ApplySite, type BrowserSession } from '@kv/apply';
import type { DescriptionFetcher } from '@kv/connectors';
import {
  applicationById, applyCountsSince, nextApplyCommand, nextQueuedApplication, recoverApplications, recoverApplyCommands,
  siteState, transitionApplication, type Db,
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
  /** `applyAvailability(process.env)` e navegador encontrado. */
  availability: { available: boolean; reason: string | null };
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
 * 1. função indisponível (HOST não local, navegador não encontrado): nada. Disponível: roda os comandos pendentes do app,
 *    mesmo com a função desligada, para o dono conectar as contas antes (não com uma candidatura usando o navegador);
 * 2. sem candidatura em andamento, fecha o navegador parado há mais de `browserIdleMs`;
 * 3. função desligada: para aqui;
 * 4. a cada `sweepMs`, dentro do horário, cria as candidaturas automáticas que cabem hoje (`sweepCandidates`);
 * 5. sem candidatura em andamento, reivindica a próxima (`preparing`, guardada por `from: ['queued']`) fora dos sites
 *    pausados, sem limite sobrando ou ainda no intervalo de ritmo; fora do horário só as manuais. Começa uma e não espera;
 * 6. uma vez por dia, apaga as fotos com mais de `shotRetentionDays` dias.
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
      await runApplyCommand({ db, sites: deps.sites, browser, now }, command);
      n += 1;
    }
    return n;
  }

  /** Sites de onde nada pode começar agora: não cadastrados, pausados, sem limite sobrando hoje ou no intervalo de ritmo. */
  async function blockedSites(cfg: ApplyConfig, sites: ApplySite[], at: number): Promise<ApplySiteId[]> {
    const counts = await applyCountsSince(db, dayStartMs(at, cfg.timeZone));
    const blocked = new Set<ApplySiteId>(APPLY_SITE_IDS.filter((id) => !sites.some((s) => s.id === id)));
    for (const site of sites) {
      const state = await siteState(db, site.id);
      const left = capsLeft(counts, cfg.dailyCaps, site.id);
      if (state.paused || left.forms <= 0 || left.views <= 0 || readyAt(site.id, state) > at) blocked.add(site.id);
    }
    return [...blocked];
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
    const sites = deps.sites();
    const at = now();
    const excludeSites = await blockedSites(cfg, sites, at);
    if (excludeSites.length >= APPLY_SITE_IDS.length) return false;
    const row = await nextQueuedApplication(db, { excludeSites }, at);
    // As manuais saem primeiro: se a primeira é automática, fora do horário não há o que começar.
    if (!row || (!within && row.trigger !== 'manual')) return false;
    if (!(await transitionApplication(db, row.id, { status: 'preparing', from: ['queued'] }, at))) return false;
    start(cfg, sites, { ...row, status: 'preparing' });
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
      for (const file of await readdir(path).catch(() => [] as string[])) {
        const filePath = join(path, file);
        const info = await stat(filePath).catch(() => null);
        if (info && info.mtimeMs < cutoff) await rm(filePath, { force: true });
      }
      if ((await readdir(path).catch(() => ['?'])).length === 0) await rm(path, { recursive: true, force: true });
    }
  }

  async function tick(): Promise<ApplyTickResult> {
    const result: ApplyTickResult = { commands: 0, swept: 0, started: false };
    if (!availability.available || ticking) return result;
    ticking = true;
    try {
      // O navegador é um só: com uma candidatura nele, os comandos esperam a próxima verificação.
      if (!inFlight) result.commands = await runCommands();
      if (!inFlight && browser.isOpen() && now() - browser.lastUsedAt() > APPLY_TIMING.browserIdleMs) await browser.close();

      const cfg = await deps.settings.applyConfig();
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
      await cleanupShots(at, cfg.timeZone).catch((e) => log(`candidaturas: erro ao apagar fotos antigas: ${errorText(e)}`));
      return result;
    } finally {
      ticking = false;
    }
  }

  return {
    tick,
    /**
     * Só no início do worker: o que ficou `running` é de um processo anterior. Comandos viram erro; candidaturas antes do
     * clique voltam à fila; uma encontrada em `submitting` nunca é reenviada: vai ao dono confirmar no site.
     */
    async recoverInterrupted() {
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
