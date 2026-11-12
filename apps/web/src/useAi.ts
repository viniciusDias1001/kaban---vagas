import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import type { AiProviderId, ProfileWire, ResumeLang, SettingsPatch, TailoredDraft } from '@kv/shared/client';
import { aiApi } from './aiApi';
import { pollMs, toScoreMap } from './lib/ai';

/** Chaves do React Query das telas de IA. */
export const AI_KEYS = {
  status: ['ai', 'status'] as const,
  usage: ['ai', 'usage'] as const,
  profile: ['ai', 'profile'] as const,
  /** Notas de todas as vagas (GET /jobs/ai); o quadro junta com a consulta ['jobs'] pelo id. */
  scores: ['jobs-ai'] as const,
  job: (jobId: number) => ['job-ai', jobId] as const,
  tailored: (jobId: number) => ['tailored', jobId] as const,
  settings: ['settings'] as const,
};

const PENDING_TASK = new Set(['queued', 'running']);
/** Mutação cujo erro a própria tela mostra junto do campo: o `MutationCache` (main.tsx) não abre o aviso flutuante. */
const INLINE_ERROR = { inlineError: true } as const;

/** Provedor, modelos e orçamento do dia. Toda área de IA consulta isto para saber se mostra o aviso de configuração. */
export function useAiStatus() {
  return useQuery({ queryKey: AI_KEYS.status, queryFn: aiApi.status, refetchInterval: 30_000 });
}

export function useAiUsage() {
  return useQuery({ queryKey: AI_KEYS.usage, queryFn: aiApi.usage, refetchInterval: 30_000 });
}

/** Currículos, perfis e a tarefa de perfil mais recente de cada idioma. Atualiza a cada 2 s enquanto há tarefa pendente. */
export function useProfileOverview() {
  return useQuery({
    queryKey: AI_KEYS.profile,
    queryFn: aiApi.profile,
    refetchInterval: (query) => (query.state.data?.tasks.some((t) => PENDING_TASK.has(t.status)) ? 2_000 : false),
  });
}

export function useUploadResume() {
  const qc = useQueryClient();
  return useMutation({
    // O erro (arquivo ilegível, currículo longo demais...) aparece no próprio cartão do idioma.
    meta: INLINE_ERROR,
    mutationFn: (v: { lang: ResumeLang; file: File }) => aiApi.uploadResume(v.lang, v.file),
    onSuccess: () => qc.invalidateQueries({ queryKey: AI_KEYS.profile }),
  });
}

/** Salvar o perfil muda a versão: notas, análises e currículos adaptados passam a "desatualizado". */
export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    // O 409 (o perfil mudou no servidor) é tratado pelo próprio editor, que mostra as opções; sem aviso flutuante.
    meta: INLINE_ERROR,
    mutationFn: (v: { lang: ResumeLang; data: ProfileWire; version: number }) => aiApi.saveProfile(v.lang, v.data, v.version),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AI_KEYS.profile });
      void qc.invalidateQueries({ queryKey: AI_KEYS.scores });
      void qc.invalidateQueries({ queryKey: ['job-ai'] });
      void qc.invalidateQueries({ queryKey: ['tailored'] });
    },
  });
}

/** Depois de apagar dados pessoais, tudo o que as telas de IA mostram precisa ser relido. */
function useAiDataRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: AI_KEYS.profile });
    void qc.invalidateQueries({ queryKey: AI_KEYS.scores });
    void qc.invalidateQueries({ queryKey: ['job-ai'] });
    void qc.invalidateQueries({ queryKey: ['tailored'] });
  };
}

/** Apaga o currículo, o perfil e os currículos adaptados de um idioma. */
export function useDeleteResume() {
  const refresh = useAiDataRefresh();
  return useMutation({ mutationFn: (lang: ResumeLang) => aiApi.deleteResume(lang), onSuccess: refresh });
}

/** "Apagar todos os dados de IA". */
export function useDeleteAiData() {
  const refresh = useAiDataRefresh();
  return useMutation({ mutationFn: () => aiApi.deleteAiData(), onSuccess: refresh });
}

export function useTranslateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lang: ResumeLang) => aiApi.translateProfile(lang),
    onSuccess: () => qc.invalidateQueries({ queryKey: AI_KEYS.profile }),
  });
}

/** Aceita gastar acima do limite do dia em uma tarefa bloqueada. */
export function useConfirmTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: number) => aiApi.confirmTask(taskId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: AI_KEYS.profile });
      void qc.invalidateQueries({ queryKey: ['job-ai'] });
      void qc.invalidateQueries({ queryKey: ['tailored'] });
      void qc.invalidateQueries({ queryKey: AI_KEYS.status });
    },
  });
}

/** Tudo que a aba Configurações mostra (das chaves, só metadados). */
export function useSettings() {
  return useQuery({ queryKey: AI_KEYS.settings, queryFn: aiApi.settings });
}

/** Uma mudança de configuração muda o estado da IA em todas as telas: tudo que depende dele é relido. */
function useSettingsRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: AI_KEYS.settings });
    void qc.invalidateQueries({ queryKey: AI_KEYS.status });
    void qc.invalidateQueries({ queryKey: AI_KEYS.usage });
    void qc.invalidateQueries({ queryKey: AI_KEYS.scores });
  };
}

export function useSaveSettings() {
  const refresh = useSettingsRefresh();
  return useMutation({ mutationFn: (patch: SettingsPatch) => aiApi.saveSettings(patch), onSuccess: refresh });
}

/**
 * Grava a chave de um provedor. Quem chama limpa o campo no sucesso: a chave não fica em estado React.
 * `gcTime: 0`: as variáveis da mutação (que levam a chave) saem do cache do React Query assim que quem
 * chamou faz `reset()`, em vez de ficarem lá pelos 5 minutos padrão.
 */
export function useSaveApiKey() {
  const refresh = useSettingsRefresh();
  return useMutation({
    gcTime: 0,
    // O erro (chave vazia, gravação bloqueada...) aparece junto do campo da chave.
    meta: INLINE_ERROR,
    mutationFn: (v: { provider: AiProviderId; key: string }) => aiApi.saveApiKey(v.provider, v.key),
    onSuccess: refresh,
  });
}

export function useDeleteApiKey() {
  const refresh = useSettingsRefresh();
  return useMutation({ mutationFn: (provider: AiProviderId) => aiApi.deleteApiKey(provider), onSuccess: refresh });
}

/** "Testar conexão". O resultado (sucesso ou a classe do erro) vem em `data`; 429 e 409 vêm como erro. */
export function useTestConnection() {
  const refresh = useSettingsRefresh();
  return useMutation({ mutationFn: () => aiApi.testConnection(), onSuccess: refresh });
}

/** Mapa jobId → nota, para o quadro. `enabled` = IA configurada. Mesmo intervalo de atualização do quadro (15 s). */
export function useJobScores(enabled: boolean) {
  const query = useQuery({ queryKey: AI_KEYS.scores, queryFn: aiApi.jobScores, enabled, refetchInterval: 15_000 });
  const scores = useMemo(() => toScoreMap(query.data ?? []), [query.data]);
  return { ...query, scores };
}

/**
 * A seção "Análise IA" de uma vaga aberta. Com `auto` (a configuração "análise automática", que vem de
 * `useAiStatus().data.tier2Auto`), abrir a vaga pede a análise uma vez: a API só enfileira o que falta ou
 * está desatualizado, e NUNCA refaz sozinha uma camada que terminou em erro (isso é do botão "Tentar de novo").
 * Sem `auto`, nada é pedido sozinho; a tela oferece o botão de `useAnalyzeJob`.
 * Atualiza a cada 2 s enquanto há camada pendente.
 */
export function useJobAi(jobId: number, enabled: boolean, auto: boolean) {
  const qc = useQueryClient();
  const key = AI_KEYS.job(jobId);
  useEffect(() => {
    if (!enabled || !auto) return;
    let cancelled = false;
    aiApi
      .analyzeJob(jobId)
      .then(() => {
        if (!cancelled) void qc.invalidateQueries({ queryKey: key });
      })
      // Falha ao pedir a análise não é erro da tela: o estado mostrado vem do GET abaixo.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, enabled, auto]);
  return useQuery({
    queryKey: key,
    queryFn: () => aiApi.jobAi(jobId),
    enabled,
    refetchInterval: (query) => pollMs(query.state.data?.tier1.state, query.state.data?.tier2.state),
  });
}

/** Pedido explícito de análise: o botão "Analisar esta vaga" e o "Tentar de novo" (refaz também o que deu erro). */
export function useAnalyzeJob(jobId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => aiApi.analyzeJob(jobId, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: AI_KEYS.job(jobId) }),
  });
}

export function useTailored(jobId: number, enabled: boolean) {
  return useQuery({
    queryKey: AI_KEYS.tailored(jobId),
    queryFn: () => aiApi.tailored(jobId),
    enabled,
    refetchInterval: (query) => pollMs(query.state.data?.state),
  });
}

export function useRequestTailored(jobId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => aiApi.requestTailored(jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: AI_KEYS.tailored(jobId) }),
  });
}

export function useSaveTailored(jobId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (draft: TailoredDraft) => aiApi.saveTailored(jobId, draft),
    onSuccess: () => qc.invalidateQueries({ queryKey: AI_KEYS.tailored(jobId) }),
  });
}
