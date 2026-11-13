import { CircleAlert, CircleCheck, CircleDashed, CircleOff, Inbox, LoaderCircle, Lock, LogOut, Mail, MailCheck, PlugZap, RotateCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { APP_SECRET_COMMAND, type EmailFactsMode, type EmailMoveMode, type MailAccountDto, type MailIgnoredDto, type SettingsDto } from '@kv/shared/client';
import { ageLabel } from '../age';
import { mailPasswordProblem } from '../lib/email';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import type { SettingsForm } from '../settingsForm';
import { useConnectMailbox, useDisconnectMailbox, useIgnoredMail, useMailAccount, useMessageActions } from '../useEmail';
import { SecretCommand } from './ApiKeyField';
import { MailPasswordField } from './MailPasswordField';
import { CARD, ERROR, EYEBROW, HINT, LABEL, SectionHeader, SourceTag, ToggleRow } from './SettingsAiSection';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Input } from './ui/input';
import { Notice } from './ui/notice';
import { Segmented } from './ui/segmented';
import { Skeleton } from './ui/skeleton';

const MOVE_OPTIONS: { value: EmailMoveMode; label: string }[] = [
  { value: 'auto', label: 'Automático' }, { value: 'confirm', label: 'Pedir confirmação' },
];
const MOVE_HINTS: Record<EmailMoveMode, string> = {
  auto: 'Reprovação, convite de entrevista e oferta movem o card na hora. O histórico do card mostra o e-mail e tem Desfazer.',
  confirm: 'Cada movimento vira um alerta com Mover e Não mover.',
};
const FACTS_OPTIONS: { value: EmailFactsMode; label: string }[] = [
  { value: 'auto', label: 'Automático' }, { value: 'approve', label: 'Pedir aprovação' }, { value: 'off', label: 'Desligado' },
];
const FACTS_HINTS: Record<EmailFactsMode, string> = {
  auto: 'Quando a empresa pede só dados que você salvou, o app responde sozinho com um texto fixo, sem IA.',
  approve: 'A resposta com os seus dados fica pronta e só sai quando você aprovar.',
  off: 'O app não monta respostas com os seus dados.',
};
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MINUTE = 60_000;

/** "há 3 min", "há 2 h"; de um dia em diante, o mesmo texto da idade das vagas ("há 2 dias"). */
function sinceLabel(at: number, now: number): string {
  const minutes = Math.floor((now - at) / MINUTE);
  if (minutes < 1) return 'agora há pouco';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return ageLabel(at, now);
}

const dateLabel = (ms: number) => new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const messageOf = (e: unknown) => (e instanceof Error && e.message.trim() !== '' ? e.message : 'Algo deu errado. Tente de novo.');

function Block({ title, children, first }: { title: string; children: ReactNode; first?: boolean }) {
  return (
    <div className={cn(!first && 'border-t border-line pt-5')}>
      <h3 className={cn(EYEBROW, 'mb-3')}>{title}</h3>
      {children}
    </div>
  );
}

/**
 * O motivo de não poder gravar a senha, como a API escreve. Quando ele traz o comando que gera o APP_SECRET, o comando
 * aparece uma vez só, no bloco de copiar, no lugar em que estava na frase.
 */
function SecretProblem({ text }: { text: string }) {
  const [before, after, ...rest] = text.split(APP_SECRET_COMMAND);
  if (after === undefined || rest.length > 0) {
    return (
      <>
        <p className="break-words">{text}</p>
        <SecretCommand />
      </>
    );
  }
  return (
    <>
      {before.trim() && <p className="break-words">{before.trim()}</p>}
      <SecretCommand />
      {after.trim() && <p className="mt-2 break-words">{after.trim().charAt(0).toUpperCase() + after.trim().slice(1)}</p>}
    </>
  );
}

/** O que a tela diz sobre a caixa: conectada, parada (com a causa) ou não conectada. */
function stateOf(account: MailAccountDto): { tone: 'ok' | 'bad' | 'none'; text: string } {
  if (!account.connected) return { tone: 'none', text: 'Não conectada' };
  if (account.paused || account.error) return { tone: 'bad', text: `Parada: ${account.error ?? 'a leitura da caixa está em pausa.'}` };
  return { tone: 'ok', text: 'Conectada' };
}

function StateRow({ account, now, onDisconnect }: { account: MailAccountDto; now: number; onDisconnect: () => void }) {
  const state = stateOf(account);
  return (
    <div
      className={cn(
        'flex flex-wrap items-start gap-x-3 gap-y-2.5 rounded-2xl border px-4 py-3 transition-colors duration-200',
        state.tone === 'ok' ? 'border-ok/25 bg-ok/8' : state.tone === 'bad' ? 'border-bad/25 bg-bad/8' : 'border-line-strong bg-surface-2/60',
      )}
    >
      {state.tone === 'ok' ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
        : state.tone === 'bad' ? <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
        : <CircleDashed aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />}
      <div className="min-w-48 flex-1 text-[13px] leading-relaxed text-ink-2">
        <p data-testid="email-state" role="status" className="break-words font-semibold text-ink">{state.text}</p>
        {account.connected && (
          <p className="break-words">
            <span className="text-ink">{account.address}</span>
            <span aria-hidden className="text-faint"> · </span>
            {account.lastReadAt !== null ? `última leitura ${sinceLabel(account.lastReadAt, now)}` : 'a primeira leitura ainda não terminou'}
          </p>
        )}
      </div>
      {account.connected && (
        <Button type="button" size="sm" variant="ghost" data-testid="email-disconnect" onClick={onDisconnect} className="self-center">
          <LogOut aria-hidden /> Desconectar
        </Button>
      )}
    </div>
  );
}

/** Endereço, senha de app e "Testar e conectar". A senha só existe no campo até a chamada terminar. */
function ConnectForm({ account, locked }: { account: MailAccountDto; locked: boolean }) {
  const connect = useConnectMailbox();
  const addressId = useId();
  const passwordId = useId();
  const addressHelp = useId();
  const passwordHelp = useId();
  const password = useRef<HTMLInputElement>(null);
  const [address, setAddress] = useState(() => account.address ?? account.profileEmail ?? '');
  const [addressProblem, setAddressProblem] = useState<string | null>(null);
  const [passwordProblem, setPasswordProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = connect.isPending;

  async function submit() {
    const el = password.current;
    if (!el || busy || locked) return;
    const wrongAddress = ADDRESS.test(address.trim()) ? null : 'Digite o endereço do Gmail, como maria@gmail.com.';
    const wrongPassword = mailPasswordProblem(el.value);
    setAddressProblem(wrongAddress);
    setPasswordProblem(wrongPassword);
    setFailure(null);
    if (wrongAddress) return document.getElementById(addressId)?.focus();
    if (wrongPassword) return el.focus();
    try {
      await connect.mutateAsync({ address: address.trim(), password: el.value.replace(/\s+/g, '') });
    } catch (e) {
      setFailure(messageOf(e));
    } finally {
      // Deu certo ou não, a senha sai da página assim que a chamada termina.
      el.value = '';
    }
  }

  return (
    <fieldset disabled={locked} className={cn('min-w-0 space-y-3', locked && 'opacity-60')}>
      <legend className="sr-only">Conectar a caixa</legend>
      <div className="grid gap-x-4 gap-y-3 @xl:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={addressId} className={LABEL}>Endereço do Gmail</label>
          <Input
            id={addressId} data-testid="email-address" type="email" inputMode="email" autoComplete="off" spellCheck={false} maxLength={254}
            value={address}
            onChange={(e) => { setAddress(e.target.value); if (addressProblem) setAddressProblem(null); }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              // Enter aqui conecta; não envia o formulário das configurações.
              e.preventDefault();
              void submit();
            }}
            aria-invalid={addressProblem ? true : undefined} aria-describedby={addressProblem ? addressHelp : undefined}
          />
          {addressProblem && <p id={addressHelp} role="alert" className={ERROR}>{addressProblem}</p>}
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={passwordId} className={LABEL}>Senha de app</label>
          <MailPasswordField
            id={passwordId} inputRef={password} disabled={locked || busy} invalid={!!passwordProblem} describedBy={passwordHelp}
            onSubmit={() => void submit()} onEdit={() => { if (passwordProblem) setPasswordProblem(null); }}
          />
          <p id={passwordHelp} role={passwordProblem ? 'alert' : undefined} className={passwordProblem ? ERROR : HINT}>
            {passwordProblem ?? 'Os 16 caracteres que o Google mostra; os espaços não importam.'}
          </p>
        </div>
      </div>
      <Button type="button" variant="primary" data-testid="email-connect" disabled={locked || busy} onClick={() => void submit()}>
        {busy ? <LoaderCircle aria-hidden className="animate-spin" /> : <PlugZap aria-hidden />}
        {busy ? 'Testando…' : 'Testar e conectar'}
      </Button>
      <AnimatePresence initial={false}>
        {failure && (
          <motion.div key="failure" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden">
            <Notice tone="bad" role="alert" data-testid="email-connect-error" title="A caixa não foi conectada">
              <p className="break-words">{failure}</p>
            </Notice>
          </motion.div>
        )}
      </AnimatePresence>
    </fieldset>
  );
}

function DisconnectDialog({ address, open, onOpenChange }: { address: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const disconnect = useDisconnectMailbox();
  const checkId = useId();
  const [deleteMail, setDeleteMail] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const change = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setDeleteMail(false);
      setFailure(null);
    }
  };

  async function confirm() {
    setFailure(null);
    try {
      await disconnect.mutateAsync(deleteMail ? 'delete' : 'keep');
      change(false);
    } catch (e) {
      setFailure(messageOf(e));
    }
  }

  return (
    <ConfirmDialog
      open={open} onOpenChange={change} busy={disconnect.isPending} testId="email-disconnect-dialog"
      title="Desconectar a caixa de e-mail?" confirmLabel={disconnect.isPending ? 'Desconectando…' : 'Desconectar'} onConfirm={() => void confirm()}
    >
      <p>A senha de app é apagada e o app para de ler {address ?? 'a caixa'}. Para voltar, será preciso colar uma senha de app de novo.</p>
      <label htmlFor={checkId} className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl border border-line bg-surface-2/50 px-3 py-2.5">
        <input
          id={checkId} type="checkbox" data-testid="email-disconnect-delete" checked={deleteMail} disabled={disconnect.isPending}
          onChange={(e) => setDeleteMail(e.target.checked)} className="mt-0.5 size-4 shrink-0 cursor-pointer accent-accent"
        />
        <span className="min-w-0">
          <span className="block font-medium text-ink">Apagar também os e-mails guardados</span>
          <span className={cn(HINT, 'mt-0.5 block')}>Some a conversa de cada vaga, as respostas e os alertas do e-mail.</span>
        </span>
      </label>
      {failure && <Notice tone="bad" role="alert" className="mt-3"><p className="break-words">{failure}</p></Notice>}
    </ConfirmDialog>
  );
}

function IgnoredRow({ item }: { item: MailIgnoredDto }) {
  const { promote } = useMessageActions();
  const [failure, setFailure] = useState<string | null>(null);
  const pending = promote.isPending && promote.variables === item.id;
  const sender = item.fromName.trim() || item.fromAddress;

  async function mark() {
    setFailure(null);
    try {
      await promote.mutateAsync(item.id);
    } catch (e) {
      setFailure(messageOf(e));
    }
  }

  return (
    <motion.li
      layout="position" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}
      data-testid={`email-ignored-${item.id}`}
      className="rounded-2xl border border-line bg-surface-2/50 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-48 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 break-words text-[13px] font-medium leading-snug text-ink">{item.subject.trim() || '(sem assunto)'}</p>
            <Badge tone="neutral">{item.company}</Badge>
          </div>
          <p className="mt-0.5 break-words text-xs leading-snug text-muted">
            {sender}{sender !== item.fromAddress && <span className="text-faint"> &lt;{item.fromAddress}&gt;</span>}
            <span aria-hidden className="text-faint"> · </span>
            <span className="tabular-nums">{dateLabel(item.sentAt)}</span>
          </p>
        </div>
        {item.promoted ? (
          <Badge tone="ok" size="md"><MailCheck aria-hidden className="size-3.5" /> marcado como de vaga</Badge>
        ) : (
          <Button type="button" size="sm" disabled={pending} onClick={() => void mark()} aria-label={`É de vaga: ${item.subject}`}>
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Inbox aria-hidden />}
            É de vaga
          </Button>
        )}
      </div>
      {failure && <p role="alert" className={cn(ERROR, 'mt-2')}>{failure}</p>}
    </motion.li>
  );
}

/** Os e-mails que o filtro local deixou de fora. Sem nenhum, a parte não aparece. */
function IgnoredMail() {
  const ignored = useIgnoredMail();
  const items = ignored.data ?? [];
  if (items.length === 0) return null;
  return (
    <Block title="E-mails ignorados">
      <p className={cn(HINT, '-mt-1 mb-3')}>
        Mensagens de empresas do seu quadro que não pareceram de vaga. Ficam aqui 30 dias, só com remetente, assunto e data.
      </p>
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {items.map((item) => <IgnoredRow key={item.id} item={item} />)}
        </AnimatePresence>
      </ul>
    </Block>
  );
}

interface Props {
  dto: SettingsDto;
  form: SettingsForm;
  onChange: (next: Partial<SettingsForm>) => void;
}

export function SettingsEmailSection({ dto, form, onChange }: Props) {
  const titleId = useId();
  const moveLabel = useId();
  const factsLabel = useId();
  const account = useMailAccount();
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const email = dto.email;

  // "Última leitura há …" acompanha o relógio, e a leitura que o worker faz a cada 3 min aparece sem recarregar.
  const { refetch } = account;
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      void refetch();
    }, MINUTE);
    return () => clearInterval(timer);
  }, [refetch]);
  const { dataUpdatedAt } = account;
  useEffect(() => setNow(Date.now()), [dataUpdatedAt]);

  const a = account.data;
  const locked = !!a && (!a.available || !a.canStore);
  const stopped = !!a && a.connected && (a.paused || a.error !== null);

  return (
    <section data-testid="settings-email" aria-labelledby={titleId} className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]">
      <div className={cn(CARD, '@container min-w-0')}>
        <SectionHeader id={titleId} icon={<Mail />} title="E-mail">
          O app lê a sua Caixa de entrada, liga os e-mails de vaga aos cards e responde só o que você deixar.
        </SectionHeader>

        <div className="space-y-5 px-5 py-5 sm:px-6">
          <Block title="Conexão" first>
            {a ? (
              <div className="space-y-3">
                {!a.available && (
                  <Notice tone="bad" role="alert" data-testid="email-unavailable" icon={<CircleOff />}>
                    <p className="break-words">{a.unavailableReason}</p>
                  </Notice>
                )}
                {a.available && !a.canStore && (
                  <Notice tone="warn" data-testid="email-secret-missing" icon={<Lock />} title="Conexão bloqueada">
                    <SecretProblem text={a.secretProblem ?? 'Defina APP_SECRET no servidor para conectar a caixa.'} />
                  </Notice>
                )}
                <StateRow account={a} now={now} onDisconnect={() => setConfirming(true)} />
                {a.connected && a.differsFromProfile && a.profileEmail && (
                  <Notice tone="warn" role="status" data-testid="email-differs">
                    As respostas das empresas chegam em <span className="font-medium text-ink">{a.profileEmail}</span>, que não é a caixa conectada.
                  </Notice>
                )}
                {(!a.connected || stopped) && <ConnectForm key={a.address ?? ''} account={a} locked={locked} />}
              </div>
            ) : account.isError ? (
              <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <p className={ERROR}>Não foi possível ler o estado da caixa: {account.error.message}</p>
                <Button type="button" size="sm" variant="ghost" onClick={() => void account.refetch()}>
                  <RotateCw aria-hidden /> Tentar de novo
                </Button>
              </div>
            ) : (
              <div className="space-y-3"><Skeleton className="h-16 rounded-2xl" /><Skeleton className="h-10 rounded-xl" /></div>
            )}
          </Block>

          <Block title="O que o app faz sozinho">
            <div className="space-y-4">
              <ToggleRow
                testId="email-enabled" label="Ler a caixa"
                off="o app não lê a caixa, não move cards e não responde nada."
                on="a cada 3 minutos o app lê os e-mails novos da Caixa de entrada."
                checked={form.emailEnabled} onChange={(emailEnabled) => onChange({ emailEnabled })}
                source={email.enabled.source} changed={form.emailEnabled !== email.enabled.value}
              />
              <fieldset disabled={!form.emailEnabled} className={cn('min-w-0 space-y-4 transition-opacity duration-200', !form.emailEnabled && 'opacity-50')}>
                <legend className="sr-only">Com a leitura ligada</legend>
                <div className="grid gap-x-4 gap-y-4 @2xl:grid-cols-2">
                  <div className="min-w-0">
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <span id={moveLabel} className={LABEL}>Mover cards pelos e-mails</span>
                      <SourceTag source={email.moveMode.source} changed={form.emailMoveMode !== email.moveMode.value} />
                    </div>
                    <div data-testid="email-move-mode">
                      <Segmented aria-labelledby={moveLabel} value={form.emailMoveMode} onValueChange={(emailMoveMode) => onChange({ emailMoveMode })} options={MOVE_OPTIONS} />
                    </div>
                    <p className={cn(HINT, 'mt-1.5')}>{MOVE_HINTS[form.emailMoveMode]}</p>
                  </div>
                  <div className="min-w-0">
                    <div className="mb-2 flex items-baseline justify-between gap-2">
                      <span id={factsLabel} className={LABEL}>Respostas com fatos salvos</span>
                      <SourceTag source={email.factsMode.source} changed={form.emailFactsMode !== email.factsMode.value} />
                    </div>
                    <div data-testid="email-facts-mode">
                      <Segmented aria-labelledby={factsLabel} value={form.emailFactsMode} onValueChange={(emailFactsMode) => onChange({ emailFactsMode })} options={FACTS_OPTIONS} />
                    </div>
                    <p className={cn(HINT, 'mt-1.5')}>{FACTS_HINTS[form.emailFactsMode]}</p>
                  </div>
                </div>
                <ToggleRow
                  testId="email-ai-drafts" label="Rascunhos escritos pela IA"
                  off="convites e pedidos fora dos seus dados salvos só geram um alerta."
                  on="para convites e pedidos fora dos seus dados salvos, a IA escreve um rascunho, que nunca sai sem a sua aprovação."
                  checked={form.emailAiDrafts} onChange={(emailAiDrafts) => onChange({ emailAiDrafts })}
                  source={email.aiDrafts.source} changed={form.emailAiDrafts !== email.aiDrafts.value}
                />
              </fieldset>
            </div>
          </Block>

          <IgnoredMail />
        </div>
      </div>

      <div className={cn(CARD, 'p-5')}>
        <h3 className={EYEBROW}>Como criar a senha de app</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          Na sua Conta Google, ative a verificação em duas etapas e crie uma senha de app para 'E-mail'. Ela dá acesso à caixa inteira: o app só lê a Caixa de entrada e só envia as respostas que você vê aqui.
        </p>
      </div>
      <DisconnectDialog address={a?.address ?? null} open={confirming} onOpenChange={setConfirming} />
    </section>
  );
}
