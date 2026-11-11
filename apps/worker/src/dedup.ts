import { createHash } from 'node:crypto';

const fold = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Mesma empresa + título + local = mesma vaga, venha de onde vier. */
export function dedupHash(job: { company: string; title: string; location: string }): string {
  return createHash('sha1').update(`${fold(job.company)}|${fold(job.title)}|${fold(job.location)}`).digest('hex');
}
