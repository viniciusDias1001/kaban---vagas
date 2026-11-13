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
   * Clica no envio final e confirma que o site aceitou. O motor chama `submit` outra vez depois de um bloqueio
   * resolvido pelo dono; nessa chamada o roteiro não clica de novo enquanto o primeiro envio pode estar em andamento
   * (ver `submitAndWait`): com a confirmação na tela devolve sem clicar, e na dúvida lança `SiteLayoutError`.
   * Abrir o formulário (`open`) e sair dele (`discard`) esquecem o clique.
   */
  submit(page: Page): Promise<{ confirmation: string }>;
  humanGate(page: Page): Promise<HumanGate | null>;
  /** Fecha o formulário sem enviar e sem deixar rascunho. */
  discard(page: Page): Promise<void>;
}

/**
 * A página não é o que o roteiro espera. Antes do clique de envio vira `needs_human` com `unsupported_form`; depois
 * dele, `confirm_submission` (um clique pode ter chegado ao site).
 */
export class SiteLayoutError extends Error {}
/**
 * O site recusou o envio, ou mostrou um portão logo depois do clique. Com um portão na tela, o motor espera o dono;
 * sem portão, vira `needs_human` com `confirm_submission` (depois do clique) ou `unsupported_form` (antes dele).
 */
export class SubmitRejectedError extends Error {}
