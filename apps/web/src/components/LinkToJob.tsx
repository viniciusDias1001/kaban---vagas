import { useQuery } from '@tanstack/react-query';
import { Check, Link2, LoaderCircle, Search } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useMemo, useState } from 'react';
import { COLUMN_LABELS, isAppliedOrLater, type JobListItemDto } from '@kv/shared/client';
import { api } from '../api';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { useMessageActions } from '../useEmail';
import { JOBS_KEY } from '../useMoveJob';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Notice } from './ui/notice';
import { Skeleton } from './ui/skeleton';

/** Quantas vagas a busca de "Ligar a esta vaga" mostra de uma vez: a lista não ganha barra própria. */
const LINK_MATCHES = 6;
const NO_JOBS: JobListItemDto[] = [];

export interface LinkToJobProps {
  picked: number | null;
  onPick: (jobId: number | null) => void;
  searchTestId: string;
  jobTestId: (jobId: number) => string;
}

/** Busca uma vaga em Aplicada ou depois para ligar um e-mail (e o fio dele) a ela. Usado no sino e no Painel. */
export function LinkToJob({ picked, onPick, searchTestId, jobTestId }: LinkToJobProps) {
  // A mesma consulta do quadro (mesma chave): em geral já está em cache.
  const { data, isPending } = useQuery({ queryKey: JOBS_KEY, queryFn: api.jobs });
  const [search, setSearch] = useState('');
  const fieldId = useId();

  const applied = useMemo(() => (data ?? NO_JOBS).filter((j) => isAppliedOrLater(j.column)), [data]);
  const term = search.trim().toLocaleLowerCase('pt-BR');
  const matches = term === ''
    ? applied
    : applied.filter((j) => `${j.title} ${j.company}`.toLocaleLowerCase('pt-BR').includes(term));
  const pickedJob = applied.find((j) => j.id === picked) ?? null;
  // A vaga escolhida continua à vista mesmo quando a busca muda.
  const firstMatches = matches.slice(0, LINK_MATCHES);
  const shown = pickedJob && !firstMatches.includes(pickedJob) ? [pickedJob, ...firstMatches.slice(0, LINK_MATCHES - 1)] : firstMatches;
  const hidden = matches.filter((j) => !shown.includes(j)).length;

  return (
    <div className="mt-3.5 space-y-2.5">
      <label htmlFor={fieldId} className="block text-xs font-medium text-ink-2">De qual vaga é este e-mail?</label>
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <Input
          id={fieldId} data-testid={searchTestId} value={search} placeholder="Empresa ou título"
          autoComplete="off" className="h-9 pl-9" onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {isPending ? (
        <Skeleton className="h-16 w-full rounded-xl" />
      ) : applied.length === 0 ? (
        <p className="text-xs text-muted">Nenhuma vaga em Aplicada ou depois.</p>
      ) : shown.length === 0 ? (
        <p className="text-xs text-muted">Nenhuma vaga com “{search.trim()}”.</p>
      ) : (
        <ul aria-label="Vagas em Aplicada ou depois" className="space-y-1">
          {shown.map((j) => {
            const on = j.id === picked;
            return (
              <li key={j.id}>
                <button
                  type="button" aria-pressed={on} data-testid={jobTestId(j.id)} onClick={() => onPick(on ? null : j.id)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors duration-150',
                    'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40',
                    on ? 'border-accent/45 bg-accent/10' : 'border-line bg-bg/40 hover:border-line-strong hover:bg-surface-3',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{j.title}</span>
                    <span className="block truncate text-xs text-muted">{j.company}</span>
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">{COLUMN_LABELS[j.column]}</span>
                  {on && <Check aria-hidden className="size-4 shrink-0 text-accent" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && <p className="text-xs text-faint">Mais {hidden} {hidden === 1 ? 'vaga' : 'vagas'}: refine a busca.</p>}
    </div>
  );
}

const messageOf = (e: unknown) => (e instanceof Error && e.message.trim() ? e.message : 'Não foi possível concluir. Tente de novo.');

/**
 * A busca e o botão "Ligar a esta vaga", com o erro logo abaixo: para um e-mail sem card fora do sino (a conversa do
 * Painel). Ao ligar, a lista e a conversa são relidas e o e-mail passa a mostrar a vaga; `onLinked` é chamado depois do sucesso.
 */
export function LinkMailToJob({ messageId, testIdPrefix, onLinked }: { messageId: number; testIdPrefix: string; onLinked?: () => void }) {
  const { link } = useMessageActions();
  const [picked, setPicked] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (picked === null) return;
    setError(null);
    try {
      await link.mutateAsync({ id: messageId, jobId: picked });
    } catch (e) {
      setError(messageOf(e));
      return;
    }
    onLinked?.();
  };

  return (
    <div data-testid={`${testIdPrefix}-box`}>
      <LinkToJob
        picked={picked} onPick={setPicked}
        searchTestId={`${testIdPrefix}-search`} jobTestId={(jobId) => `${testIdPrefix}-job-${jobId}`}
      />
      <Button
        type="button" size="sm" variant="primary" className="mt-3" data-testid={testIdPrefix}
        disabled={link.isPending || picked === null} onClick={() => void submit()}
      >
        {link.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Link2 aria-hidden />} Ligar a esta vaga
      </Button>
      <AnimatePresence initial={false}>
        {error && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
            <Notice tone="bad" role="alert" className="mt-3" data-testid={`${testIdPrefix}-error`}>{error}</Notice>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
