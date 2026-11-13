import type { FastifyInstance } from 'fastify';
import { baseProfile, deleteMailAccount, deleteMailData, getMailAccount, resolveAlerts, saveMailAccount, type Db } from '@kv/db';
import { MailAuthError, PhoneAlertError, type Mailbox } from '@kv/mail';
import { SecretMissingError } from '@kv/settings';
import { DisconnectQuerySchema, MailAccountInputSchema, PhoneTokenInputSchema, emailAvailability, type MailAccountDto } from '@kv/shared';
import type { AiContext } from '../ai-context';

/** Frase fixa de qualquer falha do teste que não seja login recusado: nada do que o servidor respondeu chega à tela. */
const UNREACHABLE = 'Não foi possível falar com o Gmail agora.';
/** Frase fixa de uma falha do Telegram que não é um `PhoneAlertError` (que já traz a sua frase fixa). */
const PHONE_UNREACHABLE = 'Não foi possível falar com o Telegram agora.';
const NO_CHAT = 'Mande uma mensagem para o seu bot no Telegram e tente de novo.';
const NO_TOKEN = 'Grave o token do bot antes.';
const NO_CHAT_YET = 'Aperte Achar meu chat antes de enviar o teste.';

/**
 * A caixa do dono: conectar (testa o login e guarda a senha de app cifrada), ver o estado e desconectar.
 *
 * A senha de app abre a caixa inteira: ela só existe no corpo do PUT e na chamada a `check()`. Nenhuma resposta a devolve,
 * nenhum erro a repete (as falhas do teste viram frases fixas) e nada aqui escreve o corpo da requisição no log.
 */
export function emailAccountRoutes(app: FastifyInstance, db: Db, ctx: AiContext) {
  async function dto(): Promise<MailAccountDto> {
    const [row, profile, phoneTokenSaved] = await Promise.all([getMailAccount(db), baseProfile(db), ctx.settings.hasSecret('telegram_bot_token')]);
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
      phoneTokenSaved,
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

  // --- Aviso no celular (Telegram). O token do bot só existe no corpo do PUT, no cofre e dentro do notificador: nenhuma
  // resposta o devolve, e as falhas do Telegram viram frases fixas (a URL de toda chamada leva o token).

  /** Fora de host local ou sem APP_SECRET: a resposta 409; senão null. */
  function phoneBlocked(): { error: string; message: string | null } | null {
    const { available, reason } = emailAvailability(process.env);
    if (!available) return { error: 'email_unavailable', message: reason };
    const secretProblem = ctx.settings.secretProblem();
    if (secretProblem) return { error: 'no_app_secret', message: secretProblem };
    return null;
  }

  /** O token gravado; não gravado ou ilegível (APP_SECRET mudou), a resposta 409 com a causa. */
  async function phoneToken(): Promise<{ token: string } | { error: 'no_phone_token'; message: string }> {
    const secret = await ctx.settings.readSecret('telegram_bot_token');
    if (secret.value !== null) return { token: secret.value };
    return { error: 'no_phone_token', message: secret.code === 'none' ? NO_TOKEN : secret.problem };
  }

  /** A vez do limite do Telegram; sem ela, a resposta 429. */
  function phoneRateLimited(): { seconds: number } | null {
    const decision = ctx.phoneLimiter.take();
    return decision.ok ? null : { seconds: Math.ceil(decision.retryAfterMs / 1000) };
  }

  /** Falha do Telegram: a frase fixa do `PhoneAlertError`, ou uma frase fixa para qualquer outra coisa. Nada do erro original. */
  const phoneFailure = (e: unknown) => ({ error: 'phone_failed', message: e instanceof PhoneAlertError ? e.message : PHONE_UNREACHABLE });

  /** Grava o token do bot, cifrado. Não fala com o Telegram: "Achar meu chat" e "Enviar teste" conferem o token. */
  app.put('/email/phone-token', async (req, reply) => {
    const blocked = phoneBlocked();
    if (blocked) return reply.code(409).send(blocked);
    const { token } = PhoneTokenInputSchema.parse(req.body);
    try {
      await ctx.settings.saveSecret('telegram_bot_token', token);
    } catch (e) {
      if (e instanceof SecretMissingError) return reply.code(409).send({ error: 'no_app_secret', message: e.message });
      throw e;
    }
    return dto();
  });

  /** Apagar o token só pede host local: sem APP_SECRET ele ainda pode ser apagado (é o jeito de largar um ilegível). */
  app.delete('/email/phone-token', async (_req, reply) => {
    const { available, reason } = emailAvailability(process.env);
    if (!available) return reply.code(409).send({ error: 'email_unavailable', message: reason });
    await ctx.settings.deleteSecret('telegram_bot_token');
    return reply.code(204).send();
  });

  /** "Achar meu chat": o chat privado da mensagem mais recente ao bot vira `telegramChatId`. */
  app.post('/email/phone-chat', async (_req, reply) => {
    const blocked = phoneBlocked();
    if (blocked) return reply.code(409).send(blocked);
    const saved = await phoneToken();
    if (!('token' in saved)) return reply.code(409).send(saved);
    const { token } = saved;
    const limited = phoneRateLimited();
    if (limited) {
      return reply.code(429).header('retry-after', String(limited.seconds))
        .send({ error: 'rate_limited', message: `Aguarde ${limited.seconds} s para tentar de novo.` });
    }
    let chatId: string | null;
    try {
      chatId = await ctx.findPhoneChat(token);
    } catch (e) {
      return reply.code(502).send(phoneFailure(e));
    }
    if (chatId === null) return reply.code(409).send({ error: 'no_chat', message: NO_CHAT });
    await ctx.settings.update({ telegramChatId: chatId });
    return { chatId };
  });

  /** "Enviar teste": manda o texto fixo de teste ao chat gravado. */
  app.post('/email/phone-test', async (_req, reply) => {
    const blocked = phoneBlocked();
    if (blocked) return reply.code(409).send(blocked);
    const saved = await phoneToken();
    if (!('token' in saved)) return reply.code(409).send(saved);
    const { token } = saved;
    const { chatId } = await ctx.settings.phoneAlertConfig();
    if (chatId === null) return reply.code(409).send({ error: 'no_phone_chat', message: NO_CHAT_YET });
    const limited = phoneRateLimited();
    if (limited) {
      return reply.code(429).header('retry-after', String(limited.seconds))
        .send({ error: 'rate_limited', message: `Aguarde ${limited.seconds} s para tentar de novo.` });
    }
    try {
      await ctx.phoneNotifier({ token, chatId }).sendTest();
    } catch (e) {
      return reply.code(502).send(phoneFailure(e));
    }
    return { ok: true };
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
