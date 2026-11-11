import {
  DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { COLUMNS, COLUMN_LABELS, type Column, type JobDto } from '@kv/shared';
import { api } from '../api';
import { computePosition } from '../position';
import { JobCard, JobCardBody } from './JobCard';
import { StatsBar } from './StatsBar';

function ColumnView({ column, jobs, onOpen }: { column: Column; jobs: JobDto[]; onOpen: (id: number) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column}` });
  return (
    <section
      ref={setNodeRef}
      data-testid={`column-${column}`}
      className={`flex min-w-60 flex-1 basis-0 flex-col rounded-xl border bg-surface-2/40 ${isOver ? 'border-accent' : 'border-line'}`}
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-sm font-semibold">{COLUMN_LABELS[column]}</h2>
        <span className="text-xs text-muted">{jobs.length}</span>
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {jobs.map((j) => (
          <JobCard key={j.id} job={j} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

export function Board({ onOpen }: { onOpen: (id: number) => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [activeId, setActiveId] = useState<number | null>(null);
  const { data: jobs = [], isSuccess } = useQuery({
    queryKey: ['jobs', q],
    queryFn: () => api.jobs(q),
    refetchInterval: 15_000,
  });
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

  function onDragStart(e: DragStartEvent) {
    setActiveId(Number(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
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
    move.mutate({ id, column, position: computePosition(others, beforeId) });
  }

  const active = jobs.find((j) => j.id === activeId);
  const empty = isSuccess && jobs.length === 0 && q === '';

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center justify-between gap-4">
        <StatsBar />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filtrar por título ou empresa"
          aria-label="Filtrar vagas"
          className="w-72 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </div>

      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <img
            src="/empty.png" alt="" className="h-48"
            onError={(e) => { e.currentTarget.style.display = 'none'; }}
          />
          <p className="text-muted">
            Nenhuma vaga ainda. Crie um perfil em <strong>Perfis de busca</strong> e clique em <strong>Buscar agora</strong>.
          </p>
        </div>
      ) : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
            {COLUMNS.map((c) => (
              <ColumnView key={c} column={c} jobs={byColumn[c]} onOpen={onOpen} />
            ))}
          </div>
          <DragOverlay>
            {active && (
              <article className="w-64 rotate-2 cursor-grabbing rounded-lg border border-accent bg-surface p-3 shadow-xl">
                <JobCardBody job={active} />
              </article>
            )}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  );
}
