import type { Level, NormalizedJob, SearchFilters } from '@kv/shared';
import { fold, hasTerm } from './text';

const DAY = 86_400_000;

const SENIOR = /(?<![a-z])(sr|senior|staff|principal|lead|especialista|specialist)(?![a-z])/;
const JUNIOR = /(?<![a-z])(jr|junior|estagio|estagiario|intern|internship|trainee|entry)(?![a-z])/;
const PLENO = /(?<![a-z])(pl|pleno|mid|midlevel)(?![a-z])/;

export function detectLevel(title: string): Level | null {
  const t = fold(title);
  if (SENIOR.test(t)) return 'senior';
  if (JUNIOR.test(t)) return 'junior';
  if (PLENO.test(t)) return 'pleno';
  return null;
}

export const KNOWN_STACKS = [
  'react', 'react native', 'node', 'typescript', 'javascript', 'python', 'java', 'go', 'rust', 'php', 'ruby',
  'c#', '.net', 'angular', 'vue', 'next.js', 'aws', 'docker', 'kubernetes', 'sql', 'postgres', 'mongodb',
  'flutter', 'kotlin', 'swift',
];

export function detectStacks(text: string): string[] {
  return KNOWN_STACKS.filter((s) => hasTerm(text, s));
}

export function matchesFilters(job: NormalizedJob, f: SearchFilters, now: number = Date.now()): boolean {
  if (job.postedAt !== null && now - job.postedAt > f.maxAgeDays * DAY) return false;
  if (f.stacks.length > 0) {
    const hay = `${job.title} ${job.stacks.join(' ')} ${job.description}`;
    if (!f.stacks.some((s) => hasTerm(hay, s))) return false;
  }
  if (f.levels.length > 0) {
    const level = detectLevel(job.title);
    if (level && !f.levels.includes(level)) return false;
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
