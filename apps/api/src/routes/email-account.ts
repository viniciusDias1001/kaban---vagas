import type { FastifyInstance } from 'fastify';
import { baseProfile, deleteMailAccount, deleteMailData, getMailAccount, resolveAlerts, saveMailAccount, type Db } from '@kv/db';
import { MailAuthError, type Mailbox } from '@kv/mail';
import { SecretMissingError } from '@kv/settings';
import { DisconnectQuerySchema, MailAccountInputSchema, emailAvailability, type MailAccountDto } from '@kv/shared';
import type { AiContext } from '../ai-context';

/** Frase fixa de qualquer falha do teste que não seja login recusado: nada do que o servidor respondeu chega à tela. */
const UNREACHABLE = 'Não foi possível falar com o Gmail agora.';

/**
 * A caixa do dono: conectar (testa o login e guarda a senha de app cifrada), ver o estado e desconectar.
 *
 * A senha de app abre a caixa inteira: ela só existe no corpo do PUT e na chamada a `check()`. Nenhuma resposta a devolve,
 * nenhum erro a repete (as falhas do teste viram frases fixas) e nada aqui escreve o corpo da requisição no log.
 */
export function emailAccountRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  async function dto(): Promise<MailAccountDto> {
    const [row, profile] = await Promise.all([getMailAccount(db), baseProfile(db)]);
    const { available, reason } = emailAvailability(process.env);
    const secretProblem = ctx.settings.secretProblem();
    const address = row?.address ?? null;
    const profileEmail = profile?.data.contact?.email?.trim() || null;
    return {
      connected: row !== null,
      address,
      connectedAt: row?.connectedAt ?? null,
      lastReadAt: row?.lastReadAt ?? null,
      paused: row?.paused ?? false,
      error: row?.error ?? null,
      available,
      unavailableReason: reason,
      canStore: secretProblem === null,
      secretProblem,
      profileEmail,
      // As respostas das empresas chegam no endereço do perfil (o que vai nas candidaturas), não no conectado.
      differsFromProfile: address !== null && profileEmail !== null && address.toLowerCase() !== profileEmail.toLowerCase(),
    };
  }

  app.get('/email/account', dto);

  /** "Testar e conectar": confere o login na caixa e, só se ele passar, grava a senha cifrada e a conta. */
  app.put('/email/account', async (req, reply) => {
    const { available, reason } = emailAvailability(process.env);
    if (!available) return reply.code(409).send({ error: 'email_unavailable', message: reason });
    const secretProblem = ctx.settings.secretProblem();
    if (secretProblem) return reply.code(409).send({ error: 'no_app_secret', message: secretProblem });
    // Corpo inválido responde 400 antes do limite: um erro de digitação não gasta a vez do teste.
    const { address, password } = MailAccountInputSchema.parse(req.body);
    const decision = ctx.connectLimiter.take();
    if (!decision.ok) {
      const seconds = Math.ceil(decision.retryAfterMs / 1000);
      return reply
        .code(429)
        .header('retry-after', String(seconds))
        .send({ error: 'rate_limited', message: `Aguarde ${seconds} s para testar a conexão de novo.` });
    }

    const failure = await checkLogin(ctx.mailbox({ address, password }));
    if (failure) return reply.code(failure.status).send(failure.body);

    try {
      await ctx.settings.saveSecret('mail_password', password);
    } catch (e) {
      if (e instanceof SecretMissingError) return reply.code(409).send({ error: 'no_app_secret', message: e.message });
      throw e;
    }
    await saveMailAccount(db, address, ctx.now());
    // Login aceito: o aviso de "caixa com erro" (senha revogada, por exemplo) deixa de valer.
    await resolveAlerts(db, { kind: 'mailbox_error' }, ctx.now());
    return dto();
  });

  /** Apaga a credencial e a conta; com `messages=delete`, também as mensagens, respostas e alertas do e-mail. */
  app.delete('/email/account', async (req, reply) => {
    const { messages } = DisconnectQuerySchema.parse(req.query);
    await ctx.settings.deleteSecret('mail_password');
    await deleteMailAccount(db);
    if (messages === 'delete') await deleteMailData(db);
    return reply.code(204).send();
  });
}

type LoginFailure = { status: 422 | 502; body: { error: 'mail_auth' | 'mail_unreachable'; message: string } };

/**
 * Abre a sessão, confere o login e fecha a caixa, também quando falha. Login recusado: a mensagem fixa do `MailAuthError`
 * (em pt-BR, sem nada do servidor). Qualquer outra falha: uma frase fixa. Nenhuma das duas leva a senha.
 */
async function checkLogin(mailbox: Mailbox): Promise<LoginFailure | null> {
  try {
    await mailbox.check();
    return null;
  } catch (e) {
    if (e instanceof MailAuthError) return { status: 422, body: { error: 'mail_auth', message: e.message } };
    return { status: 502, body: { error: 'mail_unreachable', message: UNREACHABLE } };
  } finally {
    // Fechar uma sessão que nem abriu também pode falhar: isso não muda o resultado do teste.
    await mailbox.close().catch(() => undefined);
  }
}
