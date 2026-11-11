import { COLUMNS, type Column, type JobDto, type JobListItemDto } from '@kv/shared';

export type ByColumn = Record<Column, JobListItemDto[]>;

/** Quantos cards cada coluna renderiza de início e a cada "Mostrar mais". */
export const PAGE_SIZE = 60;

/**
 * Quantos cards do topo de cada coluna animam a mudança de lugar (`layout` do Motion). Cada card com
 * `layout` é medido de novo a cada reordenação da coluna; do topo para baixo é onde o olho está e o
 * custo fica limitado, por mais cards que o usuário revele com "Mostrar mais".
 */
export const LAYOUT_ANIMATED = 24;

/** Minúsculas e sem acentos: "Açaí" e "acai" casam. */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** `needle` já normalizado (ver `normalizeText`). Procura no título e na empresa. */
export function matchesFilter(job: Pick<JobListItemDto, 'title' | 'company'>, needle: string): boolean {
  if (needle === '') return true;
  return normalizeText(job.title).includes(needle) || normalizeText(job.company).includes(needle);
}

const sameItems = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Vagas por coluna, na ordem do quadro (posição, depois id — a mesma ordem da API). Com `previous`, a
 * coluna cujo conteúdo não mudou devolve o MESMO array de antes: um refetch que mexe em uma coluna não
 * re-renderiza as outras.
 */
export function groupByColumn(jobs: readonly JobListItemDto[], previous?: ByColumn): ByColumn {
  const map = Object.fromEntries(COLUMNS.map((c) => [c, [] as JobListItemDto[]])) as ByColumn;
  for (const job of [...jobs].sort((a, b) => a.position - b.position || a.id - b.id)) map[job.column]?.push(job);
  if (previous) for (const c of COLUMNS) if (sameItems(previous[c], map[c])) map[c] = previous[c];
  return map;
}

/** Filtra cada coluna mantendo a ordem real; sem filtro devolve o próprio `byColumn`. */
export function filterByColumn(byColumn: ByColumn, needle: string, previous?: ByColumn): ByColumn {
  if (needle === '') return byColumn;
  const out = {} as ByColumn;
  for (const c of COLUMNS) {
    const matched = byColumn[c].filter((j) => matchesFilter(j, needle));
    out[c] = previous && sameItems(previous[c], matched) ? previous[c] : matched;
  }
  return out;
}

export const countJobs = (byColumn: ByColumn) => COLUMNS.reduce((n, c) => n + byColumn[c].length, 0);

/** Movimento otimista: só a vaga movida muda (as demais mantêm a identidade, e os cards delas não re-renderizam). */
export function applyMove(jobs: readonly JobListItemDto[], id: number, column: Column, position: number): JobListItemDto[] {
  return jobs.map((j) => (j.id === id ? { ...j, column, position } : j));
}

/** Resposta do PATCH: a vaga como o servidor gravou (posição final, `appliedBy`...), sem a descrição. */
export function mergeServerJob(jobs: readonly JobListItemDto[], server: JobDto | JobListItemDto): JobListItemDto[] {
  const { description: _description, dedupHash: _dedupHash, ...item } = server as JobDto & { dedupHash?: string };
  return jobs.map((j) => (j.id === item.id ? { ...j, ...item } : j));
}

/** Quantos cards da coluna ficam fora da tela com o limite atual. */
export const remainingAfter = (total: number, limit: number) => Math.max(0, total - limit);
