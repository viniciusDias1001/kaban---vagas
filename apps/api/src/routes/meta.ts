import type { FastifyInstance } from 'fastify';
import { getConnectors } from '@kv/connectors';
import { jobs, type Db } from '@kv/db';
import type { SourceDto, StatsDto } from '@kv/shared';

export function metaRoutes(app: FastifyInstance, db: Db) {
  app.get('/sources', (): SourceDto[] => getConnectors().map((c) => ({ id: c.id, name: c.name })));

  app.get('/stats', (): StatsDto => {
    const rows = db.select({ appliedBy: jobs.appliedBy, needsHuman: jobs.needsHuman }).from(jobs).all();
    return {
      total: rows.length,
      appliedByAi: rows.filter((r) => r.appliedBy === 'ia').length,
      appliedByHuman: rows.filter((r) => r.appliedBy === 'humano').length,
      needsHuman: rows.filter((r) => r.needsHuman).length,
    };
  });
}
