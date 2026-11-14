import { describe, expect, it } from 'vitest';
import { MAIL_LIMITS } from '@kv/shared';
import { clipBody, htmlToText, pickTextPart, syntheticMessageId, threadKeyFromHeaders } from './text';

type Node = { part?: string; type: string; disposition?: string; childNodes?: Node[] };
const part = (id: string, type: string, disposition?: string): Node => ({ part: id, type, ...(disposition ? { disposition } : {}) });
const multipart = (childNodes: Node[]): Node => ({ type: 'multipart/mixed', childNodes });

describe('htmlToText', () => {
  it('turns HTML into readable text without scripts or styles', () => {
    expect(htmlToText('<style>p{}</style><p>Olá, Maria.</p><script>x()</script><div>Segue o <b>convite</b>.<br>Até logo &amp; obrigado.</div>'))
      .toBe('Olá, Maria.\nSegue o convite.\nAté logo & obrigado.');
  });
  it('decodes numeric and named entities and drops comments and the head', () => {
    expect(htmlToText('<head><title>t</title></head><!-- x --><p>R&#36; 10&nbsp;mil &lt;b&gt; &#x41;&eacute;</p>')).toBe('R$ 10 mil <b> Aé');
  });
  it('keeps the text of a link but never its address', () => {
    expect(htmlToText('<p>Veja <a href="https://acme.example/x">aqui</a></p><img src="https://t.example/p.gif">')).toBe('Veja aqui');
  });
});

describe('clipBody', () => {
  it('clips a long body', () => expect(clipBody('a'.repeat(50_000))).toHaveLength(MAIL_LIMITS.bodyChars));
  it('drops NUL characters, which Postgres refuses in text', () => expect(clipBody('Olá\u0000 Maria\u0000.')).toBe('Olá Maria.'));
  it('joins repeated spaces and blank lines', () => {
    expect(clipBody('  Olá,\t\tMaria.  \r\n\r\n\r\n\r\nTudo   bem?  ')).toBe('Olá, Maria.\n\nTudo bem?');
  });
});

describe('pickTextPart', () => {
  it('picks plain text, then HTML, and never an attachment', () => {
    expect(pickTextPart(multipart([part('1', 'text/plain'), part('2', 'text/html'), part('3', 'application/pdf', 'attachment')]))).toEqual({ part: '1', html: false });
    expect(pickTextPart(multipart([part('1', 'text/html'), part('2', 'text/plain', 'attachment')]))).toEqual({ part: '1', html: true });
    expect(pickTextPart(multipart([part('1', 'application/pdf', 'attachment')]))).toBeNull();
  });
  it('finds the text inside nested multiparts', () => {
    const tree = multipart([{ part: '1', type: 'multipart/alternative', childNodes: [part('1.1', 'text/plain'), part('1.2', 'text/html')] }, part('2', 'image/png', 'attachment')]);
    expect(pickTextPart(tree)).toEqual({ part: '1.1', html: false });
  });
  it('treats a single-part message as part 1', () => {
    expect(pickTextPart({ type: 'text/plain' })).toEqual({ part: '1', html: false });
    expect(pickTextPart({ type: 'text/html' })).toEqual({ part: '1', html: true });
    expect(pickTextPart({ type: 'application/pdf' })).toBeNull();
  });
  it('never reads a forwarded message or a malformed structure', () => {
    const fwd = multipart([{ part: '1', type: 'message/rfc822', childNodes: [part('1', 'text/plain')] }]);
    expect(pickTextPart(fwd)).toBeNull();
    expect(pickTextPart(null)).toBeNull();
    expect(pickTextPart('x')).toBeNull();
  });
});

describe('ids', () => {
  it('derives ids for mail without Message-ID and the thread from the headers', () => {
    expect(syntheticMessageId(7, 42)).toBe('uid-7-42@sem-id.local');
    expect(threadKeyFromHeaders({ messageId: 'c@x', inReplyTo: 'b@x', references: ['a@x', 'b@x'] })).toBe('a@x');
    expect(threadKeyFromHeaders({ messageId: 'c@x', inReplyTo: null, references: [] })).toBe('c@x');
    expect(threadKeyFromHeaders({ messageId: 'c@x', inReplyTo: 'b@x', references: [] })).toBe('b@x');
  });
});
