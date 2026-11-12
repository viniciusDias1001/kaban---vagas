/** Camada HTTP falsa para os testes dos adaptadores: responde com fixtures e guarda o que foi pedido. */
export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type FakeReply = { status?: number; json: unknown; headers?: Record<string, string> } | { networkError: string };

interface SseMessage {
  content: Record<string, unknown>[];
  stop_reason: unknown;
  stop_sequence?: unknown;
  stop_details?: unknown;
  usage: Record<string, unknown>;
}

/**
 * Uma resposta de POST /v1/messages reescrita como o fluxo de eventos que a API manda com `stream: true`
 * (message_start, um trio content_block_* por bloco, message_delta com o motivo de parada e o uso, message_stop).
 */
export function anthropicSse(message: SseMessage): string {
  const events: Record<string, unknown>[] = [];
  const { iterations, output_tokens, ...startUsage } = message.usage;
  events.push({ type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_details: null, usage: { ...startUsage, output_tokens: 0 } } });
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: block });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence ?? null, stop_details: message.stop_details ?? null },
    usage: { output_tokens, ...(iterations ? { iterations } : {}) },
  });
  events.push({ type: 'message_stop' });
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

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
    // Pedido em streaming (Anthropic, nível forte) respondido com sucesso: a mesma mensagem, como eventos SSE.
    const body = text ? (JSON.parse(text) as { stream?: unknown }) : {};
    if (body.stream === true && (reply.status ?? 200) === 200) {
      return new Response(anthropicSse(reply.json as SseMessage), { status: 200, headers: { 'content-type': 'text/event-stream', ...reply.headers } });
    }
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}
