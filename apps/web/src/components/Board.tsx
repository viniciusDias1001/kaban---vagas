import {
  DndContext, DragOverlay, PointerSensor, defaultDropAnimationSideEffects, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent, type DragStartEvent, type DropAnimation,
} from '@dnd-kit/core';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudOff, LoaderCircle, RotateCw, Rows2, Rows4, Search, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { memo, useCallback, useMemo, useState, type CSSProperties } from 'react';
import { COLUMNS, COLUMN_LABELS, type Column, type JobDto } from '@kv/shared';
import { api } from '../api';
import { COLUMN_COLOR } from '../lib/columns';
import { spring, springSnap } from '../lib/motion';
import { cn } from '../lib/utils';
import { computePosition } from '../position';
import { JobCard, JobCardBody } from './JobCard';
import { StatsBar } from './StatsBar';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Skeleton } from './ui/skeleton';
import { Tooltip } from './ui/tooltip';

const NO_JOBS: JobDto[] = [];

type Density = 'comfortable' | 'compact';
const DENSITY_KEY = 'kv:density';
function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

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

interface ColumnProps {
  column: Column;
  index: number;
  jobs: JobDto[];
  onOpen: (id: number) => void;
  compact: boolean;
  isTarget: boolean;
}

const ColumnView = memo(function ColumnView({ column, index, jobs, onOpen, compact, isTarget }: ColumnProps) {
  const { setNodeRef } = useDroppable({ id: `col:${column}` });
  const order = useMemo(() => jobs.map((j) => j.id).join(','), [jobs]);
  return (
    <motion.section
      ref={setNodeRef}
      data-testid={`column-${column}`}
      data-target={isTarget}
      aria-label={COLUMN_LABELS[column]}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: index * 0.045 }}
      style={{ '--col': COLUMN_COLOR[column] } as CSSProperties}
      className="kv-column flex min-w-52 flex-1 basis-0 flex-col"
    >
      <header className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-3">
        <span aria-hidden className="kv-dot" />
        <h2 className="text-sm font-semibold text-ink">{COLUMN_LABELS[column]}</h2>
        <span className="kv-count ml-auto">{jobs.length}</span>
      </header>
      {/* layoutScroll: o Motion desconta a rolagem ao animar a reordenação dos cards. */}
      <motion.div layoutScroll className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 pt-0.5">
        {jobs.map((j, i) => (
          <JobCard key={j.id} job={j} onOpen={onOpen} order={order} index={i} compact={compact} />
        ))}
        {jobs.length === 0 && (
          <div
            aria-hidden
            className={cn(
              'grid h-20 place-items-center rounded-[0.875rem] border border-dashed text-xs transition-colors duration-200',
              isTarget ? 'border-(color:--col) bg-(--col)/10 text-ink-2' : 'border-line text-faint',
            )}
          >
            {isTarget ? 'Solte aqui' : 'Arraste vagas para cá'}
          </div>
        )}
      </motion.div>
    </motion.section>
  );
});

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
  const { data, isSuccess, isPending, isError, isFetching, isPlaceholderData, refetch } = useQuery({
    queryKey: ['jobs', q],
    queryFn: () => api.jobs(q),
    refetchInterval: 15_000,
    // Mantém o resultado anterior na tela enquanto o filtro novo carrega (sem piscar o quadro vazio).
    placeholderData: keepPreviousData,
  });
  const jobs = data ?? NO_JOBS;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const move = useMutation({
    mutationFn: (v: { id: number; column: Column; position: number }) =>
      api.patchJob(v.id, { column: v.column, position: v.position }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['jobs'] });
      qc.setQueryData<JobDto[]>(['jobs', q], (old = []) =>
        old.map((j) => (j.id === v.id ? { ...j, column: v.column, position: v.position } : j)),
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  const byColumn = useMemo(() => {
    const map = Object.fromEntries(COLUMNS.map((c) => [c, [] as JobDto[]])) as Record<Column, JobDto[]>;
    for (const j of [...jobs].sort((a, b) => a.position - b.position)) map[j.column].push(j);
    return map;
  }, [jobs]);

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
      return jobs.find((j) => j.id === Number(over.slice(5)))?.column ?? null;
    },
    [jobs],
  );

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
      const target = jobs.find((j) => j.id === beforeId);
      if (!target) return;
      column = target.column;
    }
    const others = byColumn[column].filter((j) => j.id !== id);
    setSettled(true);
    move.mutate({ id, column, position: computePosition(others, beforeId) });
  }

  function onDragCancel() {
    setActiveId(null);
    setOverColumn(null);
  }

  const active = jobs.find((j) => j.id === activeId);
  const empty = isSuccess && !isPlaceholderData && jobs.length === 0 && q === '';
  const compact = density === 'compact';
  const filtering = q !== '' && isFetching && isPlaceholderData;

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6 sm:pb-4">
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={spring}
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3"
      >
        <StatsBar />
        <div className="flex min-w-64 flex-1 items-center justify-end gap-2.5">
          {q !== '' && !filtering && isSuccess && (
            <span className="whitespace-nowrap text-xs tabular-nums text-muted">
              {jobs.length} {jobs.length === 1 ? 'resultado' : 'resultados'}
            </span>
          )}
          <div className="relative w-full max-w-80">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filtrar por título ou empresa"
              aria-label="Filtrar vagas"
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
          sensors={sensors} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel}
        >
          <motion.div layoutScroll className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
            {COLUMNS.map((c, i) => (
              <ColumnView
                key={c} column={c} index={i} jobs={byColumn[c]} onOpen={onOpen} compact={compact}
                isTarget={overColumn === c}
              />
            ))}
          </motion.div>
          <DragOverlay zIndex={30} dropAnimation={reducedMotion ? null : settled ? DROP_SETTLE : DROP_RETURN}>
            {active && (
              <motion.article
                initial={{ scale: 1, rotate: 0 }} animate={{ scale: 1.04, rotate: 1.8 }} transition={springSnap}
                className="job-card job-card--lifted"
              >
                <JobCardBody job={active} compact={compact} />
              </motion.article>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
});
