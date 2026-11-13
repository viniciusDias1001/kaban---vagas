import { bankBoolean, bankList, parseNumberAnswer, type CandidateProfile, type KnownFact } from '@kv/shared';

export type FactValue = { text: string } | { flag: boolean } | { amount: number; unit: 'brl_month' | 'usd_year' } | { resume: true };
export interface FactSources {
  profile: CandidateProfile;
  /** Linhas de `apply_answers`. Só valem as de escopo `always`, com resposta não vazia e país nulo ou igual a `country`. */
  answers: readonly { key: string | null; answer: string; kind: string; scope: string; country: string | null }[];
  country: 'BR' | 'INT';
  /** Há um currículo para anexar (o da candidatura ou o base). */
  hasResume: boolean;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
const isHost = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function link(profile: CandidateProfile, pick: (host: string) => boolean): FactValue | null {
  const found = profile.links.find((l) => pick(hostOf(l.url)));
  return found ? { text: found.url.trim() } : null;
}

/** A resposta salva da chave: a de país igual ao da vaga vale mais que a de qualquer país. */
function savedAnswer(src: FactSources, key: string): string | null {
  const rows = src.answers.filter((a) => a.key === key && a.scope === 'always' && a.answer.trim() !== '' && (a.country === null || a.country === src.country));
  const row = rows.find((a) => a.country === src.country) ?? rows[0];
  return row ? row.answer.trim() : null;
}

function text(value: string): FactValue | null {
  const t = value.trim();
  return t ? { text: t } : null;
}

function answerFlag(src: FactSources, key: string): FactValue | null {
  const a = savedAnswer(src, key);
  const flag = a === null ? null : bankBoolean(a);
  return flag === null ? null : { flag };
}

function answerText(src: FactSources, key: string): FactValue | null {
  const a = savedAnswer(src, key);
  return a === null ? null : text(bankList(a).join(', '));
}

/** O valor salvo do fato, ou null se o dono não o salvou. */
export function resolveFact(fact: KnownFact, src: FactSources): FactValue | null {
  const { contact } = src.profile;
  switch (fact) {
    case 'phone': return text(contact.phone);
    case 'email': return text(contact.email);
    case 'location': return text(contact.location);
    case 'linkedin': return link(src.profile, (h) => isHost(h, 'linkedin.com'));
    case 'github': return link(src.profile, (h) => isHost(h, 'github.com'));
    case 'portfolio': return link(src.profile, (h) => h !== '' && !isHost(h, 'linkedin.com') && !isHost(h, 'github.com'));
    case 'salary': {
      const unit = src.country === 'BR' ? 'brl_month' : 'usd_year';
      const a = savedAnswer(src, src.country === 'BR' ? 'salary_brl_month' : 'salary_usd_year');
      const n = a === null ? null : parseNumberAnswer(a);
      return n === null ? null : { amount: Number(n), unit };
    }
    case 'visa_sponsorship': return answerFlag(src, 'visa_sponsorship');
    case 'work_authorization': return answerFlag(src, 'work_authorization');
    case 'relocation': return answerFlag(src, 'relocation');
    case 'start_availability': return answerText(src, 'start_availability');
    case 'work_models': return answerText(src, 'work_models');
    case 'pronouns': return answerText(src, 'pronouns');
    case 'resume': return src.hasResume ? { resume: true } : null;
  }
}
