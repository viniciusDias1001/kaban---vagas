import { describe, expect, it } from 'vitest';
import { chooseRecipient, isNoReply, isTrustedRecipient } from './recipient';
import { rawMail } from './testing';

describe('isNoReply', () => {
  it.each(['no-reply@greenhouse.io', 'noreply@acme.com', 'DoNotReply@acme.com', 'nao-responda@acme.com.br', 'mailer-daemon@x.com', 'postmaster@x.com', 'bounce-123@x.com', 'no_reply@x.com', 'do-not-reply@x.com', 'naoresponda@x.com'])('%s takes no reply', (a) => {
    expect(isNoReply(a)).toBe(true);
  });

  it.each(['careers-noreply@acme.com', 'talent.noreply@acme.com', 'jobs-noreply@acme.com', 'acme-no-reply@acme.com', 'recrutamento.naoresponda@acme.com.br', 'ana.noreply.silva@acme.com', 'ana.noreply@acme.com', 'vagas_do-not-reply@acme.com', 'rh+nao-responda@acme.com', 'NoReply-Talent@acme.com'])('%s takes no reply (token anywhere)', (a) => {
    expect(isNoReply(a)).toBe(true);
  });

  it.each(['joana@acme.com', 'rh@acme.com', 'bernoreply@acme.com', 'ana.noreplysilva@acme.com'])('%s takes a reply', (a) => {
    expect(isNoReply(a)).toBe(false);
  });
});

describe('chooseRecipient', () => {
  it('prefers Reply-To over the sender', () => {
    expect(chooseRecipient(rawMail({ from: { address: 'no-reply@greenhouse.io', name: 'Acme' }, replyTo: 'joana@acme.com' }))).toEqual({ ok: true, address: 'joana@acme.com' });
  });

  it('uses the sender when there is no Reply-To', () => {
    expect(chooseRecipient(rawMail({ replyTo: null }))).toEqual({ ok: true, address: 'joana@acme.com' });
  });

  it('has no recipient for no-reply, lists and automatic mail', () => {
    expect(chooseRecipient(rawMail({ from: { address: 'no-reply@acme.com', name: 'Acme' }, replyTo: null }))).toEqual({ ok: false, why: 'no_reply' });
    expect(chooseRecipient(rawMail({ listId: true }))).toEqual({ ok: false, why: 'list' });
    expect(chooseRecipient(rawMail({ autoSubmitted: true, replyTo: 'joana@acme.com' }))).toEqual({ ok: false, why: 'auto_submitted' });
  });

  it('has no recipient when the Reply-To itself is no-reply', () => {
    expect(chooseRecipient(rawMail({ replyTo: 'noreply@acme.com' }))).toEqual({ ok: false, why: 'no_reply' });
  });

  it('has no recipient when the chosen address is not exactly one plain address', () => {
    expect(chooseRecipient(rawMail({ replyTo: 'a@acme.com, b@acme.com' }))).toEqual({ ok: false, why: 'ambiguous' });
    expect(chooseRecipient(rawMail({ from: { address: '', name: 'Acme' }, replyTo: null }))).toEqual({ ok: false, why: 'ambiguous' });
    expect(chooseRecipient(rawMail({ replyTo: 'joana@acme@com' }))).toEqual({ ok: false, why: 'ambiguous' });
    expect(chooseRecipient(rawMail({ replyTo: 'joana acme.com' }))).toEqual({ ok: false, why: 'ambiguous' });
    // A ordem fica: lista e automático vêm antes.
    expect(chooseRecipient(rawMail({ listId: true, replyTo: 'a@acme.com, b@acme.com' }))).toEqual({ ok: false, why: 'list' });
  });
});

describe('isTrustedRecipient', () => {
  const ctx = { sender: 'joana@acme.com', company: 'Acme', threadAddresses: ['rh@parceira.example'] };

  it('trusts the sender, the company domain, a verified application system and thread addresses only', () => {
    expect(isTrustedRecipient('joana@acme.com', ctx)).toBe(true);
    expect(isTrustedRecipient('vagas@acme.com', ctx)).toBe(true);
    expect(isTrustedRecipient('reply@us.greenhouse-mail.io', ctx)).toBe(true);
    expect(isTrustedRecipient('rh@parceira.example', ctx)).toBe(true);
    expect(isTrustedRecipient('joana.acme@gmail.com', ctx)).toBe(false);
    expect(isTrustedRecipient('x@lever.co', ctx)).toBe(false); // só no filtro, não verificado
  });

  it('compares addresses without regard to case', () => {
    expect(isTrustedRecipient('Joana@ACME.com', ctx)).toBe(true);
    expect(isTrustedRecipient('RH@Parceira.Example', ctx)).toBe(true);
    expect(isTrustedRecipient('x@y.com', { sender: 'X@Y.COM', company: null, threadAddresses: [] })).toBe(true);
  });

  it('never trusts something that is not exactly one plain address', () => {
    expect(isTrustedRecipient('a@acme.com, b@acme.com', ctx)).toBe(false);
    expect(isTrustedRecipient('', { sender: '', company: null, threadAddresses: [''] })).toBe(false);
    expect(isTrustedRecipient('joana@acme.com joana@acme.com', ctx)).toBe(false);
  });

  it('has no company domain to trust when the card has no company', () => {
    expect(isTrustedRecipient('vagas@acme.com', { ...ctx, company: null })).toBe(false);
  });

  it('trusts a company domain only when the company is the registrable label', () => {
    const acme = { sender: 'joana@acme.com', company: 'Acme', threadAddresses: [] };
    for (const a of ['rh@acme.com', 'rh@mail.acme.com', 'rh@acme.com.br']) expect(isTrustedRecipient(a, acme), a).toBe(true);
    for (const a of ['x@acme.phish.io', 'x@acme.evil.com.br', 'x@acme-jobs.com', 'x@acmecorp.com', 'x@mail.acme.phish.io']) {
      expect(isTrustedRecipient(a, acme), a).toBe(false);
    }
  });

  it('never trusts a company name shorter than 3 characters by domain', () => {
    const nu = { sender: 'joana@outro.example', company: 'Nu', threadAddresses: [] };
    expect(isTrustedRecipient('rh@nu.com', nu)).toBe(false);
    expect(isTrustedRecipient('rh@nu.com.br', nu)).toBe(false);
  });

  it('never trusts an address with characters outside a plain address', () => {
    const acme = { sender: 'joana@acme.com', company: 'Acme', threadAddresses: [] };
    for (const a of ['"x"@acme.com', 'x;y@acme.com', 'x:y@acme.com', '<x@acme.com>', 'x@acme.com>', 'x@acme', 'x@-.com.', 'x@acme..com']) {
      expect(isTrustedRecipient(a, acme), a).toBe(false);
    }
  });
});

describe('chooseRecipient with odd characters', () => {
  it('calls an address with ; : < > or quotes ambiguous', () => {
    for (const a of ['"x"@acme.com', 'x;y@acme.com', 'x:y@acme.com', '<x@acme.com>', 'Joana <joana@acme.com>']) {
      expect(chooseRecipient(rawMail({ replyTo: a })), a).toEqual({ ok: false, why: 'ambiguous' });
    }
  });

  it('accepts a plain address with upper case and spaces around it', () => {
    expect(chooseRecipient(rawMail({ replyTo: ' Joana.Silva+vagas@Acme.com.br ' }))).toEqual({ ok: true, address: 'Joana.Silva+vagas@Acme.com.br' });
  });
});
