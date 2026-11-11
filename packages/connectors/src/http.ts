export const USER_AGENT = 'Mozilla/5.0 (compatible; kanban-vagas/0.1)';

export async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/html', ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  return res.text();
}

export async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse(await fetchText(url)) as T;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
