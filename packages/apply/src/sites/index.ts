import type { ApplyJob, ApplySite, ApplyTarget } from '../types';
import { createFakeSite } from './fake';

/** Sites reais registrados. Vazia até o plano dos sites reais. */
function realSites(): ApplySite[] {
  return [];
}

/** Com `FAKE_APPLY_SITE=1`, só o site de teste; senão, os sites reais registrados. */
export function applySites(env: NodeJS.ProcessEnv = process.env): ApplySite[] {
  return env.FAKE_APPLY_SITE === '1' ? [createFakeSite()] : realSites();
}

export function siteFor(job: ApplyJob, sites: ApplySite[]): { site: ApplySite; target: ApplyTarget } | null {
  for (const site of sites) {
    const target = site.match(job);
    if (target) return { site, target };
  }
  return null;
}
