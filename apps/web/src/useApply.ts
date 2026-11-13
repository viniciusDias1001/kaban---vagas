import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { ApplicationDto, ApplicationFilter, ApplySiteId, ApplyStatusDto, JobApplicationDto } from '@kv/shared/client';
import { applyApi, type ApplyAnswerInput, type PendingAnswersBody } from './applyApi';
import {
  afterSend, applyPollMs, findListItem, queueSignature, waitNotice, waitingText, withApplication, type ApplicationListDto,
} from './lib/apply';
import { JOBS_KEY } from './useMoveJob';

/** Chaves do React Query das telas de candidatura automática. */
export const APPLY_KEYS = {
  status: ['apply', 'status'] as const,
  /** Prefixo de todas as listas da aba (uma por filtro). */
  applications: ['applications'] as const,
  list: (filter: ApplicationFilter) => ['applications', filter] as const,
  /** Prefixo da resposta de todas as vagas. */
  jobs: ['application'] as const,
  job: (jobId: number) => ['application', jobId] as const,
  answers: ['apply', 'answers'] as const,
};

/** Mutação cujo erro a própria tela mostra junto do botão: o `MutationCache` (main.tsx) não abre o aviso flutuante. */
const INLINE_ERROR = { inlineError: true } as const;

/** Intervalo de releitura pelo estado em cache de `useApplyStatus`: rápido com candidatura ativa ou espera ao vivo. */
const pollFromStatus = (qc: QueryClient) => () => applyPollMs(qc.getQueryData(APPLY_KEYS.status));

/** Estado geral: sites, sessões, limites do dia, fila, espera ao vivo e o que o worker publicou. */
export function useApplyStatus() {
  return useQuery({
    queryKey: APPLY_KEYS.status,
    queryFn: applyApi.status,
    refetchInterval: (q) => applyPollMs(q.state.data),
  });
}

/**
 * Um único observador (no `App`): quando as contagens da fila ou a espera mudam, relê na hora as listas, as candidaturas
 * das vagas e o quadro (os selos vêm da lista de vagas). Elas andam no ritmo do estado, e quando a fila para o ritmo cai
 * para 15 s (o contador "Precisam de você" já mostraria a pergunta e a lista ainda não).
 */
export function useApplyQueueRefresh() {
  const qc = useQueryClient();
  const signature = queueSignature(useApplyStatus().data);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (signature === null) return;
    const before = seen.current;
    seen.current = signature;
    if (before === null || before === signature) return;
    void qc.invalidateQueries({ queryKey: APPLY_KEYS.applications });
    void qc.invalidateQueries({ queryKey: APPLY_KEYS.jobs });
    void qc.invalidateQueries({ queryKey: JOBS_KEY, exact: true });
  }, [signature, qc]);
}

/**
 * As candidaturas de um filtro (as 200 mais novas) e as contagens de todos. Ao trocar de filtro, a resposta anterior
 * fica como marcador (`isPlaceholderData`): as contagens não piscam, e a tela mostra o esqueleto no lugar das linhas.
 */
export function useApplications(filter: ApplicationFilter, enabled = true) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: APPLY_KEYS.list(filter),
    queryFn: () => applyApi.applications(filter),
    refetchInterval: pollFromStatus(qc),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** A candidatura de uma vaga e se "Aplicar com IA" pode aparecer; `null` quando a vaga não existe mais. */
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
    void qc.invalidateQueries({ queryKey: APPLY_KEYS.jobs });
    void qc.invalidateQueries({ queryKey: JOBS_KEY });
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
    send: useMutation({
      ...applyOpts,
      mutationFn: (id: number) => applyApi.send(id),
      // O estado em cache ainda é "ensaio pronto" até a releitura: sem isto o botão voltaria a ligar nesse intervalo.
      onSuccess: (_, id) => {
        qc.setQueriesData<JobApplicationDto | null>(
          { queryKey: APPLY_KEYS.jobs },
          (old) => (old?.application && old.application.id === id ? withApplication(old, afterSend(old.application)) : old),
        );
        refresh();
      },
    }),
    sendAll: useMutation({ ...applyOpts, mutationFn: (ids: number[]) => applyApi.sendAll(ids) }),
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

/** Grava no cache da vaga a candidatura que uma ação devolveu (a resposta da API é a verdade). */
export function setJobApplication(qc: QueryClient, application: ApplicationDto) {
  qc.setQueryData<JobApplicationDto | null>(APPLY_KEYS.job(application.jobId), (old) => withApplication(old, application));
}

/**
 * Uma notificação do navegador por espera ao vivo nova (captcha, código, login), se o dono já deu a permissão. A
 * permissão só é pedida por um botão na aba Candidaturas, nunca ao carregar a página.
 */
export function useLiveWaitNotification(waiting: ApplyStatusDto['waiting'] | undefined) {
  const qc = useQueryClient();
  /** `undefined` até a primeira leitura do estado: uma espera que já existia ao abrir a página não avisa. */
  const seen = useRef<string | null | undefined>(undefined);
  const key = waiting ? `${waiting.applicationId}:${waiting.gate}` : null;
  useEffect(() => {
    if (waiting === undefined) return; // o estado ainda não chegou: não é "sem espera"
    const next = waitNotice(seen.current, key);
    seen.current = next.seen;
    if (!next.notify || !waiting) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const lists = qc.getQueriesData<ApplicationListDto>({ queryKey: APPLY_KEYS.applications }).map(([, data]) => data);
    const item = findListItem(lists, waiting.applicationId);
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
