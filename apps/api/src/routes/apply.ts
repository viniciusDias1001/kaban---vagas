import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { dayStartMs } from '@kv/ai';
import { withinWindow } from '@kv/apply';
import {
  applicationQueueCounts, applyCountsSince, deleteApplyAnswer, enqueueApplyCommand, ensureSeedAnswers, listApplyAnswers,
  removeAlias, saveApplyAnswer, siteState, toApplyAnswerDto, updateSiteState, waitingApplication, type ApplyCommandKind, type Db,
} from '@kv/db';
import {
  APPLY_SITE_IDS, APPLY_SITE_LABELS, ApplyAnswerInputSchema, applyAvailability, type ApplyAnswerDto, type ApplySiteId,
  type ApplySiteStateDto, type ApplyStatusDto,
} from '@kv/shared';
import type { AiContext } from '../ai-context';
import { idParam } from './ids';

const unavailable = (reason: string | null) => ({ error: 'apply_unavailable', message: reason ?? 'a candidatura automática não está disponível' });
const answerNotFound = { error: 'not_found', message: 'resposta não encontrada' };

/** Status, contas dos sites e banco de respostas da candidatura automática. Nenhuma rota chama modelo de IA. */
export function applyRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  app.get('/apply/status', async () => {
    const availability = applyAvailability(process.env);
    const cfg = await ctx.settings.applyConfig();
    const now = ctx.now();
    const counts = await applyCountsSince(db, dayStartMs(now, cfg.timeZone));
    const sites: ApplySiteStateDto[] = [];
    for (const site of ctx.sites) {
      const state = await siteState(db, site.id);
      const isLinkedin = site.id === 'linkedin';
      sites.push({
        site: site.id, label: APPLY_SITE_LABELS[site.id], needsLogin: site.needsLogin, mode: cfg.siteModes[site.id],
        session: state.session, sessionCheckedAt: state.sessionCheckedAt, paused: state.paused, pauseReason: state.pauseReason,
        formsToday: counts.forms[site.id], formsCap: cfg.dailyCaps[site.id],
        viewsToday: isLinkedin ? counts.views.linkedin : null, viewsCap: isLinkedin ? cfg.dailyCaps.linkedinViews : null,
      });
    }
    const queue = await applicationQueueCounts(db);
    const body: ApplyStatusDto = {
      available: availability.available, unavailableReason: availability.reason, enabled: cfg.enabled,
      withinWindow: withinWindow(now, cfg.window, cfg.timeZone), sites, totalToday: counts.total, totalCap: cfg.dailyCaps.total,
      queued: queue.queued, needsHuman: queue.needsHuman, running: queue.running, waiting: await waitingApplication(db),
    };
    return body;
  });

  /** Pedidos ao worker (ele é quem tem o navegador): a API só enfileira, uma linha igual pendente não se repete. */
  function sessionCommand(path: string, method: 'POST' | 'DELETE', kind: ApplyCommandKind) {
    app.route({
      method, url: path,
      handler: async (req, reply) => {
        const availability = applyAvailability(process.env);
        if (!availability.available) return reply.code(409).send(unavailable(availability.reason));
        const site = ctx.sites.find((s) => s.id === (req.params as { site: string }).site);
        if (!site) return reply.code(404).send({ error: 'not_found', message: 'site desconhecido' });
        if (!site.needsLogin) return reply.code(400).send({ error: 'no_login', message: 'este site não pede login' });
        await enqueueApplyCommand(db, kind, site.id, ctx.now());
        return reply.code(202).send({ queued: true });
      },
    });
  }
  sessionCommand('/apply/sessions/:site/open', 'POST', 'open_login');
  sessionCommand('/apply/sessions/:site/check', 'POST', 'check_session');
  sessionCommand('/apply/sessions/:site', 'DELETE', 'logout');

  /** Tira a pausa do site e zera as sequências que a causaram. */
  app.post('/apply/sites/:site/resume', async (req, reply) => {
    const site = (req.params as { site: string }).site as ApplySiteId;
    if (!APPLY_SITE_IDS.includes(site)) return reply.code(404).send({ error: 'not_found', message: 'site desconhecido' });
    await updateSiteState(db, site, {
      paused: false, pauseReason: null, pausedAt: null, consecutiveFailures: 0, consecutiveRejections: 0, humanTimeouts: 0,
    });
    return reply.code(204).send();
  });

  app.get('/apply/answers', async () => {
    await ensureSeedAnswers(db, ctx.now());
    const body: ApplyAnswerDto[] = (await listApplyAnswers(db)).map(toApplyAnswerDto);
    return body;
  });

  const saveAnswer = async (req: FastifyRequest, reply: FastifyReply, id?: number) => {
    const input = ApplyAnswerInputSchema.parse(req.body);
    if (input.scope !== 'always' && !input.scopeValue?.trim()) {
      return reply.code(400).send({ error: 'validation', message: 'scopeValue: informe a empresa ou a vaga a que a resposta se aplica' });
    }
    if (id !== undefined && !(await listApplyAnswers(db)).some((a) => a.id === id)) return reply.code(404).send(answerNotFound);
    const row = await saveApplyAnswer(db, { ...input, id, scopeValue: input.scopeValue?.trim() || null }, ctx.now());
    return toApplyAnswerDto(row);
  };
  app.post('/apply/answers', async (req, reply) => saveAnswer(req, reply));
  app.put('/apply/answers/:id', async (req, reply) => {
    const id = idParam(req);
    if (id === null) return reply.code(404).send(answerNotFound);
    return saveAnswer(req, reply, id);
  });

  app.delete('/apply/answers/:id', async (req, reply) => {
    const id = idParam(req);
    if (id === null || !(await deleteApplyAnswer(db, id))) return reply.code(404).send(answerNotFound);
    return reply.code(204).send();
  });
  app.delete('/apply/answers/:id/aliases/:normalized', async (req, reply) => {
    const id = idParam(req);
    if (id === null) return reply.code(404).send(answerNotFound);
    await removeAlias(db, id, (req.params as { normalized: string }).normalized, ctx.now());
    return reply.code(204).send();
  });
}
