import { domainOf } from './company';

export const ATS_TRUSTED_DOMAINS = ['greenhouse.io', 'greenhouse-mail.io', 'workablemail.com', 'ashbyhq.com'] as const;
export const ATS_FILTER_DOMAINS = [...ATS_TRUSTED_DOMAINS, 'lever.co', 'gupy.io'] as const;

/** O domínio do endereço é um da lista ou subdomínio de um deles. */
export function isAtsAddress(address: string, list: readonly string[] = ATS_FILTER_DOMAINS): boolean {
  const domain = domainOf(address);
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}
