export interface RawMail {
  uid: number;
  /** Sem os sinais de menor e maior. */
  messageId: string;
  threadKey: string;
  from: { address: string; name: string };
  /** Endereços de To e Cc, em minúsculas. */
  to: string[];
  replyTo: string | null;
  subject: string;
  /** Data do cabeçalho Date, em epoch ms. */
  date: number;
  inReplyTo: string | null;
  references: string[];
  /** Cabeçalho Auto-Submitted presente e diferente de "no". */
  autoSubmitted: boolean;
  /** Tem List-Id. */
  listId: boolean;
  /** Marca de envio em massa: List-Unsubscribe, ou Precedence bulk, list ou junk. */
  bulk: boolean;
  /** Texto puro (ou o HTML convertido), cortado em MAIL_LIMITS.bodyChars. */
  text: string;
}
export interface OutgoingMail {
  messageId: string; from: string; fromName: string; to: string; subject: string; text: string;
  inReplyTo: string; references: string[];
  attachment: { fileName: string; content: Buffer } | null;
}
export class MailAuthError extends Error {}       // login recusado: senha revogada ou errada
export class MailTransientError extends Error {}  // rede, tempo esgotado, servidor ocupado
export interface Mailbox {
  /** Abre a sessão e confere o login. */
  check(): Promise<void>;
  /** Caixa de entrada: UID maior que `afterUid`; com `afterUid` null (ou `uidValidity` diferente do informado), as de `since` em diante. No máximo `limit`, das mais antigas para as mais novas. */
  fetchInbox(opts: { uidValidity: number | null; afterUid: number | null; since: number; limit: number }): Promise<{ uidValidity: number; mails: RawMail[] }>;
  fetchInboxByUid(uid: number): Promise<RawMail | null>;
  /** Todas as mensagens do fio, inclusive as que o dono enviou, da mais antiga para a mais nova. */
  fetchThread(threadKey: string): Promise<RawMail[]>;
  /** Há em Enviados uma mensagem com esse Message-ID? */
  sentExists(messageId: string): Promise<boolean>;
  send(mail: OutgoingMail): Promise<void>;
  close(): Promise<void>;
}
