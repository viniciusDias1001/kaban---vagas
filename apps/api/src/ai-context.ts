import { applyDataDir, applySites, type ApplySite } from '@kv/apply';
import { createProvider, type AiConfig, type AiProvider } from '@kv/ai';
import type { Db } from '@kv/db';
import { findPhoneChatFor, mailboxFor, phoneNotifierFor, type Mailbox, type PhoneNotifier } from '@kv/mail';
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
  /** Pasta de dados da candidatura automática (fotos, perfil do navegador). Trocada nos testes. */
  dataDir: string;
  /** Abre a caixa do dono com as credenciais dadas. Produção: `mailboxFor` (Gmail, ou a falsa com `FAKE_MAIL=1`). Trocada nos testes. */
  mailbox: (creds: { address: string; password: string }) => Mailbox;
  /** Limite de frequência do "Testar e conectar" da caixa. */
  connectLimiter: RateLimiter;
  /** Monta o aviso no celular com o token e o chat dados. Produção: `phoneNotifierFor` (Telegram, ou o falso com `FAKE_MAIL=1`). Trocado nos testes. */
  phoneNotifier: (opts: { token: string; chatId: string }) => PhoneNotifier;
  /** "Achar meu chat": o chat privado mais recente do bot. Produção: `findPhoneChatFor` (com `FAKE_MAIL=1`, um id fixo, sem rede). Trocado nos testes. */
  findPhoneChat: (token: string) => Promise<string | null>;
  /** Limite de frequência do "Achar meu chat" e do "Enviar teste" (juntos). */
  phoneLimiter: RateLimiter;
  /** Sites de candidatura registrados (com `FAKE_APPLY_SITE=1`, só o de teste). Trocados nos testes. */
  sites: ApplySite[];
  now: () => number;
}

export interface AiContextOptions extends Partial<AiContext> {
  /** Ambiente lido pelo serviço de configurações (padrão: o do processo). Trocado nos testes. */
  env?: Record<string, string | undefined>;
}

export function createAiContext(db: Db, over: AiContextOptions = {}): AiContext {
  const now = over.now ?? Date.now;
  const dataDir = over.dataDir ?? applyDataDir();
  return {
    settings: over.settings ?? createSettingsService(db, { env: over.env, now }),
    extractResume: over.extractResume ?? ((buf, kind) => extractInWorker(buf, kind)),
    renderPdf: over.renderPdf ?? renderResumePdf,
    createProvider: over.createProvider ?? createProvider,
    // No máximo um teste a cada 10 s e cinco a cada 10 min: o botão não vira amplificador de gasto.
    testLimiter: over.testLimiter ?? createRateLimiter({ minIntervalMs: 10_000, max: 5, windowMs: 10 * 60_000, now }),
    // Cada teste de login abre uma sessão no Gmail: o mesmo limite do "Testar conexão" (um a cada 10 s, cinco a cada 10 min).
    connectLimiter: over.connectLimiter ?? createRateLimiter({ minIntervalMs: 10_000, max: 5, windowMs: 10 * 60_000, now }),
    dataDir,
    mailbox: over.mailbox ?? ((creds) => mailboxFor(process.env, dataDir, creds)),
    phoneNotifier: over.phoneNotifier ?? ((opts) => phoneNotifierFor(process.env, dataDir, opts)),
    findPhoneChat: over.findPhoneChat ?? ((token) => findPhoneChatFor(process.env, token)),
    // Cada chamada vai ao Telegram: um a cada 5 s e dez a cada 10 min.
    phoneLimiter: over.phoneLimiter ?? createRateLimiter({ minIntervalMs: 5_000, max: 10, windowMs: 10 * 60_000, now }),
    sites: over.sites ?? applySites(),
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
