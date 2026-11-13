import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ApplySiteId } from '@kv/shared/client';
import { applyApi, type ApplyAnswerInput, type PendingAnswersBody } from './applyApi';
import { applyPollMs } from './lib/apply';
import { useEffect, useRef } from 'react';
import type { ApplicationListItemDto, ApplyStatusDto } from '@kv/shared/client';
import { waitingText } from './lib/apply';

/** Chaves do React Query das telas de candidatura automática. */
export const APPLY_KEYS = {
  status: ['apply', 'status'] as const,
  applications: ['applications'] as const,
  job: (jobId: number) => ['application', jobId] as const,
  answers: ['apply', 'answers'] as const,
};

/** Mutação cujo erro a própria tela mostra junto do botão: o `MutationCache` (main.tsx) não abre o aviso flutuante. */
const INLINE_ERROR = { inlineError: true } as const;

/** Intervalo de releitura pelo estado em cache de `useApplyStatus`: rápido com candidatura ativa ou espera ao vivo. */
const pollFromStatus = (qc: QueryClient) => () => applyPollMs(qc.getQueryData(APPLY_KEYS.status));

/** Estado geral: sites, sessões, limites do dia, fila e espera ao vivo. */
export function useApplyStatus() {
  return useQuery({
    queryKey: APPLY_KEYS.status,
    queryFn: applyApi.status,
    refetchInterval: (query) => applyPollMs(query.state.data),
  });
}

export function useApplications() {
  const qc = useQueryClient();
  return useQuery({ queryKey: APPLY_KEYS.applications, queryFn: applyApi.applications, refetchInterval: pollFromStatus(qc) });
}

/** A candidatura de uma vaga; `null` quando não existe. */
export function useJobApplication(jobId: number) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: APPLY_KEYS.job(jobId),
    queryFn: () => applyApi.jobApplication(jobId),
    refetchInterval: pollFromStatus(qc),
  });
}

/** O banco de respostas (a primeira leitura cria as perguntas comuns). */
export function useApplyAnswers() {
  return useQuery({ queryKey: APPLY_KEYS.answers, queryFn: applyApi.answers });
}

/** Tudo que muda com uma ação de candidatura: o estado, as listas, a candidatura da vaga e as marcas do quadro. */
function useApplyRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: APPLY_KEYS.status });
    void qc.invalidateQueries({ queryKey: APPLY_KEYS.applications });
    void qc.invalidateQueries({ queryKey: ['application'] });
    void qc.invalidateQueries({ queryKey: ['jobs'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
  };
}

export function useApplyActions() {
  const qc = useQueryClient();
  const refresh = useApplyRefresh();
  const refreshAnswers = () => {
    void qc.invalidateQueries({ queryKey: APPLY_KEYS.answers });
    refresh();
  };
  const applyOpts = { meta: INLINE_ERROR, onSuccess: refresh } as const;
  return {
    apply: useMutation({ ...applyOpts, mutationFn: (jobId: number) => applyApi.apply(jobId) }),
    retry: useMutation({ ...applyOpts, mutationFn: (id: number) => applyApi.retry(id) }),
    cancel: useMutation({ ...applyOpts, mutationFn: (id: number) => applyApi.cancel(id) }),
    send: useMutation({ ...applyOpts, mutationFn: (id: number) => applyApi.send(id) }),
    sendAll: useMutation({ ...applyOpts, mutationFn: () => applyApi.sendAll() }),
    answer: useMutation({
      ...applyOpts,
      onSuccess: refreshAnswers,
      mutationFn: (v: { id: number; body: PendingAnswersBody }) => applyApi.answer(v.id, v.body),
    }),
    openLogin: useMutation({ ...applyOpts, mutationFn: (site: ApplySiteId) => applyApi.openLogin(site) }),
    checkSession: useMutation({ ...applyOpts, mutationFn: (site: ApplySiteId) => applyApi.checkSession(site) }),
    logout: useMutation({ ...applyOpts, mutationFn: (site: ApplySiteId) => applyApi.logout(site) }),
    resumeSite: useMutation({ ...applyOpts, mutationFn: (site: ApplySiteId) => applyApi.resumeSite(site) }),
    /** Sem `id`: cria; com `id`: troca a resposta. */
    saveAnswer: useMutation({
      meta: INLINE_ERROR,
      onSuccess: refreshAnswers,
      mutationFn: (v: { id?: number; input: ApplyAnswerInput }) =>
        v.id === undefined ? applyApi.createAnswer(v.input) : applyApi.updateAnswer(v.id, v.input),
    }),
    deleteAnswer: useMutation({ meta: INLINE_ERROR, onSuccess: refreshAnswers, mutationFn: (id: number) => applyApi.deleteAnswer(id) }),
    removeAlias: useMutation({
      meta: INLINE_ERROR,
      onSuccess: refreshAnswers,
      mutationFn: (v: { id: number; normalized: string }) => applyApi.removeAlias(v.id, v.normalized),
    }),
  };
}

/**
 * Uma notificação do navegador por espera ao vivo nova (captcha, código, login), se o dono já deu a permissão. A
 * permissão só é pedida por um botão na aba Candidaturas, nunca ao carregar a página.
 */
export function useLiveWaitNotification(waiting: ApplyStatusDto['waiting'] | undefined) {
  const qc = useQueryClient();
  const notified = useRef<string | null>(null);
  const key = waiting ? `${waiting.applicationId}:${waiting.gate}` : null;
  useEffect(() => {
    if (!waiting || key === null) {
      notified.current = null;
      return;
    }
    if (notified.current === key) return;
    notified.current = key;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const item = qc.getQueryData<ApplicationListItemDto[]>(APPLY_KEYS.applications)?.find((a) => a.id === waiting.applicationId);
    try {
      new Notification('Uma candidatura precisa de você', {
        body: `${waitingText(waiting.gate)}.${item ? ` Vaga: ${item.jobTitle} (${item.company}).` : ''}`,
        tag: `apply-wait-${key}`,
      });
    } catch {
      // navegador sem suporte a `new Notification` (ex.: só via service worker): o aviso da aba continua valendo
    }
  }, [key, waiting, qc]);
}
