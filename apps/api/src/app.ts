import { resolve } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Db } from '@kv/db';
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
}

const API_PREFIX = '/api';
/** Arquivos com hash no nome (gerados pelo Vite em /assets) nunca mudam de conteúdo. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

const pathOf = (url: string) => url.split('?', 1)[0];
const isApiPath = (path: string) => path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
/** "/perfis" é uma página do SPA; "/favicon.ico" ou "/assets/x.js" é um arquivo que não existe. */
const looksLikeFile = (path: string) => path.slice(path.lastIndexOf('/') + 1).includes('.');

export function buildApp(db: Db, opts: AppOptions = {}) {
  const app = Fastify();
  app.register(cors, { origin: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: 'validation', message });
    }
    const e = err as { statusCode?: number; message?: string };
    return reply.code(e.statusCode ?? 500).send({ error: 'internal', message: e.message ?? String(err) });
  });

  // As mesmas rotas na raiz (proxy do Vite em dev, que remove o /api) e sob /api (web buildado servido
  // pela própria API, sem proxy).
  const routes = async (scope: FastifyInstance) => {
    profileRoutes(scope, db);
    jobRoutes(scope, db);
    runRoutes(scope, db);
    metaRoutes(scope, db);
  };
  app.register(routes);
  app.register(routes, { prefix: API_PREFIX });

  const webDist = opts.webDist ? resolve(opts.webDist) : undefined;
  if (webDist) {
    app.register(fastifyStatic, {
      root: webDist,
      cacheControl: false,
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
