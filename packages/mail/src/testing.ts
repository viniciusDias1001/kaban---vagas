import type { RawMail } from './types';

/** Mensagem recebida fictícia para os testes; `over` troca só o que o teste precisa. */
export function rawMail(over: Partial<RawMail> = {}): RawMail {
  return {
    uid: 1,
    messageId: 'm1@example.com',
    threadKey: 'm1@example.com',
    from: { address: 'joana@acme.com', name: 'Joana Lima' },
    to: ['maria@example.com'],
    replyTo: null,
    subject: 'Olá',
    date: 1_700_000_000_000,
    inReplyTo: null,
    references: [],
    autoSubmitted: false,
    listId: false,
    bulk: false,
    text: 'Olá, Maria.',
    ...over,
  };
}
