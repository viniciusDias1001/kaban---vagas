import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, CloudOff, Globe, Info, MapPin, RotateCw, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { AI_TIER2_DESCRIPTION_CHARS, COLUMNS, COLUMN_LABELS, LIMITS, type Column, type JobDto } from '@kv/shared/client';
import { ageLabel } from '../age';
import { api } from '../api';
import { drawerTitle } from '../lib/ai';
import { COLUMN_COLOR } from '../lib/columns';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { useAiStatus, useJobAi, useJobScores } from '../useAi';
import { useJobNotes } from '../useJobNotes';
import { useMoveJob } from '../useMoveJob';
import { JobAiSection } from './JobAiSection';
import { JobApplicationSection } from './JobApplicationSection';
import { SourceMark, sourceInfo } from './SourceMark';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Textarea } from './ui/input';
import { Segmented } from './ui/segmented';
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/sheet';
import { Skeleton } from './ui/skeleton';

const ACTOR_LABEL = { ia: 'IA', humano: 'Você', sistema: 'Sistema', email: 'E-mail' } as const;
const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-faint';
/** A partir de quanto do limite o contador de caracteres das notas aparece. */
const NOTES_COUNTER_FROM = Math.floor(LIMITS.notes * 0.9);

function CloseButton() {
  return (
    <SheetClose asChild>
      <Button variant="ghost" size="icon" aria-label="Fechar" className="-mr-1.5 -mt-1 shrink-0">
        <X aria-hidden />
      </Button>
    </SheetClose>
  );
}

function Section({ title, titleId, aside, children, index }: {
  title: string; titleId?: string; aside?: ReactNode; children: ReactNode; index: number;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: 0.04 + index * 0.04 }}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 id={titleId} className={EYEBROW}>{title}</h3>
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

/**
 * Mover a vaga sem arrastar (teclado, leitor de tela, toque): faz o mesmo movimento que soltar o card no
 * fim da coluna escolhida e grava o mesmo histórico. São botões, e não um grupo de rádio, de propósito:
 * num rádio as setas trocariam a seleção a cada tecla e cada passo viraria um movimento no histórico.
 */
function MoveTo({ job, index }: { job: JobDto; index: number }) {
  const { moveTo } = useMoveJob();
  const titleId = useId();
  return (
    <Section title="Mover para" titleId={titleId} index={index}>
      <div role="group" aria-labelledby={titleId} className="grid grid-cols-3 gap-1.5">
        {COLUMNS.map((c: Column) => {
          const current = c === job.column;
          return (
            <Button
              key={c} size="sm"
              aria-current={current ? 'true' : undefined}
              aria-label={current ? `${COLUMN_LABELS[c]} (coluna atual)` : `Mover para ${COLUMN_LABELS[c]}`}
              onClick={() => !current && moveTo(job.id, c, null)}
              style={{ '--col': COLUMN_COLOR[c] } as CSSProperties}
              className={cn(
                'justify-start gap-2 px-2.5',
                current && 'cursor-default border-(color:--col)/45 bg-(--col)/14 text-ink shadow-none hover:border-(color:--col)/45 hover:bg-(--col)/14 active:scale-100',
              )}
            >
              <span aria-hidden className={cn('size-1.5 rounded-full bg-(--col)', !current && 'opacity-70')} />
              {COLUMN_LABELS[c]}
            </Button>
          );
        })}
      </div>
    </Section>
  );
}

function Notes({ jobId, serverNotes, index }: { jobId: number; serverNotes: string; index: number }) {
  const notes = useJobNotes(jobId, serverNotes);
  const errorId = useId();

  const failed = notes.status === 'error';
  const status = notes.status === 'saving' ? 'Salvando…' : failed ? 'Não salvo' : notes.status === 'saved' && !notes.dirty ? 'Salvo' : '';
  const length = notes.text.length;

  return (
    <Section
      title="Notas" index={index}
      aside={<span aria-live="polite" className={cn('text-[11px]', failed ? 'text-bad' : 'text-faint')}>{status}</span>}
    >
      {notes.seeded && (
        <Textarea
          value={notes.text}
          onChange={(e) => notes.edit(e.target.value)}
          onBlur={notes.flush}
          rows={2}
          maxLength={LIMITS.notes}
          placeholder="Contatos, próximos passos, impressões…"
          aria-label="Notas"
          aria-invalid={failed || undefined}
          aria-describedby={failed ? errorId : undefined}
          // Começa baixo e cresce com o texto até o teto; depois rola.
          className="max-h-80 min-h-[4.25rem] overflow-y-auto"
        />
      )}
      {length >= NOTES_COUNTER_FROM && (
        <p className={cn('mt-1.5 text-right text-[11px] tabular-nums', length >= LIMITS.notes ? 'text-warn' : 'text-faint')}>
          {length.toLocaleString('pt-BR')} / {LIMITS.notes.toLocaleString('pt-BR')} caracteres
          {length >= LIMITS.notes && ' (limite atingido)'}
        </p>
      )}
      {failed && (
        <div id={errorId} role="alert" className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-bad/25 bg-bad/8 px-3 py-2">
          <p className="min-w-0 flex-1 text-xs leading-snug text-bad">
            Não foi possível salvar as notas. {notes.error} Seu texto continua aqui.
          </p>
          <Button size="sm" onClick={notes.flush}>
            <RotateCw aria-hidden /> Tentar de novo
          </Button>
        </div>
      )}
    </Section>
  );
}

/**
 * Descrição da vaga. Quando a IA já traduziu, um controle troca entre o texto original e o traduzido
 * (padrão: traduzido). Os dois vêm de fora (site da vaga, IA): entram sempre como texto, nunca como HTML.
 */
function Description({ original, translated, index }: { original: string; translated: string | null; index: number }) {
  const [show, setShow] = useState<'original' | 'traduzido'>('traduzido');
  const labelId = useId();
  const hasOriginal = original.trim() !== '';
  const hasTranslation = !!translated && translated.trim() !== '';
  if (!hasOriginal && !hasTranslation) return null;
  const text = hasTranslation && (show === 'traduzido' || !hasOriginal) ? translated : original;
  return (
    <Section
      title="Descrição" index={index}
      aside={hasTranslation && (hasOriginal ? (
        <div data-testid="description-toggle" className="-my-1.5">
          <span id={labelId} className="sr-only">Idioma da descrição</span>
          <Segmented
            aria-labelledby={labelId} value={show} onValueChange={setShow}
            options={[{ value: 'original', label: 'Original' }, { value: 'traduzido', label: 'Traduzido' }]}
            className="w-48 p-0.5 [&>button]:h-7 [&>button]:text-xs"
          />
        </div>
      ) : <span className="text-[11px] text-faint">traduzida pela IA</span>)}
    >
      <p lang={text === original ? undefined : 'pt-BR'} className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-2">{text}</p>
      {text !== original && original.trim().length > AI_TIER2_DESCRIPTION_CHARS && (
        <p data-testid="translation-partial" className="mt-2 text-xs leading-snug text-faint">
          A descrição é longa: a IA leu e traduziu os primeiros {AI_TIER2_DESCRIPTION_CHARS.toLocaleString('pt-BR')} caracteres. O restante está no texto original.
        </p>
      )}
    </Section>
  );
}

function DrawerContent({ id, onOpenSettings }: { id: number; onOpenSettings: () => void }) {
  const { data, isError } = useQuery({ queryKey: ['job', id], queryFn: () => api.job(id) });
  // A análise mora na seção "Análise IA"; a consulta fica aqui porque a descrição usa a tradução.
  const aiStatus = useAiStatus();
  const aiConfigured = aiStatus.data?.configured === true;
  const ai = useJobAi(id, aiConfigured, aiStatus.data?.tier2Auto === true);
  const { scores } = useJobScores(aiConfigured);

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
  const hasDescription = job.description.trim() !== '';
  const hasStacks = job.stacks.length > 0;
  const translated = aiConfigured && ai.data?.descriptionPt?.trim() ? ai.data.descriptionPt : null;
  // O mesmo título do card: a nota do quadro (já em cache) responde na hora; o detalhe da vaga confirma depois.
  const titlePt = aiConfigured ? (scores.get(job.id)?.titlePt ?? ai.data?.summary?.titlePt) : null;
  const shown = drawerTitle(job.title, titlePt);
  // Seções opcionais (stacks, descrição) não deixam buraco na cascata de entrada.
  let order = 0;

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
            {/* Como no card: o título traduzido primeiro; o original logo abaixo, identificado. Os dois como texto. */}
            <SheetTitle data-testid="job-title" className="break-words text-[19px] font-semibold leading-snug text-ink">{shown.title}</SheetTitle>
            {shown.original !== null && (
              <p data-testid="job-original-title" className="mt-0.5 break-words text-xs leading-snug text-muted">
                <span className="text-faint">Título original: </span>{shown.original}
              </p>
            )}
            {/* Cada fato aparece uma vez: aqui empresa e local; status, nível, fonte e idade ficam nos chips. */}
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
              <span className="text-ink-2">{job.company}</span>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1">
                {job.remote ? <Globe aria-hidden className="size-3.5" /> : <MapPin aria-hidden className="size-3.5" />}
                {job.remote ? 'Remoto' : job.location || 'Local n/d'}
              </span>
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
          <Badge size="md" tone="outline">{source.name}</Badge>
          <Badge size="md" tone="outline">{ageLabel(job.postedAt)}</Badge>
          {job.needsHuman && <Badge size="md" tone="warn">precisa de você</Badge>}
        </div>
      </header>

      <div className="relative flex-1 space-y-6 overflow-y-auto p-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <Button asChild variant="primary" size="lg">
            <a href={job.url} target="_blank" rel="noreferrer">
              Abrir vaga original <ArrowUpRight aria-hidden />
            </a>
          </Button>
          {!hasDescription && (
            <p className="flex min-w-52 flex-1 items-start gap-1.5 text-xs leading-snug text-faint">
              <Info aria-hidden className="mt-px size-3.5 shrink-0" />
              Esta fonte não entrega a descrição na busca. Abra a vaga original para ler.
            </p>
          )}
        </div>

        <MoveTo job={job} index={order++} />

        {/* Some quando a função está desligada e a vaga não tem candidatura: o painel fica como sempre foi. */}
        <JobApplicationSection job={job} index={order++} />

        {hasStacks && (
          <Section title="Stacks" index={order++}>
            <ul aria-label="Stacks da vaga" className="flex flex-wrap gap-1.5">
              {job.stacks.map((s) => (
                <li key={s} className="flex"><Badge size="md">{s}</Badge></li>
              ))}
            </ul>
          </Section>
        )}

        <Notes jobId={job.id} serverNotes={job.notes} index={order++} />

        {(hasDescription || translated) && <Description original={job.description} translated={translated} index={order++} />}

        <JobAiSection jobId={job.id} status={aiStatus} detail={ai} onOpenSettings={onOpenSettings} index={order++} />

        <Section title="Histórico" index={order++}>
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

export function JobDrawer({ id, onClose, onOpenSettings }: { id: number | null; onClose: () => void; onOpenSettings: () => void }) {
  return (
    <Sheet open={id !== null} onOpenChange={(open) => !open && onClose()}>
      {id !== null && (
        <SheetContent>
          <DrawerContent id={id} onOpenSettings={onOpenSettings} />
        </SheetContent>
      )}
    </Sheet>
  );
}
