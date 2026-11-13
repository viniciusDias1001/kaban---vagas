import { useQuery } from '@tanstack/react-query';
import { CalendarCheck, MessageSquareReply, RotateCw, Send, Trophy } from 'lucide-react';
import { motion } from 'motion/react';
import { useId, useState, type ReactNode } from 'react';
import {
  AI_LAYERS, DASHBOARD_PERIODS, DASHBOARD_PERIOD_LABELS, DEFAULT_DASHBOARD_PERIOD, EMAIL_KINDS, EMAIL_KIND_LABELS,
  type DashboardDto, type DashboardPeriod,
} from '@kv/shared/client';
import { api } from '../api';
import {
  blockerLabel, breakdownLabel, daysText, emptyReason, minutesText, ratioShare, ratioText, usdText,
} from '../lib/dashboard';
import { STATUS_LABELS } from '../lib/apply';
import { spring } from '../lib/motion';
import { CARD } from '../lib/styles';
import { cn } from '../lib/utils';
import { useDashboard } from '../useDashboard';
import { BarLegend, BarRows, type BarRow, type BarSeries } from './charts/BarRows';
import { FunnelChart } from './charts/FunnelChart';
import { KpiTile } from './charts/KpiTile';
import { PainelEmailList } from './PainelEmailList';
import { LAYER_LABELS } from './SettingsAiSection';
import { Button } from './ui/button';
import { Notice } from './ui/notice';
import { Segmented } from './ui/segmented';
import { Skeleton } from './ui/skeleton';

const PERIOD_KEY = 'kv.painel.period';

function loadPeriod(): DashboardPeriod {
  try {
    const stored = localStorage.getItem(PERIOD_KEY);
    return (DASHBOARD_PERIODS as readonly string[]).includes(stored ?? '') ? (stored as DashboardPeriod) : DEFAULT_DASHBOARD_PERIOD;
  } catch {
    return DEFAULT_DASHBOARD_PERIOD;
  }
}

function savePeriod(period: DashboardPeriod) {
  try {
    localStorage.setItem(PERIOD_KEY, period);
  } catch {
    // Sem armazenamento (modo privado, bloqueio): o período vale só nesta visita.
  }
}

type Dimension = keyof DashboardDto['breakdowns'];
const DIMENSIONS: { value: Dimension; label: string }[] = [
  { value: 'site', label: 'Site' },
  { value: 'source', label: 'Fonte' },
  { value: 'score', label: 'Nota' },
  { value: 'resumeLang', label: 'Idioma do currículo' },
  { value: 'appliedBy', label: 'Quem aplicou' },
];

/** Resposta no acento (a mesma cor de "Responderam" no funil); entrevista na cor da coluna Entrevista. */
const RATE_SERIES: BarSeries[] = [
  { name: 'Resposta', fill: 'bg-accent' },
  { name: 'Entrevista', fill: 'bg-(--col-entrevista)' },
];
const BLOCKER_SERIES: BarSeries[] = [{ name: 'Candidaturas', fill: 'bg-warn/80' }];
const COST_SERIES: BarSeries[] = [{ name: 'Gasto', fill: 'bg-accent' }];
const MAIL_SERIES: BarSeries[] = [{ name: 'E-mails', fill: 'bg-(--col-aplicada)' }];

/** Fração de `n` sobre o maior valor da lista (barras de contagem). */
const shareOfMax = (n: number, max: number) => (max <= 0 ? 0 : n / max);

/** Um bloco do Painel: cartão, título e, sem dados, só o título e a frase do que falta. */
function Block({ title, testId, empty, emptyTestId, aside, children, index, className }: {
  title: string;
  testId?: string;
  empty: string | null;
  /** Só nos blocos que podem ficar vazios sozinhos. */
  emptyTestId?: string;
  aside?: ReactNode;
  children?: ReactNode;
  /** Posição na página, para a entrada em sequência. */
  index: number;
  className?: string;
}) {
  const titleId = useId();
  return (
    <motion.section
      data-testid={testId} aria-labelledby={titleId}
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.03 * index }}
      className={cn(CARD, 'min-w-0 p-5 sm:p-6', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h3 id={titleId} className="text-[15px] font-semibold leading-tight text-ink">{title}</h3>
        {!empty && aside}
      </div>
      {empty
        ? <p data-testid={emptyTestId} className="mt-2 text-[13px] leading-relaxed text-muted">{empty}</p>
        : <div className="mt-5">{children}</div>}
    </motion.section>
  );
}

/** "4,5 dias (3 respostas)": o número em destaque e a base, que o próprio texto traz entre parênteses, menor. */
function SplitFigure({ text }: { text: string }) {
  const cut = text.indexOf(' (');
  const main = cut < 0 ? text : text.slice(0, cut);
  const base = cut < 0 ? null : text.slice(cut + 1);
  return (
    <p className="tabular-nums">
      <span className="text-[24px] font-semibold leading-tight tracking-tight text-ink">{main}</span>
      {base && <span className="ml-1.5 text-[13px] text-muted">{base}</span>}
    </p>
  );
}

/** Um valor com rótulo, numa caixa discreta dentro de um bloco. */
function Figure({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="min-w-0 rounded-2xl border border-line bg-surface-2/50 px-4 py-3">
      <p className="text-[12.5px] font-medium text-muted">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Kpis({ dto }: { dto: DashboardDto }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={spring}
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      <KpiTile
        testId="kpi-applied" label="Candidaturas" value={dto.applied.total}
        detail={`${dto.applied.byAi} pela IA, ${dto.applied.byOwner} por você`}
        tone="text-(--col-aplicada)" icon={<Send aria-hidden />}
      />
      <KpiTile
        testId="kpi-responded" label="Respostas" value={dto.responded.n} detail={ratioText(dto.responded)}
        tone="text-accent" icon={<MessageSquareReply aria-hidden />}
      />
      <KpiTile
        testId="kpi-interviews" label="Entrevistas" value={dto.interviews.n} detail={ratioText(dto.interviews)}
        tone="text-(--col-entrevista)" icon={<CalendarCheck aria-hidden />}
      />
      <KpiTile
        testId="kpi-offers" label="Ofertas" value={dto.offers.n} detail={ratioText(dto.offers)}
        tone="text-(--col-oferta)" icon={<Trophy aria-hidden />}
      />
    </motion.div>
  );
}

function Breakdowns({ dto, sources }: { dto: DashboardDto; sources: { id: string; name: string }[] }) {
  const [dimension, setDimension] = useState<Dimension>('site');
  const labelId = useId();
  const rows: BarRow[] = dto.breakdowns[dimension].map((r) => {
    const responded = { n: r.responded, of: r.applied };
    const interviews = { n: r.interviews, of: r.applied };
    return {
      key: r.key,
      label: breakdownLabel(dimension, r.key, sources),
      bars: [
        { share: ratioShare(responded), text: ratioText(responded) },
        { share: ratioShare(interviews), text: ratioText(interviews) },
      ],
    };
  });
  const dimensionLabel = DIMENSIONS.find((d) => d.value === dimension)?.label ?? '';
  return (
    <Block
      title="Taxa de resposta e de entrevista" testId="painel-breakdown" index={2}
      empty={null}
      aside={(
        <div data-testid="painel-breakdown-dimension" className="max-w-full">
          <span id={labelId} className="sr-only">Separar por</span>
          <Segmented
            aria-labelledby={labelId} value={dimension} onValueChange={setDimension} options={DIMENSIONS}
            className="flex flex-wrap [&>button]:whitespace-nowrap [&>button]:px-3"
          />
        </div>
      )}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-[13px] text-muted">Por {dimensionLabel.toLowerCase()}, das candidaturas do período.</p>
        <BarLegend series={RATE_SERIES} />
      </div>
      <BarRows rows={rows} series={RATE_SERIES} label={`Taxas por ${dimensionLabel.toLowerCase()}`} />
    </Block>
  );
}

function Timing({ dto }: { dto: DashboardDto }) {
  const t = dto.timing;
  return (
    <Block title="Tempo até a resposta" testId="painel-timing" index={3} empty={emptyReason('timing', dto)} emptyTestId="painel-empty-timing">
      <div className="grid gap-3">
        <Figure label="Até a primeira resposta" testId="painel-timing-first">
          <SplitFigure text={daysText(t.firstResponseDays, t.firstResponseBase)} />
        </Figure>
        <Figure label="Até a reprovação" testId="painel-timing-rejection">
          <SplitFigure text={daysText(t.rejectionDays, t.rejectionBase)} />
        </Figure>
        <p className="text-[12.5px] leading-snug text-faint">Mediana, em dias, das candidaturas do período.</p>
      </div>
    </Block>
  );
}

function Blockers({ dto }: { dto: DashboardDto }) {
  const max = Math.max(0, ...dto.blockers.map((b) => b.count));
  const rows: BarRow[] = dto.blockers.map((b) => ({
    key: `${b.kind}:${b.reason}`,
    label: blockerLabel(b.kind, b.reason),
    hint: STATUS_LABELS[b.kind],
    bars: [{ share: shareOfMax(b.count, max), text: String(b.count) }],
  }));
  return (
    <Block
      title="O que mais trava as candidaturas" testId="painel-blockers" index={4}
      empty={emptyReason('blockers', dto)} emptyTestId="painel-empty-blockers"
    >
      <BarRows rows={rows} series={BLOCKER_SERIES} label="Candidaturas travadas por motivo" stacked />
    </Block>
  );
}

function Cost({ dto }: { dto: DashboardDto }) {
  const layers = AI_LAYERS.filter((l) => dto.cost.byLayer[l] > 0).sort((a, b) => dto.cost.byLayer[b] - dto.cost.byLayer[a]);
  const max = Math.max(0, ...layers.map((l) => dto.cost.byLayer[l]));
  const rows: BarRow[] = layers.map((l) => ({
    key: l, label: LAYER_LABELS[l], bars: [{ share: shareOfMax(dto.cost.byLayer[l], max), text: usdText(dto.cost.byLayer[l]) }],
  }));
  return (
    <Block title="Custo de IA" testId="painel-cost" index={5} empty={emptyReason('cost', dto)} emptyTestId="painel-empty-cost">
      <div className="grid gap-6 md:grid-cols-[15rem_minmax(0,1fr)]">
        <div className="grid content-start gap-3">
          <Figure label="Total no período" testId="painel-cost-total">
            <p className="text-[24px] font-semibold leading-tight tracking-tight tabular-nums text-ink">{usdText(dto.cost.total)}</p>
          </Figure>
          <Figure label="Por candidatura enviada" testId="painel-cost-per-application">
            <p className="text-[24px] font-semibold leading-tight tracking-tight tabular-nums text-ink">{usdText(dto.cost.perApplication)}</p>
          </Figure>
        </div>
        <div className="min-w-0">
          <p className="mb-3 text-[13px] text-muted">Por camada</p>
          <BarRows rows={rows} series={COST_SERIES} label="Custo de IA por camada" />
        </div>
      </div>
    </Block>
  );
}

function Email({ dto }: { dto: DashboardDto }) {
  const e = dto.email;
  const kinds = EMAIL_KINDS.filter((k) => e.received[k] > 0).sort((a, b) => e.received[b] - e.received[a]);
  const max = Math.max(0, ...kinds.map((k) => e.received[k]));
  const rows: BarRow[] = kinds.map((k) => ({
    key: k, label: EMAIL_KIND_LABELS[k], bars: [{ share: shareOfMax(e.received[k], max), text: String(e.received[k]) }],
  }));
  return (
    <Block title="E-mails" testId="painel-email" index={6} empty={emptyReason('email', dto)} emptyTestId="painel-empty-email">
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-[13px] text-muted">Recebidos por tipo</p>
            <p className="text-[13px] tabular-nums text-ink-2">Total: <span className="font-semibold text-ink">{e.receivedTotal}</span></p>
          </div>
          <BarRows rows={rows} series={MAIL_SERIES} label="E-mails recebidos por tipo" />
          {e.waiting > 0 && (
            <p data-testid="painel-email-waiting" className="mt-4 flex items-center gap-2 text-[13px] text-warn">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
              <span>Esperando classificação: <span className="font-semibold tabular-nums">{e.waiting}</span></span>
            </p>
          )}
        </div>
        <div className="min-w-0">
          <p className="mb-3 text-[13px] text-muted">Respondidos</p>
          <div className="grid grid-cols-3 gap-3">
            {([['Automático', e.repliedAuto], ['Aprovados por você', e.repliedApproved], ['Descartados', e.discarded]] as const).map(([label, n]) => (
              <Figure key={label} label={label}>
                <p className="text-[24px] font-semibold leading-tight tracking-tight tabular-nums text-ink">{n}</p>
              </Figure>
            ))}
          </div>
          <div className="mt-3">
            <Figure label="Tempo entre o pedido e a resposta" testId="painel-email-reply-time">
              <p className="text-[20px] font-semibold leading-tight tabular-nums text-ink">{minutesText(e.replyMinutes)}</p>
            </Figure>
          </div>
        </div>
      </div>
    </Block>
  );
}

function Blocks({ dto, sources }: { dto: DashboardDto; sources: { id: string; name: string }[] }) {
  // Sem candidaturas no período, números, funil e taxas dizem a mesma coisa: um cartão só, com a frase uma vez.
  const noApplications = emptyReason('kpis', dto);
  return (
    <>
      {noApplications ? (
        <Block title="Números do período" empty={noApplications} emptyTestId="painel-empty-kpis" index={0} />
      ) : (
        <>
          <Kpis dto={dto} />
          <Block title="Funil" testId="painel-funnel" index={1} empty={null}>
            <FunnelChart funnel={dto.funnel} />
          </Block>
          <Breakdowns dto={dto} sources={sources} />
        </>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Timing dto={dto} />
        <Blockers dto={dto} />
      </div>
      <Cost dto={dto} />
      <Email dto={dto} />
    </>
  );
}

/** Esqueleto no formato dos blocos, enquanto o primeiro período carrega. */
function Loading() {
  const card = cn(CARD, 'p-5 sm:p-6');
  return (
    <div aria-busy="true" aria-label="Carregando o Painel" className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3 rounded-2xl border border-line bg-surface/80 p-4 shadow-card">
            <Skeleton className="size-10 rounded-xl" />
            <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-24" /><Skeleton className="h-8 w-16" /><Skeleton className="h-3 w-28" /></div>
          </div>
        ))}
      </div>
      <div className={card}>
        <Skeleton className="h-4 w-20" />
        <div className="mt-5 space-y-2.5">{[100, 70, 45, 20].map((w) => <Skeleton key={w} className="h-7" style={{ width: `${w}%` }} />)}</div>
      </div>
      <div className={card}>
        <Skeleton className="h-4 w-56" />
        <div className="mt-5 space-y-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {[0, 1].map((i) => <div key={i} className={card}><Skeleton className="h-4 w-40" /><Skeleton className="mt-5 h-28 w-full" /></div>)}
      </div>
    </div>
  );
}

export default function PainelPage() {
  const [period, setPeriod] = useState<DashboardPeriod>(loadPeriod);
  const periodLabelId = useId();
  const dashboard = useDashboard(period);
  const { data: sources = [] } = useQuery({ queryKey: ['sources'], queryFn: api.sources });
  const { data, isPlaceholderData, isError, error, refetch, isFetching } = dashboard;
  const choose = (next: DashboardPeriod) => {
    setPeriod(next);
    savePeriod(next);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}
          className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3"
        >
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">Painel</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Como estão as suas candidaturas: quantas empresas respondem, onde elas travam e quanto custa a IA.
            </p>
          </div>
          <div data-testid="painel-period">
            <span id={periodLabelId} className="sr-only">Período</span>
            <Segmented
              aria-labelledby={periodLabelId} value={period} onValueChange={choose}
              options={DASHBOARD_PERIODS.map((p) => ({ value: p, label: DASHBOARD_PERIOD_LABELS[p] }))}
              className="[&>button]:whitespace-nowrap [&>button]:px-3.5"
            />
          </div>
        </motion.div>

        {isError && (
          <Notice
            tone="bad" role="alert" title="Não foi possível carregar o Painel"
            action={(
              <Button size="sm" disabled={isFetching} onClick={() => void refetch()}>
                <RotateCw aria-hidden /> Tentar de novo
              </Button>
            )}
          >
            <p>{error.message}</p>
          </Notice>
        )}

        {data ? (
          // Os números do período anterior ficam na tela enquanto o novo carrega: apagados e marcados como ocupados.
          <div
            data-testid="painel-blocks" aria-busy={isPlaceholderData || undefined}
            className={cn('space-y-5 transition-opacity duration-200 ease-out-soft', isPlaceholderData && 'pointer-events-none opacity-45')}
          >
            <Blocks dto={data} sources={sources} />
          </div>
        ) : !isError && <Loading />}

        <PainelEmailList period={period} />
      </div>
    </div>
  );
}
