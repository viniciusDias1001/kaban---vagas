/**
 * Peças de teste da fila de candidaturas: vagas e notas no banco, um site de mentira que registra as chamadas e uma
 * `BrowserSession` de mentira. Nenhuma abre navegador nem toca site de verdade. Só os testes importam este arquivo.
 */
import { SAMPLE_PROFILE } from '@kv/ai/testing';
import { SiteLayoutError, SubmitRejectedError, type ApplySite, type BrowserSession, type HumanGate } from '@kv/apply';
import { jobAi, jobs, saveProfile, type Db } from '@kv/db';
import type { Question } from '@kv/shared';

/** 12:00 em São Paulo, quarta-feira 11/11/2026 (o fuso padrão das configurações). */
export const NOON = Date.UTC(2026, 10, 11, 15, 0, 0);
export const HOUR = 3_600_000;

export async function seedProfile(db: Db): Promise<number> {
  return (await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido', NOON - 10 * 86_400_000)).version;
}

let seq = 0;
/** Uma vaga com nota da camada 1. `variant` escolhe o comportamento do site de mentira (vai na URL). */
export async function seedJob(
  db: Db,
  o: {
    variant?: string; source?: string; company?: string; score?: number | null; version?: number; discoveredAt?: number;
    description?: string; column?: typeof jobs.$inferInsert.column;
  } = {},
): Promise<typeof jobs.$inferSelect> {
  seq += 1;
  const source = o.source ?? 'fake';
  const url = `https://vagas.example.test/${seq}?v=${o.variant ?? 'form'}`;
  const [job] = await db
    .insert(jobs)
    .values({
      source, externalId: String(seq), url, title: 'Pessoa desenvolvedora React', company: o.company ?? `Empresa ${seq}`,
      location: 'São Paulo, SP', country: 'BR', remote: true, stacks: [], description: o.description ?? 'Vaga com React e Node.',
      postedAt: null, discoveredAt: o.discoveredAt ?? NOON - 86_400_000, dedupHash: url, profileId: null, position: seq,
      ...(o.column ? { column: o.column } : {}),
    })
    .returning();
  if (o.score !== null) {
    await db.insert(jobAi).values({ jobId: job.id, score: o.score ?? 85, tier1State: 'ok', tier1ProfileVersion: o.version ?? 1 });
  }
  return job;
}

const q = (id: string, label: string, extra: Partial<Question> = {}): Question => ({
  id, label, help: '', kind: 'text', options: [], required: true, maxLength: null, ...extra,
});
/** Respondidas pelas regras: identidade e currículo. */
export const BASIC_QUESTIONS: Question[] = [
  q('name', 'Nome completo'), q('email', 'E-mail'), q('resume', 'Currículo', { kind: 'file' }),
];
export const SALARY = q('salary', 'Pretensão salarial mensal (R$)');
export const MOTIVATION = q('why', 'Conte por que você quer esta vaga', { kind: 'longtext', maxLength: 2000 });

/** O que cada variante faz (a variante vem de `?v=` na URL da vaga). */
export interface VariantScript {
  questions?: Question[];
  open?: () => Promise<{ kind: 'form' } | { kind: 'unavailable'; reason: 'closed' | 'external' | 'already_applied' }>;
  readStep?: () => Promise<void>;
  /** A cada consulta: o bloqueio na tela. */
  gate?: () => HumanGate | null;
  submit?: () => Promise<{ confirmation: string }>;
}

export interface FakeSite extends ApplySite {
  calls: string[];
  /** Variantes extras ou substitutas, por nome. */
  variants: Record<string, VariantScript>;
  sessions: 'logged_in' | 'logged_out';
}

const variantOf = (url: string) => new URL(url).searchParams.get('v') ?? 'form';

export const DEFAULT_VARIANTS: Record<string, VariantScript> = {
  form: {},
  salary: { questions: [...BASIC_QUESTIONS, SALARY] },
  open: { questions: [...BASIC_QUESTIONS, MOTIVATION] },
  layout: { readStep: async () => { throw new SiteLayoutError('o formulário mudou'); } },
  restricted: { gate: () => 'restricted' },
  already: { open: async () => ({ kind: 'unavailable', reason: 'already_applied' }) },
  net: { open: async () => { throw new Error('net::ERR_CONNECTION_RESET'); } },
  refused: { submit: async () => { throw new SubmitRejectedError('recusado'); } },
};

/** Site de mentira (`fake`, ou o id dado): atende vagas da fonte de mesmo nome e registra cada chamada em `calls`. */
export function createRecordingSite(opts: { needsLogin?: boolean; id?: ApplySite['id'] } = {}): FakeSite {
  const id = opts.id ?? 'fake';
  const calls: string[] = [];
  let current = 'form';
  const script = (): VariantScript => site.variants[current] ?? {};
  const site: FakeSite = {
    id,
    needsLogin: opts.needsLogin ?? false,
    ...(opts.needsLogin ? { loginUrl: 'https://www.fake.test/entrar' } : {}),
    calls,
    variants: { ...DEFAULT_VARIANTS },
    sessions: 'logged_in',
    match(job) {
      if (job.source !== id) return null;
      return { site: id, url: job.url, ref: { variant: variantOf(job.url) } };
    },
    async sessionState() {
      calls.push('sessionState');
      return site.sessions;
    },
    async open(_page, target) {
      calls.push('open');
      current = target.ref.variant ?? 'form';
      return (await script().open?.()) ?? { kind: 'form' };
    },
    async readStep() {
      calls.push('readStep');
      await script().readStep?.();
      return { questions: script().questions ?? BASIC_QUESTIONS, isLast: true };
    },
    async fillStep() {
      calls.push('fillStep');
    },
    async next() {
      calls.push('next');
    },
    async submit() {
      calls.push('submit');
      return (await script().submit?.()) ?? { confirmation: 'Candidatura recebida' };
    },
    async humanGate() {
      return script().gate?.() ?? null;
    },
    async discard() {
      calls.push('discard');
    },
  };
  return site;
}

/** `BrowserSession` de mentira: a página só sabe tirar foto. */
export function createFakeBrowser(): BrowserSession & { calls: string[]; usedAt: number; open: boolean } {
  const page = { screenshot: async () => Buffer.from('jpeg') } as unknown as Awaited<ReturnType<BrowserSession['page']>>;
  const browser = {
    calls: [] as string[],
    usedAt: 0,
    open: false,
    async page() {
      browser.open = true;
      browser.usedAt = Date.now();
      return page;
    },
    async bringToFront() {
      browser.calls.push('front');
    },
    async close() {
      browser.calls.push('close');
      browser.open = false;
    },
    isOpen: () => browser.open,
    lastUsedAt: () => browser.usedAt,
  };
  return browser;
}
