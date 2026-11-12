import {
  DndContext, DragOverlay, PointerSensor, defaultDropAnimationSideEffects, rectIntersection, useDroppable, useSensor,
  useSensors,
  type Announcements, type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent,
  type DropAnimation, type UniqueIdentifier,
} from '@dnd-kit/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownWideNarrow, CloudOff, LoaderCircle, RotateCw, Rows2, Rows4, Search, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { memo, useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import { COLUMNS, COLUMN_LABELS, LIMITS, type Column, type JobListItemDto } from '@kv/shared/client';
import { api } from '../api';
import { scoringPauseText, type ColumnSort, type ScoreMap } from '../lib/ai';
import { LAYOUT_ANIMATED, PAGE_SIZE, countJobs, displayColumn, filterByColumn, groupByColumn, normalizeText, remainingAfter, type ByColumn } from '../lib/board';
import { COLUMN_COLOR } from '../lib/columns';
import { useDebouncedValue, useScrollEdges } from '../lib/hooks';
import { spring, springSnap } from '../lib/motion';
import { cn } from '../lib/utils';
import { useAiStatus, useJobScores } from '../useAi';
import { JOBS_KEY, MOVE_KEY, useMoveJob } from '../useMoveJob';
import { JobCard, JobCardBody } from './JobCard';
import { StatsBar } from './StatsBar';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Notice } from './ui/notice';
import { Skeleton } from './ui/skeleton';
import { Tooltip } from './ui/tooltip';

const NO_JOBS: JobListItemDto[] = [];
/** Espera depois da última tecla antes de filtrar o quadro. */
const FILTER_DEBOUNCE_MS = 160;

type Density = 'comfortable' | 'compact';
const DENSITY_KEY = 'kv:density';
function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

type SortByColumn = Record<Column, ColumnSort>;
const SORT_KEY = 'kv.board.sort';
const BOARD_ORDER = Object.fromEntries(COLUMNS.map((c) => [c, 'board'])) as SortByColumn;
function readSort(): SortByColumn {
  try {
    const stored = JSON.parse(localStorage.getItem(SORT_KEY) ?? '{}') as Partial<Record<Column, unknown>>;
    return Object.fromEntries(COLUMNS.map((c) => [c, stored?.[c] === 'score' ? 'score' : 'board'])) as SortByColumn;
  } catch {
    return BOARD_ORDER;
  }
}
const SORT_HINT = 'Com a ordem por nota ligada, arrastar muda só a coluna.';

const transformOf = (t: { x: number; y: number; scaleX: number; scaleY: number }, scale = 1) =>
  `translate3d(${t.x}px, ${t.y}px, 0) scaleX(${t.scaleX * scale}) scaleY(${t.scaleY * scale})`;

/** Vaga movida: o card "pousa" onde foi solto e some, enquanto o card real entra na nova posição. */
const DROP_SETTLE: DropAnimation = {
  duration: 180,
  easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  keyframes: ({ transform }) => [
    { transform: transformOf(transform.initial), opacity: 1 },
    { transform: transformOf(transform.initial, 0.96), opacity: 0 },
  ],
};
/** Arraste cancelado: o card volta para o lugar de origem. */
const DROP_RETURN: DropAnimation = {
  duration: 260,
  easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
};

/**
 * Alvo do arraste. Vale a regra de sempre (o card ou a coluna com maior sobreposição), com um caso a mais:
 * ponteiro dentro de uma coluna e abaixo do último card dela (no "Mostrar mais" ou no espaço vazio) é
 * sempre a coluna, isto é, o fim de verdade. Sem isso, numa coluna cheia a maior sobreposição seria quase
 * sempre o último card visível, e não haveria como soltar "no fim".
 */
const dropTarget: CollisionDetection = (args) => {
  const { pointerCoordinates: pointer, droppableContainers, droppableRects } = args;
  if (pointer) {
    for (const container of droppableContainers) {
      if (!String(container.id).startsWith('col:')) continue;
      const col = droppableRects.get(container.id);
      if (!col || pointer.x < col.left || pointer.x > col.right || pointer.y < col.top || pointer.y > col.bottom) continue;
      let lastCardBottom = -Infinity;
      for (const other of droppableContainers) {
        if (!String(other.id).startsWith('card:')) continue;
        const card = droppableRects.get(other.id);
        if (card && card.left >= col.left && card.right <= col.right) lastCardBottom = Math.max(lastCardBottom, card.bottom);
      }
      if (pointer.y > lastCardBottom) return [{ id: container.id }];
      break;
    }
  }
  return rectIntersection(args);
};

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

interface ColumnProps {
  column: Column;
  index: number;
  /** Cards da coluna que passam pelo filtro, na ordem real. */
  jobs: JobListItemDto[];
  /** Total de verdade da coluna (sem filtro). */
  total: number;
  filtered: boolean;
  onOpen: (id: number) => void;
  compact: boolean;
  isTarget: boolean;
  /** Notas por vaga (vazio sem IA configurada). */
  scores: ScoreMap;
  sort: ColumnSort;
  /** A IA está configurada e existe ao menos uma nota: o botão de ordenar aparece. */
  canSort: boolean;
  onToggleSort: (column: Column) => void;
}

const ColumnView = memo(function ColumnView({ column, index, jobs, total, filtered, onOpen, compact, isTarget, scores, sort, canSort, onToggleSort }: ColumnProps) {
  const { setNodeRef } = useDroppable({ id: `col:${column}` });
  // Só uma "página" de cards vai para o DOM; o resto entra em passos com "Mostrar mais". Soltar um card na
  // coluna continua valendo o fim de verdade: a posição é calculada sobre a coluna completa (useMoveJob).
  const [limit, setLimit] = useState(PAGE_SIZE);
  // Ordem de exibição: depois do filtro de texto, antes da paginação. A posição gravada não muda.
  const byScore = canSort && sort === 'score';
  // Coluna sem cards à vista não tem o que ordenar: o botão some (a preferência gravada continua valendo).
  const showSort = canSort && jobs.length > 0;
  const shown = useMemo(() => displayColumn(jobs, byScore ? 'score' : 'board', scores), [jobs, byScore, scores]);
  const visible = useMemo(() => (shown.length > limit ? shown.slice(0, limit) : shown), [shown, limit]);
  const order = useMemo(() => visible.map((j) => j.id).join(','), [visible]);
  const remaining = remainingAfter(jobs.length, limit);
  const label = COLUMN_LABELS[column];
  const rest = `${remaining} ${plural(remaining, 'restante', 'restantes')}`;
  return (
    <motion.section
      ref={setNodeRef}
      data-testid={`column-${column}`}
      data-target={isTarget}
      aria-label={label}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: index * 0.045 }}
      style={{ '--col': COLUMN_COLOR[column] } as CSSProperties}
      className="kv-column flex min-w-52 flex-1 basis-0 flex-col"
    >
      <header className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-3">
        <span aria-hidden className="kv-dot" />
        <h2 className="text-sm font-semibold text-ink">{label}</h2>
        {showSort && (
          <Tooltip label={byScore ? `Ordenado por nota. ${SORT_HINT}` : `Ordenar por nota. ${SORT_HINT}`}>
            <button
              type="button" data-testid={`sort-${column}`} aria-pressed={byScore} aria-label={`Ordenar ${label} por nota`}
              onClick={() => onToggleSort(column)}
              className={cn(
                '-my-1 ml-auto grid size-7 shrink-0 cursor-pointer place-items-center rounded-lg transition-colors duration-150 active:scale-95',
                'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45',
                byScore ? 'bg-(--col)/16 text-ink ring-1 ring-inset ring-(color:--col)/40' : 'text-faint hover:bg-surface-3 hover:text-ink',
              )}
            >
              <ArrowDownWideNarrow aria-hidden className="size-3.5" />
            </button>
          </Tooltip>
        )}
        <span className={cn('kv-count', !showSort && 'ml-auto')}>
          <span aria-hidden>{filtered ? `${jobs.length}/${total}` : total}</span>
          <span className="sr-only">
            {filtered ? `${jobs.length} de ${total} vagas com o filtro` : `${total} ${plural(total, 'vaga', 'vagas')}`}
          </span>
        </span>
      </header>
      {/* layoutScroll: o Motion desconta a rolagem ao animar a reordenação dos cards. */}
      <motion.div layoutScroll className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 pt-0.5">
        {visible.map((j, i) => (
          <JobCard
            key={j.id} job={j} onOpen={onOpen} order={i < LAYOUT_ANIMATED ? order : ''} index={i} compact={compact}
            animateLayout={i < LAYOUT_ANIMATED} ai={scores.get(j.id)} insertable={!byScore}
          />
        ))}
        {remaining > 0 && (
          <Button
            variant="ghost" size="sm"
            onClick={() => setLimit((l) => l + PAGE_SIZE)}
            aria-label={`Mostrar mais vagas em ${label} (${rest})`}
            className="h-auto min-h-9 w-full whitespace-normal border border-dashed border-line py-1.5 text-xs text-muted hover:border-line-strong"
          >
            Mostrar mais ({rest})
          </Button>
        )}
        {jobs.length === 0 && (
          <div
            aria-hidden
            className={cn(
              'grid h-20 place-items-center rounded-[0.875rem] border border-dashed px-2 text-center text-xs transition-colors duration-200',
              isTarget ? 'border-(color:--col) bg-(--col)/10 text-ink-2' : 'border-line text-faint',
            )}
          >
            {isTarget ? 'Solte aqui' : filtered && total > 0 ? 'Nenhuma vaga com esse filtro' : 'Arraste vagas para cá'}
          </div>
        )}
      </motion.div>
    </motion.section>
  );
});

const EDGE_FADE =
  'pointer-events-none absolute bottom-2 top-0 z-10 w-14 from-bg/95 to-transparent transition-opacity duration-200 ease-out-soft';

const SKELETON_CARDS = [5, 3, 2, 1, 1, 0];

function BoardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Carregando vagas" className="flex min-h-0 flex-1 gap-3 overflow-hidden pb-2">
      {COLUMNS.map((c, i) => (
        <div
          key={c}
          style={{ '--col': COLUMN_COLOR[c] } as CSSProperties}
          className="kv-column flex min-w-52 flex-1 basis-0 flex-col"
        >
          <div className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-3">
            <span aria-hidden className="kv-dot opacity-50" />
            <h2 className="text-sm font-semibold text-muted">{COLUMN_LABELS[c]}</h2>
          </div>
          <div className="flex flex-col gap-2 px-2">
            {Array.from({ length: SKELETON_CARDS[i] ?? 0 }, (_, n) => (
              <div key={n} className="rounded-[0.875rem] border border-line bg-surface-2/60 p-3">
                <Skeleton className="h-3.5 w-[85%]" />
                <Skeleton className="mt-2 h-3 w-[55%]" />
                <div className="mt-3 flex gap-1.5">
                  <Skeleton className="h-4 w-10" />
                  <Skeleton className="h-4 w-12" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export const Board = memo(function Board({ onOpen }: { onOpen: (id: number) => void }) {
  const qc = useQueryClient();
  const reducedMotion = useReducedMotion();
  const [q, setQ] = useState('');
  const [density, setDensity] = useState<Density>(readDensity);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [overColumn, setOverColumn] = useState<Column | null>(null);
  const [settled, setSettled] = useState(false);
  // Uma consulta só para o quadro inteiro: o filtro de texto é aplicado aqui no cliente, sem ir à API.
  const { data, isSuccess, isPending, isError, refetch } = useQuery({
    queryKey: JOBS_KEY,
    queryFn: api.jobs,
    // Com um movimento em andamento o refetch periódico traria o quadro de antes dele; o próprio
    // movimento consulta o quadro de novo quando termina.
    refetchInterval: () => (qc.isMutating({ mutationKey: MOVE_KEY }) > 0 ? false : 15_000),
  });
  const jobs = data ?? NO_JOBS;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const { moveTo, moveToColumn } = useMoveJob();
  // Notas da IA: chegam por uma consulta própria (GET /jobs/ai) e são juntadas às vagas pelo id.
  const aiStatus = useAiStatus().data;
  const aiConfigured = aiStatus?.configured === true;
  // As notas pararam de chegar porque o provedor está indisponível: o quadro diz o motivo em vez de só ficar sem notas.
  const scoringPause = aiConfigured && aiStatus?.scoringPause ? scoringPauseText(aiStatus.scoringPause) : null;
  const { scores } = useJobScores(aiConfigured);
  const canSort = aiConfigured && scores.size > 0;
  const [sort, setSort] = useState<SortByColumn>(readSort);
  const toggleSort = useCallback((column: Column) => {
    setSort((prev) => {
      const next = { ...prev, [column]: prev[column] === 'score' ? 'board' : 'score' } as SortByColumn;
      try {
        localStorage.setItem(SORT_KEY, JSON.stringify(next));
      } catch {
        // sem armazenamento local: a escolha vale só para esta sessão
      }
      return next;
    });
  }, []);

  // Coluna real e completa, na ordem do quadro. Colunas que não mudaram mantêm o mesmo array entre
  // refetches (e a ColumnView delas, memoizada, não re-renderiza).
  const groupedRef = useRef<ByColumn | undefined>(undefined);
  const byColumn = useMemo(() => (groupedRef.current = groupByColumn(jobs, groupedRef.current)), [jobs]);
  const needle = normalizeText(useDebouncedValue(q, FILTER_DEBOUNCE_MS));
  const matchedRef = useRef<ByColumn | undefined>(undefined);
  const matched = useMemo(
    () => (matchedRef.current = filterByColumn(byColumn, needle, matchedRef.current)),
    [byColumn, needle],
  );
  const byId = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  const edges = useScrollEdges<HTMLDivElement>();

  function changeDensity(next: Density) {
    setDensity(next);
    try {
      localStorage.setItem(DENSITY_KEY, next);
    } catch {
      // sem armazenamento local: a escolha vale só para esta sessão
    }
  }

  const columnOf = useCallback(
    (overId: string | number | undefined): Column | null => {
      if (overId === undefined) return null;
      const over = String(overId);
      if (over.startsWith('col:')) return over.slice(4) as Column;
      return byId.get(Number(over.slice(5)))?.column ?? null;
    },
    [byId],
  );

  // O que o leitor de tela ouve durante o arraste (o padrão do dnd-kit é em inglês e fala em ids).
  const accessibility = useMemo(() => {
    const title = (id: UniqueIdentifier) => byId.get(Number(id))?.title ?? 'Vaga';
    const place = (overId: UniqueIdentifier | undefined) => {
      const column = columnOf(overId);
      return column ? `coluna ${COLUMN_LABELS[column]}` : null;
    };
    const announcements: Announcements = {
      onDragStart: ({ active }) => `${title(active.id)}: card levantado.`,
      onDragOver: ({ over }) => (place(over?.id) ? `Sobre a ${place(over?.id)}.` : undefined),
      onDragEnd: ({ active, over }) =>
        place(over?.id) ? `${title(active.id)}: solto na ${place(over?.id)}.` : `${title(active.id)}: solto fora do quadro; nada mudou.`,
      onDragCancel: ({ active }) => `${title(active.id)}: arraste cancelado.`,
    };
    return { announcements };
  }, [byId, columnOf]);

  function onDragStart(e: DragStartEvent) {
    setSettled(false);
    setActiveId(Number(e.active.id));
  }

  function onDragOver(e: DragOverEvent) {
    setOverColumn(columnOf(e.over?.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    setOverColumn(null);
    if (!e.over) return;
    const id = Number(e.active.id);
    const over = String(e.over.id);
    let column: Column;
    let beforeId: number | null = null;
    if (over.startsWith('col:')) {
      column = over.slice(4) as Column;
    } else {
      beforeId = Number(over.slice(5));
      if (beforeId === id) return;
      const target = byId.get(beforeId);
      if (!target) return;
      column = target.column;
    }
    // Coluna ordenada por nota: a ordem exibida não é a das posições gravadas, então soltar ali muda só a
    // coluna (sem posição calculada); soltar na própria coluna não faz nada.
    if (canSort && sort[column] === 'score') {
      if (byId.get(id)?.column === column) return;
      setSettled(true);
      moveToColumn(id, column);
      return;
    }
    setSettled(true);
    // Antes do card visível `beforeId` na ordem real, ou no fim de verdade da coluna — mesmo com filtro
    // ativo ou com a coluna só parcialmente renderizada.
    moveTo(id, column, beforeId);
  }

  function onDragCancel() {
    setActiveId(null);
    setOverColumn(null);
  }

  const active = activeId === null ? undefined : byId.get(activeId);
  const empty = isSuccess && jobs.length === 0;
  const compact = density === 'compact';
  const hasFilter = needle !== '';
  /** A digitação ainda não chegou ao quadro (debounce). */
  const filtering = normalizeText(q) !== needle;
  const results = hasFilter ? countJobs(matched) : jobs.length;

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6 sm:pb-4">
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={spring}
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3"
      >
        <StatsBar />
        <div className="flex min-w-64 flex-1 items-center justify-end gap-2.5">
          {hasFilter && !filtering && isSuccess && (
            <span aria-live="polite" className="whitespace-nowrap text-xs tabular-nums text-muted">
              {results === 0 ? 'Nenhum resultado' : `${results} ${plural(results, 'resultado', 'resultados')}`}
            </span>
          )}
          <div className="relative w-full max-w-80">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filtrar por título ou empresa"
              aria-label="Filtrar vagas"
              maxLength={LIMITS.search}
              className="bg-surface/80 px-9"
            />
            {filtering && (
              <LoaderCircle aria-hidden className="absolute right-3 top-1/2 -mt-2 size-4 animate-spin text-faint" />
            )}
            {q !== '' && !filtering && (
              <button
                type="button" onClick={() => setQ('')} aria-label="Limpar filtro"
                className="absolute right-1.5 top-1/2 grid size-7 -translate-y-1/2 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-surface-3 hover:text-ink"
              >
                <X aria-hidden className="size-4" />
              </button>
            )}
          </div>
          <div role="group" aria-label="Densidade dos cards" className="flex shrink-0 rounded-xl border border-line bg-bg/55 p-0.5 shadow-[inset_0_1px_2px_rgb(3_5_14/0.6)]">
            {([['comfortable', 'Cards confortáveis', Rows2], ['compact', 'Cards compactos', Rows4]] as const).map(([id, label, Icon]) => (
              <Tooltip key={id} label={label}>
                <button
                  type="button" aria-label={label} aria-pressed={density === id} onClick={() => changeDensity(id)}
                  className={cn(
                    'relative grid size-8.5 cursor-pointer place-items-center rounded-[0.625rem] transition-colors duration-150 active:scale-95',
                    density === id ? 'text-ink' : 'text-faint hover:text-ink',
                  )}
                >
                  {density === id && (
                    <motion.span
                      layoutId="density-pill" transition={springSnap}
                      className="absolute inset-0 rounded-[0.625rem] bg-surface-3 shadow-card ring-1 ring-inset ring-white/6"
                    />
                  )}
                  <Icon aria-hidden className="relative size-4" />
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </motion.div>

      {scoringPause && (
        <Notice tone="warn" role="status" data-testid="scoring-paused" title="As notas automáticas estão em pausa" className="shrink-0">
          <p className="break-words">{scoringPause.reason} {scoringPause.next}</p>
        </Notice>
      )}

      {isPending ? (
        <BoardSkeleton />
      ) : isError && !data ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-bad/12 text-bad ring-1 ring-inset ring-bad/25">
            <CloudOff aria-hidden className="size-6" />
          </span>
          <h2 className="text-lg font-semibold">Não foi possível carregar as vagas</h2>
          <p className="max-w-sm text-sm text-muted">Confira se a API está no ar e tente de novo.</p>
          <Button onClick={() => refetch()} className="mt-1">
            <RotateCw aria-hidden /> Tentar de novo
          </Button>
        </div>
      ) : empty ? (
        <motion.div
          initial={{ opacity: 0, y: 14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={spring}
          className="flex flex-1 flex-col items-center justify-center text-center"
        >
          <div className="relative">
            <div aria-hidden className="absolute inset-x-6 top-10 h-32 rounded-full bg-accent/20 blur-3xl" />
            <img
              src="/empty.png" alt="" className="relative h-52"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          </div>
          <h2 className="mt-2 text-xl font-semibold text-ink">Seu quadro está esperando as primeiras vagas</h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
            Nenhuma vaga ainda. Crie um perfil em <strong className="font-semibold text-ink">Perfis de busca</strong> e clique em{' '}
            <strong className="font-semibold text-ink">Buscar agora</strong>.
          </p>
        </motion.div>
      ) : (
        <DndContext
          sensors={sensors} collisionDetection={dropTarget} accessibility={accessibility} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel}
        >
          <div className="relative flex min-h-0 flex-1">
            <motion.div
              layoutScroll ref={edges.ref} onScroll={edges.update}
              className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2"
            >
              {COLUMNS.map((c, i) => (
                <ColumnView
                  key={c} column={c} index={i} jobs={matched[c]} total={byColumn[c].length} filtered={hasFilter}
                  onOpen={onOpen} compact={compact} isTarget={overColumn === c}
                  scores={scores} sort={sort[c]} canSort={canSort} onToggleSort={toggleSort}
                />
              ))}
            </motion.div>
            {/* Em telas estreitas o quadro rola na horizontal: o esmaecido avisa que há colunas fora da vista. */}
            <div aria-hidden className={cn(EDGE_FADE, 'left-0 bg-linear-to-r', edges.left ? 'opacity-100' : 'opacity-0')} />
            <div aria-hidden className={cn(EDGE_FADE, 'right-0 bg-linear-to-l', edges.right ? 'opacity-100' : 'opacity-0')} />
          </div>
          <DragOverlay zIndex={30} dropAnimation={reducedMotion ? null : settled ? DROP_SETTLE : DROP_RETURN}>
            {active && (
              <motion.article
                // Com "reduzir movimento" o card arrastado não cresce nem inclina: só a sombra o destaca.
                initial={{ scale: 1, rotate: 0 }}
                animate={reducedMotion ? { scale: 1, rotate: 0 } : { scale: 1.04, rotate: 1.8 }}
                transition={springSnap}
                className="job-card job-card--lifted"
              >
                <JobCardBody job={active} compact={compact} ai={scores.get(active.id)} />
              </motion.article>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
});
