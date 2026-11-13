import { foldText, allowedNumbers, numberIds } from './text';
import { numericTexts } from './verify';
import type { EmailDraftInput } from './email-tasks';

/**
 * Conferência do rascunho de resposta a um e-mail, escrito pelo modelo. O rascunho nunca sai sem o dono aprovar; esta
 * barreira existe para que ele não precise caçar, no meio do texto, um endereço ou um número que o e-mail recebido
 * (texto de terceiros) plantou no modelo.
 */

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const URL = /(?:https?:\/\/|www\.)[^\s<>"'()[\]{}]+/giu;
/** Domínio sem protocolo ("fora.com.br/form"): só com um destes finais, para "Node.js" e "Vue.js" não virarem link. */
const BARE_HOST = /(?<![\p{L}\p{N}_.@/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,})(?![\p{L}\p{N}_-])(?:\/[^\s<>"'()[\]{}]*)?/giu;
const TLDS = new Set('com br net org io dev app co me info biz xyz tech site online jobs pt eu uk us'.split(' '));
const TRAILING = /[.,;:!?…]+$/;

/** Quantos dígitos um número precisa ter para ser conferido: "2 semanas" e "40%" são prosa, "987654" não. */
const MIN_CHECKED_DIGITS = 3;
/** Linhas não vazias, a partir do fim, onde a assinatura é procurada. */
const SIGNATURE_LINES = 3;

type Found = { kind: 'email' | 'link'; raw: string; start: number; end: number };

/** Endereços de e-mail e links de um texto, com a posição de cada um. */
export function findContacts(text: string): Found[] {
  const out: Found[] = [];
  for (const m of text.matchAll(EMAIL)) {
    const raw = m[0].replace(TRAILING, '');
    out.push({ kind: 'email', raw, start: m.index, end: m.index + raw.length });
  }
  // Os endereços viram espaços, para o domínio de "rh@fora.com" não contar de novo como link.
  let masked = text;
  for (const f of out) masked = masked.slice(0, f.start) + ' '.repeat(f.end - f.start) + masked.slice(f.end);
  const links: Found[] = [];
  for (const m of masked.matchAll(URL)) {
    const raw = m[0].replace(TRAILING, '');
    links.push({ kind: 'link', raw, start: m.index, end: m.index + raw.length });
  }
  for (const m of masked.matchAll(BARE_HOST)) {
    if (!TLDS.has(m[1].toLowerCase())) continue;
    if (links.some((l) => m.index >= l.start && m.index < l.end)) continue;
    const raw = m[0].replace(TRAILING, '');
    links.push({ kind: 'link', raw, start: m.index, end: m.index + raw.length });
  }
  return [...out, ...links].sort((a, b) => a.start - b.start);
}

/** Texto do modelo que só é mostrado (resumo, descrição de um pedido): endereços e links saem. */
export function stripContacts(text: string): string {
  let out = text;
  for (const f of findContacts(text).reverse()) out = `${out.slice(0, f.start)}[endereço omitido]${out.slice(f.end)}`;
  return out;
}

const linkKey = (raw: string) =>
  raw.toLowerCase().replace(TRAILING, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
const sameLine = (text: string) => foldText(text).replace(/\s+/g, ' ').trim();

/**
 * Violações do rascunho, em pt-BR; lista vazia = aceito.
 * - texto vazio (e então nada mais é conferido);
 * - número com 3 dígitos ou mais que não está no perfil, nos valores salvos nem no e-mail recebido (assunto, texto e
 *   nome do remetente); números dentro de endereços e links ficam para a regra deles;
 * - endereço de e-mail ou link que não está no perfil nem num valor salvo (o e-mail recebido NÃO abona endereço: é
 *   assim que uma mensagem forjada pediria os dados para outro lugar);
 * - o nome do perfil ausente das últimas linhas (a assinatura).
 */
export function verifyEmailDraft(input: Pick<EmailDraftInput, 'profile' | 'requests' | 'mail'>, text: string): string[] {
  if (text.trim() === '') return ['o rascunho está vazio'];
  const { profile, requests, mail } = input;
  const saved = requests.flatMap((r) => (r.saved === null ? [] : [r.saved]));
  const own = [profile.contact.email, profile.contact.phone, profile.contact.location, ...profile.links.map((l) => l.url), ...saved];

  const violations: string[] = [];
  const report = (message: string) => {
    if (!violations.includes(message)) violations.push(message);
  };

  const ownFound = own.flatMap(findContacts);
  const emails = new Set(ownFound.filter((f) => f.kind === 'email').map((f) => f.raw.toLowerCase()));
  const links = new Set([...profile.links.map((l) => linkKey(l.url)), ...ownFound.filter((f) => f.kind === 'link').map((f) => linkKey(f.raw))]);
  const found = findContacts(text);
  for (const f of found) {
    if (f.kind === 'email' && !emails.has(f.raw.toLowerCase())) report(`o endereço "${f.raw}" não está no perfil`);
    if (f.kind === 'link' && !links.has(linkKey(f.raw))) report(`o link "${f.raw}" não está no perfil`);
  }

  let prose = text;
  for (const f of [...found].reverse()) prose = `${prose.slice(0, f.start)} ${prose.slice(f.end)}`;
  const allowed = allowedNumbers([...numericTexts(profile), ...own, mail.subject, mail.text, mail.fromName]);
  for (const id of numberIds(prose)) {
    if ((id.match(/\d/g) ?? []).length < MIN_CHECKED_DIGITS || allowed.has(id)) continue;
    report(`o número "${id}" não está no perfil, nos valores salvos nem no e-mail recebido`);
  }

  const name = sameLine(profile.contact.name);
  if (name !== '') {
    const tail = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-SIGNATURE_LINES).map(sameLine).join(' ');
    if (!tail.includes(name)) report(`a assinatura não traz o nome do perfil ("${profile.contact.name.trim()}")`);
  }
  return violations;
}
