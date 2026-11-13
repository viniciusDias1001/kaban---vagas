import { CircleCheck, CircleDashed, CircleOff, Clock, LoaderCircle, LogIn, LogOut, Plus, Play, RefreshCw, Send, ShieldAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useState, type ReactNode } from 'react';
import {
  APPLY_AI_ANSWER_MODES, APPLY_DEFAULTS, APPLY_SETTINGS_LIMITS, APPLY_TIMING, type ApplyDailyCaps, type ApplyMode, type ApplyResumeMode,
  type ApplySiteId, type ApplySiteStateDto, type ApplyStatusDto, type SettingSource, type SettingsDto, type SitePauseReason, type SiteSession,
} from '@kv/shared/client';
import { AI_ANSWER_LABELS } from '../lib/apply';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { badDailyCap, collectBlockItems, type SettingsForm, type SettingsFormErrors } from '../settingsForm';
import { useProfileOverview } from '../useAi';
import { useApplyActions, useApplyStatus } from '../useApply';
import { CARD, EYEBROW, ERROR, HINT, LABEL, SectionHeader, SourceTag, ToggleRow, type SettingsFieldIds } from './SettingsAiSection';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Notice } from './ui/notice';
import { Segmented } from './ui/segmented';
import { Skeleton } from './ui/skeleton';
import { TagInput } from './ui/tag-input';

const MODE_OPTIONS: { value: ApplyMode; label: string }[] = [{ value: 'dry_run', label: 'Ensaio' }, { value: 'real', label: 'Enviar' }];
const RESUME_OPTIONS: { value: ApplyResumeMode; label: string }[] = [
  { value: 'tailored', label: 'Adaptado à vaga' }, { value: 'base', label: 'Currículo base' },
];
const SESSION_BADGE: Record<SiteSession, { tone: 'ok' | 'warn' | 'neutral'; label: string }> = {
  logged_in: { tone: 'ok', label: 'conectado' },
  logged_out: { tone: 'warn', label: 'desconectado' },
  unknown: { tone: 'neutral', label: 'sessão não verificada' },
};
const PAUSE_TEXT: Record<SitePauseReason, string> = {
  brake: `Pausado depois de ${APPLY_TIMING.brakeAfter} falhas seguidas neste site.`,
  restricted: 'Pausado porque o site restringiu a conta. Confira a conta no site antes de retomar.',
  owner_away: `Pausado porque ${APPLY_TIMING.ownerAwayAfter} esperas por você passaram do prazo.`,
};

/** Sites que já tiveram a troca para "Enviar" confirmada nesta sessão do navegador: o aviso aparece uma vez só. */
const confirmedReal = new Set<ApplySiteId>();

const time = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function Block({ title, children, first, aside }: { title: string; children: ReactNode; first?: boolean; aside?: ReactNode }) {
  return (
    <div className={cn(!first && 'border-t border-line pt-5')}>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h3 className={EYEBROW}>{title}</h3>
        {aside}
      </div>
      {children}
    </div>
  );
}

/** Campo numérico curto com rótulo, origem e ajuda/erro embaixo. */
function NumberField({ id, testId, label, value, onChange, hint, error, changed, source, max }: {
  id: string; testId: string; label: string; value: string; onChange: (v: string) => void; hint: ReactNode; error: string | undefined;
  changed: boolean; source: SettingSource; max?: number;
}) {
  const helpId = useId();
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className={LABEL}>{label}</label>
        <SourceTag source={source} changed={changed} />
      </div>
      <Input
        id={id} data-testid={testId} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)}
        maxLength={max === undefined ? 3 : String(max).length} autoComplete="off"
        aria-invalid={error ? true : undefined} aria-describedby={helpId} className="tabular-nums"
      />
      <p id={helpId} className={error ? ERROR : HINT}>{error ?? hint}</p>
    </div>
  );
}

/** A empresa atual do perfil (experiência sem data de fim), de preferência no perfil em português. */
function useCurrentCompany(): string | null {
  const { data } = useProfileOverview();
  const profiles = [...(data?.profiles ?? [])].sort((a, b) => Number(b.lang === 'pt-BR') - Number(a.lang === 'pt-BR'));
  for (const p of profiles) {
    const current = p.data.experiences.find((e) => e.end.trim() === '' && e.company.trim() !== '');
    if (current) return current.company.trim();
  }
  return null;
}

function SiteRow({ site, form, errors, capId, onChange }: {
  site: ApplySiteStateDto; form: SettingsForm; errors: SettingsFormErrors; capId: string;
  onChange: (next: Partial<SettingsForm>) => void;
}) {
  const id = site.site;
  const labelId = useId();
  const capHelp = useId();
  const loginHint = useId();
  const actions = useApplyActions();
  const [asking, setAsking] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const mode = form.applySiteModes[id];
  const capKey = id as keyof ApplyDailyCaps;
  const capError = badDailyCap(form) === capKey ? errors.applyDailyCaps : undefined;

  const setMode = (next: ApplyMode) => {
    if (next === 'real' && site.mode !== 'real' && !confirmedReal.has(id)) {
      setAsking(true);
      return;
    }
    setAsking(false);
    onChange({ applySiteModes: { ...form.applySiteModes, [id]: next } });
  };
  const confirmReal = () => {
    confirmedReal.add(id);
    setAsking(false);
    onChange({ applySiteModes: { ...form.applySiteModes, [id]: 'real' } });
  };

  // Ações do worker: a API só enfileira o pedido; o estado mostrado segue o que /apply/status informa.
  const account = [
    { key: 'open', label: 'Abrir para fazer login', icon: <LogIn aria-hidden />, m: actions.openLogin },
    { key: 'check', label: 'Verificar', icon: <RefreshCw aria-hidden />, m: actions.checkSession },
    { key: 'logout', label: 'Desconectar', icon: <LogOut aria-hidden />, m: actions.logout },
  ] as const;
  const accountError = account.map((a) => a.m).find((m) => m.isError && m.variables === id)?.error;
  const busy = account.some((a) => a.m.isPending && a.m.variables === id);
  const resuming = actions.resumeSite.isPending && actions.resumeSite.variables === id;
  const resumeError = actions.resumeSite.isError && actions.resumeSite.variables === id ? actions.resumeSite.error : null;
  const session = SESSION_BADGE[site.session];

  return (
    <li data-testid={`apply-site-${id}`} aria-labelledby={labelId} className="rounded-2xl border border-line bg-surface-2/50 px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h4 id={labelId} className="text-[14px] font-semibold text-ink">{site.label}</h4>
          {site.needsLogin && <Badge tone={session.tone}>{session.label}</Badge>}
          {site.paused && <Badge tone="warn">pausado</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {mode !== site.mode && <SourceTag source="ui" changed />}
          <div data-testid={`apply-mode-${id}`}>
            <Segmented
              aria-labelledby={labelId} value={mode} onValueChange={setMode} options={MODE_OPTIONS}
              className="w-44 [&>button]:px-3"
            />
          </div>
        </div>
      </div>

      <p className={cn(HINT, 'mt-1.5')}>
        {mode === 'real' ? 'Enviar: preenche e envia a candidatura.' : 'Ensaio: preenche o formulário e para antes de enviar, para você conferir.'}
      </p>

      <AnimatePresence initial={false}>
        {asking && (
          <motion.div key="confirm" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden">
            <Notice
              tone="warn" role="alert" data-testid={`apply-real-confirm-${id}`} className="mt-3"
              action={(
                <>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>Manter Ensaio</Button>
                  <Button type="button" size="sm" data-testid={`apply-real-confirm-yes-${id}`} onClick={confirmReal}>Usar Enviar</Button>
                </>
              )}
            >
              Neste modo o app envia candidaturas de verdade em seu nome neste site.
            </Notice>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-3 flex flex-wrap items-start gap-x-6 gap-y-2 border-t border-line/70 pt-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5">
            <label htmlFor={capId} className="text-[13px] text-ink-2">Limite do dia</label>
            <Input
              id={capId} data-testid={`apply-cap-${id}`} inputMode="numeric" value={form.applyDailyCaps[capKey]}
              onChange={(e) => onChange({ applyDailyCaps: { ...form.applyDailyCaps, [capKey]: e.target.value } })}
              maxLength={3} autoComplete="off" aria-invalid={capError ? true : undefined} aria-describedby={capHelp}
              className="h-8 w-16 px-2 text-center tabular-nums"
            />
          </div>
          {capError && <p id={capHelp} className={ERROR}>{capError}</p>}
        </div>
        <p id={capError ? undefined : capHelp} className="py-1.5 text-[13px] tabular-nums text-ink-2">
          Feitas hoje: <span className="font-semibold text-ink">{site.formsToday}</span> de {site.formsCap}
          {site.viewsCap !== null && (
            <>
              <span aria-hidden className="text-faint"> · </span>
              vagas abertas: <span className="font-semibold text-ink">{site.viewsToday ?? 0}</span> de {site.viewsCap}
            </>
          )}
        </p>
      </div>

      {site.needsLogin && (
        <div className="mt-3 space-y-2 border-t border-line/70 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            {account.map((a) => {
              const pending = a.m.isPending && a.m.variables === id;
              return (
                <Button
                  key={a.key} type="button" size="sm" variant={a.key === 'logout' ? 'ghost' : 'secondary'}
                  data-testid={`apply-${a.key}-${id}`} disabled={busy}
                  aria-describedby={a.key === 'open' ? loginHint : undefined}
                  onClick={() => a.m.mutate(id, { onSuccess: () => setSent(a.key) })}
                >
                  {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : a.icon}
                  {a.label}
                </Button>
              );
            })}
            <span role="status" className="text-xs text-muted">{sent && !busy && !accountError ? 'Pedido enviado.' : ''}</span>
          </div>
          <p id={loginHint} className={HINT}>
            A janela abre no navegador das candidaturas. Você digita a senha no próprio site; o app não vê nem guarda a sua senha.
            {site.sessionCheckedAt !== null && ` Última verificação às ${time(site.sessionCheckedAt)}.`}
          </p>
          {accountError && <p role="alert" className={ERROR}>{accountError.message}</p>}
        </div>
      )}

      {site.paused && (
        <Notice
          tone="warn" role="status" data-testid={`apply-paused-${id}`} className="mt-3"
          action={(
            <Button type="button" size="sm" data-testid={`apply-resume-${id}`} disabled={resuming} onClick={() => actions.resumeSite.mutate(id)}>
              {resuming ? <LoaderCircle aria-hidden className="animate-spin" /> : <Play aria-hidden />}
              Retomar
            </Button>
          )}
        >
          <p>{site.pauseReason ? PAUSE_TEXT[site.pauseReason] : 'Pausado.'}</p>
          {resumeError && <p role="alert" className="text-bad">{resumeError.message}</p>}
        </Notice>
      )}
    </li>
  );
}

function Today({ status }: { status: ApplyStatusDto | undefined }) {
  const share = status && status.totalCap > 0 ? Math.min(1, status.totalToday / status.totalCap) : 0;
  return (
    <div data-testid="apply-today" className={cn(CARD, 'p-5')}>
      <h3 className={EYEBROW}>Hoje</h3>
      {status ? (
        <>
          <p className="mt-2 text-[13px] text-ink-2">
            Candidaturas: <span className="font-semibold tabular-nums text-ink">{status.totalToday}</span> de <span className="tabular-nums">{status.totalCap}</span>
          </p>
          <div aria-hidden className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out-soft" style={{ width: `${share * 100}%` }} />
          </div>
          <ul className="mt-3 space-y-2 text-[13px] leading-snug text-ink-2">
            <li className="flex items-start gap-2.5">
              {status.enabled
                ? <CircleCheck aria-hidden className="mt-px size-4 shrink-0 text-ok" />
                : <CircleOff aria-hidden className="mt-px size-4 shrink-0 text-faint" />}
              {status.enabled ? 'Salva como ligada.' : 'Salva como desligada.'}
            </li>
            <li className="flex items-start gap-2.5">
              <Clock aria-hidden className="mt-px size-4 shrink-0 text-faint" />
              {status.withinWindow ? 'Dentro do horário de candidaturas.' : 'Fora do horário: a fila espera o próximo início.'}
            </li>
            <li className="flex items-start gap-2.5 tabular-nums">
              <CircleDashed aria-hidden className="mt-px size-4 shrink-0 text-faint" />
              {status.queued} na fila, {status.running} em andamento, {status.needsHuman} precisando de você.
            </li>
          </ul>
        </>
      ) : (
        <Skeleton className="mt-3 h-24 w-full" />
      )}
    </div>
  );
}

interface Props {
  dto: SettingsDto;
  form: SettingsForm;
  errors: SettingsFormErrors;
  /** Só mostra os erros depois de uma tentativa de salvar ou de o formulário ter sido mexido. */
  showErrors: boolean;
  dirty: boolean;
  ids: SettingsFieldIds;
  onChange: (next: Partial<SettingsForm>) => void;
}

export function SettingsApplySection({ dto, form, errors, showErrors, dirty, ids, onChange }: Props) {
  const titleId = useId();
  const resumeLabel = useId();
  const answersLabel = useId();
  const windowHelp = useId();
  const companiesHelp = useId();
  const termsHelp = useId();
  const capBase = useId();
  const status = useApplyStatus();
  const currentCompany = useCurrentCompany();
  const apply = dto.apply;
  const available = status.data?.available ?? true;
  const shown: SettingsFormErrors = showErrors || dirty ? errors : {};
  const badCap = badDailyCap(form);
  /** O campo de limite inválido recebe o id do erro (o foco vai para ele); os demais, um id próprio. */
  const capId = (key: keyof ApplyDailyCaps) => (key === badCap ? ids.applyDailyCaps : `${capBase}-${key}`);
  const capChanged = (key: keyof ApplyDailyCaps) => form.applyDailyCaps[key].trim() !== String(apply.dailyCaps.value[key]);
  const capError = (key: keyof ApplyDailyCaps) => (key === badCap ? shown.applyDailyCaps : undefined);
  const setCap = (key: keyof ApplyDailyCaps) => (v: string) => onChange({ applyDailyCaps: { ...form.applyDailyCaps, [key]: v } });

  const companies = collectBlockItems(form.applyBlockedCompanies, form.applyBlockedCompaniesDraft);
  const terms = collectBlockItems(form.applyBlockedTerms, form.applyBlockedTermsDraft);
  // A sugestão só aparece enquanto a lista nunca foi gravada por aqui e está vazia.
  const suggest = currentCompany && apply.blockedCompanies.source !== 'ui' && companies.length === 0 ? currentCompany : null;

  return (
    <section data-testid="settings-apply" aria-labelledby={titleId} className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]">
      <div className={cn(CARD, '@container min-w-0')}>
        <SectionHeader id={titleId} icon={<Send />} title="Candidatura automática">
          O app preenche e envia candidaturas às vagas com nota alta, nos sites e limites escolhidos aqui.
        </SectionHeader>

        <div className="space-y-5 px-5 py-5 sm:px-6">
          {!available && (
            <Notice tone="bad" role="alert" data-testid="apply-unavailable" icon={<CircleOff />} title="Indisponível neste endereço">
              <p>{status.data?.unavailableReason ?? 'A candidatura automática não está disponível.'}</p>
              <p className="text-muted">As configurações abaixo ficam bloqueadas até o app voltar a rodar em endereço local.</p>
            </Notice>
          )}

          <fieldset disabled={!available} className={cn('min-w-0 space-y-5', !available && 'opacity-60')}>
            <Block title="Ligar" first>
              <ToggleRow
                testId="apply-enabled" label="Candidatura automática"
                off="nenhuma candidatura é preparada nem enviada; o app funciona como antes."
                checked={form.applyEnabled} onChange={(applyEnabled) => onChange({ applyEnabled })}
                source={apply.enabled.source} changed={form.applyEnabled !== apply.enabled.value}
              />
              <Notice tone="warn" icon={<ShieldAlert />} className="mt-2.5" data-testid="apply-risk">
                O app não tem login: quem alcançar esta página controla as suas candidaturas. A função só roda neste computador. O LinkedIn proíbe automação nos termos de uso; usar com a sua conta é por sua conta e risco.
              </Notice>
              <div className="mt-4 max-w-[17rem]">
                <NumberField
                  id={ids.applyMinScore} testId="apply-min-score" label="Nota mínima" value={form.applyMinScore}
                  onChange={(applyMinScore) => onChange({ applyMinScore })} error={shown.applyMinScore}
                  source={apply.minScore.source} changed={form.applyMinScore.trim() !== String(apply.minScore.value)}
                  hint={`De 0 a 100 (padrão ${APPLY_DEFAULTS.minScore}). Vagas com nota menor não entram na fila.`}
                />
              </div>
            </Block>

            <Block title="Sites">
              {status.data ? (
                status.data.sites.length > 0 ? (
                  <ul className="space-y-2.5">
                    {status.data.sites.map((site) => (
                      <SiteRow key={site.site} site={site} form={form} errors={shown} capId={capId(site.site)} onChange={onChange} />
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">Nenhum site de candidatura está registrado nesta instalação.</p>
                )
              ) : status.isError ? (
                <p role="alert" className={ERROR}>Não foi possível ler o estado dos sites: {status.error.message}</p>
              ) : (
                <div className="space-y-2.5"><Skeleton className="h-28 rounded-2xl" /></div>
              )}
            </Block>

            <Block title="Limites gerais">
              <div className="grid gap-x-4 gap-y-3 @xl:grid-cols-3">
                <NumberField
                  id={capId('total')} testId="apply-cap-total" label="Total por dia" value={form.applyDailyCaps.total} onChange={setCap('total')}
                  error={capError('total')} source={apply.dailyCaps.source} changed={capChanged('total')} hint={`Somando todos os sites (padrão ${APPLY_DEFAULTS.dailyCaps.total}).`}
                />
                <NumberField
                  id={ids.applyCompanyCap} testId="apply-company-cap" label={`Por empresa a cada ${APPLY_DEFAULTS.companyCapDays} dias`}
                  value={form.applyCompanyCap} onChange={(applyCompanyCap) => onChange({ applyCompanyCap })} error={shown.applyCompanyCap}
                  source={apply.companyCap.source} changed={form.applyCompanyCap.trim() !== String(apply.companyCap.value)} max={APPLY_SETTINGS_LIMITS.maxCompanyCap}
                  hint={`De 1 a ${APPLY_SETTINGS_LIMITS.maxCompanyCap} (padrão ${APPLY_DEFAULTS.companyCap}).`}
                />
                <NumberField
                  id={capId('linkedinViews')} testId="apply-cap-linkedin-views" label="Vagas abertas no LinkedIn por dia"
                  value={form.applyDailyCaps.linkedinViews} onChange={setCap('linkedinViews')} error={capError('linkedinViews')}
                  source={apply.dailyCaps.source} changed={capChanged('linkedinViews')} hint={`Cada vaga lida conta (padrão ${APPLY_DEFAULTS.dailyCaps.linkedinViews}).`}
                />
              </div>
              <fieldset className="mt-4 min-w-0" aria-describedby={windowHelp}>
                <div className="mb-1.5 flex items-baseline justify-between gap-2">
                  <legend className={LABEL}>Horário das candidaturas</legend>
                  <SourceTag
                    source={apply.window.source}
                    changed={form.applyWindowStart !== apply.window.value.start || form.applyWindowEnd !== apply.window.value.end}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2.5">
                  <label htmlFor={ids.applyWindow} className="text-[13px] text-ink-2">das</label>
                  <Input
                    id={ids.applyWindow} data-testid="apply-window-start" type="time" value={form.applyWindowStart}
                    onChange={(e) => onChange({ applyWindowStart: e.target.value })} aria-invalid={shown.applyWindow ? true : undefined}
                    className="w-32 tabular-nums"
                  />
                  <label htmlFor={`${capBase}-end`} className="text-[13px] text-ink-2">às</label>
                  <Input
                    id={`${capBase}-end`} data-testid="apply-window-end" type="time" value={form.applyWindowEnd}
                    onChange={(e) => onChange({ applyWindowEnd: e.target.value })} aria-invalid={shown.applyWindow ? true : undefined}
                    className="w-32 tabular-nums"
                  />
                </div>
                <p id={windowHelp} className={cn(shown.applyWindow ? ERROR : HINT, 'mt-1.5')}>
                  {shown.applyWindow ?? `Fora deste horário a fila espera (padrão ${APPLY_DEFAULTS.window.start} às ${APPLY_DEFAULTS.window.end}).`}
                </p>
              </fieldset>
            </Block>

            <Block title="Currículo e respostas">
              <div className="max-w-md">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <span id={resumeLabel} className={LABEL}>Currículo da candidatura</span>
                  <SourceTag source={apply.resumeMode.source} changed={form.applyResumeMode !== apply.resumeMode.value} />
                </div>
                <div data-testid="apply-resume-mode">
                  <Segmented aria-labelledby={resumeLabel} value={form.applyResumeMode} onValueChange={(applyResumeMode) => onChange({ applyResumeMode })} options={RESUME_OPTIONS} />
                </div>
                <p className={cn(HINT, 'mt-1.5')}>
                  {form.applyResumeMode === 'tailored'
                    ? 'Envia o currículo adaptado a cada vaga; sem ele pronto, a candidatura espera.'
                    : 'Envia sempre o currículo que você carregou em Meu perfil.'}
                </p>
              </div>

              <div className="mt-5">
                <div className="mb-2 flex items-baseline justify-between gap-2">
                  <span id={answersLabel} className={LABEL}>Respostas propostas pela IA</span>
                  <SourceTag source={apply.aiAnswers.source} changed={form.applyAiAnswers !== apply.aiAnswers.value} />
                </div>
                <div role="radiogroup" aria-labelledby={answersLabel} data-testid="apply-ai-answers" className="grid gap-2 @2xl:grid-cols-3">
                  {APPLY_AI_ANSWER_MODES.map((mode) => {
                    const active = form.applyAiAnswers === mode;
                    return (
                      <label
                        key={mode} data-testid={`apply-ai-answers-${mode}`}
                        className={cn(
                          'relative flex cursor-pointer items-start gap-3 rounded-2xl border px-3.5 py-3 transition-colors duration-150',
                          'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-accent/40',
                          active ? 'border-accent/45 bg-accent/10' : 'border-line bg-surface-2/50 hover:border-line-strong',
                        )}
                      >
                        <input
                          type="radio" name={answersLabel} value={mode} checked={active} onChange={() => onChange({ applyAiAnswers: mode })}
                          className="mt-0.5 size-4 shrink-0 cursor-pointer accent-accent"
                        />
                        <span className="min-w-0">
                          <span className="block text-[13px] font-medium leading-snug text-ink">{AI_ANSWER_LABELS[mode].title}</span>
                          <span className={cn(HINT, 'mt-0.5 block')}>{AI_ANSWER_LABELS[mode].hint}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <AnimatePresence initial={false}>
                  {form.applyAiAnswers === 'auto' && (
                    <motion.div key="auto" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden">
                      <Notice tone="warn" role="status" data-testid="apply-ai-auto-warning" className="mt-2.5">
                        No automático, a IA responde perguntas do formulário sem você ver antes. A conferência compara o texto da resposta com o seu perfil e pode deixar passar exageros ou respostas fora de contexto. Prefira 'Com a sua aprovação' até confiar no resultado.
                      </Notice>
                    </motion.div>
                  )}
                </AnimatePresence>
                <p className={cn(HINT, 'mt-2.5')}>
                  Perguntas pessoais (pretensão salarial, visto, disponibilidade, dados demográficos) nunca são respondidas pela IA: só pelas respostas que você salvou em Meu perfil.
                </p>
              </div>
            </Block>

            <Block title="Lista de bloqueio">
              <div className="grid gap-x-4 gap-y-4 @2xl:grid-cols-2">
                <div data-testid="apply-blocked-companies" className="min-w-0 space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <label htmlFor={ids.applyBlockedCompanies} className={LABEL}>Empresas</label>
                    <SourceTag source={apply.blockedCompanies.source} changed={!sameList(companies, apply.blockedCompanies.value)} />
                  </div>
                  <TagInput
                    id={ids.applyBlockedCompanies} tags={form.applyBlockedCompanies} draft={form.applyBlockedCompaniesDraft}
                    onTagsChange={(applyBlockedCompanies) => onChange({ applyBlockedCompanies })}
                    onDraftChange={(applyBlockedCompaniesDraft) => onChange({ applyBlockedCompaniesDraft })}
                    placeholder="nome da empresa" invalid={!!shown.applyBlockedCompanies} describedBy={companiesHelp}
                  />
                  <div id={companiesHelp} className="space-y-1.5">
                    {shown.applyBlockedCompanies && <p className={ERROR}>{shown.applyBlockedCompanies}</p>}
                    <p className={HINT}>
                      Uma empresa fica bloqueada quando o nome dela contém um item da lista, ou o item contém o nome dela. Palavras curtas e comuns (por exemplo 'Tech') bloqueiam mais empresas do que parece.
                    </p>
                  </div>
                  {suggest && (
                    <button
                      type="button" data-testid="apply-suggest-company"
                      onClick={() => onChange({ applyBlockedCompanies: [...form.applyBlockedCompanies, suggest.toLowerCase()] })}
                      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-accent/45 px-3 py-1 text-xs font-medium text-accent transition-colors hover:border-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40"
                    >
                      <Plus aria-hidden className="size-3.5" /> Adicionar {suggest}
                    </button>
                  )}
                </div>
                <div data-testid="apply-blocked-terms" className="min-w-0 space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <label htmlFor={ids.applyBlockedTerms} className={LABEL}>Termos no título ou na descrição</label>
                    <SourceTag source={apply.blockedTerms.source} changed={!sameList(terms, apply.blockedTerms.value)} />
                  </div>
                  <TagInput
                    id={ids.applyBlockedTerms} tags={form.applyBlockedTerms} draft={form.applyBlockedTermsDraft}
                    onTagsChange={(applyBlockedTerms) => onChange({ applyBlockedTerms })}
                    onDraftChange={(applyBlockedTermsDraft) => onChange({ applyBlockedTermsDraft })}
                    placeholder="ex.: estágio" invalid={!!shown.applyBlockedTerms} describedBy={termsHelp}
                  />
                  <p id={termsHelp} className={shown.applyBlockedTerms ? ERROR : HINT}>
                    {shown.applyBlockedTerms ?? `Uma vaga com um destes termos no título ou na descrição não recebe candidatura. Até ${APPLY_SETTINGS_LIMITS.listItems} itens por lista; Enter ou vírgula adiciona.`}
                  </p>
                </div>
              </div>
            </Block>
          </fieldset>
        </div>
      </div>

      <div className="grid min-w-0 items-start gap-4 md:grid-cols-2 xl:grid-cols-1">
        <Today status={status.data} />
        <div className={cn(CARD, 'p-5')}>
          <h3 className={EYEBROW}>Ensaio e Enviar</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            Comece cada site em Ensaio: o app preenche o formulário, guarda uma foto e para antes do envio. Quando os ensaios estiverem certos, troque o site para Enviar.
          </p>
        </div>
      </div>
    </section>
  );
}
