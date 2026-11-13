import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appliedJobFacts, applyBlockers, mailFacts, usageByLayer, type Db } from '@kv/db';
import { DASHBOARD_PERIODS, DEFAULT_DASHBOARD_PERIOD, periodSince, type DashboardDto } from '@kv/shared';
import type { AiContext } from '../ai-context';
import { buildDashboard } from '../dashboard-metrics';

const QuerySchema = z.object({ period: z.enum(DASHBOARD_PERIODS).default(DEFAULT_DASHBOARD_PERIOD) });

export function dashboardRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  /** Os números do Painel, calculados na hora a partir do que o app já grava. Só leitura. */
  app.get('/dashboard', async (req): Promise<DashboardDto> => {
    const { period } = QuerySchema.parse(req.query);
    const since = periodSince(period, ctx.now());
    const [facts, blockers, mail, usage] = await Promise.all([
      appliedJobFacts(db, since), applyBlockers(db, since), mailFacts(db, since), usageByLayer(db, since ?? 0),
    ]);
    return buildDashboard({ period, since, facts, blockers, mail, usage });
  });
}
