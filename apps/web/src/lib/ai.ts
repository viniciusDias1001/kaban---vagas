import { LIMITS, type AiTaskDto, type JobAiSummaryDto, type LayerState, type ProfileWire } from '@kv/shared/client';

/** Lógica pura das telas de IA (sem React): ordenação, rótulos, estados e validação do arquivo. */

export type ScoreMap = ReadonlyMap<number, JobAiSummaryDto>;
export const toScoreMap = (scores: readonly JobAiSummaryDto[]): ScoreMap => new Map(scores.map((s) => [s.jobId, s]));

/** Ordem de uma coluna: a do quadro (posição) ou por nota. */
export type ColumnSort = 'board' | 'score';

/**
 * Ordena por nota, da maior para a menor. Vagas sem nota vão para o fim, na ordem do quadro; empates
 * também mantêm a ordem do quadro. Não altera a lista recebida.
 */
export function sortByScore<T extends { id: number }>(jobs: readonly T[], scores: ScoreMap): T[] {
  const score = (job: T) => scores.get(job.id)?.score ?? -1;
  return jobs.map((job, index) => ({ job, index })).sort((a, b) => score(b.job) - score(a.job) || a.index - b.index).map((x) => x.job);
}

export type ScoreTone = 'high' | 'mid' | 'low';
/** Faixa visual da nota: 75 ou mais, 50 a 74, abaixo de 50. */
export const scoreTone = (score: number): ScoreTone => (score >= 75 ? 'high' : score >= 50 ? 'mid' : 'low');

/**
 * Título a mostrar no card: o traduzido, quando existe e é diferente do original. `original` (para a
 * dica) só vem preenchido quando o card está mostrando a tradução.
 */
export function cardTitle(title: string, ai: JobAiSummaryDto | undefined): { title: string; original: string | null } {
  const translated = ai?.titlePt?.trim();
  if (!translated || translated.toLowerCase() === title.trim().toLowerCase()) return { title, original: null };
  return { title: translated, original: title };
}

/** "pt" → "PT", "en-US" → "EN"; null quando o idioma ainda não foi detectado. */
export const languageBadge = (language: string | null | undefined): string | null =>
  language ? language.slice(0, 2).toUpperCase() : null;

export const isPending = (state: LayerState): boolean => state === 'queued' || state === 'running';

/** Intervalo de atualização enquanto alguma camada está na fila ou executando; `false` para parar. */
export const pollMs = (...states: (LayerState | undefined)[]): number | false =>
  states.some((s) => s !== undefined && isPending(s)) ? 2_000 : false;

/** Frase de estado para a interface. */
export function layerMessage(state: LayerState, task: AiTaskDto | null): string {
  switch (state) {
    case 'none':
      return 'Ainda não processado.';
    case 'queued':
      return task && task.attempts > 0 ? `Nova tentativa agendada (tentativa ${task.attempts + 1} de 3).` : 'Na fila.';
    case 'running':
      return 'Processando...';
    case 'ok':
      return 'Pronto.';
    case 'stale':
      return 'Feito com uma versão anterior do seu perfil.';
    case 'blocked_budget':
      return 'O limite de gasto de hoje foi atingido.';
    case 'error':
      return task?.error ? `Falhou: ${task.error}` : 'Falhou.';
  }
}

const USD = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
export const formatUsd = (value: number): string => USD.format(value);

/** Confere o arquivo antes de enviar; a API confere de novo, pelo conteúdo. Devolve a mensagem de erro ou null. */
export function resumeFileProblem(file: { name: string; size: number }): string | null {
  if (!/\.(pdf|docx)$/i.test(file.name)) return 'Envie um arquivo PDF ou DOCX.';
  if (file.size > LIMITS.resumeBytes) return 'O arquivo tem mais de 5 MB.';
  if (file.size === 0) return 'O arquivo está vazio.';
  return null;
}

/** Itens novos do editor de perfil: `id` vazio, que a API troca por um id estável ao salvar. */
export const blankItem = {
  experience: (): ProfileWire['experiences'][number] => ({ id: '', company: '', title: '', start: '', end: '', location: '', achievements: [] }),
  achievement: (): ProfileWire['experiences'][number]['achievements'][number] => ({ id: '', text: '' }),
  education: (): ProfileWire['education'][number] => ({ id: '', institution: '', degree: '', start: '', end: '' }),
  skill: (): ProfileWire['skills'][number] => ({ id: '', name: '' }),
  language: (): ProfileWire['languages'][number] => ({ id: '', name: '', level: '' }),
  certification: (): ProfileWire['certifications'][number] => ({ id: '', name: '', issuer: '', date: '' }),
  link: (): ProfileWire['links'][number] => ({ id: '', label: '', url: '' }),
};
