export const USER_AGENT = 'Mozilla/5.0 (compatible; kanban-vagas/0.1)';

const REQUEST_TIMEOUT_MS = 30_000;

/** `signal` (opcional) cancela a requisição antes do timeout próprio de 30 s. */
export async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/html', ...headers },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return JSON.parse(await fetchText(url, {}, signal)) as T;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
