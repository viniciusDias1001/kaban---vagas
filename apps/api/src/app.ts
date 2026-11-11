import { resolve } from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Db } from '@kv/db';
import { LIMITS } from '@kv/shared';
import { createAiContext, type AiContextOptions } from './ai-context';
import { aiRoutes } from './routes/ai';
import { jobRoutes } from './routes/jobs';
import { metaRoutes } from './routes/meta';
import { profileRoutes } from './routes/profiles';
import { runRoutes } from './routes/runs';

export interface AppOptions {
  /**
   * Diretório do web buildado (`apps/web/dist`). Quando informado, a API também serve o web: arquivos
   * estáticos e `index.html` para as demais URLs de página. Sem ele (dev e testes) só existem as rotas da API.
   */
  webDist?: string;
  /** Serviço de configurações, ambiente e extrator de currículo. Padrão: os do processo. Trocado nos testes. */
  ai?: AiContextOptions;
}

const API_PREFIX = '/api';
/** Arquivos com hash no nome (gerados pelo Vite em /assets) nunca mudam de conteúdo. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Política das páginas HTML. O web é um build do Vite: scripts, estilos, fontes e imagens vêm da própria
 * origem (imagens também de `data:`), e as chamadas vão só para a própria API. `style-src 'unsafe-inline'`
 * é necessário porque o Motion e o dnd-kit posicionam elementos com atributos `style`. `frame-ancestors
 * 'none'` impede que outra página embuta o quadro (clickjacking).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const pathOf = (url: string) => url.split('?', 1)[0];
const isApiPath = (path: string) => path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
/** "/perfis" é uma página do SPA; "/favicon.ico" ou "/assets/x.js" é um arquivo que não existe. */
const looksLikeFile = (path: string) => path.slice(path.lastIndexOf('/') + 1).includes('.');

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Verdadeiro se o cabeçalho `Origin` aponta para o mesmo host (nome e porta) do cabeçalho `Host`, ou
 * seja, se a página que fez a requisição foi servida pelo mesmo endereço que a está recebendo.
 */
export function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false; // "null" (iframe em sandbox, file://) ou lixo
  }
}

/** A causa original de um erro: o Drizzle embrulha o erro do driver em `cause`. */
function rootCause(err: unknown): unknown {
  const cause = (err as { cause?: unknown } | null)?.cause;
  return cause instanceof Error ? cause : err;
}

export function buildApp(db: Db, opts: AppOptions = {}) {
  const app = Fastify();
  const ctx = createAiContext(db, opts.ai);

  // Upload de currículo. Só multipart/form-data passa por aqui: um arquivo, até LIMITS.resumeBytes (acima
  // disso, 413). O limite de 1 MiB do corpo JSON (padrão do Fastify) continua valendo para o resto.
  app.register(multipart, { limits: { fileSize: LIMITS.resumeBytes, files: 1, fields: 0, parts: 1 } });

  // Sem CORS: o web é sempre servido pela mesma origem da API (proxy do Vite em dev, a própria API em
  // produção), então nenhuma outra página precisa ler as respostas. Além disso, como a API não tem
  // login, requisições que alteram dados vindas de OUTRA origem são recusadas: um site qualquer aberto no
  // navegador não consegue criar perfis nem mexer nas vagas com um <form> ou um fetch "no-cors". Quem não
  // manda `Origin` (curl, scripts) passa.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!STATE_CHANGING.has(req.method) || origin === undefined) return;
    if (!isSameOrigin(origin, req.headers.host)) {
      return reply.code(403).send({ error: 'forbidden', message: 'requisição de outra origem recusada' });
    }
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: 'validation', message });
    }
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    // Erros 4xx do próprio Fastify: JSON malformado, corpo grande demais, content-type não suportado.
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({ error: 'bad_request', message: message ?? 'requisição inválida' });
    }
    // Qualquer outra coisa é falha nossa (ou do banco). O detalhe vai para o log do servidor, nunca para a
    // resposta: a mensagem do Drizzle traz o SQL e os parâmetros. No log vai a causa original (o erro do
    // driver), que não repete os parâmetros, e nunca o corpo da requisição.
    const cause = rootCause(err);
    console.error(`[api] erro em ${req.method} ${req.url}: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
    return reply.code(500).send({ error: 'internal', message: 'erro interno' });
  });

  // As mesmas rotas na raiz (proxy do Vite em dev, que remove o /api) e sob /api (web buildado servido
  // pela própria API, sem proxy).
  const routes = async (scope: FastifyInstance) => {
    profileRoutes(scope, db);
    jobRoutes(scope, db);
    runRoutes(scope, db);
    metaRoutes(scope, db);
    aiRoutes(scope, db, ctx);
  };
  app.register(routes);
  app.register(routes, { prefix: API_PREFIX });

  const webDist = opts.webDist ? resolve(opts.webDist) : undefined;
  if (webDist) {
    app.register(fastifyStatic, {
      root: webDist,
      cacheControl: false,
      // Arquivos e pastas começados por ponto (.env, .git, .vite) nunca são servidos: respondem 404.
      dotfiles: 'ignore',
      setHeaders: (res, filePath) => {
        const hashed = filePath.replaceAll('\\', '/').startsWith(`${webDist.replaceAll('\\', '/')}/assets/`);
        res.header('cache-control', hashed ? IMMUTABLE : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const path = pathOf(req.url);
    const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && !isApiPath(path) && !looksLikeFile(path);
    if (webDist && wantsPage) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'not_found', message: `rota não encontrada: ${req.method} ${path}` });
  });

  return app;
}
