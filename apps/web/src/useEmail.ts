import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import * as api from './emailApi';
import type { MailAccountInput, MailMessageFilter } from './emailApi';
import { JOBS_KEY } from './useMoveJob';

/** Chaves do React Query das telas de e-mail. */
export const EMAIL_KEYS = {
  account: ['email', 'account'],
  alerts: ['alerts'],
  ignored: ['email', 'ignored'],
  messages: (f: object) => ['email', 'messages', f],
  job: (id: number) => ['email', 'job', id],
} as const;

/** Prefixos usados só para invalidar: todas as listas de e-mails, e a conversa de todas as vagas. */
const MESSAGES_PREFIX = ['email', 'messages'] as const;
const JOB_EMAILS_PREFIX = ['email', 'job'] as const;

/** Mutação cujo erro a própria tela mostra junto do botão: o `MutationCache` (main.tsx) não abre o aviso flutuante. */
const INLINE_ERROR = { inlineError: true } as const;

/** O estado da caixa: conectada, pausada, com erro, e se a função está disponível neste computador. */
export function useMailAccount() {
  return useQuery({ queryKey: EMAIL_KEYS.account, queryFn: api.getMailAccount });
}

/**
 * Testa e conecta a caixa. A senha de app só existe nas variáveis desta mutação: `gcTime: 0` e o `reset()` ao terminar a
 * tiram do cache do React Query. Por isso o resultado (e o erro) vão para quem chama pela promessa de `mutateAsync`, não
 * por `error`/`data` do hook, que voltam ao zero ao terminar. No sucesso, a conta devolvida entra no cache da conta.
 */
export function useConnectMailbox() {
  const qc = useQueryClient();
  const reset = useRef<() => void>(() => undefined);
  const mutation = useMutation({
    gcTime: 0,
    meta: INLINE_ERROR,
    mutationFn: (input: MailAccountInput) => api.connectMailbox(input),
    onSuccess: (account) => {
      qc.setQueryData(EMAIL_KEYS.account, account);
      void qc.invalidateQueries({ queryKey: EMAIL_KEYS.alerts });
    },
    onSettled: () => reset.current(),
  });
  reset.current = mutation.reset;
  return mutation;
}

/** Desconecta: `keep` guarda os e-mails já lidos, `delete` os apaga junto com respostas e alertas. */
export function useDisconnectMailbox() {
  const qc = useQueryClient();
  return useMutation({
    meta: INLINE_ERROR,
    mutationFn: (messages: 'keep' | 'delete') => api.disconnectMailbox(messages),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: EMAIL_KEYS.account });
      void qc.invalidateQueries({ queryKey: EMAIL_KEYS.alerts });
      void qc.invalidateQueries({ queryKey: MESSAGES_PREFIX });
      void qc.invalidateQueries({ queryKey: JOB_EMAILS_PREFIX });
      void qc.invalidateQueries({ queryKey: EMAIL_KEYS.ignored });
      void qc.invalidateQueries({ queryKey: JOBS_KEY });
    },
  });
}

/** Os alertas abertos, relidos a cada 15 s (o sino). */
export function useAlerts() {
  return useQuery({
    queryKey: EMAIL_KEYS.alerts,
    queryFn: async () => (await api.listAlerts()).alerts,
    refetchInterval: 15_000,
  });
}

/** Os e-mails e as respostas de uma vaga. */
export function useJobEmails(jobId: number) {
  return useQuery({ queryKey: EMAIL_KEYS.job(jobId), queryFn: () => api.getJobEmails(jobId) });
}

/** Os e-mails que o filtro local descartou, guardados por 30 dias. */
export function useIgnoredMail() {
  return useQuery({ queryKey: EMAIL_KEYS.ignored, queryFn: api.listIgnored });
}

export function useMailMessages(filter: MailMessageFilter = {}) {
  return useQuery({ queryKey: EMAIL_KEYS.messages(filter), queryFn: () => api.listMailMessages(filter) });
}

/** Tudo que muda com uma ação sobre e-mails: os alertas, as conversas, o quadro (selos e coluna) e os números. */
function useEmailRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: EMAIL_KEYS.alerts });
    void qc.invalidateQueries({ queryKey: MESSAGES_PREFIX });
    void qc.invalidateQueries({ queryKey: JOB_EMAILS_PREFIX });
    void qc.invalidateQueries({ queryKey: JOBS_KEY });
    void qc.invalidateQueries({ queryKey: ['job'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
  };
}

/** Editar, aprovar e descartar uma resposta; cada uma devolve a resposta como ficou. */
export function useReplyActions() {
  const refresh = useEmailRefresh();
  const opts = { meta: INLINE_ERROR, onSuccess: refresh } as const;
  return {
    edit: useMutation({ ...opts, mutationFn: (v: { id: number; body: string }) => api.editReply(v.id, v.body) }),
    approve: useMutation({ ...opts, mutationFn: (id: number) => api.approveReply(id) }),
    discard: useMutation({ ...opts, mutationFn: (id: number) => api.discardReply(id) }),
  };
}

/** Dispensar, responder a um "mover?", reler depois de salvar o dado que faltava e classificar mesmo assim. */
export function useAlertActions() {
  const refresh = useEmailRefresh();
  const opts = { meta: INLINE_ERROR, onSuccess: refresh } as const;
  return {
    dismiss: useMutation({ ...opts, mutationFn: (id: number) => api.dismissAlert(id) }),
    move: useMutation({ ...opts, mutationFn: (v: { id: number; accept: boolean }) => api.answerMoveAlert(v.id, v.accept) }),
    retry: useMutation({ ...opts, mutationFn: (id: number) => api.retryAlert(id) }),
    classifyAnyway: useMutation({ ...opts, mutationFn: (id: number) => api.classifyAnyway(id) }),
  };
}

/** Ligar um e-mail a uma vaga, desligar, desfazer o movimento do card e promover um e-mail ignorado. */
export function useMessageActions() {
  const qc = useQueryClient();
  const refresh = useEmailRefresh();
  const opts = { meta: INLINE_ERROR, onSuccess: refresh } as const;
  return {
    link: useMutation({ ...opts, mutationFn: (v: { id: number; jobId: number }) => api.linkMessage(v.id, v.jobId) }),
    unlink: useMutation({ ...opts, mutationFn: (id: number) => api.unlinkMessage(id) }),
    undo: useMutation({ ...opts, mutationFn: (id: number) => api.undoMailMove(id) }),
    promote: useMutation({
      meta: INLINE_ERROR,
      mutationFn: (id: number) => api.promoteIgnored(id),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: EMAIL_KEYS.ignored });
        refresh();
      },
    }),
  };
}
