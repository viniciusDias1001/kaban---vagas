import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getConnectors } from '@kv/connectors';
import { jobs, type Db } from '@kv/db';
import type { SourceDto, StatsDto } from '@kv/shared';

/** count() no Postgres é bigint e chega como string: `::int` + mapWith(Number) garante number no JSON. */
const countWhere = (condition?: ReturnType<typeof sql>) =>
  (condition ? sql<number>`(count(*) filter (where ${condition}))::int` : sql<number>`count(*)::int`).mapWith(Number);

export function metaRoutes(app: FastifyInstance, db: Db) {
  app.get('/sources', (): SourceDto[] => getConnectors().map((c) => ({ id: c.id, name: c.name })));

  app.get('/stats', async (): Promise<StatsDto> => {
    const [row] = await db
      .select({
        total: countWhere(),
        appliedByAi: countWhere(sql`${jobs.appliedBy} = 'ia'`),
        appliedByHuman: countWhere(sql`${jobs.appliedBy} = 'humano'`),
        needsHuman: countWhere(sql`${jobs.needsHuman}`),
      })
      .from(jobs);
    return row;
  });
}
