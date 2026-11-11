import type { UseQueryResult } from '@tanstack/react-query';
import { CircleCheck, CircleHelp, FileText, GraduationCap, Info, LoaderCircle, RotateCw, ShieldAlert, Sparkles, Target, WandSparkles } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { AiStatusDto, JobAiDetailDto } from '@kv/shared/client';
import { isPending, layerMessage } from '../lib/ai';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { useAnalyzeJob, useConfirmTask, useProfileOverview, useRequestTailored, useTailored } from '../useAi';
import { AiNotConfigured } from './AiNotConfigured';
import { LanguageBadge, ScoreBadge } from './ScoreBadge';
import { TailoredResumeEditor } from './TailoredResumeEditor';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Notice } from './ui/notice';
import { Skeleton } from './ui/skeleton';

const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-faint';
/** Com a análise automática ligada, o pedido sai sozinho ao abrir; o botão manual só aparece se nada acontecer. */
const MANUAL_FALLBACK_MS = 4_000;
const VERIFIER_PREFIX = 'verificação de não invenção bloqueou o resultado:';

function Working({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-[13px] text-ink-2">
      <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-accent" />
      {children}
    </span>
  );
}

/** Um bloco da análise: título + lista. Os itens vêm da IA e entram só como texto. */
function ListBlock({ title, icon, items, tone }: { title: string; icon: ReactNode; items: string[]; tone: string }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-2xl border border-line bg-surface-2/50 p-3.5">
      <h4 className="flex items-center gap-2 text-[13px] font-semibold text-ink">
        <span aria-hidden className={cn('shrink-0 [&_svg]:size-4', tone)}>{icon}</span>
        {title}
      </h4>
      <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-ink-2">
        {items.map((item, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden className="mt-[0.55rem] size-1 shrink-0 rounded-full bg-faint" />
            <span className="min-w-0 break-words">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Keywords({ title, items, tone }: { title: string; items: string[]; tone: 'ok' | 'outline' }) {
  if (items.length === 0) return null;
  return (
    <div className="min-w-0">
      <h4 className="text-xs font-medium text-muted">{title}</h4>
      <ul className="mt-1.5 flex flex-wrap gap-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex min-w-0"><Badge size="md" tone={tone} className="max-w-full truncate">{item}</Badge></li>
        ))}
      </ul>
    </div>
  );
}

function AnalysisSkeleton() {
  return (
    <div aria-hidden className="space-y-2.5">
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-20 w-full rounded-2xl" />
      <div className="flex gap-1.5">
        <Skeleton className="h-6 w-16 rounded-lg" />
        <Skeleton className="h-6 w-20 rounded-lg" />
        <Skeleton className="h-6 w-14 rounded-lg" />
      </div>
    </div>
  );
}

/** Texto de erro de uma tarefa (vem do servidor/IA): só texto, uma linha por "; ". */
function TaskError({ error }: { error: string | null | undefined }) {
  if (!error) return <p>Falhou.</p>;
  const blocked = error.startsWith(VERIFIER_PREFIX);
  const lines = (blocked ? error.slice(VERIFIER_PREFIX.length) : error).split('; ').map((l) => l.trim()).filter(Boolean);
  return (
    <>
      <p>{blocked ? `Falhou: ${VERIFIER_PREFIX}` : lines.length > 1 ? 'Falhou:' : `Falhou: ${lines[0]}`}</p>
      {(blocked || lines.length > 1) && (
        <ul className="mt-1 space-y-1">
          {lines.map((line, i) => <li key={i} className="break-words">{line}</li>)}
        </ul>
      )}
    </>
  );
}

function Tailored({ jobId }: { jobId: number }) {
  const titleId = useId();
  const tailored = useTailored(jobId, true);
  const request = useRequestTailored(jobId);
  const confirm = useConfirmTask();
  const data = tailored.data;
  const state = data?.state ?? 'none';
  const busy = isPending(state);
  // Aguardando confirmação de gasto: a ação é "Executar mesmo assim", no aviso; pedir de novo não faria nada.
  const showButton = state !== 'blocked_budget' && (!data?.tailored || state === 'stale' || state === 'error' || busy);

  return (
    <div role="group" aria-labelledby={titleId} className="space-y-3 border-t border-line pt-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
        <div className="min-w-48 flex-1">
          <h4 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-ink">
            <FileText aria-hidden className="size-4 text-accent" /> Currículo adaptado
          </h4>
          <p className="mt-0.5 text-xs leading-snug text-muted">
            Uma versão do seu perfil voltada a esta vaga, no idioma dela. Nada é inventado: só o resumo e as realizações são reescritos.
          </p>
        </div>
        {tailored.isPending ? (
          <Skeleton className="h-9 w-40 rounded-xl" />
        ) : showButton && (
          <Button
            type="button" variant={data?.tailored ? 'secondary' : 'primary'} data-testid="tailor-button"
            disabled={busy || request.isPending} onClick={() => request.mutate()}
          >
            {busy ? <LoaderCircle aria-hidden className="animate-spin" /> : <WandSparkles aria-hidden />}
            {busy ? 'Gerando…' : state === 'stale' || state === 'error' ? 'Gerar de novo' : 'Adaptar currículo'}
          </Button>
        )}
      </div>

      <div data-testid="tailored-state" aria-live="polite" className={cn((state === 'none' || state === 'ok' || (state === 'stale' && data?.tailored)) && 'sr-only')}>
        {data && (state === 'queued' || state === 'running') && <Working>{layerMessage(state, data.task)} O currículo aparece aqui em instantes.</Working>}
        {data && state === 'blocked_budget' && (
          <Notice tone="warn" title={layerMessage(state, data.task)} action={
            data.task && <Button type="button" size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate(data.task!.id)}>Executar mesmo assim</Button>
          }>
            O currículo adaptado está esperando a sua confirmação.
          </Notice>
        )}
        {data && state === 'error' && (
          <Notice tone="bad" icon={data.task?.error?.startsWith(VERIFIER_PREFIX) ? <ShieldAlert /> : undefined}>
            <TaskError error={data.task?.error} />
            {data.tailored && <p className="mt-1 text-muted">O currículo abaixo é o da última geração que passou na verificação.</p>}
          </Notice>
        )}
        {data && state === 'stale' && <p className="text-xs text-warn">{layerMessage(state, data.task)}</p>}
        {data && (state === 'none' || state === 'ok') && layerMessage(state, data.task)}
      </div>

      {tailored.isError && !data && (
        <Notice tone="bad" action={<Button type="button" size="sm" onClick={() => tailored.refetch()}><RotateCw aria-hidden /> Tentar de novo</Button>}>
          Não foi possível carregar o currículo adaptado. {tailored.error.message}
        </Notice>
      )}

      {data?.tailored && <TailoredResumeEditor key={`${data.tailored.createdAt}`} jobId={jobId} tailored={data.tailored} />}
    </div>
  );
}

interface Props {
  jobId: number;
  status: UseQueryResult<AiStatusDto>;
  /** A consulta de `useJobAi` (feita no drawer, que também usa a tradução na descrição). */
  detail: UseQueryResult<JobAiDetailDto>;
  onOpenSettings: () => void;
  index: number;
}

export function JobAiSection({ jobId, status, detail, onOpenSettings, index }: Props) {
  const titleId = useId();
  const analyze = useAnalyzeJob(jobId);
  const confirm = useConfirmTask();
  const configured = status.data?.configured === true;
  const overview = useProfileOverview();
  const noProfile = overview.data !== undefined && overview.data.profiles.length === 0;
  const auto = status.data?.tier2Auto === true;
  const [late, setLate] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setLate(true), MANUAL_FALLBACK_MS);
    return () => clearTimeout(id);
  }, []);

  const data = detail.data;
  const tier2 = data?.tier2;
  const state = tier2?.state ?? 'none';
  const analysis = data?.analysis ?? null;
  const summary = data?.summary && data.summary.score !== null ? data.summary : null;
  const canAsk = (state === 'none' || state === 'stale') && !noProfile && (!auto || late);
  const analyzeButton = (label: string) => (
    <Button type="button" size="sm" data-testid="ai-analyze" disabled={analyze.isPending} onClick={() => analyze.mutate()}>
      <Sparkles aria-hidden /> {label}
    </Button>
  );

  let body: ReactNode;
  if (status.isPending) {
    body = <AnalysisSkeleton />;
  } else if (!configured) {
    body = (
      <AiNotConfigured problem={status.data?.problem ?? status.error?.message} onOpenSettings={onOpenSettings}>
        <p>Com a IA configurada, esta seção mostra a análise da vaga e o currículo adaptado.</p>
      </AiNotConfigured>
    );
  } else if (detail.isError && !data) {
    body = (
      <Notice tone="bad" role="alert" action={<Button type="button" size="sm" onClick={() => detail.refetch()}><RotateCw aria-hidden /> Tentar de novo</Button>}>
        Não foi possível carregar a análise. {detail.error.message}
      </Notice>
    );
  } else if (!data) {
    body = <AnalysisSkeleton />;
  } else {
    body = (
      <div className="space-y-3">
        {summary && (
          <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface-2/50 p-3.5">
            <ScoreBadge ai={summary} size="lg" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-ink">
                Aderência ao seu perfil <LanguageBadge language={summary.language} />
              </p>
              {summary.reason && <p className="mt-0.5 break-words text-[13px] leading-relaxed text-ink-2">{summary.reason}</p>}
              {summary.stale && state !== 'stale' && <p className="mt-0.5 text-xs text-warn">Nota calculada com uma versão anterior do seu perfil.</p>}
            </div>
          </div>
        )}

        <div data-testid="ai-analysis-state" aria-live="polite" className={cn(state === 'ok' && 'sr-only')}>
          {state === 'ok' && layerMessage(state, tier2?.task ?? null)}
          {(state === 'queued' || state === 'running') && <Working>{layerMessage(state, tier2?.task ?? null)} Analisando a vaga com o seu perfil.</Working>}
          {state === 'none' && (
            noProfile ? (
              <Notice tone="info">Envie seu currículo em Meu perfil para ver a análise desta vaga.</Notice>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-dashed border-line px-3.5 py-3">
                <p className="min-w-40 flex-1 text-[13px] text-muted">
                  {layerMessage(state, tier2?.task ?? null)}
                  {!auto && ' A análise automática está desligada em Configurações.'}
                </p>
                {canAsk && analyzeButton('Analisar esta vaga')}
              </div>
            )
          )}
          {state === 'stale' && (
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p className="min-w-40 flex-1 text-xs text-warn">
                {layerMessage(state, tier2?.task ?? null)}
                {!auto && ' A análise automática está desligada em Configurações.'}
              </p>
              {canAsk && analyzeButton('Analisar de novo')}
            </div>
          )}
          {state === 'blocked_budget' && (
            <Notice tone="warn" title={layerMessage(state, tier2?.task ?? null)} action={
              tier2?.task && (
                <Button type="button" size="sm" data-testid="ai-confirm-budget" disabled={confirm.isPending} onClick={() => confirm.mutate(tier2.task!.id)}>
                  Executar mesmo assim
                </Button>
              )
            }>
              A análise desta vaga está esperando a sua confirmação.
            </Notice>
          )}
          {state === 'error' && (
            <Notice tone="bad" action={
              <Button type="button" size="sm" disabled={analyze.isPending} onClick={() => analyze.mutate()}><RotateCw aria-hidden /> Tentar de novo</Button>
            }>
              <TaskError error={tier2?.task?.error} />
            </Notice>
          )}
        </div>

        {(state === 'queued' || state === 'running') && !analysis && <AnalysisSkeleton />}

        {analysis && (
          <div className="space-y-2.5">
            <ListBlock title="Pontos fortes" icon={<CircleCheck />} tone="text-ok" items={analysis.strengths} />
            <ListBlock title="Lacunas" icon={<Target />} tone="text-warn" items={analysis.gaps} />
            {(analysis.keywordsPresent.length > 0 || analysis.keywordsMissing.length > 0) && (
              <div className="grid gap-3 rounded-2xl border border-line bg-surface-2/50 p-3.5 sm:grid-cols-2">
                <Keywords title="Palavras-chave presentes" items={analysis.keywordsPresent} tone="ok" />
                <Keywords title="Palavras-chave ausentes" items={analysis.keywordsMissing} tone="outline" />
              </div>
            )}
            <ListBlock title="O que revisar para a entrevista" icon={<GraduationCap />} tone="text-accent" items={analysis.interviewTopics} />
            <ListBlock title="Perguntas prováveis" icon={<CircleHelp />} tone="text-accent" items={analysis.likelyQuestions} />
          </div>
        )}

        {!data.descriptionAvailable && (
          <p className="flex items-start gap-1.5 text-xs leading-snug text-faint">
            <Info aria-hidden className="mt-px size-3.5 shrink-0" />
            Esta fonte não entregou a descrição e não foi possível buscá-la; a análise usou só o título, a empresa e o local.
          </p>
        )}

        <Tailored jobId={jobId} />
      </div>
    );
  }

  return (
    <motion.section
      data-testid="ai-analysis" aria-labelledby={titleId}
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.04 + index * 0.04 }}
    >
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 id={titleId} className={EYEBROW}>Análise IA</h3>
      </div>
      {body}
    </motion.section>
  );
}
