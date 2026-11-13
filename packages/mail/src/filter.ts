import { isAtsAddress } from './ats';
import { companyInHeaders, hasPhrase } from './company';
import type { RawMail } from './types';

export interface FilterContext {
  ownAddress: string;
  /** Fios já guardados (o app enviou algo neles, ou o dono ligou a um card, ou já passaram no filtro). */
  knownThreads: ReadonlySet<string>;
  companies: readonly { company: string; title: string }[];
}
export type FilterResult = { pass: true; why: 'thread' | 'ats' | 'company' } | { pass: false; ignoredCompany: string | null };

export const HIRING_WORDS = [
  'candidatura', 'vaga', 'entrevista', 'processo seletivo', 'recrutamento', 'currículo', 'curriculo',
  'application', 'applied', 'interview', 'position', 'role', 'recruiting', 'recruiter', 'hiring',
  'candidate', 'resume', 'job offer', 'proposta',
] as const;

export const RECRUITING_LOCALS = [
  'careers', 'career', 'carreiras', 'jobs', 'vagas', 'talent', 'talentos', 'rh', 'hr', 'people',
  'recruiting', 'recrutamento', 'hiring',
] as const;

function hasHiringSignal(mail: RawMail, title: string, ownAddress: string): boolean {
  const body = `${mail.subject}\n${mail.text}`;
  if (hasPhrase(body, title)) return true;
  if (HIRING_WORDS.some((w) => hasPhrase(body, w, { plural: true }))) return true;
  const local = mail.from.address.slice(0, mail.from.address.lastIndexOf('@')).trim().toLowerCase();
  if ((RECRUITING_LOCALS as readonly string[]).includes(local)) return true;
  return !mail.bulk && !mail.autoSubmitted && mail.to.some((a) => a.trim().toLowerCase() === ownAddress);
}

export function filterMail(mail: RawMail, ctx: FilterContext): FilterResult {
  const own = ctx.ownAddress.trim().toLowerCase();
  if (mail.from.address.trim().toLowerCase() === own) return { pass: false, ignoredCompany: null };
  if (ctx.knownThreads.has(mail.threadKey)) return { pass: true, why: 'thread' };
  if (mail.listId) return { pass: false, ignoredCompany: null };
  if (isAtsAddress(mail.from.address)) return { pass: true, why: 'ats' };
  const matched = ctx.companies.filter((c) => companyInHeaders(c.company, mail));
  if (matched.length === 0) return { pass: false, ignoredCompany: null };
  if (matched.some((c) => hasHiringSignal(mail, c.title, own))) return { pass: true, why: 'company' };
  return { pass: false, ignoredCompany: matched[0]!.company };
}
