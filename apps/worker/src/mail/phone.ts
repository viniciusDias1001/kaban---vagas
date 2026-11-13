/**
 * Aviso no celular: para cada alerta `interview` ou `offer` aberto, uma mensagem só com o tipo e a empresa. A primeira
 * leitura nunca abre esses alertas, então nunca manda aviso. O alerta do app não muda: o aviso é só um eco dele.
 */
import { markPhoneAttempt, nextPhoneAlert, type Db } from '@kv/db';
import { PhoneAlertError, type PhoneNotifier } from '@kv/mail';

/** Manda o aviso do alerta pendente mais antigo. Devolve se havia o que fazer. Falha conta uma tentativa (3 no máximo). */
export async function notifyNext(deps: {
  db: Db; notifier: PhoneNotifier | null; now: () => number; log: (msg: string) => void;
}): Promise<boolean> {
  const { db, notifier, now, log } = deps;
  if (!notifier) return false;
  const alert = await nextPhoneAlert(db);
  if (!alert || (alert.kind !== 'interview' && alert.kind !== 'offer')) return false;
  try {
    await notifier.send({ kind: alert.kind, company: alert.company });
  } catch (e) {
    await markPhoneAttempt(db, alert.id, false, now());
    // Só a frase fixa do canal: a mensagem de outro erro pode trazer a URL do Telegram, e a URL traz o token.
    const cause = e instanceof PhoneAlertError ? e.message : 'erro inesperado';
    log(`[mail] o aviso no celular do alerta ${alert.id} falhou: ${cause}`);
    return true;
  }
  await markPhoneAttempt(db, alert.id, true, now());
  log(`[mail] aviso no celular enviado (alerta ${alert.id})`);
  return true;
}
