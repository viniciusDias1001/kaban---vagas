import {
  LIMITS, type AiStatusDto, type AiTaskDto, type JobAiSummaryDto, type LayerState, type PdfWarningsDto, type ProfileWire, type Violation,
  type ViolationCode,
} from '@kv/shared/client';
import { NETWORK_ERROR, errorMessage } from '../apiError';

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
export const cardTitle = (title: string, ai: JobAiSummaryDto | undefined): { title: string; original: string | null } =>
  drawerTitle(title, ai?.titlePt);

/**
 * A mesma regra do card, para o cabeçalho do painel da vaga: o título traduzido vem primeiro e o original
 * vai para uma segunda linha; sem tradução (ou com tradução igual ao original), só o original.
 */
export function drawerTitle(title: string, titlePt: string | null | undefined): { title: string; original: string | null } {
  const translated = titlePt?.trim();
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

const RETRY_NOTE = 'Nova tentativa agendada.';
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Uma frase: primeira letra maiúscula e pontuação no fim. Não mexe no meio do texto. */
const sentence = (text: string) => {
  const t = capitalize(text.trim());
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

/**
 * O erro gravado em uma tarefa (`ai_tasks.error`), pronto para a tela. Vem do worker como texto livre: ora
 * uma frase fixa e completa, ora um fragmento curto ("falha de rede"). Aqui ele só ganha maiúscula e ponto;
 * nada é presumido sobre prefixo, separadores ou número de tentativas. Entra na tela sempre como texto.
 */
export const taskErrorText = (error: string | null | undefined): string => (error?.trim() ? sentence(error) : 'Falhou, sem detalhe.');

/**
 * "Nova tentativa agendada." só para a tarefa que voltou para a fila depois de falhar. Uma tarefa em execução
 * já conta a tentativa em curso (`attempts` ≥ 1 na primeira execução), e a camada 3 pode somar duas na mesma
 * execução: o número de tentativas não é mostrado.
 */
export const retryNote = (task: AiTaskDto | null | undefined): string => (task?.status === 'queued' && task.attempts > 0 ? RETRY_NOTE : '');

/** Frase de estado para a interface. */
export function layerMessage(state: LayerState, task: AiTaskDto | null): string {
  switch (state) {
    case 'none':
      return 'Ainda não processado.';
    case 'queued':
      return task && task.attempts > 0 ? RETRY_NOTE : 'Na fila.';
    case 'running':
      return 'Processando...';
    case 'ok':
      return 'Pronto.';
    case 'stale':
      return 'Feito com uma versão anterior do seu perfil.';
    case 'blocked_budget':
      return 'O limite de gasto de hoje foi atingido.';
    case 'error':
      return taskErrorText(task?.error);
  }
}

/**
 * A triagem automática em pausa (`AiStatusDto.scoringPause`), em duas frases para a tela: o que o provedor
 * respondeu e o que acontece agora. `message` vem do worker (frase fixa do adaptador) e entra só como texto.
 */
export function scoringPauseText(pause: NonNullable<AiStatusDto['scoringPause']>): { reason: string; next: string } {
  const at = new Date(pause.retryAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const jobs = pause.tasks === 1 ? '1 vaga aguarda' : `${pause.tasks} vagas aguardam`;
  return {
    reason: `O provedor de IA respondeu: ${taskErrorText(pause.message)}`,
    next: `${jobs} a nota. Nova tentativa automática às ${at}; corrigir a chave ou o modelo em Configurações, ou um "Testar conexão" que funcione, retoma na hora.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Verificador de não invenção: rótulos das violações
// ---------------------------------------------------------------------------------------------

/**
 * Nome e explicação de cada código do verificador. `Record<ViolationCode, …>` obriga a cobrir todo código
 * que `@kv/shared` declarar (o typecheck quebra se faltar um), e o teste confere o mesmo contra
 * `VIOLATION_CODES` em tempo de execução.
 */
export const VIOLATION_LABELS: Record<ViolationCode, { label: string; help: string }> = {
  unknown_id: {
    label: 'Item que não existe no perfil',
    help: 'O currículo cita uma experiência, formação, habilidade ou outro item que não está (mais) no seu perfil.',
  },
  duplicate_id: {
    label: 'Item repetido',
    help: 'O mesmo item do perfil aparece mais de uma vez no currículo.',
  },
  new_number: {
    label: 'Número que não está no perfil',
    help: 'O texto traz um número, valor ou data que não aparece no trecho correspondente do seu perfil.',
  },
  foreign_company: {
    label: 'Nome da empresa da vaga',
    help: 'O texto cita a empresa que está contratando, que não é uma empresa do seu perfil.',
  },
  novel_term: {
    label: 'Termo que não está no perfil',
    help: 'O texto cita uma tecnologia, empresa, instituição, sigla ou outro nome que o seu perfil não menciona.',
  },
  unrelated_text: {
    label: 'Realização sem relação com a original',
    help: 'O texto desta realização não fala mais do mesmo assunto que a realização do perfil de onde ela veio, ou ficou vazio.',
  },
  limit: {
    label: 'Fora dos limites',
    help: 'Um texto ou uma lista passou do tamanho permitido, ou o texto contém um caractere de controle.',
  },
};

const PLACE_LISTS: Record<string, { one: string; many: string }> = {
  experiences: { one: 'Experiência', many: 'Experiências' },
  educationIds: { one: 'Formação', many: 'Formação' },
  skillIds: { one: 'Habilidade', many: 'Habilidades' },
  languageIds: { one: 'Idioma', many: 'Idiomas' },
  certificationIds: { one: 'Certificação', many: 'Certificações' },
  linkIds: { one: 'Link', many: 'Links' },
};

/** "experiences[0].achievements[1].text" → "Experiência 1, realização 2". null quando o caminho não é conhecido. */
export function violationPlace(path: string): string | null {
  if (path === 'summary') return 'Resumo';
  const m = /^([A-Za-z]+)(?:\[(\d+)\])?(?:\.achievements(?:\[(\d+)\])?)?(?:\.text)?$/.exec(path);
  const list = m && Object.hasOwn(PLACE_LISTS, m[1]) ? PLACE_LISTS[m[1]] : null;
  if (!m || !list) return null;
  if (m[2] === undefined) return list.many;
  const item = `${list.one} ${Number(m[2]) + 1}`;
  if (m[1] !== 'experiences' || !path.includes('.achievements')) return item;
  return m[3] === undefined ? `${item}, realizações` : `${item}, realização ${Number(m[3]) + 1}`;
}

const TERM_MAX = 120;

/** O termo ou número que divergiu, como uma pessoa o escreveria. As identidades internas de número não aparecem. */
function violationTerm(v: Violation): string | null {
  const detail = v.detail?.trim();
  if (!detail) return null;
  if (v.code === 'new_number') {
    const date = /^d:(\d{4})-(\d+)$/.exec(detail);
    if (date) return `${date[2].padStart(2, '0')}/${date[1]}`;
    if (/^[a-z]:/.test(detail)) return null;
  }
  return detail.length > TERM_MAX ? `${detail.slice(0, TERM_MAX)}…` : detail;
}

export interface ViolationView {
  label: string;
  help: string;
  /** O termo ou número que divergiu, quando há um. Texto vindo do modelo ou do usuário: sempre renderizado como texto. */
  term: string | null;
  /** Onde, em palavras ("Resumo", "Experiência 1, realização 2"). */
  place: string | null;
}

/** Como mostrar uma violação (ou aviso) do verificador. Um código que este build não conhece usa a mensagem da API. */
export function violationView(v: Violation): ViolationView {
  const known = Object.hasOwn(VIOLATION_LABELS, v.code) ? VIOLATION_LABELS[v.code] : null;
  return {
    label: known?.label ?? 'Divergência',
    help: known?.help ?? sentence(v.message || 'O verificador encontrou uma divergência.'),
    term: violationTerm(v),
    place: violationPlace(v.path),
  };
}

// ---------------------------------------------------------------------------------------------
// PDF do currículo adaptado: avisos antes do download e falhas do download
// ---------------------------------------------------------------------------------------------

/** `"😀" (U+1F600)`: o caractere e o código, para quem não o enxerga na tela. */
export const describeChar = (char: string): string => `"${char}" (U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')})`;

const CHARS_SHOWN = 12;

export interface PdfBlockers {
  /** Caracteres que a fonte do PDF não desenha, já descritos; no máximo 12. */
  characters: string[];
  /** Quantos ficaram fora da lista. */
  more: number;
  tooLong: boolean;
}

/** O que impediria o PDF de sair, a partir de `TailoredDto.pdfWarnings`. null = nada impede. */
export function pdfBlockers(warnings: PdfWarningsDto | undefined): PdfBlockers | null {
  const unsupported = warnings?.unsupportedCharacters ?? [];
  const tooLong = warnings?.tooLong === true;
  if (unsupported.length === 0 && !tooLong) return null;
  return {
    characters: unsupported.slice(0, CHARS_SHOWN).map(describeChar),
    more: Math.max(0, unsupported.length - CHARS_SHOWN),
    tooLong,
  };
}

/** Uma falha do download do PDF, pronta para a tela. */
export interface PdfFailure {
  title: string;
  /** O que fazer em seguida, quando há algo específico a dizer. */
  hint: string | null;
  /** Violações do verificador (409 `verification_failed`); mostradas como os avisos do salvamento. */
  violations: Violation[];
  /** Caracteres sem glifo (422 `pdf_unavailable`), já descritos. */
  characters: string[];
}

const isViolation = (v: unknown): v is Violation => {
  const o = v as Partial<Record<keyof Violation, unknown>> | null;
  return typeof o === 'object' && o !== null && typeof o.code === 'string' && typeof o.path === 'string' && typeof o.message === 'string' &&
    (o.detail === undefined || typeof o.detail === 'string');
};

/**
 * Lê a resposta de erro de `GET /jobs/:id/tailored.pdf`: 409 `verification_failed` (com `violations`), 409
 * `profile_missing`, 422 `pdf_unavailable` (com `code` e, às vezes, `characters`), ou qualquer outra coisa
 * (404, 5xx, a página de um proxy). `status` 0 = a requisição não teve resposta.
 */
export function parsePdfFailure(status: number, bodyText: string): PdfFailure {
  if (status === 0) return { title: NETWORK_ERROR, hint: null, violations: [], characters: [] };
  let body: { error?: unknown; violations?: unknown; characters?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === 'object' && parsed !== null) body = parsed;
  } catch {
    // corpo que não é JSON: `errorMessage` já sabe o que dizer
  }
  const title = sentence(errorMessage(status, bodyText));
  if (status === 409 && body.error === 'verification_failed') {
    return {
      // A mensagem da API repete as violações em uma linha só; aqui elas vão em lista, logo abaixo.
      title: 'O currículo não confere mais com o seu perfil e não pode virar PDF.',
      hint: 'Revise o texto e salve, ou adapte o currículo de novo.',
      violations: Array.isArray(body.violations) ? body.violations.filter(isViolation).map((v) => ({ ...v })) : [],
      characters: [],
    };
  }
  if (status === 409 && body.error === 'profile_missing') {
    return { title, hint: 'Envie o currículo ou gere o perfil de novo em Meu perfil e adapte o currículo outra vez.', violations: [], characters: [] };
  }
  const characters = status === 422 && Array.isArray(body.characters)
    ? body.characters.filter((c): c is string => typeof c === 'string' && c !== '').slice(0, CHARS_SHOWN).map(describeChar)
    : [];
  return { title, hint: null, violations: [], characters };
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
