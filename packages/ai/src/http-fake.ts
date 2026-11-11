/** Camada HTTP falsa para os testes dos adaptadores: responde com fixtures e guarda o que foi pedido. */
export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type FakeReply = { status?: number; json: unknown; headers?: Record<string, string> } | { networkError: string };

export function fakeHttp(...replies: FakeReply[]) {
  const requests: RecordedRequest[] = [];
  let next = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    // Como o fetch de verdade: sinal já abortado rejeita com AbortError.
    if (request.signal.aborted) throw new DOMException('This operation was aborted', 'AbortError');
    const text = await request.text();
    requests.push({
      url: request.url,
      headers: Object.fromEntries(request.headers.entries()),
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    });
    const reply = replies[Math.min(next++, replies.length - 1)];
    if ('networkError' in reply) throw new TypeError(reply.networkError);
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}
