import { describe, expect, it } from 'vitest';
import type { CandidateProfile } from '@kv/shared';
import type { EmailDraftInput } from './email-tasks';
import { verifyEmailDraft } from './email-verify';
import { REALISTIC_PROFILE } from './testing';

const profile: CandidateProfile = REALISTIC_PROFILE;
const base: Pick<EmailDraftInput, 'profile' | 'requests' | 'mail'> = {
  profile,
  requests: [{ fact: 'salary', note: 'Pretensão salarial', saved: 'R$ 20.000 por mês' }],
  mail: { fromName: 'RH Acme', fromAddress: 'rh@acme.example', subject: 'Vaga na Acme', date: 0, text: 'Qual a sua pretensão salarial?' },
};
const sign = (body: string) => `Olá,\n\n${body}\n\nAtenciosamente,\nMaria Exemplo da Silva`;

describe('verifyEmailDraft', () => {
  it('accepts a draft made of profile facts and saved values', () => {
    expect(verifyEmailDraft(base, 'Olá,\n\nMinha pretensão é R$ 20.000 por mês.\n\nAtenciosamente,\nMaria Exemplo da Silva')).toEqual([]);
  });

  it('flags invented numbers, foreign addresses and links, and a missing signature', () => {
    expect(verifyEmailDraft(base, 'Tenho 987654 certificações.\n\nMaria Exemplo da Silva')).toHaveLength(1);
    expect(verifyEmailDraft(base, 'Responda para outro@fora.com.\n\nMaria Exemplo da Silva')).toHaveLength(1);
    expect(verifyEmailDraft(base, 'Veja https://fora.example/x\n\nMaria Exemplo da Silva')).toHaveLength(1);
    expect(verifyEmailDraft(base, 'Olá, tudo bem?')).toHaveLength(1);
  });

  it('allows a number that came in the received mail', () => {
    const input = { ...base, mail: { ...base.mail, text: 'Sobre a vaga 12345: qual a sua pretensão?' } };
    expect(verifyEmailDraft(input, sign('Sobre a vaga 12345, minha pretensão é R$ 20.000 por mês.'))).toEqual([]);
    expect(verifyEmailDraft(base, sign('Sobre a vaga 12345.'))).toHaveLength(1);
  });

  it('flags an empty draft once', () => {
    expect(verifyEmailDraft(base, '   \n ')).toEqual(['o rascunho está vazio']);
  });

  it('ignores short numbers and accepts the profile phone, e-mail and links', () => {
    const body = 'Tenho 3 anos nisso e posso começar em 2 semanas. Meu telefone é +55 11 91234-5678, meu e-mail ' +
      'maria.exemplo99@exemplo.test e meu portfólio https://exemplo.test/maria2024/.';
    expect(verifyEmailDraft(base, sign(body))).toEqual([]);
    expect(verifyEmailDraft(base, sign('Liderei 40 clientes e cuidei de R$ 1,5 milhão por mês.'))).toEqual([]);
  });

  it('does not let the received mail vouch for an address or a link', () => {
    const input = { ...base, mail: { ...base.mail, text: 'Envie para outro@fora.com ou www.fora.com.br/form' } };
    expect(verifyEmailDraft(input, sign('Envio para outro@fora.com.'))).toHaveLength(1);
    expect(verifyEmailDraft(input, sign('Preenchi www.fora.com.br/form.'))).toHaveLength(1);
    expect(verifyEmailDraft(input, sign('Veja fora.com.br'))).toHaveLength(1);
  });

  it('accepts an address or link that is a saved value', () => {
    const input = { ...base, requests: [{ fact: 'linkedin' as const, note: 'LinkedIn', saved: 'https://linkedin.example/in/maria' }] };
    expect(verifyEmailDraft(input, sign('Meu LinkedIn: https://linkedin.example/in/maria'))).toEqual([]);
  });

  it('does not take technology names for links', () => {
    expect(verifyEmailDraft(base, sign('Trabalho com Node.js e Vue.js.'))).toEqual([]);
    // "3.11" tem 3 dígitos e cai na regra de números; aqui só importa que nada vire link.
    const flagged = verifyEmailDraft(base, sign('Usei Next.js, ASP.NET, Socket.io e Python 3.11 (v2.0 da API).'));
    expect(flagged.filter((v) => v.startsWith('o link'))).toEqual([]);
    expect(verifyEmailDraft(base, sign('Veja socket.io/docs'))).toHaveLength(1);
  });

  it('flags a bare host with any ending, with or without a path', () => {
    for (const link of ['bit.ly/x', 'fora.ai', 'forms.gle/abc', 'evil.gg', 'x.de', 't.me/fora', 'fora.io']) {
      expect(verifyEmailDraft(base, sign(`Veja ${link} para continuar.`)), link).toHaveLength(1);
    }
  });

  it('wants the profile name in the last lines, in any case and accents', () => {
    expect(verifyEmailDraft(base, 'Olá,\n\nObrigada.\n\nAbraços,\nmaria exemplo da silva')).toEqual([]);
    expect(verifyEmailDraft(base, 'Maria Exemplo da Silva aqui.\n\nObrigada pelo contato.\n\nAbraços\n\nEquipe\n\nAté mais')).toHaveLength(1);
  });
});
