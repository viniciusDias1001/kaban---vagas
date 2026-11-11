import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, KeyRound, Lock, ServerCog, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useId, useRef, useState } from 'react';
import {
  AI_KEY_ENV_VARS, AI_PROVIDER_LABELS, APP_SECRET_COMMAND, SETTINGS_LIMITS, type AiKeyMetaDto, type AiProviderId, type SettingsDto,
} from '@kv/shared/client';
import { spring } from '../lib/motion';
import { cn } from '../lib/utils';
import { apiKeyProblem, keyView, maskedKey, type KeyView } from '../settingsForm';
import { showToast } from '../toast';
import { AI_KEYS, useDeleteApiKey, useSaveApiKey } from '../useAi';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { Input } from './ui/input';
import { Notice } from './ui/notice';

const VIEW_BADGE: Record<KeyView, { label: string; tone: 'ok' | 'warn' | 'bad' | 'outline' | 'accent' }> = {
  env: { label: 'definida pelo ambiente', tone: 'accent' },
  stored: { label: 'chave gravada', tone: 'ok' },
  undecryptable: { label: 'não decifra', tone: 'bad' },
  locked: { label: 'gravação bloqueada', tone: 'warn' },
  empty: { label: 'sem chave', tone: 'outline' },
};

const savedAtLabel = (ms: number) =>
  new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** O comando que gera o APP_SECRET, com botão de copiar. */
export function SecretCommand() {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(APP_SECRET_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('Não foi possível copiar. Selecione o comando e copie à mão.');
    }
  }
  return (
    <div className="mt-2 flex items-stretch gap-1.5">
      <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded-lg border border-line bg-bg/70 px-2.5 py-1.5 text-xs text-ink-2">
        {APP_SECRET_COMMAND}
      </code>
      <Button type="button" size="sm" onClick={copy} aria-label="Copiar o comando que gera o APP_SECRET" className="h-auto">
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? 'Copiado' : 'Copiar'}
      </Button>
    </div>
  );
}

interface ApiKeyFieldProps {
  provider: AiProviderId;
  meta: AiKeyMetaDto;
  dto: SettingsDto;
  /** É o provedor escolhido no formulário: o bloco vem primeiro e destacado. */
  selected: boolean;
  defaultOpen: boolean;
}

/**
 * Bloco da chave de API de um provedor. A chave é só de escrita: o campo é não controlado (o texto nunca
 * entra em estado React), é lido uma vez no envio e apagado em seguida. Depois de gravada, a tela só
 * conhece o que a API devolve: os quatro últimos caracteres e a data.
 */
export function ApiKeyField({ provider, meta, dto, selected, defaultOpen }: ApiKeyFieldProps) {
  const qc = useQueryClient();
  const label = AI_PROVIDER_LABELS[provider];
  const view = keyView(meta, dto.ai.canStoreKeys);
  const [open, setOpen] = useState(defaultOpen);
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const problemId = useId();
  const panelId = useId();
  const save = useSaveApiKey();
  const remove = useDeleteApiKey();
  const busy = save.isPending || remove.isPending;

  // O bloco do provedor recém-escolhido abre sozinho, e o do que deixou de ser o escolhido fecha: só um aberto
  // por vez, a menos que o usuário abra outro à mão.
  const [wasSelected, setWasSelected] = useState(selected);
  if (selected !== wasSelected) {
    setWasSelected(selected);
    setOpen(selected);
  }

  function submit() {
    const el = input.current;
    if (!el || busy) return;
    const found = apiKeyProblem(el.value);
    setProblem(found);
    if (found) return el.focus();
    save.mutate(
      { provider, key: el.value.trim() },
      {
        onSuccess: (saved) => {
          // A resposta traz só metadados; entra no cache para o bloco virar "gravada" na hora.
          qc.setQueryData<SettingsDto>(AI_KEYS.settings, (old) =>
            old && { ...old, ai: { ...old.ai, keys: old.ai.keys.map((k) => (k.provider === provider ? saved : k)) } });
          setReplacing(false);
          showToast(`Chave de ${label} gravada.`, 'info');
        },
        // A recusa da API (400 para chave vazia ou inválida, 409 sem APP_SECRET) aparece junto do campo.
        onError: (e) => {
          setProblem(e.message);
          input.current?.focus();
        },
        onSettled: () => {
          if (input.current) input.current.value = '';
          // Solta as variáveis da mutação (elas levam a chave) do cache do React Query.
          save.reset();
        },
      },
    );
  }

  function removeKey() {
    remove.mutate(provider, {
      onSuccess: () => {
        setReplacing(false);
        showToast(`Chave de ${label} removida.`, 'info');
      },
      // Com erro o aviso flutuante diz o motivo; a caixa fecha nos dois casos.
      onSettled: () => setConfirming(false),
    });
  }

  // Apagar a chave não tem volta (ela não pode ser lida de novo): o botão só abre a confirmação.
  const removeButton = (
    <Button
      type="button" variant="danger" size="sm" disabled={busy} onClick={() => setConfirming(true)}
      data-testid={`key-remove-${provider}`} aria-label={`Remover a chave gravada de ${label}`}
    >
      <Trash2 aria-hidden /> Remover
    </Button>
  );
  const last4 = meta.last4 ? <> (final <span className="font-mono text-ink">{meta.last4}</span>)</> : null;

  const field = (disabled: boolean, cancel: boolean) => (
    // Não é um <form>: o bloco vive dentro do formulário das configurações. Enter no campo salva só a chave.
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="sr-only">Chave de API de {label}</label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={input} id={inputId} type="password" autoComplete="off" spellCheck={false} disabled={disabled || busy}
          data-testid={`key-input-${provider}`} maxLength={SETTINGS_LIMITS.apiKeyMax}
          placeholder={disabled ? 'Indisponível sem APP_SECRET' : 'Cole a chave de API aqui'}
          onChange={() => problem && setProblem(null)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            submit();
          }}
          aria-invalid={problem ? true : undefined} aria-describedby={problem ? problemId : undefined}
          className="min-w-52 flex-1 font-mono"
        />
        <Button type="button" variant="primary" onClick={submit} disabled={disabled || busy} data-testid={`key-save-${provider}`} className="h-10">
          {save.isPending ? 'Salvando…' : 'Salvar chave'}
        </Button>
        {cancel && (
          <Button type="button" variant="ghost" className="h-10" onClick={() => { setReplacing(false); setProblem(null); }}>
            Cancelar
          </Button>
        )}
      </div>
      {problem && <p id={problemId} role="alert" data-testid={`key-problem-${provider}`} className="break-words text-xs leading-snug text-bad">{problem}</p>}
    </div>
  );

  return (
    <div
      data-testid={`key-${provider}`} data-view={view}
      className={cn(
        'rounded-2xl border bg-surface-2/50 transition-[border-color,box-shadow] duration-200 ease-out-soft',
        selected ? 'border-accent/45 ring-[3px] ring-accent/10' : 'border-line',
      )}
    >
      <button
        type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45"
      >
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg ring-1 ring-inset', selected ? 'bg-accent/14 text-accent ring-accent/25' : 'bg-surface-3 text-muted ring-white/6')}>
          {view === 'env' ? <ServerCog aria-hidden className="size-3.5" /> : view === 'locked' ? <Lock aria-hidden className="size-3.5" /> : <KeyRound aria-hidden className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{label}</span>
        {selected && <Badge tone="accent">em uso</Badge>}
        <Badge tone={VIEW_BADGE[view].tone}>{VIEW_BADGE[view].label}</Badge>
        <ChevronDown aria-hidden className={cn('size-4 shrink-0 text-faint transition-transform duration-200 ease-out-soft', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId} key="panel" className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring}
          >
            <div className="space-y-3 border-t border-line px-3.5 py-3.5">
              {view === 'env' && (
                <>
                  <p data-testid={`key-env-${provider}`} className="text-[13px] leading-relaxed text-ink-2">
                    Definida pelo ambiente (<code className="rounded-md bg-surface-3 px-1 py-px">{AI_KEY_ENV_VARS[provider]}</code>). Para trocá-la, edite a variável no servidor.
                  </p>
                  {meta.hasStored && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bg/40 px-3 py-2">
                      <p className="text-xs text-muted">Há também uma chave gravada aqui, que não está em uso.</p>
                      {removeButton}
                    </div>
                  )}
                </>
              )}

              {view === 'stored' && (
                <>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
                    <div className="min-w-0 flex-1">
                      <p data-testid={`key-masked-${provider}`} className="font-mono text-[15px] tracking-wide text-ink">{maskedKey(meta.last4)}</p>
                      {meta.savedAt !== null && <p className="mt-0.5 text-xs tabular-nums text-muted">Gravada em {savedAtLabel(meta.savedAt)}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {!replacing && <Button type="button" size="sm" disabled={busy} onClick={() => setReplacing(true)}>Trocar chave</Button>}
                      {removeButton}
                    </div>
                  </div>
                  {replacing && field(false, true)}
                </>
              )}

              {view === 'undecryptable' && (
                <>
                  <Notice tone="bad" role="alert" action={removeButton}>
                    A chave gravada (final <span className="font-mono text-ink">{meta.last4 ?? '••••'}</span>) não pôde ser decifrada: o APP_SECRET do servidor mudou. Cole a chave de novo.
                  </Notice>
                  {field(false, false)}
                </>
              )}

              {view === 'locked' && (
                <>
                  {field(true, false)}
                  {meta.hasStored && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-bg/40 px-3 py-2">
                      <p className="text-xs text-muted">Há uma chave gravada (final <span className="font-mono text-ink-2">{meta.last4 ?? '••••'}</span>) que não pode ser lida sem o APP_SECRET.</p>
                      {removeButton}
                    </div>
                  )}
                </>
              )}

              {view === 'empty' && field(false, false)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={confirming} onOpenChange={setConfirming} busy={remove.isPending} testId={`key-remove-dialog-${provider}`}
        title={`Remover a chave de API de ${label}?`} confirmLabel={remove.isPending ? 'Removendo…' : 'Remover chave'} onConfirm={removeKey}
      >
        <p>A chave gravada de {label}{last4} será apagada do banco. Ela não pode ser recuperada: para voltar a usá-la, será preciso colar a chave de novo.</p>
        {view === 'env' ? (
          <p>A chave definida pelo ambiente continua valendo: os recursos de IA não são afetados.</p>
        ) : (
          <p>
            Os recursos de IA que usam {label} (notas das vagas, análises e currículos adaptados) param de funcionar até outra chave ser gravada.
            {!selected && ` ${label} não é o provedor em uso agora.`}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
