import type { RawMail } from './types';

const CORPORATE_SUFFIXES = new Set(['ltda', 'me', 'eireli', 'sa', 'inc', 'llc', 'gmbh', 'corp', 'co', 'ltd']);
const SECOND_LEVEL = new Set(['com', 'co', 'net', 'org', 'gov', 'edu']);

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Minúsculas, sem acento, sem pontuação; `dots` diz se ponto, barra e apóstrofo somem (S.A. vira sa) ou viram espaço. */
function words(value: string, dots: 'drop' | 'space'): string[] {
  return fold(value)
    .replace(/[./'’]/g, dots === 'drop' ? '' : ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** Minúsculas, sem acento, sem pontuação e sem sufixo societário (ltda, me, eireli, sa, s.a., inc, llc, gmbh, corp, co, ltd). */
export function normalizeCompany(name: string): string {
  const tokens = words(name, 'drop');
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(' ');
}

/** `phrase` aparece em `text` como palavra ou frase inteira (sem acento, sem diferença de caixa). */
export function hasPhrase(text: string, phrase: string, opts: { plural?: boolean } = {}): boolean {
  const needle = words(phrase, 'space').join(' ');
  if (!needle) return false;
  const haystack = ` ${words(text, 'space').join(' ')} `;
  const endings = opts.plural ? ['', 's', 'es'] : [''];
  return endings.some((end) => haystack.includes(` ${needle}${end} `));
}

/** O nome aparece em `text` como palavra inteira. Nome normalizado com menos de 3 letras nunca casa em texto. */
export function companyInText(company: string, text: string): boolean {
  const name = normalizeCompany(company);
  if (name.replace(/ /g, '').length < 3) return false;
  const needle = ` ${name} `;
  return ` ${words(text, 'drop').join(' ')} `.includes(needle) || ` ${words(text, 'space').join(' ')} `.includes(needle);
}

/** Os rótulos do domínio antes do sufixo público (`com`, `io`, `com.br`, `co.uk`…), em minúsculas. */
function labelsBeforeSuffix(domain: string): string[] {
  const labels = domain.trim().toLowerCase().split('.').filter(Boolean);
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const suffix = last && second && /^[a-z]{2}$/.test(last) && SECOND_LEVEL.has(second) ? 2 : 1;
  return labels.slice(0, Math.max(0, labels.length - suffix));
}

/** Um rótulo do domínio (fora o sufixo público) é igual ao nome normalizado sem espaços. Regra frouxa: só para o filtro e o casamento. */
export function companyInDomain(company: string, domain: string): boolean {
  const name = normalizeCompany(company).replace(/ /g, '');
  if (!name) return false;
  return labelsBeforeSuffix(domain).includes(name);
}

/**
 * O domínio é da empresa: o rótulo registrável (o que vem logo antes do sufixo público) é o nome normalizado sem
 * espaços. `acme.com`, `acme.com.br` e `mail.acme.com` são da Acme; `acme.phish.io`, `acme-jobs.com` e `acmecorp.com`
 * não. Nome com menos de 3 letras nunca é da empresa pelo domínio. Regra estrita: é a da confiança no destinatário.
 */
export function domainIsCompanys(company: string, domain: string): boolean {
  const name = normalizeCompany(company).replace(/ /g, '');
  if (name.length < 3) return false;
  const labels = labelsBeforeSuffix(domain);
  return labels.length > 0 && labels[labels.length - 1] === name;
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase();
}

/** Nome do remetente, domínio do remetente ou assunto. */
export function companyInHeaders(company: string, mail: Pick<RawMail, 'from' | 'subject'>): boolean {
  return (
    companyInText(company, mail.from.name) ||
    companyInDomain(company, domainOf(mail.from.address)) ||
    companyInText(company, mail.subject)
  );
}
