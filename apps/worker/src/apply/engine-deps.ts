import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import {
  resolveAnswers, shotPath, type ApplySite, type BrowserSession, type EngineDeps, type EngineUpdate, type HumanGate,
  type ResolveDeps,
} from '@kv/apply';
import { applications, listApplyAnswers, transitionApplication, type Db } from '@kv/db';
import type { AnswerRecord, ApplyAiAnswers, ApplyMode, ShotKind } from '@kv/shared';
import { BEFORE_CLICK, cancelRequested, recordMissedWait, recordSolvedWait } from './outcome';

/** O trabalho passou do tempo antes do clique: o motor descarta o formulário e relança; a fila conta erro passageiro. */
export class WorkTimeoutError extends Error {
  constructor(ms: number) {
    super(`o trabalho passou de ${Math.round(ms / 60_000)} min`);
    this.name = 'WorkTimeoutError';
  }
}

/**
 * Relógio do tempo de trabalho de uma candidatura: dispara `onExpire` quando o tempo ativo passa de `limitMs`. A espera
 * pelo dono não conta (`pause`/`resume`). Usa o relógio real: é um tempo de execução, não uma data.
 */
export class WorkClock {
  private remaining: number;
  private startedAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly limitMs: number, private readonly onExpire: () => void) {
    this.remaining = limitMs;
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.remaining = 0;
      this.onExpire();
    }, this.remaining);
  }

  pause(): void {
    if (!this.timer || this.startedAt === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
  }

  resume(): void {
    this.start();
  }

  /** Recomeça a contagem inteira (o tempo depois do clique de envio). */
  restart(): void {
    this.pause();
    this.remaining = this.limitMs;
    this.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Em que ponto a execução está. `pre`: antes do clique de envio. `click`: `submitting` foi aceito (o clique vem ou veio).
 * `aborted`: o tempo de trabalho acabou antes do clique (nenhuma gravação e nenhum clique depois disso).
 * `abandoned`: o tempo acabou depois do clique e a fila já gravou `confirm_submission` (nenhum clique novo).
 */
export type RunPhase = 'pre' | 'click' | 'aborted' | 'abandoned';

export interface RunState {
  phase: RunPhase;
}

export interface EngineDepsInput {
  db: Db;
  applicationId: number;
  site: ApplySite;
  page: EngineDeps['page'];
  browser: BrowserSession;
  dataDir: string;
  mode: ApplyMode;
  resumePath: string;
  approved: AnswerRecord[];
  aiAnswers: ApplyAiAnswers;
  ctx: ResolveContext;
  resolveDeps: ResolveDeps;
  state: RunState;
  clock: WorkClock;
  workTimeoutMs: number;
  humanPollMs: number;
  humanWaitMs: number;
  now: () => number;
}

/** O contexto das regras e do banco de respostas (perfil, vaga, fonte, arquivo do currículo, empresa, país). */
export type ResolveContext = Parameters<typeof resolveAnswers>[0]['ctx'];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** As dependências do motor para uma candidatura: o estado gravado, as fotos, a espera pelo dono e as respostas. */
export function buildEngineDeps(input: EngineDepsInput): EngineDeps {
  const { db, applicationId: id, site, page, browser, state, clock, now } = input;
  const cancelled = () => cancelRequested(db, id);
  const guard = () => {
    if (state.phase === 'aborted') throw new WorkTimeoutError(input.workTimeoutMs);
  };

  async function report(update: EngineUpdate): Promise<boolean> {
    guard();
    if (state.phase === 'abandoned') return false;
    if (update.status === 'submitting') {
      // Um `submitting` repetido (antes de um novo clique, depois de um bloqueio resolvido) é só a pergunta do cancelamento.
      if (state.phase === 'click') return !(await cancelled());
      if (await cancelled()) return false;
      guard(); // o tempo pode ter acabado durante a leitura acima
      state.phase = 'click';
      const ok = await transitionApplication(db, id, { status: 'submitting', from: BEFORE_CLICK, set: { answers: update.answers } }, now());
      if (!ok) {
        state.phase = 'pre';
        throw new Error('a candidatura saiu do andamento antes do envio');
      }
      return true;
    }
    if (await cancelled()) return false;
    guard();
    const ok = await transitionApplication(db, id, { status: update.status, from: BEFORE_CLICK }, now());
    if (!ok) throw new Error('a candidatura saiu do andamento');
    return true;
  }

  async function shot(kind: ShotKind): Promise<string> {
    const bytes = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: true });
    const { absolute, relative } = shotPath(input.dataDir, id, kind);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
    const [row] = await db.select({ shots: applications.shots }).from(applications).where(eq(applications.id, id));
    await db.update(applications).set({ shots: { ...row?.shots, [kind]: relative } }).where(eq(applications.id, id));
    return relative;
  }

  /**
   * Mostra a espera sem decidir o estado gravado (`waiting_gate`), traz a janela para a frente e consulta o bloqueio a
   * cada `humanPollMs` até `humanWaitMs`. Um cancelamento encerra a espera na hora (e não conta como espera perdida).
   * O tempo da espera não conta no tempo de trabalho.
   */
  async function waitHuman(gate: HumanGate): Promise<'solved' | 'timeout'> {
    clock.pause();
    try {
      await db.update(applications).set({ waitingGate: gate }).where(eq(applications.id, id));
      await browser.bringToFront().catch(() => {});
      const started = Date.now();
      for (;;) {
        await sleep(input.humanPollMs);
        if (state.phase === 'aborted' || state.phase === 'abandoned' || (await cancelled())) return 'timeout';
        let onScreen: HumanGate | null = gate;
        try {
          onScreen = await site.humanGate(page);
        } catch { /* sem leitura: continua esperando */ }
        if (onScreen !== gate) {
          await recordSolvedWait(db, site.id);
          return 'solved';
        }
        if (Date.now() - started >= input.humanWaitMs) {
          await recordMissedWait(db, site.id, now());
          return 'timeout';
        }
      }
    } finally {
      await db.update(applications).set({ waitingGate: null }).where(eq(applications.id, id)).catch(() => {});
      clock.resume();
    }
  }

  async function resolve(questions: Parameters<EngineDeps['resolve']>[0]) {
    guard();
    const bank = await listApplyAnswers(db);
    return resolveAnswers(
      { questions, bank, ctx: input.ctx, aiAnswers: input.aiAnswers, approved: input.approved },
      input.resolveDeps,
    );
  }

  return { site, page, mode: input.mode, resumePath: input.resumePath, approved: input.approved, resolve, report, shot, waitHuman };
}
