import type { Level, NormalizedJob, SearchFilters } from '@kv/shared';
import { fold, hasTerm, isShortTerm } from './text';

const DAY = 86_400_000;

// `staff` e `lead` têm exceções para cargos que não são de senioridade (Chief of Staff, Staff Accountant,
// Lead Generation); `pl` não vale em PL/SQL; `entry` só vale em "entry level" (não em "Data Entry").
const SENIOR = 'sr|senior|(?<!chief of )staff(?! accountant)|principal|lead(?! gen)|especialista|specialist';
const JUNIOR = 'jr|junior|estagio|estagiari[oa]|intern|internship|trainee|entry[- ]level';
const PLENO = 'pl(?![-/ ]?sql)|pleno|mid|midlevel';

const LEVEL_RE = new RegExp(
  `(?<![a-z])(?:(?<senior>${SENIOR})|(?<junior>${JUNIOR})|(?<pleno>${PLENO}))(?![a-z])`,
  'g',
);

/** Todos os níveis citados no título, na ordem em que aparecem ("Dev PL/SR" → pleno, senior). */
export function detectLevels(title: string): Level[] {
  const found: Level[] = [];
  for (const m of fold(title).matchAll(LEVEL_RE)) {
    const level: Level = m.groups?.senior ? 'senior' : m.groups?.junior ? 'junior' : 'pleno';
    if (!found.includes(level)) found.push(level);
  }
  return found;
}

/**
 * Nível único para gravar na vaga e mostrar no cartão: o primeiro citado no título.
 * Em "Pleno/Sênior" fica `pleno`, para o cartão não parecer exclusivo de sênior.
 */
export function detectLevel(title: string): Level | null {
  return detectLevels(title)[0] ?? null;
}

export const KNOWN_STACKS = [
  'react', 'react native', 'node', 'typescript', 'javascript', 'python', 'java', 'go', 'rust', 'php', 'ruby',
  'c#', '.net', 'angular', 'vue', 'next.js', 'aws', 'docker', 'kubernetes', 'sql', 'postgres', 'mongodb',
  'flutter', 'kotlin', 'swift', 'c++',
];

export function detectStacks(text: string): string[] {
  return KNOWN_STACKS.filter((s) => hasTerm(text, s));
}

export function matchesFilters(job: NormalizedJob, f: SearchFilters, now: number = Date.now()): boolean {
  if (job.postedAt !== null && now - job.postedAt > f.maxAgeDays * DAY) return false;
  if (f.stacks.length > 0) {
    // Termos curtos ("go", "r") aparecem demais em texto corrido: só valem no título e nas stacks.
    const head = `${job.title} ${job.stacks.join(' ')}`;
    const full = `${head} ${job.description}`;
    if (!f.stacks.some((s) => hasTerm(isShortTerm(s) ? head : full, s))) return false;
  }
  if (f.levels.length > 0) {
    const levels = detectLevels(job.title);
    if (levels.length > 0 && !levels.some((l) => f.levels.includes(l))) return false;
  }
  if (f.regions.length > 0) {
    const ok =
      (f.regions.includes('remoto') && job.remote) ||
      (f.regions.includes('brasil') && job.country === 'BR') ||
      (f.regions.includes('exterior') && job.country === 'INT');
    if (!ok) return false;
  }
  return true;
}
