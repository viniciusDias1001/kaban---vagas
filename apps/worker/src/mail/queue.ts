/**
 * A fila de e-mail do worker: decide quando a caixa é lida e em que ordem as unidades de trabalho rodam. As garantias são
 * das unidades (`ingest`, `classify`, `act`, `send`); a fila só não deixa duas rodarem juntas, abre a caixa só para quem
 * precisa dela e sempre a fecha.
 */
import { getMailAccount, nextApprovedReply, nextPromoted, repliesInSending, type Db } from '@kv/db';
import type { Mailbox } from '@kv/mail';
import type { SettingsService } from '@kv/settings';
import { MAIL_LIMITS } from '@kv/shared';
import { finishBackfill, actOnNext } from './act';
import type { MailAi } from './ai-calls';
import { classifyNext, type MailWorkDeps } from './classify';
import { ingestInbox, promoteNext } from './ingest';
import { recoverSending, sendNext, type SendDeps } from './send';

export interface MailQueueDeps {
  db: Db; settings: SettingsService; ai: MailAi; now?: () => number; log?: (msg: string) => void;
  /** A caixa para as credenciais atuais, ou null sem caixa conectada ou sem credencial legível. Uma por unidade de trabalho; a fila a fecha. */
  openMailbox: () => Promise<Mailbox | null>;
  availability: () => { available: boolean; reason: string | null };
  resume: SendDeps['resume'];
  pollMs?: number; // padrão MAIL_LIMITS.pollMs
  /** Depois de cada unidade de trabalho que criou alertas (Task 22). */
  afterWork?: () => Promise<void>;
}

export interface MailQueue {
  /**
   * Uma verificação: no máximo uma leitura e uma unidade de trabalho, sem esperar por elas. `read`: começou uma rodada com
   * leitura da caixa, que depois segue para a próxima unidade de trabalho; `worked`: começou uma rodada sem leitura, só a
   * procura da próxima unidade (promover, classificar, agir, fechar a primeira leitura, enviar). Nada começa com uma
   * rodada ainda em andamento.
   */
  tick(): Promise<{ read: boolean; worked: boolean }>;
  /** As respostas que ficaram em `enviando` são conferidas em Enviados (se a caixa é usável). Um erro sobe. */
  recoverInterrupted(): Promise<void>;
  /** Encerramento: depois disto nenhuma verificação começa uma unidade, nem uma que já estava em andamento. */
  stop(): void;
  /** Resolve quando não há verificação em andamento nem unidade rodando. */
  idle(): Promise<void>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A cada verificação, nada roda fora de host local, sem caixa conectada, com o e-mail desligado ou com a caixa pausada.
 * Fora disso: a cada `pollMs` (e logo na primeira verificação) uma leitura (`ingestInbox`), repetida na verificação
 * seguinte enquanto vier lote cheio; depois da leitura, na mesma rodada, e nas verificações entre leituras, uma unidade
 * de trabalho por rodada, a primeira que tiver o que fazer nesta
 * ordem: promover um ignorado marcado pelo dono, classificar, agir, fechar a primeira leitura (só depois de uma leitura que
 * não deixou nada para trás), recuperar um envio interrompido, enviar. Uma leitura que falha (de qualquer jeito) faz a
 * próxima esperar `pollMs`. Um provedor de IA fora do ar suspende a classificação até a próxima leitura. O erro de uma
 * unidade vai para o log e a procura segue para a próxima.
 */
export function createMailQueue(deps: MailQueueDeps): MailQueue {
  const { db, settings, ai } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const pollMs = deps.pollMs ?? MAIL_LIMITS.pollMs;
  const work: MailWorkDeps = { db, settings, ai, now, log };

  /** A verificação em andamento (do início até começar, ou não, uma unidade). */
  let pendingTick: Promise<unknown> | null = null;
  let inFlight: Promise<void> | null = null;
  /** Depois de `stop`, nenhuma verificação começa uma unidade. */
  let stopped = false;
  /** Quando a última leitura começou; null antes da primeira. */
  let lastRead: number | null = null;
  /** A última leitura trouxe um lote cheio: a próxima verificação lê de novo. */
  let more = false;
  /** A última leitura terminou sem deixar nada para trás: a primeira leitura pode ser fechada. */
  let caughtUp = false;
  /** O provedor de IA falhou para qualquer pedido: nada é classificado até a próxima leitura. */
  let classifyOff = false;

  /** Fora de host local, sem caixa, desligado ou pausado: nada roda. */
  async function usable(): Promise<boolean> {
    if (!deps.availability().available) return false;
    const account = await getMailAccount(db);
    if (!account || account.paused) return false;
    return (await settings.emailConfig()).enabled;
  }

  /** Abre a caixa, roda `fn` e fecha a caixa, também em erro. Sem caixa (credencial ilegível): null, sem rodar. */
  async function withMailbox<T>(fn: (mailbox: Mailbox) => Promise<T>): Promise<T | null> {
    const mailbox = await deps.openMailbox();
    if (!mailbox) return null;
    try {
      return await fn(mailbox);
    } finally {
      await mailbox.close().catch((e) => log(`[mail] erro ao fechar a caixa: ${errorText(e)}`));
    }
  }

  /** Roda uma unidade; erro vai para o log e conta como "nada feito". */
  async function guarded(name: string, unit: () => Promise<boolean>): Promise<boolean> {
    try {
      return await unit();
    } catch (e) {
      log(`[mail] erro ao ${name}: ${errorText(e)}`);
      return false;
    }
  }

  /** Devolve true: uma leitura pode abrir alertas (caixa recusada) mesmo sem trazer nada. */
  async function read(): Promise<boolean> {
    lastRead = now();
    more = false;
    caughtUp = false;
    classifyOff = false;
    try {
      const result = await withMailbox((mailbox) => ingestInbox({ db, mailbox, now, log }));
      if (result) {
        more = result.more;
        caughtUp = !result.more;
      }
    } catch (e) {
      log(`[mail] erro ao ler a caixa: ${errorText(e)}`);
    }
    return true;
  }

  /** A primeira unidade, na ordem, que tiver o que fazer. Devolve se alguma fez. */
  async function workOnce(): Promise<boolean> {
    if (await guarded('promover um e-mail ignorado', async () =>
      (await nextPromoted(db)) !== null && (await withMailbox((mailbox) => promoteNext({ db, mailbox, now, log }))) === true)) return true;
    if (!classifyOff) {
      const done = await guarded('classificar', async () => {
        const result = await classifyNext(work);
        if (result === 'off') classifyOff = true;
        return result === 'done';
      });
      if (done) return true;
    }
    if (await guarded('agir sobre um e-mail', () => actOnNext(work))) return true;
    if (caughtUp && (await guarded('fechar a primeira leitura', () => finishBackfill(work)))) return true;
    const sendDeps = (mailbox: Mailbox): SendDeps => ({ db, mailbox, now, log, resume: deps.resume });
    // Uma resposta em `enviando` (o envio caiu, ou ficou assim com a caixa pausada) é conferida em Enviados antes de
    // qualquer outro envio.
    if (await guarded('recuperar um envio interrompido', async () => {
      if ((await repliesInSending(db)).length === 0) return false;
      const result = await withMailbox((mailbox) => recoverSending(sendDeps(mailbox)));
      return result !== null && result.sent + result.returned > 0;
    })) return true;
    return guarded('enviar uma resposta', async () =>
      (await repliesInSending(db)).length === 0
      && (await nextApprovedReply(db)) !== null
      && (await withMailbox((mailbox) => sendNext(sendDeps(mailbox)))) === true);
  }

  function start(unit: () => Promise<unknown>): void {
    const done = unit()
      .then(async (worked) => {
        if (worked === true && deps.afterWork) await deps.afterWork();
      })
      .catch((e) => log(`[mail] erro na fila: ${errorText(e)}`))
      .finally(() => {
        if (inFlight === done) inFlight = null;
      });
    inFlight = done;
  }

  /**
   * Uma rodada com leitura: a leitura e, em seguida, a unidade de trabalho de sempre. Com a leitura mais curta que o timer
   * (a caixa falsa lê a cada 3 s), toda verificação tem leitura vencida, e a leitura sozinha deixaria o trabalho parado.
   * A leitura pode pausar a caixa (login recusado): as regras são conferidas de novo antes da unidade.
   */
  async function readThenWork(): Promise<boolean> {
    await read();
    if (!stopped && (await usable())) await workOnce();
    return true;
  }

  async function check(): Promise<{ read: boolean; worked: boolean }> {
    const result = { read: false, worked: false };
    // `stop` pode chegar enquanto `usable` espera o banco: conferido de novo antes de começar a unidade.
    if (!(await usable()) || stopped) return result;
    if (lastRead === null || more || now() - lastRead >= pollMs) {
      result.read = true;
      start(readThenWork);
    } else {
      result.worked = true;
      start(workOnce);
    }
    return result;
  }

  return {
    tick() {
      if (stopped || pendingTick || inFlight) return Promise.resolve({ read: false, worked: false });
      const tick = check().finally(() => {
        if (pendingTick === tick) pendingTick = null;
      });
      pendingTick = tick;
      return tick;
    },
    async recoverInterrupted() {
      if (stopped || !(await usable()) || (await repliesInSending(db)).length === 0) return;
      await withMailbox((mailbox) => recoverSending({ db, mailbox, now, log, resume: deps.resume }));
    },
    stop() {
      stopped = true;
    },
    async idle() {
      // A verificação em andamento pode ainda começar uma unidade: espera a verificação e depois a unidade.
      while (pendingTick || inFlight) {
        if (pendingTick) await pendingTick.catch(() => {}); // o erro da verificação é de quem chamou `tick`
        if (inFlight) await inFlight;
      }
    },
  };
}
