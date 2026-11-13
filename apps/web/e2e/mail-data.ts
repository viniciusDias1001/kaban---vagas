import { rmSync } from 'node:fs';
// Import pelo caminho, como o prepare-db.ts faz com o @kv/db: o pacote web não depende do @kv/mail.
import { deliverFakeMail, fakeMailDir, readFakeMailbox, type FakeStored, type RawMail } from '../../../packages/mail/src/index';
import { E2E_APPLY_DATA_DIR } from './apply-data';

/**
 * A caixa falsa do servidor do e2e (`FAKE_MAIL=1` no playwright.config): um arquivo em `<APPLY_DATA_DIR>/fake-mail`, que a
 * API e o worker leem e em que o teste entrega e-mails. Nada sai da máquina; nenhum servidor de e-mail é aberto.
 */
export const E2E_MAIL_DIR = fakeMailDir(E2E_APPLY_DATA_DIR);

/** O endereço fictício da dona da caixa. */
export const OWNER_ADDRESS = 'maria@example.com';

/**
 * A empresa das duas vagas da fonte falsa (packages/connectors: "Fake Corp"). Sem o sufixo societário, o nome casa com o
 * domínio `fake.example` do remetente; é por ele que o filtro local deixa o e-mail passar.
 */
export const COMPANY = 'Fake Corp';
const RECRUITER = { address: 'joana@fake.example', name: 'Joana Lima' };

/** Apaga a caixa falsa (só ela: o caminho é fixo, nunca lido do ambiente). */
export function resetFakeMail(): void {
  rmSync(E2E_MAIL_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Entrega um e-mail na Caixa de entrada falsa, para a dona, com a data de agora (depois da conexão: não é primeira leitura). */
export function deliver(mail: Partial<RawMail>): RawMail {
  return deliverFakeMail(E2E_MAIL_DIR, { to: [OWNER_ADDRESS], date: Date.now(), ...mail });
}

/** O que o app enviou (a pasta Enviados da caixa falsa). */
export function sentMail(): FakeStored[] {
  return readFakeMailbox(E2E_MAIL_DIR).messages.filter((m) => m.folder === 'sent');
}

/** Reprovação: o modelo falso classifica pela palavra "infelizmente". */
export const rejection = (subjectNote = ''): Partial<RawMail> => ({
  from: RECRUITER,
  subject: `Sua candidatura na ${COMPANY}: infelizmente${subjectNote}`,
  text: `Olá, Maria.\n\nAgradecemos o seu interesse. Infelizmente seguimos com outras pessoas no processo seletivo da ${COMPANY}.\n\nJoana`,
});

/** Pedido de um fato salvo: "pretensão" vira um pedido do fato `salary`. */
export const salaryRequest = (): Partial<RawMail> => ({
  from: RECRUITER,
  subject: `Processo seletivo ${COMPANY}`,
  text: `Olá, Maria.\n\nPara seguirmos com a sua candidatura na ${COMPANY}: qual a sua pretensão salarial?\n\nJoana`,
});

/** Convite: "entrevista" vira convite, e o rascunho do modelo falso traz a lacuna `[[seus horários]]`. */
export const invite = (): Partial<RawMail> => ({
  from: RECRUITER,
  subject: `Convite para entrevista - ${COMPANY}`,
  text: `Olá, Maria.\n\nGostaríamos de conversar com você sobre a vaga na ${COMPANY}. Quando você pode?\n\nJoana`,
});

/**
 * Fatura da mesma empresa: cita a empresa do quadro (domínio e nome), mas não tem sinal de contratação; é envio em massa
 * (List-Unsubscribe), então nem o "escrito direto para você" conta. Fica em "E-mails ignorados", sem texto.
 */
export const invoice = (): Partial<RawMail> => ({
  from: { address: 'faturamento@fake.example', name: `${COMPANY} Faturamento` },
  subject: `Sua fatura de novembro - ${COMPANY}`,
  text: 'Olá, Maria.\n\nSegue a fatura do mês. Valor: R$ 99,90. Vencimento: dia 20.',
  bulk: true,
});
