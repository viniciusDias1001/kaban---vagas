import { useDraggable, useDroppable } from '@dnd-kit/core';
import { motion } from 'motion/react';
import type { JobDto } from '@kv/shared';

const DAY = 86_400_000;

export function ageLabel(postedAt: number | null, now: number = Date.now()): string {
  if (postedAt === null) return 'data n/d';
  const days = Math.floor((now - postedAt) / DAY);
  if (days <= 0) return 'hoje';
  return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

export function JobCardBody({ job }: { job: JobDto }) {
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium leading-snug">{job.title}</h3>
        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-muted">{job.source}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {job.company} · {job.remote ? 'Remoto' : job.location || 'Local n/d'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {job.level && <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent">{job.level}</span>}
        {job.stacks.slice(0, 3).map((s) => (
          <span key={s} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink">{s}</span>
        ))}
        {job.needsHuman && <span className="rounded bg-warn/20 px-1.5 py-0.5 text-[10px] text-warn">precisa de você</span>}
        <span className="ml-auto text-[10px] text-muted">{ageLabel(job.postedAt)}</span>
      </div>
    </>
  );
}

export function JobCard({ job, onOpen }: { job: JobDto; onOpen: (id: number) => void }) {
  const drag = useDraggable({ id: job.id });
  const drop = useDroppable({ id: `card:${job.id}` });
  const setRef = (el: HTMLElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  };

  return (
    <motion.article
      ref={setRef}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: drag.isDragging ? 0.35 : 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      data-testid="job-card"
      onClick={() => onOpen(job.id)}
      className={`cursor-grab rounded-lg border bg-surface p-3 shadow-sm ${
        drop.isOver && !drag.isDragging ? 'border-accent' : 'border-line'
      }`}
      {...drag.listeners}
      {...drag.attributes}
    >
      <JobCardBody job={job} />
    </motion.article>
  );
}
