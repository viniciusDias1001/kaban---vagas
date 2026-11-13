import { ATS_TRUSTED_DOMAINS, isAtsAddress } from './ats';
import { companyInDomain, domainOf } from './company';
import type { RawMail } from './types';

const NO_REPLY_PREFIX = /^(no-reply|noreply|no_reply|do-not-reply|donotreply|nao-responda|naoresponda|mailer-daemon|postmaster|bounce)/i;

/** Parte local começa com no-reply, noreply, no_reply, do-not-reply, donotreply, nao-responda, naoresponda, mailer-daemon, postmaster ou bounce. */
export function isNoReply(address: string): boolean {
  const at = address.lastIndexOf('@');
  const local = (at < 0 ? address : address.slice(0, at)).trim();
  return NO_REPLY_PREFIX.test(local);
}

export type Recipient = { ok: true; address: string } | { ok: false; why: 'no_reply' | 'list' | 'auto_submitted' | 'ambiguous' };

/** Exatamente um endereço simples: sem vírgula nem espaço, um só `@`, com texto dos dois lados. */
function isSingleAddress(address: string): boolean {
  return /^[^\s@,]+@[^\s@,]+$/.test(address);
}

/** `Reply-To` se houver, senão o remetente. Lista ou `Auto-Submitted`: sem destinatário. Endereço escolhido que não é um só endereço simples: ambíguo. Endereço escolhido "no-reply": sem destinatário. */
export function chooseRecipient(mail: Pick<RawMail, 'from' | 'replyTo' | 'autoSubmitted' | 'listId'>): Recipient {
  if (mail.listId) return { ok: false, why: 'list' };
  if (mail.autoSubmitted) return { ok: false, why: 'auto_submitted' };
  const address = mail.replyTo?.trim() || mail.from.address;
  if (!isSingleAddress(address)) return { ok: false, why: 'ambiguous' };
  if (isNoReply(address)) return { ok: false, why: 'no_reply' };
  return { ok: true, address };
}

/** O endereço do remetente, um do domínio da empresa do card, um de ATS_TRUSTED_DOMAINS, ou um que já apareceu no fio. */
export function isTrustedRecipient(
  address: string,
  ctx: { sender: string; company: string | null; threadAddresses: readonly string[] },
): boolean {
  const wanted = address.trim().toLowerCase();
  if (!isSingleAddress(wanted)) return false;
  if (wanted === ctx.sender.trim().toLowerCase()) return true;
  if (ctx.threadAddresses.some((a) => a.trim().toLowerCase() === wanted)) return true;
  if (ctx.company !== null && companyInDomain(ctx.company, domainOf(wanted))) return true;
  return isAtsAddress(wanted, ATS_TRUSTED_DOMAINS);
}
