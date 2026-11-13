import { filterMail, type FilterContext } from './filter';
import type { Mailbox, RawMail } from './types';

/*
 * As partes puras do `pnpm mail:smoke` (scripts/mail-smoke.ts): os argumentos, a leitura dos últimos dias da Caixa de
 * entrada (com a caixa recebida de fora) e o resumo que ele imprime. Nada aqui grava no banco nem envia e-mail.
 */

const DAY_MS = 86_400_000;
/** Quantos dias para trás o comando lê (os mesmos da primeira leitura do app). */
export const SMOKE_DAYS = 30;
/** Teto de mensagens lidas, para uma caixa enorme não prender o comando. */
export const SMOKE_MAX_MAILS = 2_000;
/** Teto de `--classify`: cada uma é uma chamada paga ao provedor de IA. */
export const SMOKE_MAX_CLASSIFY = 20;
const PAGE = 50;

export interface MailSmokeArgs {
  /** Quantas mensagens que passaram no filtro o comando classifica com a IA (0: nenhuma). */
  classify: number;
}

const USAGE = `Use: pnpm mail:smoke [-- --classify N], com N de 1 a ${SMOKE_MAX_CLASSIFY}.`;

/** Aceita só `--classify N` (e ignora o `--` solto que o pnpm repassa). Com `CI` definida, recusa. */
export function parseMailSmokeArgs(argv: string[], env: NodeJS.ProcessEnv): MailSmokeArgs | { error: string } {
  if (env.CI) return { error: 'mail:smoke não roda na CI: ele abre a caixa de e-mail de verdade do dono.' };
  const args = argv.filter((a) => a !== '--');
  if (args.length === 0) return { classify: 0 };
  if (args[0] !== '--classify') return { error: `Argumento não aceito: ${args[0]}. ${USAGE}` };
  const value = args[1];
  if (value === undefined) return { error: `Falta o número de --classify. ${USAGE}` };
  if (args.length > 2) return { error: `Argumento não aceito: ${args[2]}. ${USAGE}` };
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > SMOKE_MAX_CLASSIFY) {
    return { error: `--classify precisa de um número de 1 a ${SMOKE_MAX_CLASSIFY}; veio "${value}".` };
  }
  return { classify: Number(value) };
}

/**
 * As mensagens da Caixa de entrada dos últimos `days` dias, das mais antigas para as mais novas, em páginas (a caixa só
 * é lida). `truncated`: parou no teto `max` antes do fim.
 */
export async function readRecentInbox(
  mailbox: Mailbox, now: number, opts: { days?: number; max?: number } = {},
): Promise<{ mails: RawMail[]; truncated: boolean }> {
  const since = now - (opts.days ?? SMOKE_DAYS) * DAY_MS;
  const max = opts.max ?? SMOKE_MAX_MAILS;
  const mails: RawMail[] = [];
  let uidValidity: number | null = null;
  let afterUid: number | null = null;
  for (;;) {
    const batch = await mailbox.fetchInbox({ uidValidity, afterUid, since, limit: PAGE });
    // A busca por data do IMAP vale pelo dia inteiro: pode trazer um pouco mais que o pedido.
    mails.push(...batch.mails.filter((m) => m.date >= since));
    if (mails.length >= max) return { mails: mails.slice(0, max), truncated: true };
    if (batch.mails.length < PAGE) return { mails, truncated: false };
    uidValidity = batch.uidValidity;
    afterUid = Math.max(...batch.mails.map((m) => m.uid));
  }
}

export type SmokeRule = 'thread' | 'ats' | 'company';
export const SMOKE_RULE_LABELS: Record<SmokeRule, string> = {
  thread: 'fio já guardado',
  ats: 'endereço de plataforma de recrutamento',
  company: 'empresa do quadro com sinal de vaga',
};

export interface SmokeSummary {
  total: number;
  /** As que passam no filtro, na ordem da caixa, com a regra que as deixou passar. */
  passed: { mail: RawMail; why: SmokeRule }[];
  /** Citam uma empresa do quadro, sem sinal de vaga: o app guardaria só remetente, assunto e data, em "ignorados". */
  ignored: number;
  /** Nem citam empresa do quadro (ou são do próprio dono, ou de lista). */
  outside: number;
  truncated: boolean;
}

/** Passa cada mensagem no mesmo filtro local da leitura do app e conta o resultado. */
export function summarizeSmoke(mails: readonly RawMail[], ctx: FilterContext, truncated = false): SmokeSummary {
  const summary: SmokeSummary = { total: mails.length, passed: [], ignored: 0, outside: 0, truncated };
  for (const mail of mails) {
    const verdict = filterMail(mail, ctx);
    if (verdict.pass) summary.passed.push({ mail, why: verdict.why });
    else if (verdict.ignoredCompany !== null) summary.ignored += 1;
    else summary.outside += 1;
  }
  return summary;
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!;

/**
 * As duas chamadas que a leitura do app faz depois do filtro, ambas só de leitura: o fio de uma mensagem que passa (pede
 * "Todos os e-mails") e a busca em Enviados (pede "Enviados"). Uma linha para cada: "ok" ou "falhou: <frase>".
 */
export async function checkSmokeFolders(mailbox: Pick<Mailbox, 'fetchThread' | 'sentExists'>, threadKey: string): Promise<string[]> {
  const line = async (label: string, call: () => Promise<unknown>): Promise<string> => {
    try {
      await call();
      return `${label}: ok`;
    } catch (e) {
      return `${label}: falhou: ${firstLine(e)}`;
    }
  };
  return [
    await line('fio', () => mailbox.fetchThread(threadKey)),
    await line('Enviados', () => mailbox.sentExists('mail-smoke-check@invalid')),
  ];
}

/**
 * Texto de um e-mail pronto para o terminal: numa linha só e sem caracteres de controle ou invisíveis (`\p{C}`), para um
 * assunto hostil não mandar sequências de escape ao terminal do dono.
 */
export function terminalText(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\p{C}/gu, '').trim();
}

const sender = (m: RawMail) => {
  const name = terminalText(m.from.name);
  const address = terminalText(m.from.address);
  return name ? `${name} <${address}>` : address;
};
const oneLine = (s: string) => terminalText(s) || '(sem assunto)';

/** O que o comando imprime: só contagens e, por mensagem que passa, remetente, assunto e a regra. Nunca o texto. */
export function formatSmokeSummary(s: SmokeSummary, days: number = SMOKE_DAYS): string[] {
  const count = (rule: SmokeRule) => s.passed.filter((p) => p.why === rule).length;
  const lines = [
    `Caixa de entrada, últimos ${days} dias: ${s.total} mensagem(ns)${s.truncated ? ` (parou no teto de ${s.total}; há mais)` : ''}.`,
    `Passam no filtro: ${s.passed.length} (${SMOKE_RULE_LABELS.thread}: ${count('thread')}; ` +
      `${SMOKE_RULE_LABELS.ats}: ${count('ats')}; ${SMOKE_RULE_LABELS.company}: ${count('company')}).`,
    `Ignoradas (citam uma empresa do quadro, sem sinal de vaga): ${s.ignored}.`,
    `Fora do filtro: ${s.outside}.`,
  ];
  if (s.passed.length > 0) lines.push('', 'Mensagens que passam:');
  for (const { mail, why } of s.passed) lines.push(`- ${sender(mail)} | ${oneLine(mail.subject)} | regra: ${SMOKE_RULE_LABELS[why]}`);
  return lines;
}
