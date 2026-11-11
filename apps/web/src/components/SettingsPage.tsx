import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudOff, Database, Info, Languages, RotateCw, Server, Timer, TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { SETTINGS_LIMITS, type SettingSource, type SettingsDto } from '@kv/shared/client';
import { api } from '../api';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { formFromSettings, isDirty, toSettingsPatch, validateSettings, type SettingsForm, type SettingsFormErrors } from '../settingsForm';
import { showToast } from '../toast';
import { AI_KEYS, useSaveSettings, useSettings } from '../useAi';
import { isWorkerStale } from '../workerStale';
import { CARD, ERROR, HINT, LABEL, SectionHeader, SettingsAiSection, SourceTag, type SettingsFieldIds } from './SettingsAiSection';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { TagInput } from './ui/tag-input';

/**
 * Alterações não salvas quando o usuário sai da tela: ficam guardadas e voltam como estavam (o mesmo
 * mecanismo da tela de Perfis de busca). Só campos não secretos: a chave de API nunca passa por aqui.
 */
let keptForm: SettingsForm | null = null;

const ERROR_ORDER: (keyof SettingsFormErrors)[] = ['modelFast', 'modelStrong', 'dailyBudget', 'greenhouseBoards', 'leverCompanies'];
const time = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function PageShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[84rem] p-4 sm:p-6">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="mb-5">
            <h2 className="text-xl font-semibold">Configurações</h2>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Valem a partir do momento em que são salvas, sem reiniciar nada. O que você não mexer continua vindo do ambiente ou do padrão.
            </p>
          </motion.div>
          {children}
        </div>
      </div>
      {footer}
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <PageShell>
      <div aria-busy="true" aria-label="Carregando configurações" className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]">
        <div className={cn(CARD, 'p-6')}>
          <Skeleton className="h-10 w-72" />
          <Skeleton className="mt-6 h-14 w-full rounded-2xl" />
          <Skeleton className="mt-6 h-10 w-full rounded-xl" />
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-10 rounded-xl" />
            <Skeleton className="h-10 rounded-xl" />
          </div>
          <Skeleton className="mt-6 h-12 w-full rounded-2xl" />
          <Skeleton className="mt-2 h-12 w-full rounded-2xl" />
          <Skeleton className="mt-2 h-12 w-full rounded-2xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-32 rounded-3xl" />
          <Skeleton className="h-72 rounded-3xl" />
        </div>
      </div>
    </PageShell>
  );
}

function CompanyList({ id, testId, label, source, changed, tags, draft, error, onTags, onDraft, onReset, resetting }: {
  id: string; testId: string; label: string; source: SettingSource; changed: boolean; tags: string[]; draft: string;
  error: string | undefined; onTags: (tags: string[]) => void; onDraft: (draft: string) => void; onReset: () => void; resetting: boolean;
}) {
  const helpId = useId();
  return (
    <div data-testid={testId} className="min-w-0 space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className={LABEL}>{label}</label>
        <SourceTag source={source} changed={changed} />
      </div>
      <TagInput id={id} tags={tags} onTagsChange={onTags} draft={draft} onDraftChange={onDraft} placeholder="nome-da-empresa" invalid={!!error} describedBy={helpId} />
      <div className="flex min-h-5 items-start justify-between gap-2">
        <p id={helpId} aria-live="polite" className={error ? ERROR : cn(HINT, 'tabular-nums')}>
          {error ?? `${tags.length} de ${SETTINGS_LIMITS.companies} empresas. Enter ou vírgula adiciona.`}
        </p>
        {source === 'ui' && (
          <button
            type="button" onClick={onReset} disabled={resetting} aria-label={`Voltar ao padrão em ${label}`}
            className="shrink-0 cursor-pointer rounded-md px-1 text-xs font-medium text-accent transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Voltar ao padrão
          </button>
        )}
      </div>
    </div>
  );
}

function Fact({ icon, children, testId, tone }: { icon: ReactNode; children: ReactNode; testId?: string; tone?: 'warn' }) {
  return (
    <li data-testid={testId} className={cn('flex items-start gap-2.5 text-[13px] leading-snug', tone === 'warn' ? 'text-warn' : 'text-ink-2')}>
      <span aria-hidden className={cn('mt-px shrink-0 [&_svg]:size-4', tone === 'warn' ? 'text-warn' : 'text-faint')}>{icon}</span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function General({ dto }: { dto: SettingsDto }) {
  const titleId = useId();
  const { data: health, dataUpdatedAt } = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 30_000 });
  const { data: profiles } = useQuery({ queryKey: ['profiles'], queryFn: api.profiles });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [dataUpdatedAt]);
  const stale = !!health && !!profiles && isWorkerStale({ now, lastFinishedAt: health.lastFinishedAt, profiles });
  let worker: string;
  if (!health) worker = 'Consultando o worker…';
  else if (stale) worker = 'O worker não termina uma busca há mais de 2 horas. Confira se ele está rodando.';
  else if (health.lastFinishedAt !== null) worker = `Worker ativo: última busca terminada às ${time(health.lastFinishedAt)}`;
  else worker = 'Nenhuma busca terminou ainda. A primeira roda na próxima hora cheia ou pelo botão Buscar agora.';
  return (
    <section data-testid="settings-general" aria-labelledby={titleId} className={CARD}>
      <SectionHeader id={titleId} icon={<Server />} title="Geral">Como o app está rodando agora.</SectionHeader>
      <ul className="space-y-3 px-5 py-5 sm:px-6">
        <Fact testId="worker-status" icon={stale ? <TriangleAlert /> : <Server />} tone={stale ? 'warn' : undefined}>
          <span role="status">{worker}</span>
        </Fact>
        <Fact testId="next-run" icon={<Timer />}>Próxima busca: <span className="font-medium tabular-nums text-ink">{time(dto.general.nextRunAt)}</span></Fact>
        <Fact icon={<Languages />}>Idioma das traduções: português (Brasil).</Fact>
      </ul>
    </section>
  );
}

function SettingsLoaded({ dto }: { dto: SettingsDto }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<SettingsForm>(() => keptForm ?? formFromSettings(dto));
  // Chegou um SettingsDto novo: o formulário acompanha, a menos que tenha alterações não salvas.
  const [base, setBase] = useState(dto);
  if (dto !== base) {
    if (!isDirty(form, base)) setForm(formFromSettings(dto));
    setBase(dto);
  }
  const [attempted, setAttempted] = useState(false);
  const save = useSaveSettings();
  const reset = useSaveSettings();
  const sourcesTitle = useId();
  const ids: SettingsFieldIds = {
    modelFast: useId(), modelStrong: useId(), dailyBudget: useId(), greenhouseBoards: useId(), leverCompanies: useId(),
  };
  const errors = validateSettings(form);
  const dirty = isDirty(form, dto);
  const invalid = Object.keys(errors).length > 0;

  const latest = useRef({ form, dirty });
  latest.current = { form, dirty };
  useEffect(() => () => {
    keptForm = latest.current.dirty ? latest.current.form : null;
  }, []);

  const change = (next: Partial<SettingsForm>) => setForm((f) => ({ ...f, ...next }));
  const adopt = (saved: SettingsDto, next: SettingsForm) => {
    qc.setQueryData(AI_KEYS.settings, saved);
    setBase(saved);
    setForm(next);
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || save.isPending) return;
    setAttempted(true);
    const first = ERROR_ORDER.find((k) => errors[k]);
    if (first) {
      document.getElementById(ids[first])?.focus();
      return;
    }
    save.mutate(toSettingsPatch(form, dto), {
      onSuccess: (saved) => {
        adopt(saved, formFromSettings(saved));
        setAttempted(false);
        showToast('Configurações salvas. Valem a partir de agora, sem reiniciar.', 'info');
      },
    });
  }

  function resetList(key: 'greenhouseBoards' | 'leverCompanies') {
    reset.mutate({ [key]: null }, {
      onSuccess: (saved) => {
        const draft = key === 'greenhouseBoards' ? 'greenhouseDraft' : 'leverDraft';
        adopt(saved, { ...form, [key]: [...saved.sources[key].value], [draft]: '' });
      },
    });
  }

  const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const showErrors = attempted;
  const footerHint = save.isPending ? 'Salvando…'
    : !dirty ? 'Nenhuma alteração para salvar.'
    : attempted && invalid ? 'Corrija os campos destacados para salvar.'
    : 'Há alterações não salvas.';

  return (
    <form onSubmit={submit} noValidate className="contents">
      <PageShell
        footer={
          <div className="shrink-0 border-t border-line bg-surface-2/95 px-4 py-3 sm:px-6">
            <div className="mx-auto flex max-w-[84rem] flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p aria-live="polite" className={cn('min-w-0 text-xs', dirty && !save.isPending ? 'text-warn' : 'text-faint')}>{footerHint}</p>
              <div className="ml-auto flex items-center gap-2">
                {dirty && (
                  <Button type="button" variant="ghost" size="lg" disabled={save.isPending} onClick={() => { setForm(formFromSettings(dto)); setAttempted(false); }}>
                    Descartar
                  </Button>
                )}
                <Button type="submit" variant="primary" size="lg" data-testid="settings-save" disabled={!dirty || save.isPending} className="min-w-48">
                  Salvar configurações
                </Button>
              </div>
            </div>
          </div>
        }
      >
        <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.04 }} className="space-y-6">
          <SettingsAiSection dto={dto} form={form} errors={errors} showErrors={showErrors} dirty={dirty} ids={ids} onChange={change} />

          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]">
            <section data-testid="settings-sources" aria-labelledby={sourcesTitle} className={cn(CARD, '@container min-w-0')}>
              <SectionHeader id={sourcesTitle} icon={<Database />} title="Fontes">
                Empresas consultadas nos quadros de vagas do Greenhouse e do Lever.
              </SectionHeader>
              <div className="space-y-4 px-5 py-5 sm:px-6">
                <div className="grid gap-x-4 gap-y-4 @2xl:grid-cols-2">
                  <CompanyList
                    id={ids.greenhouseBoards} testId="settings-greenhouse" label="Empresas no Greenhouse"
                    source={dto.sources.greenhouseBoards.source} changed={!sameList(form.greenhouseBoards, dto.sources.greenhouseBoards.value)}
                    tags={form.greenhouseBoards} draft={form.greenhouseDraft} error={errors.greenhouseBoards}
                    onTags={(greenhouseBoards) => change({ greenhouseBoards })} onDraft={(greenhouseDraft) => change({ greenhouseDraft })}
                    onReset={() => resetList('greenhouseBoards')} resetting={reset.isPending}
                  />
                  <CompanyList
                    id={ids.leverCompanies} testId="settings-lever" label="Empresas no Lever"
                    source={dto.sources.leverCompanies.source} changed={!sameList(form.leverCompanies, dto.sources.leverCompanies.value)}
                    tags={form.leverCompanies} draft={form.leverDraft} error={errors.leverCompanies}
                    onTags={(leverCompanies) => change({ leverCompanies })} onDraft={(leverDraft) => change({ leverDraft })}
                    onReset={() => resetList('leverCompanies')} resetting={reset.isPending}
                  />
                </div>
                <p className={HINT}>
                  Use o nome da empresa como aparece na URL do quadro de vagas (ex.: boards.greenhouse.io/<strong className="font-semibold text-ink-2">gitlab</strong>).
                  {' '}Até {SETTINGS_LIMITS.companies} empresas; cada uma é uma requisição por busca.
                </p>
                <p data-testid="indeed-note" className="flex items-start gap-2 border-t border-line pt-4 text-xs leading-snug text-muted">
                  <Info aria-hidden className="mt-px size-3.5 shrink-0 text-faint" />
                  O Indeed só funciona com navegador visível (INDEED_HEADFUL=1) e não funciona no container.
                </p>
              </div>
            </section>
            <General dto={dto} />
          </div>
        </motion.div>
      </PageShell>
    </form>
  );
}

export function SettingsPage() {
  const settings = useSettings();
  if (settings.data) return <SettingsLoaded dto={settings.data} />;
  if (settings.isPending) return <SettingsSkeleton />;
  return (
    <PageShell>
      <div role="alert" className="flex flex-col items-center gap-3 rounded-3xl border border-line bg-surface/85 px-6 py-14 text-center">
        <span className="grid size-14 place-items-center rounded-2xl bg-bad/12 text-bad ring-1 ring-inset ring-bad/25">
          <CloudOff aria-hidden className="size-6" />
        </span>
        <h3 className="text-lg font-semibold">Não foi possível carregar as configurações</h3>
        <p className="max-w-sm text-sm text-muted">{settings.error?.message}</p>
        <Button onClick={() => settings.refetch()} className="mt-1">
          <RotateCw aria-hidden /> Tentar de novo
        </Button>
      </div>
    </PageShell>
  );
}
