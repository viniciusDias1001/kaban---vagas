import cors from '@fastify/cors';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import type { Db } from '@kv/db';
import { jobRoutes } from './routes/jobs';
import { metaRoutes } from './routes/meta';
import { profileRoutes } from './routes/profiles';
import { runRoutes } from './routes/runs';

export function buildApp(db: Db) {
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

  profileRoutes(app, db);
  jobRoutes(app, db);
  runRoutes(app, db);
  metaRoutes(app, db);
  return app;
}
