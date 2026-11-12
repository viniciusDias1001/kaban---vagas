import { createProvider, type AiConfig, type AiProvider } from '@kv/ai';
import type { Db } from '@kv/db';
import type { TailoredResume } from '@kv/shared';
import { extractInWorker, renderResumePdf, type ExtractResult, type ResumeKind } from '@kv/resume';
import { createSettingsService, type SettingsService } from '@kv/settings';
import { createRateLimiter, type RateLimiter } from './rate-limit';

/** O que as rotas de IA e de configurações precisam além do banco. Tudo injetável, para os testes. */
export interface AiContext {
  /**
   * Provedor, modelos, orçamento, chave e listas de empresas: tela > ambiente > padrão, com cache curto.
   * As rotas perguntam a cada requisição, então uma mudança na aba Configurações vale sem reiniciar nada.
   */
  settings: SettingsService;
  /** Extrai o texto do currículo. Produção: worker thread com teto de tempo e memória. */
  extractResume: (buf: Uint8Array, kind: ResumeKind) => Promise<ExtractResult>;
  /** Gera o PDF do currículo adaptado. Trocado nos testes; as rotas sempre o chamam uma vez por vez. */
  renderPdf: (resume: TailoredResume) => Promise<Buffer>;
  /** Monta o provedor para o "Testar conexão". Trocado nos testes. */
  createProvider: (config: AiConfig) => AiProvider;
  /** Limite de frequência do "Testar conexão". */
  testLimiter: RateLimiter;
  now: () => number;
}

export interface AiContextOptions extends Partial<AiContext> {
  /** Ambiente lido pelo serviço de configurações (padrão: o do processo). Trocado nos testes. */
  env?: Record<string, string | undefined>;
}

export function createAiContext(db: Db, over: AiContextOptions = {}): AiContext {
  const now = over.now ?? Date.now;
  return {
    settings: over.settings ?? createSettingsService(db, { env: over.env, now }),
    extractResume: over.extractResume ?? ((buf, kind) => extractInWorker(buf, kind)),
    renderPdf: over.renderPdf ?? renderResumePdf,
    createProvider: over.createProvider ?? createProvider,
    // No máximo um teste a cada 10 s e cinco a cada 10 min: o botão não vira amplificador de gasto.
    testLimiter: over.testLimiter ?? createRateLimiter({ minIntervalMs: 10_000, max: 5, windowMs: 10 * 60_000, now }),
    now,
  };
}

/** Resposta padrão (409) das rotas que precisam do provedor. `problem` vem de `settings.status()`. */
export function notConfigured(problem: string | null) {
  return {
    error: 'ai_not_configured',
    message: `IA não configurada. ${problem ?? ''} Abra a aba Configurações.`.replace(/\s+/g, ' ').trim(),
  };
}
