import { CloudOff, Download, FileText, FileUp, Languages, LoaderCircle, RotateCw, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useId, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  AI_PROVIDER_LABELS, RESUME_LANGS, otherLang, type AiTaskDto, type CandidateProfileDto, type ProfileOverviewDto, type ResumeLang,
  type ResumeMetaDto,
} from '@kv/shared/client';
import { resumeFileUrl } from '../aiApi';
import { layerMessage, resumeFileProblem, retryNote, taskErrorText } from '../lib/ai';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { bottomBarRef, showToast } from '../toast';
import {
  useAiStatus, useConfirmTask, useDeleteAiData, useDeleteResume, useProfileOverview, useTranslateProfile, useUploadResume,
} from '../useAi';
import { AiNotConfigured } from './AiNotConfigured';
import { ApplyAnswersSection } from './ApplyAnswersSection';
import { ProfileEditor, forgetProfileDraft } from './ProfileEditor';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { CheckChip } from './ui/check-chip';
import { ConfirmDialog } from './ui/confirm-dialog';
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
  const remove = useDeleteResume();
  /** Arquivo escolhido que substituiria um perfil editado: espera a confirmação na caixa do app. */
  const [replacing, setReplacing] = useState<File | null>(null);
  const [deleting, setDeleting] = useState(false);
  const text = LANG[lang];
  const langName = lang === 'pt-BR' ? 'português' : 'inglês';
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
    // Perfil editado à mão: enviar outro arquivo o substitui. A confirmação é a caixa do app, não a do navegador.
    if (profile?.origin === 'editado') return setReplacing(file);
    send(file);
  }

  function send(file: File) {
    // A recusa da API (arquivo ilegível, currículo longo demais, tipo errado) aparece aqui, junto do botão. O
    // currículo e o perfil que já existiam não mudam: a consulta só é refeita quando o envio dá certo.
    upload.mutate({ lang, file }, { onError: (e) => setProblem(e.message) });
  }

  function removeAll() {
    remove.mutate(lang, {
      onSuccess: () => {
        forgetProfileDraft(lang);
        setProblem(null);
        showToast(`Currículo e perfil em ${langName} apagados.`, 'info');
      },
      // Com erro o aviso flutuante diz o motivo; a caixa fecha nos dois casos.
      onSettled: () => setDeleting(false),
    });
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
        {(resume || profile) && (
          <Button
            type="button" variant="ghost" size="sm" data-testid={`resume-delete-${lang}`} disabled={upload.isPending || remove.isPending}
            onClick={() => setDeleting(true)} aria-label={`Apagar o currículo e o perfil em ${langName}`}
            className="ml-auto text-muted hover:bg-bad/12 hover:text-bad"
          >
            <Trash2 aria-hidden /> Apagar
          </Button>
        )}
      </div>
      {problem && <p id={problemId} role="alert" data-testid={`resume-problem-${lang}`} className="mt-2 max-w-prose break-words text-xs leading-snug text-bad">{problem}</p>}

      <div data-testid={`profile-task-${lang}`} aria-live="polite" className={cn(state && 'mt-3.5')}>{state}</div>

      <ConfirmDialog
        open={replacing !== null} onOpenChange={(open) => !open && setReplacing(null)} testId={`resume-replace-dialog-${lang}`}
        title={`Substituir o perfil em ${langName} que você editou?`} confirmLabel="Enviar e substituir"
        onConfirm={() => {
          if (replacing) send(replacing);
          setReplacing(null);
        }}
      >
        <p>
          O perfil em {langName} foi editado por você. Enviar <span className="font-medium text-ink">{replacing?.name}</span> faz a IA ler o arquivo
          novo e gravar um perfil novo no lugar: as suas edições neste idioma serão perdidas.
        </p>
        <p>O arquivo enviado antes também é substituído.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={deleting} onOpenChange={setDeleting} busy={remove.isPending} testId={`resume-delete-dialog-${lang}`}
        title={`Apagar o currículo e o perfil em ${langName}?`} confirmLabel={remove.isPending ? 'Apagando…' : 'Apagar'} onConfirm={removeAll}
      >
        <p>Serão apagados deste app, sem volta:</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>o arquivo do currículo em {langName} e o texto lido dele;</li>
          <li>o perfil estruturado em {langName}, com tudo o que você editou;</li>
          <li>os currículos adaptados escritos em {langName};</li>
          <li>leituras e traduções de perfil que estejam na fila.</li>
        </ul>
        <p>As notas e análises das vagas ficam, marcadas como desatualizadas. O que já foi enviado ao provedor de IA não é apagado por aqui.</p>
      </ConfirmDialog>
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
  // O rodapé recebe os botões do editor (portal) e avisa o aviso flutuante da altura dele, para não ser coberto.
  const footerRef = useCallback((el: HTMLElement | null) => {
    setFooter(el);
    return bottomBarRef(el);
  }, []);
  const langLabelId = useId();
  const dataLabelId = useId();
  const configured = status.data?.configured === true;
  const notConfigured = status.data?.configured === false;
  const hasResume = overview.resumes.length > 0;
  const profileOf = (lang: ResumeLang) => overview.profiles.find((p) => p.lang === lang);
  const withProfile = RESUME_LANGS.filter((l) => profileOf(l));
  const [chosen, setChosen] = useState<ResumeLang>('pt-BR');
  const wipe = useDeleteAiData();
  const [wiping, setWiping] = useState(false);
  function wipeAll() {
    wipe.mutate(undefined, {
      onSuccess: () => {
        forgetProfileDraft();
        showToast('Todos os dados de IA foram apagados.', 'info');
      },
      onSettled: () => setWiping(false),
    });
  }
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

          <ApplyAnswersSection />

          <section aria-labelledby={dataLabelId} className={cn(CARD, 'flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 sm:px-6')}>
            <div className="min-w-56 flex-1">
              <h3 id={dataLabelId} className="text-sm font-semibold text-ink">Seus dados</h3>
              <p className="mt-0.5 text-[13px] leading-snug text-muted">
                Currículos, perfis, currículos adaptados, notas e análises ficam guardados só no seu banco de dados. Você pode apagar um idioma
                (botão Apagar em cada cartão acima) ou tudo de uma vez.
              </p>
            </div>
            <Button type="button" variant="danger" data-testid="ai-data-delete" disabled={wipe.isPending} onClick={() => setWiping(true)}>
              <Trash2 aria-hidden /> Apagar todos os dados de IA
            </Button>
          </section>

          <ConfirmDialog
            open={wiping} onOpenChange={setWiping} busy={wipe.isPending} testId="ai-data-delete-dialog"
            title="Apagar todos os dados de IA?" confirmLabel={wipe.isPending ? 'Apagando…' : 'Apagar tudo'} onConfirm={wipeAll}
          >
            <p>Serão apagados deste app, sem volta:</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>os currículos enviados (arquivos e texto lido) e os perfis estruturados dos dois idiomas;</li>
              <li>todos os currículos adaptados;</li>
              <li>as notas, os títulos traduzidos e as análises de todas as vagas;</li>
              <li>a fila de tarefas da IA, inclusive o que está em andamento;</li>
              <li>as respostas para candidaturas que você salvou e as respostas guardadas nas candidaturas;</li>
              <li>os e-mails de vaga guardados, as respostas preparadas para eles, a lista de e-mails ignorados e os alertas do sino.</li>
            </ul>
            <p>
              Ficam: as vagas e as suas anotações, o histórico de gasto estimado (sem conteúdo pessoal), as configurações e as chaves de API
              (para removê-las, use a aba Configurações), e a caixa de e-mail conectada (para desconectá-la, use Configurações &gt; E-mail).
              O que já foi enviado ao provedor de IA ou às empresas não é apagado por aqui.
            </p>
          </ConfirmDialog>

          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pb-2 text-xs text-muted">
            {hasResume && <span>Currículo e vagas analisadas são enviados ao provedor de IA configurado ({providerName}).</span>}
            <span>Provedor, modelos, limite de gasto e histórico de custo ficam em Configurações.</span>
            <button type="button" onClick={onOpenSettings} className="cursor-pointer rounded-md font-medium text-accent transition-colors hover:text-ink">
              Abrir as configurações
            </button>
          </p>
        </div>
      </div>
      <div ref={footerRef} data-testid="profile-footer" className={cn('shrink-0 border-t border-line bg-surface-2/95 px-4 py-3 sm:px-6', !activeLang && 'hidden')} />
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
