import { CloudOff, Download, FileText, FileUp, Languages, LoaderCircle, RotateCw, ShieldCheck, UserRound } from 'lucide-react';
import { motion } from 'motion/react';
import { useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  AI_PROVIDER_LABELS, RESUME_LANGS, otherLang, type AiTaskDto, type CandidateProfileDto, type ProfileOverviewDto, type ResumeLang,
  type ResumeMetaDto,
} from '@kv/shared/client';
import { resumeFileUrl } from '../aiApi';
import { layerMessage, resumeFileProblem, retryNote, taskErrorText } from '../lib/ai';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { useAiStatus, useConfirmTask, useProfileOverview, useTranslateProfile, useUploadResume } from '../useAi';
import { AiNotConfigured } from './AiNotConfigured';
import { ProfileEditor } from './ProfileEditor';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { CheckChip } from './ui/check-chip';
import { Notice } from './ui/notice';
import { Segmented } from './ui/segmented';
import { Skeleton } from './ui/skeleton';

const CARD = 'rounded-3xl border border-line bg-surface/85 shadow-raised';
const PRIVACY_KEY = 'kv.ai.privacyAccepted';
const ACCEPT = '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const LANG: Record<ResumeLang, { name: string; short: string; upload: string; replace: string }> = {
  'pt-BR': { name: 'Português (Brasil)', short: 'Português', upload: 'Enviar currículo em português', replace: 'Substituir currículo em português' },
  en: { name: 'English', short: 'English', upload: 'Enviar currículo em inglês', replace: 'Substituir currículo em inglês' },
};

function readAccepted(): boolean {
  try {
    return localStorage.getItem(PRIVACY_KEY) === '1';
  } catch {
    return false;
  }
}

const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024))} kB`;
const isActive = (task: AiTaskDto | undefined) => task?.status === 'queued' || task?.status === 'running';

interface LangCardProps {
  lang: ResumeLang;
  resume: ResumeMetaDto | undefined;
  profile: CandidateProfileDto | undefined;
  other: CandidateProfileDto | undefined;
  task: AiTaskDto | undefined;
  /** IA configurada e aviso de privacidade aceito. */
  canUpload: boolean;
  index: number;
}

function LangCard({ lang, resume, profile, other, task, canUpload, index }: LangCardProps) {
  const titleId = useId();
  const inputId = useId();
  const problemId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const upload = useUploadResume();
  const translate = useTranslateProfile();
  const confirm = useConfirmTask();
  const text = LANG[lang];
  const working = isActive(task) || upload.isPending;
  const translating = task?.type === 'profile_translate';
  const canTranslate = !!other && (!profile || profile.origin === 'traduzido') && !working;

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // escolher o mesmo arquivo de novo dispara o evento outra vez
    if (!file) return;
    const found = resumeFileProblem(file);
    setProblem(found);
    if (found) return;
    if (profile?.origin === 'editado' && !window.confirm('Enviar outro arquivo substitui o perfil que você editou.')) return;
    // A recusa da API (arquivo ilegível, currículo longo demais, tipo errado) aparece aqui, junto do botão. O
    // currículo e o perfil que já existiam não mudam: a consulta só é refeita quando o envio dá certo.
    upload.mutate({ lang, file }, { onError: (e) => setProblem(e.message) });
  }

  let state: ReactNode = null;
  if (upload.isPending) {
    state = <Progress>Enviando o arquivo…</Progress>;
  } else if (task && isActive(task)) {
    state = <Progress>{translating ? 'Traduzindo o perfil...' : 'Lendo o currículo...'} <span className="text-faint">{retryNote(task)}</span></Progress>;
  } else if (task?.status === 'blocked_budget') {
    state = (
      <Notice tone="warn" title={layerMessage('blocked_budget', task)} action={
        <Button type="button" size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate(task.id)}>Executar mesmo assim</Button>
      }>
        {translating ? 'A tradução do perfil' : 'A leitura do currículo'} está esperando a sua confirmação.
      </Notice>
    );
  } else if (task?.status === 'error') {
    state = (
      <Notice tone="bad" title={translating ? 'A tradução do perfil falhou' : 'A leitura do currículo falhou'} action={
        <Button type="button" size="sm" disabled={!canUpload} onClick={() => (translating ? translate.mutate(lang) : input.current?.click())}>
          <RotateCw aria-hidden /> Tentar de novo
        </Button>
      }>
        <p data-testid="task-error" className="break-words">{taskErrorText(task.error)}</p>
      </Notice>
    );
  }

  return (
    <motion.section
      aria-labelledby={titleId}
      initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.04 + index * 0.05 }}
      className={cn(CARD, 'flex min-w-0 flex-col p-5')}
    >
      <div className="flex items-center gap-2.5">
        <h3 id={titleId} className="text-base font-semibold text-ink">{text.name}</h3>
        {profile
          ? <Badge tone="ok" size="md">perfil pronto</Badge>
          : <Badge tone="outline" size="md">sem perfil</Badge>}
      </div>

      {resume ? (
        <div className="mt-3.5 flex items-center gap-3 rounded-2xl border border-line bg-surface-2/50 px-3.5 py-3">
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/14 text-accent ring-1 ring-inset ring-accent/25">
            <FileText className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p data-testid={`resume-file-${lang}`} className="truncate text-[13px] font-medium text-ink" title={resume.fileName}>{resume.fileName}</p>
            <p className="text-xs tabular-nums text-muted">
              {fileSize(resume.size)} · enviado em {new Date(resume.uploadedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
            </p>
          </div>
          <Button asChild size="sm" variant="ghost">
            <a href={resumeFileUrl(lang)} download aria-label={`Baixar original do currículo em ${lang === 'pt-BR' ? 'português' : 'inglês'}`}>
              <Download aria-hidden /> Baixar original
            </a>
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {profile ? 'Este perfil veio da tradução do outro idioma; nenhum arquivo foi enviado.' : 'Nenhum currículo enviado neste idioma.'}
        </p>
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {/* O input fica no DOM, focável e ligado ao rótulo; só a aparência é a do botão ao lado. */}
        <input
          ref={input} id={inputId} type="file" accept={ACCEPT} disabled={!canUpload || working} onChange={onFile}
          data-testid={`resume-upload-${lang}`} aria-describedby={problem ? problemId : undefined}
          className="peer sr-only"
        />
        <label
          htmlFor={inputId}
          className={cn(
            'inline-flex h-9 cursor-pointer select-none items-center gap-2 rounded-xl px-3.5 text-sm font-medium transition-[background-color,border-color,filter,transform] duration-150 ease-out-soft active:scale-[0.97] [&_svg]:size-4',
            'peer-focus-visible:ring-[3px] peer-focus-visible:ring-accent/45',
            'peer-disabled:cursor-not-allowed peer-disabled:border peer-disabled:border-line peer-disabled:bg-none peer-disabled:bg-surface-2 peer-disabled:text-faint peer-disabled:shadow-none peer-disabled:active:scale-100',
            resume
              ? 'border border-line bg-surface-2 text-ink shadow-card hover:border-line-strong hover:bg-surface-3'
              : 'bg-linear-to-b from-[#a6b8ff] to-accent-strong font-semibold text-on-accent shadow-accent hover:brightness-110',
          )}
        >
          <FileUp aria-hidden /> {resume ? text.replace : text.upload}
        </label>
        {canTranslate && (
          <Button type="button" data-testid={`translate-${lang}`} disabled={translate.isPending || !canUpload} onClick={() => translate.mutate(lang)}>
            <Languages aria-hidden /> {profile ? 'Traduzir de novo' : 'Gerar por tradução'}
          </Button>
        )}
        <span className="text-xs text-faint">PDF ou DOCX, até 5 MB.</span>
      </div>
      {problem && <p id={problemId} role="alert" data-testid={`resume-problem-${lang}`} className="mt-2 max-w-prose break-words text-xs leading-snug text-bad">{problem}</p>}

      <div data-testid={`profile-task-${lang}`} aria-live="polite" className={cn(state && 'mt-3.5')}>{state}</div>
    </motion.section>
  );
}

function Progress({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-2xl border border-accent/25 bg-accent/7 px-3.5 py-2.5 text-[13px] text-ink-2">
      <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-accent" />
      <span>{children}</span>
    </p>
  );
}

function Loaded({ overview, onOpenSettings }: { overview: ProfileOverviewDto; onOpenSettings: () => void }) {
  const status = useAiStatus();
  const [accepted, setAccepted] = useState(readAccepted);
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  const langLabelId = useId();
  const configured = status.data?.configured === true;
  const notConfigured = status.data?.configured === false;
  const hasResume = overview.resumes.length > 0;
  const profileOf = (lang: ResumeLang) => overview.profiles.find((p) => p.lang === lang);
  const withProfile = RESUME_LANGS.filter((l) => profileOf(l));
  const [chosen, setChosen] = useState<ResumeLang>('pt-BR');
  const activeLang = withProfile.includes(chosen) ? chosen : withProfile[0];
  const providerName = status.data?.provider
    ? (AI_PROVIDER_LABELS[status.data.provider as keyof typeof AI_PROVIDER_LABELS] ?? status.data.provider)
    : 'ainda não escolhido';

  function accept(value: boolean) {
    setAccepted(value);
    try {
      if (value) localStorage.setItem(PRIVACY_KEY, '1');
      else localStorage.removeItem(PRIVACY_KEY);
    } catch {
      // sem armazenamento local: o aceite vale só para esta visita
    }
  }

  const privacyText = (
    <>
      Seu currículo e as vagas analisadas são enviados ao provedor de IA configurado ({providerName}). O arquivo original e o perfil ficam
      guardados só no seu banco de dados. Este app não tem login: não o deixe em uma URL pública.
    </>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
          <Heading />

          {notConfigured && (
            <AiNotConfigured problem={status.data?.problem} onOpenSettings={onOpenSettings}>
              <p>O currículo só vira perfil estruturado com a IA configurada.</p>
            </AiNotConfigured>
          )}

          {!hasResume && (
            <Notice
              tone="info" data-testid="privacy-notice" icon={<ShieldCheck />} title="Antes de enviar: para onde seus dados vão"
              action={<CheckChip testId="privacy-accept" label="Entendi e quero enviar meu currículo" checked={accepted} onCheckedChange={accept} />}
            >
              <p>{privacyText}</p>
            </Notice>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {RESUME_LANGS.map((lang, i) => (
              <LangCard
                key={lang} lang={lang} index={i}
                resume={overview.resumes.find((r) => r.lang === lang)}
                profile={profileOf(lang)} other={profileOf(otherLang(lang))}
                task={overview.tasks.find((t) => t.lang === lang)}
                canUpload={configured && (accepted || hasResume)}
              />
            ))}
          </div>

          <motion.section
            aria-labelledby={langLabelId}
            initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring, delay: 0.14 }}
            className={CARD}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-b border-line px-5 py-4 sm:px-6">
              <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent/14 text-accent ring-1 ring-inset ring-accent/25">
                <UserRound className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 id={langLabelId} className="font-display text-lg font-semibold leading-tight">Perfil estruturado</h3>
                <p className="mt-0.5 text-[13px] leading-snug text-muted">A fonte da verdade para tudo que a IA escreve. Revise e corrija o que ela leu.</p>
              </div>
              {withProfile.length > 1 && activeLang && (
                <Segmented
                  aria-labelledby={langLabelId} value={activeLang} onValueChange={setChosen}
                  options={withProfile.map((l) => ({ value: l, label: LANG[l].short, ariaLabel: `Perfil em ${LANG[l].name}` }))}
                  className="w-56"
                />
              )}
            </div>
            <div className="px-5 py-5 sm:px-6">
              {withProfile.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <span className="grid size-12 place-items-center rounded-2xl bg-accent/12 text-accent ring-1 ring-inset ring-accent/20">
                    <FileText aria-hidden className="size-5" />
                  </span>
                  <p className="max-w-sm text-sm text-muted">
                    {overview.tasks.some(isActive)
                      ? 'O perfil aparece aqui assim que a leitura do currículo terminar.'
                      : 'Envie um currículo acima. O texto é lido e vira um perfil que você revisa aqui.'}
                  </p>
                </div>
              )}
              {overview.profiles.map((p) => (
                <ProfileEditor key={p.lang} profile={p} active={p.lang === activeLang} footer={footer} />
              ))}
            </div>
          </motion.section>

          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pb-2 text-xs text-muted">
            {hasResume && <span>Currículo e vagas analisadas são enviados ao provedor de IA configurado ({providerName}).</span>}
            <span>Provedor, modelos, limite de gasto e histórico de custo ficam em Configurações.</span>
            <button type="button" onClick={onOpenSettings} className="cursor-pointer rounded-md font-medium text-accent transition-colors hover:text-ink">
              Abrir as configurações
            </button>
          </p>
        </div>
      </div>
      <div ref={setFooter} className={cn('shrink-0 border-t border-line bg-surface-2/95 px-4 py-3 sm:px-6', !activeLang && 'hidden')} />
    </div>
  );
}

function Heading() {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={spring}>
      <h2 className="text-xl font-semibold">Meu perfil</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Envie seu currículo em português e em inglês. O app extrai um perfil estruturado, que você revisa; é dele que saem as notas, as análises e os currículos adaptados.
      </p>
    </motion.div>
  );
}

export function MyProfilePage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const overview = useProfileOverview();
  if (overview.data) return <Loaded overview={overview.data} onOpenSettings={onOpenSettings} />;
  return (
    <div className="relative h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
        <Heading />
        {overview.isPending ? (
          <div aria-busy="true" aria-label="Carregando seu perfil" className="space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <Skeleton className="h-36 rounded-3xl" />
              <Skeleton className="h-36 rounded-3xl" />
            </div>
            <Skeleton className="h-80 rounded-3xl" />
          </div>
        ) : (
          <div role="alert" className={cn(CARD, 'flex flex-col items-center gap-3 px-6 py-14 text-center')}>
            <span className="grid size-14 place-items-center rounded-2xl bg-bad/12 text-bad ring-1 ring-inset ring-bad/25">
              <CloudOff aria-hidden className="size-6" />
            </span>
            <h3 className="text-lg font-semibold">Não foi possível carregar seu perfil</h3>
            <p className="max-w-sm text-sm text-muted">{overview.error?.message}</p>
            <Button onClick={() => overview.refetch()} className="mt-1"><RotateCw aria-hidden /> Tentar de novo</Button>
          </div>
        )}
      </div>
    </div>
  );
}
