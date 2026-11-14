import { and, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { dayStartMs } from '@kv/ai';
import { capsLeft, siteFor, type ApplySite } from '@kv/apply';
import { applications, applyCandidates, applyCountsSince, createApplication, type Db } from '@kv/db';
import { APPLY_DEFAULTS, type ApplyConfig, type ApplySiteId } from '@kv/shared';
import { discardSkippedCards } from './board';
import { DAY_MS, nextMidnight } from './day';

/** Candidatas lidas por varredura: bem mais do que cabe num dia (o total diário vai até 200 nas configurações). */
const SWEEP_LIMIT = 500;

/**
 * Candidaturas que ainda vão abrir um formulário HOJE e que `applyCountsSince` não conta: na fila (sem espera para amanhã) ou
 * em andamento, sem formulário aberto hoje. Sem elas, cada varredura encheria a fila de novo até o limite.
 */
async function pendingForms(db: Db, dayStart: number, tomorrow: number): Promise<Map<ApplySiteId, number>> {
  const rows = await db
    .select({ site: applications.site, n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(applications)
    .where(
      and(
        inArray(applications.status, ['queued', 'preparing', 'filling', 'waiting_human']),
        or(isNull(applications.formOpenedAt), lt(applications.formOpenedAt, dayStart)),
        or(isNull(applications.runAfter), lt(applications.runAfter, tomorrow)),
      ),
    )
    .groupBy(applications.site);
  return new Map(rows.map((r) => [r.site, r.n]));
}

/**
 * Cria candidaturas `queued` (gatilho `auto`, modo do site) para as vagas de `applyCandidates` que têm site e cabem nos
 * limites de hoje (por site, total e, no LinkedIn, vagas abertas), descontando o que já está na fila. Nota mais alta
 * primeiro. Antes, põe em Descartada os cards de Descobertas pulados antes de essa coluna existir (`discardSkippedCards`).
 * Devolve quantas candidaturas criou.
 */
export async function sweepCandidates(db: Db, cfg: ApplyConfig, sites: ApplySite[], now: number): Promise<number> {
  await discardSkippedCards(db, now);
  if (sites.length === 0) return 0;
  const dayStart = dayStartMs(now, cfg.timeZone);
  const counts = await applyCountsSince(db, dayStart);
  const pending = await pendingForms(db, dayStart, nextMidnight(now, cfg.timeZone));
  let totalLeft = cfg.dailyCaps.total - counts.total - [...pending.values()].reduce((a, b) => a + b, 0);
  if (totalLeft <= 0) return 0;
  const left = new Map<ApplySiteId, number>();
  for (const site of sites) {
    const caps = capsLeft(counts, cfg.dailyCaps, site.id);
    left.set(site.id, Math.min(caps.forms, caps.views) - (pending.get(site.id) ?? 0));
  }

  const candidates = await applyCandidates(db, {
    minScore: cfg.minScore, discoveredAfter: now - APPLY_DEFAULTS.maxJobAgeDays * DAY_MS, limit: SWEEP_LIMIT,
  });
  let created = 0;
  for (const c of candidates) {
    if (totalLeft <= 0) break;
    const match = siteFor({ id: c.jobId, source: c.source, url: c.url, externalId: c.externalId, company: c.company, title: c.title }, sites);
    if (!match) continue;
    const site = match.site.id;
    if ((left.get(site) ?? 0) <= 0) continue;
    const id = await createApplication(db, { jobId: c.jobId, site, trigger: 'auto', mode: cfg.siteModes[site] }, now);
    if (id === null) continue; // o dono pediu esta mesma vaga entre a leitura e agora
    created += 1;
    totalLeft -= 1;
    left.set(site, left.get(site)! - 1);
  }
  return created;
}
