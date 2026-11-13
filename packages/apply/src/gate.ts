import { APPLY_TIMING, type ApplySiteId, type ApplyConfig, type ApplyDailyCaps, type ApplyWindow } from '@kv/shared';
import type { ApplyCounts } from '@kv/db';

/** Minúsculas, sem acento, só letras e dígitos separados por um espaço: a base do casamento por palavras inteiras. */
function words(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** `needle` aparece em `haystack` como palavras inteiras (ou como o texto todo)? Ambos já normalizados. */
function containsWords(haystack: string, needle: string): boolean {
  return needle !== '' && ` ${haystack} `.includes(` ${needle} `);
}

/** O item da lista de bloqueio que pegou a vaga (empresa ou termo, sem diferença de caixa e acento), ou null. */
export function isBlocked(
  job: { company: string; title: string; description: string },
  cfg: Pick<ApplyConfig, 'blockedCompanies' | 'blockedTerms'>,
): string | null {
  const company = words(job.company);
  for (const item of cfg.blockedCompanies) if (containsWords(company, words(item))) return item;
  const text = words(`${job.title} ${job.description}`);
  for (const item of cfg.blockedTerms) if (containsWords(text, words(item))) return item;
  return null;
}

/** Diferença, em ms, entre a hora local de `timeZone` e o UTC no instante `ms` (mesma conta de `dayStartMs` em @kv/ai). */
function offsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - Math.floor(ms / 1000) * 1000;
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** `now` está dentro de [start, end) no fuso dado? Janela com início depois do fim atravessa a meia-noite. */
export function withinWindow(now: number, window: ApplyWindow, timeZone: string): boolean {
  const local = new Date(now + offsetMs(now, timeZone));
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const start = minutesOfDay(window.start);
  const end = minutesOfDay(window.end);
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Quanto ainda cabe hoje para o site. `views` só existe para o LinkedIn; nos demais é Infinity. */
export function capsLeft(counts: ApplyCounts, caps: ApplyDailyCaps, site: ApplySiteId): { forms: number; views: number; total: number } {
  const total = Math.max(0, caps.total - counts.total);
  const forms = Math.min(Math.max(0, caps[site] - counts.forms[site]), total);
  const views = site === 'linkedin' ? Math.max(0, caps.linkedinViews - counts.views.linkedin) : Infinity;
  return { forms, views, total };
}

/** O instante em que o site pode abrir a próxima vaga (`view`) ou o próximo formulário (`form`), com o intervalo sorteado de APPLY_TIMING. */
export function nextAllowedAt(
  site: ApplySiteId,
  last: { formAt: number | null; viewAt: number | null },
  kind: 'form' | 'view',
  random: () => number = Math.random,
): number {
  const since = kind === 'form' ? last.formAt : last.viewAt;
  if (since === null) return 0;
  const [lo, hi] = kind === 'view' ? APPLY_TIMING.viewIntervalMs
    : site === 'linkedin' ? APPLY_TIMING.formIntervalMs.linkedin
    : site === 'fake' ? APPLY_TIMING.formIntervalMs.fake
    : APPLY_TIMING.formIntervalMs.other;
  return since + lo + Math.floor(random() * (hi - lo));
}

export type GateOutcome =
  | { pass: true; score: number | null }
  | { pass: false; reason: 'below_min_score' | 'not_eligible' | 'blocked'; detail: string };

/** Pedido manual só respeita o bloqueio. */
export function decideGate(input: {
  blockedBy: string | null; gate: { score: number; eligible: boolean; ineligibleReason: string } | null;
  minScore: number; manual: boolean;
}): GateOutcome {
  if (input.blockedBy !== null) return { pass: false, reason: 'blocked', detail: input.blockedBy };
  const { gate } = input;
  if (input.manual) return { pass: true, score: gate?.score ?? null };
  if (!gate) return { pass: false, reason: 'below_min_score', detail: 'sem nota de adequação' };
  if (gate.score < input.minScore) return { pass: false, reason: 'below_min_score', detail: `nota ${gate.score}, mínimo ${input.minScore}` };
  if (!gate.eligible) return { pass: false, reason: 'not_eligible', detail: gate.ineligibleReason };
  return { pass: true, score: gate.score };
}
