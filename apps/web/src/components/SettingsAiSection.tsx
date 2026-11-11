import { CircleCheck, CircleDashed, LoaderCircle, Lock, PlugZap, ShieldAlert, Sparkles } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import {
  AI_LAYERS, AI_PROVIDER_IDS, AI_PROVIDER_LABELS, SETTINGS_LIMITS, type AiLayer, type AiProviderId, type SettingSource,
  type SettingsDto,
} from '@kv/shared/client';
import { formatUsd, scoringPauseText } from '../lib/ai';
import { cn } from '../lib/utils';
import { OUTCOME_TONE, SOURCE_LABELS, changeProvider, keyView, parseBudget, type SettingsForm, type SettingsFormErrors } from '../settingsForm';
import { useAiStatus, useAiUsage, useTestConnection } from '../useAi';
import { ApiKeyField, SecretCommand } from './ApiKeyField';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Notice } from './ui/notice';
import { Segmented } from './ui/segmented';
import { Skeleton } from './ui/skeleton';
import { Switch } from './ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

export const LABEL = 'block text-[13px] font-medium text-ink-2';
export const HINT = 'text-xs leading-snug text-faint';
export const ERROR = 'text-xs leading-snug text-bad';
export const EYEBROW = 'text-[11px] font-semibold uppercase tracking-[0.08em] text-faint';
export const CARD = 'rounded-3xl border border-line bg-surface/85 shadow-raised';

const NONE = 'none';
const LAYER_LABELS: Record<AiLayer, string> = {
  profile: 'Perfil',
  tier1: 'Camada 1: notas',
  tier2: 'Camada 2: análises',
  tier3: 'Camada 3: currículos',
  test: 'Testes de conexão',
};
const providerLabel = (id: string) => AI_PROVIDER_LABELS[id as keyof typeof AI_PROVIDER_LABELS] ?? id;

/** De onde vem o valor em vigor; com o campo mexido, avisa que a mudança ainda não foi salva. */
export function SourceTag({ source, changed }: { source: SettingSource; changed: boolean }) {
  return changed
    ? <span className="shrink-0 whitespace-nowrap text-[11px] font-medium text-warn">alterado, não salvo</span>
    : <span className="shrink-0 whitespace-nowrap text-[11px] text-faint">{SOURCE_LABELS[source]}</span>;
}

/** Cabeçalho de um cartão de seção: ícone, título (o `id` é o alvo do `aria-labelledby`) e subtítulo. */
export function SectionHeader({ id, icon, title, children, aside }: { id: string; icon: ReactNode; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-5 py-4 sm:px-6">
      <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/14 text-accent ring-1 ring-inset ring-accent/25 [&_svg]:size-5">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-lg font-semibold leading-tight">{title}</h2>
        <p className="mt-0.5 text-[13px] leading-snug text-muted">{children}</p>
      </div>
      {aside}
    </div>
  );
}

function Block({ title, children, first }: { title: string; children: ReactNode; first?: boolean }) {
  return (
    <div className={cn(!first && 'border-t border-line pt-5')}>
      <h3 className={cn(EYEBROW, 'mb-3')}>{title}</h3>
      {children}
    </div>
  );
}

function ToggleRow({ testId, label, off, checked, onChange, source, changed }: {
  testId: string; label: string; off: string; checked: boolean; onChange: (v: boolean) => void; source: SettingSource; changed: boolean;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-line bg-surface-2/50 px-3.5 py-3">
      <Switch id={id} data-testid={testId} checked={checked} onCheckedChange={onChange} aria-describedby={hintId} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block cursor-pointer text-[13px] font-medium leading-snug text-ink">{label}</label>
        <p id={hintId} className={cn(HINT, 'mt-0.5')}>Desligada: {off}</p>
      </div>
      <SourceTag source={source} changed={changed} />
    </div>
  );
}

function TestConnection({ dto, dirty }: { dto: SettingsDto; dirty: boolean }) {
  const test = useTestConnection();
  const disabled = !dto.ai.configured || dirty || test.isPending;
  const why = !dto.ai.configured ? 'Configure a IA para poder testar.' : dirty ? 'Salve antes de testar.' : null;
  const result = test.data;
  const tone = test.isError ? 'warn' : result ? OUTCOME_TONE[result.outcome] : null;
  return (
    <div className={cn(CARD, 'p-5')}>
      <h3 className={EYEBROW}>Testar conexão</h3>
      <p className={cn(HINT, 'mt-2')}>Faz uma chamada mínima no modelo rápido. Custa uma fração de centavo e entra no gasto.</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button type="button" data-testid="settings-test" disabled={disabled} onClick={() => test.mutate()}>
          {test.isPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <PlugZap aria-hidden />}
          {test.isPending ? 'Testando…' : 'Testar conexão'}
        </Button>
        {why && <span className={HINT}>{why}</span>}
      </div>
      <div
        data-testid="settings-test-result" role="status" aria-live="polite"
        data-outcome={test.isError ? 'throttled' : result?.outcome}
        className={cn(!tone && 'hidden')}
      >
        {tone && !test.isPending && (
          <Notice tone={tone} className="mt-3" title={tone === 'ok' ? 'Funcionando' : tone === 'warn' ? 'Tente de novo em instantes' : 'Não funcionou'}>
            <p>{test.isError ? test.error.message : result?.message}</p>
            {result?.outcome === 'ok' && result.latencyMs !== null && !test.isError && (
              <p className="mt-0.5 text-xs tabular-nums text-muted">Respondeu em {result.latencyMs} ms.</p>
            )}
          </Notice>
        )}
      </div>
    </div>
  );
}

function Usage() {
  const usage = useAiUsage();
  const status = useAiStatus();
  const budget = status.data?.budget;
  const sum = (by: Record<AiLayer, number> | undefined) => AI_LAYERS.reduce((n, l) => n + (by?.[l] ?? 0), 0);
  const money = (value: number | undefined) =>
    value === undefined ? <Skeleton className="ml-auto h-4 w-14" /> : <span className={cn(value === 0 && 'text-faint')}>{formatUsd(value)}</span>;
  const share = budget && budget.dailyUsd > 0 ? Math.min(1, budget.spentTodayUsd / budget.dailyUsd) : budget?.exceeded ? 1 : 0;
  const pause = status.data?.scoringPause ? scoringPauseText(status.data.scoringPause) : null;
  return (
    <div data-testid="settings-usage" className={cn(CARD, 'overflow-hidden')}>
      <div className="p-5 pb-4">
        <h3 className={EYEBROW}>Gasto estimado</h3>
        {budget ? (
          <>
            <p className="mt-2 text-[13px] text-ink-2">
              Limite diário: <span className="font-semibold tabular-nums text-ink">{formatUsd(budget.dailyUsd)}</span>
              <span aria-hidden className="text-faint"> · </span>
              gasto hoje: <span className="font-semibold tabular-nums text-ink">{formatUsd(budget.spentTodayUsd)}</span>
            </p>
            <div aria-hidden className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className={cn('h-full rounded-full transition-[width] duration-500 ease-out-soft', budget.exceeded ? 'bg-warn' : 'bg-accent')} style={{ width: `${share * 100}%` }} />
            </div>
            <p className={cn(HINT, 'mt-2')}>Valores estimados; o dia vira à meia-noite de {budget.timeZone}.</p>
          </>
        ) : (
          <Skeleton className="mt-3 h-10 w-full" />
        )}
        {budget?.exceeded && (
          <Notice tone="warn" role="status" data-testid="budget-exceeded" className="mt-3">
            Limite de hoje atingido. As notas automáticas voltam amanhã; análises e currículos pedem confirmação.
          </Notice>
        )}
        {pause && (
          <Notice tone="warn" role="status" data-testid="scoring-paused" title="As notas automáticas estão em pausa" className="mt-3">
            <p className="break-words">{pause.reason}</p>
            <p>{pause.next}</p>
          </Notice>
        )}
      </div>
      <Table>
        <TableHeader className="bg-surface-2/60">
          <tr>
            <TableHead className="px-5">Camada</TableHead>
            <TableHead className="px-3 text-right">Hoje</TableHead>
            <TableHead className="px-5 text-right">Últimos 30 dias</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {AI_LAYERS.map((layer) => (
            <TableRow key={layer}>
              <TableCell className="whitespace-nowrap px-5 py-2.5 text-[13px] text-ink-2">{LAYER_LABELS[layer]}</TableCell>
              <TableCell className="px-3 py-2.5 text-right text-[13px] tabular-nums">{money(usage.data?.today[layer])}</TableCell>
              <TableCell className="px-5 py-2.5 text-right text-[13px] tabular-nums">{money(usage.data?.last30Days[layer])}</TableCell>
            </TableRow>
          ))}
          <TableRow className="bg-surface-2/40 font-semibold hover:bg-surface-2/40">
            <TableCell className="px-5 py-2.5 text-[13px] text-ink">Total</TableCell>
            <TableCell className="px-3 py-2.5 text-right text-[13px] tabular-nums text-ink">{money(usage.data && sum(usage.data.today))}</TableCell>
            <TableCell className="px-5 py-2.5 text-right text-[13px] tabular-nums text-ink">{money(usage.data && sum(usage.data.last30Days))}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

export interface SettingsFieldIds {
  modelFast: string;
  modelStrong: string;
  dailyBudget: string;
  greenhouseBoards: string;
  leverCompanies: string;
}

interface Props {
  dto: SettingsDto;
  form: SettingsForm;
  errors: SettingsFormErrors;
  /** Só mostra os erros depois de uma tentativa de salvar ou de o campo ter sido mexido. */
  showErrors: boolean;
  dirty: boolean;
  ids: SettingsFieldIds;
  onChange: (next: Partial<SettingsForm>) => void;
}

export function SettingsAiSection({ dto, form, errors, showErrors, dirty, ids, onChange }: Props) {
  const titleId = useId();
  const providerLabelId = useId();
  const fastHelp = useId();
  const strongHelp = useId();
  const budgetHelp = useId();
  const ai = dto.ai;
  const hasProvider = form.provider !== '';
  const defaults = ai.defaultModels[form.provider];
  const providerChanged = (form.provider || null) !== ai.provider.value;
  const realProvider = (AI_PROVIDER_IDS as readonly string[]).includes(form.provider);
  // O provedor escolhido primeiro; os demais na ordem de sempre.
  const keyOrder = [...AI_PROVIDER_IDS].sort((a, b) => Number(b === form.provider) - Number(a === form.provider));
  const metaOf = (p: AiProviderId) =>
    ai.keys.find((k) => k.provider === p) ?? { provider: p, source: 'none' as const, last4: null, savedAt: null, usable: false, problem: null, hasStored: false };
  const anyLocked = AI_PROVIDER_IDS.some((p) => keyView(metaOf(p), ai.canStoreKeys) === 'locked');
  const err = (key: keyof SettingsFormErrors) => (showErrors || dirty ? errors[key] : undefined);

  const model = (key: 'modelFast' | 'modelStrong', label: string, testId: string, helpId: string, fallback: string | undefined) => {
    const problem = hasProvider ? err(key) : undefined;
    const changed = (form[key].trim() || null) !== ai[key].value;
    return (
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={ids[key]} className={LABEL}>{label}</label>
          <SourceTag source={ai[key].source} changed={changed} />
        </div>
        <Input
          id={ids[key]} data-testid={testId} value={form[key]} disabled={!hasProvider}
          onChange={(e) => onChange({ [key]: e.target.value })}
          maxLength={SETTINGS_LIMITS.modelId} spellCheck={false} autoComplete="off"
          placeholder={hasProvider ? fallback : 'Escolha um provedor'}
          aria-invalid={problem ? true : undefined} aria-describedby={helpId}
          className="font-mono text-[13px]"
        />
        <div id={helpId} className="flex min-h-5 items-start justify-between gap-2">
          {problem ? <p className={ERROR}>{problem}</p> : <p className={HINT}>{fallback ? `Padrão: ${fallback}` : ' '}</p>}
          {hasProvider && fallback && form[key].trim() !== fallback && (
            <button
              type="button" onClick={() => onChange({ [key]: fallback })}
              aria-label={`Usar o padrão no ${label.toLowerCase()}`}
              className="shrink-0 cursor-pointer rounded-md px-1 text-xs font-medium text-accent transition-colors hover:text-ink"
            >
              Usar o padrão
            </button>
          )}
        </div>
      </div>
    );
  };

  const budgetProblem = err('dailyBudget');

  return (
    <section data-testid="settings-ai" aria-labelledby={titleId} className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]">
      <div className={cn(CARD, '@container min-w-0')}>
        <SectionHeader id={titleId} icon={<Sparkles />} title="Inteligência artificial">
          Provedor, modelos e chave usados para dar nota às vagas, analisá-las e adaptar o currículo.
        </SectionHeader>

        <div className="space-y-5 px-5 py-5 sm:px-6">
          <div
            data-testid="settings-status" role="status"
            className={cn('flex items-start gap-3 rounded-2xl border px-4 py-3', ai.configured ? 'border-ok/25 bg-ok/8' : 'border-line-strong bg-surface-2/60')}
          >
            {ai.configured
              ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
              : <CircleDashed aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />}
            <div className="min-w-0 text-[13px] leading-relaxed text-ink-2">
              <p className="font-semibold text-ink">{ai.configured ? 'IA configurada' : 'IA não configurada'}</p>
              {ai.configured ? (
                <p>
                  {providerLabel(ai.provider.value ?? '')}
                  <span aria-hidden className="text-faint"> · </span>
                  rápido <code className="text-ink">{ai.modelFast.value}</code>
                  <span aria-hidden className="text-faint"> · </span>
                  forte <code className="text-ink">{ai.modelStrong.value}</code>
                </p>
              ) : (
                <p>{ai.problem}</p>
              )}
            </div>
          </div>

          {!ai.configured && (
            <ol className="grid gap-2 @2xl:grid-cols-3">
              {['Escolha o provedor.', 'Grave a chave de API dele (ou defina-a no ambiente).', 'Salve e clique em Testar conexão.'].map((step, i) => (
                <li key={step} className="flex items-start gap-2.5 rounded-2xl border border-dashed border-line px-3.5 py-2.5 text-[13px] leading-snug text-ink-2">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[11px] font-semibold tabular-nums text-accent ring-1 ring-inset ring-accent/25">
                    {i + 1}<span className="sr-only">.</span>
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          )}

          <Block title="Provedor e modelos">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span id={providerLabelId} className={LABEL}>Provedor de IA</span>
              <SourceTag source={ai.provider.source} changed={providerChanged} />
            </div>
            <div data-testid="settings-provider">
              <Segmented
                aria-labelledby={providerLabelId}
                value={form.provider || NONE}
                onValueChange={(v) => onChange(changeProvider(form, v === NONE ? '' : v, dto))}
                options={[{ value: NONE, label: 'Nenhum' }, ...ai.providers.map((p) => ({ value: p, label: providerLabel(p) }))]}
                className="flex flex-wrap [&>button]:flex-1 [&>button]:whitespace-nowrap [&>button]:px-3.5"
              />
            </div>
            <div className="mt-4 grid gap-x-4 gap-y-3 @xl:grid-cols-2">
              {model('modelFast', 'Modelo rápido (triagem)', 'settings-model-fast', fastHelp, defaults?.fast)}
              {model('modelStrong', 'Modelo forte (análise e currículo)', 'settings-model-strong', strongHelp, defaults?.strong)}
            </div>
          </Block>

          <Block title="Chaves de API">
            <p className={cn(HINT, '-mt-1 mb-3')}>
              Uma chave por provedor; trocar de provedor não apaga as outras. Ficam cifradas no banco e, depois de salvas, só os 4 últimos caracteres aparecem.
              {!realProvider && form.provider === 'fake' && ' O provedor falso não usa chave.'}
            </p>
            {anyLocked && (
              <Notice tone="warn" data-testid="secret-missing" icon={<Lock />} title="Gravação de chaves desabilitada" className="mb-3">
                <p>{ai.secretProblem ?? 'Defina APP_SECRET no servidor para gravar chaves por aqui.'}</p>
                <SecretCommand />
              </Notice>
            )}
            <div className="space-y-2">
              {keyOrder.map((p) => (
                <ApiKeyField key={p} provider={p} meta={metaOf(p)} dto={dto} selected={form.provider === p} defaultOpen={form.provider === p} />
              ))}
            </div>
          </Block>

          <Block title="Gasto e automação">
            <div className="grid gap-x-4 gap-y-3 @2xl:grid-cols-[17rem_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <label htmlFor={ids.dailyBudget} className={LABEL}>Limite diário de gasto (US$)</label>
                  <SourceTag source={ai.dailyBudgetUsd.source} changed={parseBudget(form.dailyBudget) !== ai.dailyBudgetUsd.value} />
                </div>
                <Input
                  id={ids.dailyBudget} data-testid="settings-budget" inputMode="decimal" value={form.dailyBudget}
                  onChange={(e) => onChange({ dailyBudget: e.target.value })} maxLength={12} autoComplete="off"
                  aria-invalid={budgetProblem ? true : undefined} aria-describedby={budgetHelp}
                  className="tabular-nums"
                />
                <p id={budgetHelp} className={budgetProblem ? ERROR : HINT}>
                  {budgetProblem ?? `De 0 a ${SETTINGS_LIMITS.maxDailyBudgetUsd}. Com 0, toda chamada pede confirmação.`}
                </p>
              </div>
              <div className="space-y-2">
                <ToggleRow
                  testId="settings-tier1" label="Triagem automática das vagas novas (nota e título)"
                  off="as notas só são calculadas quando você abre a vaga."
                  checked={form.tier1Enabled} onChange={(tier1Enabled) => onChange({ tier1Enabled })}
                  source={ai.tier1Enabled.source} changed={form.tier1Enabled !== ai.tier1Enabled.value}
                />
                <ToggleRow
                  testId="settings-tier2" label="Análise automática ao abrir a vaga ou movê-la para Selecionadas"
                  off="a análise só roda pelo botão Analisar."
                  checked={form.tier2Auto} onChange={(tier2Auto) => onChange({ tier2Auto })}
                  source={ai.tier2Auto.source} changed={form.tier2Auto !== ai.tier2Auto.value}
                />
              </div>
            </div>
          </Block>
        </div>
      </div>

      <div className="grid min-w-0 items-start gap-4 md:grid-cols-2 xl:grid-cols-1">
        <Notice tone="warn" icon={<ShieldAlert />} className="md:col-span-2 xl:col-span-1">
          Este app não tem login. Quem conseguir abrir esta página pode trocar o provedor e gastar a chave gravada aqui (mas não consegue lê-la). Não exponha o app em uma URL pública.
        </Notice>
        <TestConnection dto={dto} dirty={dirty} />
        <Usage />
      </div>
    </section>
  );
}
