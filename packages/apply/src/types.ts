import type { Page } from 'playwright';
import type { ApplySiteId, Question, ResolvedAnswer } from '@kv/shared';

export interface ApplyJob {
  id: number; source: string; url: string; externalId: string; company: string; title: string;
}
/** Para onde ir. `ref` leva o que o roteiro precisa (ex.: `{ board, jobId }`). */
export interface ApplyTarget { site: ApplySiteId; url: string; ref: Record<string, string> }
export type Unavailable = 'closed' | 'external' | 'already_applied';
export type HumanGate = 'captcha' | 'verification_code' | 'login' | 'restricted';
export interface StepRead { questions: Question[]; isLast: boolean }

export interface ApplySite {
  id: ApplySiteId;
  needsLogin: boolean;
  /** Página em que o dono faz o login. Obrigatória quando `needsLogin`. */
  loginUrl?: string;
  /** A vaga é deste site? Decide pela fonte e pela URL, sem rede. */
  match(job: ApplyJob): ApplyTarget | null;
  sessionState(page: Page): Promise<'logged_in' | 'logged_out'>;
  open(page: Page, target: ApplyTarget): Promise<{ kind: 'form' } | { kind: 'unavailable'; reason: Unavailable }>;
  /** Descrição lida da página já aberta, quando ela a mostra. */
  readDescription?(page: Page): Promise<string | null>;
  /** Lê a etapa visível. Não altera nada. */
  readStep(page: Page): Promise<StepRead>;
  fillStep(page: Page, answers: ResolvedAnswer[], files: { resumePath: string }): Promise<void>;
  /** Avança uma etapa; nunca envia. */
  next(page: Page): Promise<void>;
  /**
   * Clica no envio final e confirma que o site aceitou. Não clica de novo quando a confirmação já está na tela: o
   * motor chama `submit` outra vez depois de um bloqueio resolvido pelo dono.
   */
  submit(page: Page): Promise<{ confirmation: string }>;
  humanGate(page: Page): Promise<HumanGate | null>;
  /** Fecha o formulário sem enviar e sem deixar rascunho. */
  discard(page: Page): Promise<void>;
}

/** A página não é o que o roteiro espera. Vira `needs_human` com `unsupported_form`. */
export class SiteLayoutError extends Error {}
/** O site recusou o envio sem mostrar nada para resolver. Vira `needs_human` com `captcha`. */
export class SubmitRejectedError extends Error {}
