import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CloudOff, Globe, MapPin, Sparkles, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { COLUMN_LABELS } from '@kv/shared';
import { ageLabel } from '../age';
import { api } from '../api';
import { COLUMN_COLOR } from '../lib/columns';
import { spring } from '../lib/motion';
import { SourceMark, sourceInfo } from './SourceMark';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Textarea } from './ui/input';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/sheet';
import { Skeleton } from './ui/skeleton';

const ACTOR_LABEL = { ia: 'IA', humano: 'Você', sistema: 'Sistema' } as const;

function CloseButton() {
  return (
    <SheetClose asChild>
      <Button variant="ghost" size="icon" aria-label="Fechar" className="-mr-1.5 -mt-1 shrink-0">
        <X aria-hidden />
      </Button>
    </SheetClose>
  );
}

function Section({ title, aside, children, index }: { title: string; aside?: ReactNode; children: ReactNode; index: number }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: 0.04 + index * 0.04 }}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{title}</h3>
        {aside}
      </div>
      {children}
    </motion.section>
  );
}

function DrawerSkeleton() {
  return (
    <div aria-busy="true" className="flex h-full flex-col">
      <header className="flex items-start gap-3.5 border-b border-line p-5">
        <Skeleton className="size-10 rounded-xl" />
        <div className="flex-1 pt-0.5">
          <SheetTitle className="sr-only">Detalhe da vaga</SheetTitle>
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="mt-2.5 h-3.5 w-2/5" />
          <span className="sr-only">Carregando…</span>
        </div>
        <CloseButton />
      </header>
      <div className="space-y-6 p-5">
        <Skeleton className="h-10 w-44 rounded-xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      </div>
    </div>
  );
}

function DrawerContent({ id }: { id: number }) {
  const qc = useQueryClient();
  const { data, isError } = useQuery({ queryKey: ['job', id], queryFn: () => api.job(id) });
  const [notes, setNotes] = useState('');
  useEffect(() => {
    if (data) setNotes(data.job.notes);
  }, [data]);
  const save = useMutation({
    mutationFn: () => api.patchJob(id, { notes }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['job', id] }),
  });

  if (!data && isError) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 p-5">
          <SheetTitle className="text-lg font-semibold">Detalhe da vaga</SheetTitle>
          <CloseButton />
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <span className="grid size-14 place-items-center rounded-2xl bg-bad/12 text-bad ring-1 ring-inset ring-bad/25">
            <CloudOff aria-hidden className="size-6" />
          </span>
          <p className="max-w-xs text-sm text-muted">Não foi possível carregar esta vaga. Feche e tente abrir de novo.</p>
        </div>
      </div>
    );
  }
  if (!data) return <DrawerSkeleton />;
  const { job, events } = data;
  const source = sourceInfo(job.source);

  return (
    <div className="flex h-full flex-col">
      <header
        className="relative border-b border-line p-5"
        style={{ '--col': COLUMN_COLOR[job.column] } as CSSProperties}
      >
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-linear-to-b from-(--col)/10 to-transparent" />
        <div className="relative flex items-start gap-3.5">
          <SourceMark source={job.source} size="lg" />
          <div className="min-w-0 flex-1">
            <SheetTitle className="text-[19px] font-semibold leading-snug text-ink">{job.title}</SheetTitle>
            <p className="mt-1 text-sm text-muted">
              <span className="text-ink-2">{job.company}</span> · {job.remote ? 'Remoto' : job.location || 'Local n/d'} · {job.source}
            </p>
          </div>
          <CloseButton />
        </div>
        <div className="relative mt-4 flex flex-wrap items-center gap-1.5">
          <Badge size="md" className="gap-1.5 bg-(--col)/14 text-ink ring-(color:--col)/30">
            <span aria-hidden className="size-1.5 rounded-full bg-(--col)" />
            {COLUMN_LABELS[job.column]}
          </Badge>
          {job.level && <Badge size="md" tone="accent" className="capitalize">{job.level}</Badge>}
          <Badge size="md" tone="outline">
            {job.remote ? <Globe aria-hidden className="size-3" /> : <MapPin aria-hidden className="size-3" />}
            {job.remote ? 'Remoto' : job.location || 'Local n/d'}
          </Badge>
          <Badge size="md" tone="outline">{source.name}</Badge>
          <Badge size="md" tone="outline">{ageLabel(job.postedAt)}</Badge>
          {job.needsHuman && <Badge size="md" tone="warn">precisa de você</Badge>}
        </div>
      </header>

      <div className="flex-1 space-y-7 overflow-y-auto p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="primary" size="lg">
            <a href={job.url} target="_blank" rel="noreferrer">
              Abrir vaga original <ArrowUpRight aria-hidden />
            </a>
          </Button>
          {job.stacks.map((s) => (
            <Badge key={s} size="md">{s}</Badge>
          ))}
        </div>

        <Section title="Análise IA" index={0}>
          <div className="flex gap-3 rounded-2xl border border-dashed border-accent/30 bg-accent/6 p-4">
            <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
            <p className="text-sm leading-relaxed text-muted">
              Disponível quando o módulo de IA for instalado: pontos fortes do seu perfil para esta vaga e o que revisar antes da entrevista.
            </p>
          </div>
        </Section>

        <Section
          title="Notas" index={1}
          aside={
            <span aria-live="polite" className="text-[11px] text-faint">
              {save.isPending ? 'Salvando…' : save.isSuccess ? 'Salvo' : ''}
            </span>
          }
        >
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== job.notes && save.mutate()}
            rows={4}
            aria-label="Notas"
          />
        </Section>

        <Section title="Descrição" index={2}>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">
            {job.description || 'Esta fonte não entrega a descrição na busca. Abra a vaga original para ler.'}
          </p>
        </Section>

        <Section title="Histórico" index={3}>
          <ul className="relative space-y-3.5 before:absolute before:bottom-2 before:left-[4.5px] before:top-2 before:w-px before:bg-line">
            {events.map((e) => (
              <li key={e.id} className="relative flex gap-3" style={{ '--col': COLUMN_COLOR[e.toColumn] } as CSSProperties}>
                <span aria-hidden className="relative mt-1.5 size-2.5 shrink-0 rounded-full bg-(--col) ring-4 ring-surface" />
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-ink">
                    {e.fromColumn ? `${COLUMN_LABELS[e.fromColumn]} → ` : ''}
                    {COLUMN_LABELS[e.toColumn]}
                  </p>
                  <p className="text-xs tabular-nums text-muted">
                    {new Date(e.createdAt).toLocaleString('pt-BR')} — {ACTOR_LABEL[e.actor]}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

export function JobDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      {id !== null && (
        <SheetContent>
          <DrawerContent id={id} />
        </SheetContent>
      )}
    </Sheet>
  );
}
