import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Bot, FlaskConical, Hand, Mail, MailCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { memo, useCallback, useMemo, type KeyboardEvent } from 'react';
import type { JobAiListItemDto, JobListItemDto } from '@kv/shared/client';
import { ageLabel } from '../age';
import { cardTitle } from '../lib/ai';
import { cardBadge } from '../lib/apply';
import { mailBadgeLabel } from '../lib/email';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { LanguageBadge, ScoreBadge } from './ScoreBadge';
import { SourceMark, sourceInfo } from './SourceMark';
import { Badge } from './ui/badge';
import { Tooltip } from './ui/tooltip';

function Age({ postedAt }: { postedAt: number | null }) {
  const label = ageLabel(postedAt);
  const fresh = label === 'hoje';
  return (
    <span className={cn('flex shrink-0 items-center gap-1 pl-1 text-[11px] tabular-nums', fresh ? 'text-ok' : 'text-muted')}>
      {fresh && <span aria-hidden className="size-1.5 rounded-full bg-ok" />}
      {label}
    </span>
  );
}

type CardBadgeKind = NonNullable<ReturnType<typeof cardBadge>>;
const CARD_BADGES: Record<CardBadgeKind, { label: string; tone: 'warn' | 'accent' | 'ok' | 'neutral' }> = {
  needs_human: { label: 'precisa de você', tone: 'warn' },
  applying: { label: 'IA aplicando', tone: 'accent' },
  rehearsal: { label: 'ensaio pronto', tone: 'neutral' },
  applied_by_ai: { label: 'aplicada pela IA', tone: 'ok' },
};

/** O selo da candidatura automática: a marca da vaga manda, depois o estado da candidatura da vaga (`cardBadge`). */
function ApplyBadge({ job, className }: { job: JobListItemDto; className?: string }) {
  const kind = cardBadge(job);
  if (!kind) return null;
  const { label, tone } = CARD_BADGES[kind];
  return (
    <Badge tone={tone} data-testid={`job-badge-${kind}`} className={cn('gap-1', className)}>
      {kind === 'applying' ? (
        <span aria-hidden className="relative flex size-1.5">
          <span className="absolute inset-0 animate-pulse-dot rounded-full bg-current" />
          <span className="relative size-1.5 rounded-full bg-current" />
        </span>
      ) : kind === 'needs_human' ? <Hand aria-hidden className="size-3" />
        : kind === 'rehearsal' ? <FlaskConical aria-hidden className="size-3 text-accent" />
        : <Bot aria-hidden className="size-3" />}
      {label}
    </Badge>
  );
}

const MAIL_BADGE_TONE: Record<NonNullable<JobListItemDto['mail']['badge']>, 'accent' | 'ok' | 'warn'> = {
  entrevista: 'accent', oferta: 'ok', pedido: 'warn',
};

/** As marcas dos e-mails da vaga: o selo do e-mail novo ("entrevista", "oferta", "pediu informação") e "empresa confirmou". */
function MailMarks({ job }: { job: JobListItemDto }) {
  const { badge, confirmed } = job.mail;
  return (
    <>
      {badge && (
        <Badge tone={MAIL_BADGE_TONE[badge]} data-testid={`card-mail-badge-${job.id}`} className="gap-1">
          <Mail aria-hidden className="size-3" />
          <span className="sr-only">E-mail: </span>{mailBadgeLabel(badge)}
        </Badge>
      )}
      {confirmed && (
        <Badge tone="neutral" data-testid={`card-mail-confirmed-${job.id}`} className="gap-1">
          <MailCheck aria-hidden className="size-3 text-ok" />
          empresa confirmou
        </Badge>
      )}
    </>
  );
}

/**
 * Hierarquia do card: título (o que se lê primeiro) → fonte + empresa + local → nível/stacks e idade.
 * No modo compacto ficam só as duas primeiras linhas, com a idade na segunda.
 *
 * Com `ai` (a vaga já tem nota) entram a nota ao lado do título, o idioma original e o título traduzido,
 * com o original na dica. Sem `ai` o card fica exatamente como sempre foi: nada é reservado.
 */
export function JobCardBody({ job, compact = false, ai }: {
  job: JobListItemDto; compact?: boolean; ai?: JobAiListItemDto;
}) {
  const shown = cardTitle(job.title, ai);
  const scored = ai !== undefined && ai.score !== null;
  const heading = (
    <h3
      title={shown.original ?? undefined}
      className={cn('min-w-0 flex-1 text-[13px] font-semibold leading-[1.35] text-ink', compact ? 'truncate' : 'line-clamp-2')}
    >
      {shown.title}
      {shown.original && <span className="sr-only"> (título original: {shown.original})</span>}
    </h3>
  );
  const language = scored ? <LanguageBadge language={ai.language} /> : null;
  return (
    <div className={compact ? 'px-2.5 py-2' : 'p-3'}>
      <div className="flex items-start gap-2">
        {shown.original ? <Tooltip label={`Original: ${shown.original}`} side="top">{heading}</Tooltip> : heading}
        {scored && <ScoreBadge ai={ai} className="-mr-0.5 -mt-px" />}
      </div>
      <div className={cn('flex items-center gap-1.5 text-xs text-muted', compact ? 'mt-1' : 'mt-1.5')}>
        <SourceMark source={job.source} />
        <span className="sr-only">{sourceInfo(job.source).name}: </span>
        <p className="min-w-0 truncate">
          <span className="text-ink-2">{job.company}</span> · {job.remote ? 'Remoto' : job.location || 'Local n/d'}
        </p>
        {compact && <span className="ml-auto flex shrink-0 items-center gap-1.5">{language}<Age postedAt={job.postedAt} /></span>}
      </div>
      {!compact && (
        // As etiquetas quebram de linha quando não cabem; a idade fica fora delas e nunca é cortada ("hoje" virava "ho").
        <div className="mt-2.5 flex items-start gap-1">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {language}
            {job.level && <Badge tone="accent" className="capitalize">{job.level}</Badge>}
            {job.stacks.slice(0, 3).map((s) => (
              <Badge key={s} className="max-w-full truncate">{s}</Badge>
            ))}
            <ApplyBadge job={job} />
            <MailMarks job={job} />
          </div>
          <span className="flex h-5 shrink-0 items-center"><Age postedAt={job.postedAt} /></span>
        </div>
      )}
      {compact && (cardBadge(job) || job.mail.badge || job.mail.confirmed) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <ApplyBadge job={job} />
          <MailMarks job={job} />
        </div>
      )}
    </div>
  );
}

interface JobCardProps {
  job: JobListItemDto;
  onOpen: (id: number) => void;
  /**
   * Assinatura da ordem da coluna: só quando ela muda o Motion mede o layout de novo. Vazia para os cards
   * sem animação de layout, que assim nem re-renderizam quando a ordem muda.
   */
  order: string;
  /** Anima a mudança de lugar do card quando a coluna é reordenada (só os cards do topo; ver LAYOUT_ANIMATED). */
  animateLayout: boolean;
  index: number;
  compact: boolean;
  /** Nota, idioma e título traduzido desta vaga; ausente quando a IA ainda não a avaliou. */
  ai?: JobAiListItemDto;
  /** false na coluna ordenada por nota: soltar sobre o card não o coloca "antes dele", então sem linha de inserção. */
  insertable?: boolean;
}

/** Quantos cards do topo entram em cascata; os demais (fora da tela) aparecem de uma vez. */
const STAGGERED = 12;

const ENTER_FROM = { opacity: 0, y: 10 };
const ENTER_TO = { opacity: 1, y: 0 };
const PRESSED = { scale: 0.985 };

type Draggable = ReturnType<typeof useDraggable>;

interface CardViewProps extends JobCardProps {
  setRef: (el: HTMLElement | null) => void;
  listeners: Draggable['listeners'];
  attributes: Draggable['attributes'];
  dragging: boolean;
  over: boolean;
}

/**
 * A parte cara do card (Motion + conteúdo), memoizada: durante um arraste o dnd-kit re-renderiza todos os
 * `useDraggable`/`useDroppable` a cada mudança de alvo, mas só os cards cujo estado mudou passam daqui.
 */
const CardView = memo(function CardView(p: CardViewProps) {
  const { job, onOpen } = p;
  const transition = useMemo(
    () => ({ ...spring, delay: p.index < STAGGERED ? p.index * 0.022 : 0, layout: spring, scale: spring }),
    [p.index],
  );
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onOpen(job.id);
  };

  return (
    <motion.article
      ref={p.setRef}
      layout={p.animateLayout ? 'position' : false}
      layoutDependency={`${p.order}|${p.compact}`}
      initial={ENTER_FROM}
      animate={ENTER_TO}
      whileTap={PRESSED}
      transition={transition}
      data-testid="job-card"
      data-dragging={p.dragging}
      data-over={p.over}
      onClick={() => onOpen(job.id)}
      onKeyDown={onKeyDown}
      className="job-card shrink-0"
      {...p.listeners}
      {...p.attributes}
    >
      <JobCardBody job={job} compact={p.compact} ai={p.ai} />
    </motion.article>
  );
});

export const JobCard = memo(function JobCard(props: JobCardProps) {
  const drag = useDraggable({ id: props.job.id });
  const drop = useDroppable({ id: `card:${props.job.id}` });
  const setDragRef = drag.setNodeRef;
  const setDropRef = drop.setNodeRef;
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef],
  );

  return (
    <CardView
      {...props}
      setRef={setRef}
      listeners={drag.listeners}
      attributes={drag.attributes}
      dragging={drag.isDragging}
      over={drop.isOver && !drag.isDragging && props.insertable !== false}
    />
  );
});
