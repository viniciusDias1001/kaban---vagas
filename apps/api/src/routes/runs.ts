import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getConnectors } from '@kv/connectors';
import { enqueueRuns, runs, searchProfiles, type Db } from '@kv/db';
import { RunRequestSchema, type HealthDto } from '@kv/shared';

export function runRoutes(app: FastifyInstance, db: Db) {
  app.post('/runs', (req, reply) => {
    const { profileId } = RunRequestSchema.parse(req.body);
    const profile = db.select().from(searchProfiles).where(eq(searchProfiles.id, profileId)).get();
    if (!profile) return reply.code(404).send({ error: 'not_found', message: 'perfil não encontrado' });
    return reply.code(202).send({ queued: enqueueRuns(db, profile, 'manual') });
  });

  app.get('/runs/health', (): HealthDto => {
    const finished = db
      .select()
      .from(runs)
      .where(inArray(runs.status, ['ok', 'error']))
      .orderBy(desc(runs.id))
      .limit(500)
      .all();
    const latest = new Map<string, (typeof finished)[number]>();
    for (const r of finished) if (!latest.has(r.source)) latest.set(r.source, r);
    return {
      sources: getConnectors().map((c) => {
        const r = latest.get(c.id);
        return {
          source: c.id,
          name: c.name,
          status: r ? (r.status as 'ok' | 'error') : 'never',
          found: r?.found ?? 0,
          inserted: r?.inserted ?? 0,
          error: r?.error ?? null,
          finishedAt: r?.finishedAt ?? null,
        };
      }),
      lastFinishedAt: finished[0]?.finishedAt ?? null,
    };
  });
}
