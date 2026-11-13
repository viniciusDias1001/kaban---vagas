import { describe, expect, it } from 'vitest';
import type { CandidateProfile, Question } from '@kv/shared';
import { answerByRule, classifyByRule, declineOption, type RuleContext } from './rules';

let seq = 0;
const q = (label: string, extra: Partial<Question> = {}): Question => ({
  id: `q${++seq}`, label, help: '', kind: 'text', options: [], required: true, maxLength: null, ...extra,
});
const select = (label: string, options: string[], extra: Partial<Question> = {}): Question =>
  q(label, { kind: 'select', options, ...extra });

const profile: CandidateProfile = {
  contact: { name: 'Maria Exemplo da Silva', email: 'maria@exemplo.com', phone: '+55 11 90000-0000', location: 'São Paulo, SP, Brasil' },
  summary: 'Desenvolvedora fictícia.',
  experiences: [
    { id: 'exp_aaaaaaa1', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora Sênior', start: '2023-06', end: '', location: '', achievements: [] },
    { id: 'exp_bbbbbbb2', company: 'Outra Fictícia SA', title: 'Desenvolvedora', start: '2020-01', end: '2023-05', location: '', achievements: [] },
  ],
  education: [], skills: [], languages: [], certifications: [],
  links: [
    { id: 'lnk_aaaaaaa1', label: 'LinkedIn', url: 'https://www.linkedin.com/in/maria-exemplo' },
    { id: 'lnk_bbbbbbb2', label: 'GitHub', url: 'https://github.com/maria-exemplo' },
    { id: 'lnk_ccccccc3', label: 'Portfólio', url: 'https://maria.exemplo.dev' },
  ],
};
const ctx: RuleContext = {
  profile,
  job: { id: 1, source: 'linkedin', url: 'https://example.test/vaga/1', externalId: '1', company: 'Acme', title: 'Dev' },
  sourceLabel: 'LinkedIn',
  resumeFileName: 'Maria_Exemplo_CV.pdf',
};

describe('classifyByRule', () => {
  it('treats salary, visa and legal questions as personal in both languages', () => {
    for (const label of ['Qual a sua pretensão salarial?', 'Salary expectations', 'Will you require visa sponsorship?',
      'Você possui autorização para trabalhar no Brasil?', 'Are you subject to a non-compete agreement?', 'Aviso prévio',
      'Are you legally authorized to work in the US?', 'Expected compensation', 'Do you have a work permit?',
      'Você aceita passar por checagem de antecedentes?', 'Have you ever been convicted of a criminal offense?',
      'Are you willing to relocate?', 'Disponibilidade para mudança', 'What is your notice period?', 'Earliest start date',
      'Please list two professional references', 'Remuneração desejada', 'Expected pay'])
      expect(classifyByRule(q(label)), label).toBe('personal');
  });

  it('treats gender, race, disability and veteran status as demographic', () => {
    for (const label of ['Gênero', 'Gender', 'Raça/cor', 'Etnia', 'Race', 'Are you Hispanic or Latino?', 'Você é PCD?',
      'Pessoa com deficiência?', 'Do you have a disability?', 'Veteran status', 'Orientação sexual', 'Sexual orientation',
      'Idade', 'Data de nascimento', 'Date of birth'])
      expect(classifyByRule(q(label)), label).toBe('demographic');
  });

  it('looks for sensitive words in the help text and in the options, not only in the label', () => {
    expect(classifyByRule(q('Valor', { help: 'Informe sua pretensão salarial mensal' }))).toBe('personal');
    expect(classifyByRule(select('Status', ['I will require visa sponsorship', 'I will not require sponsorship']))).toBe('personal');
    expect(classifyByRule(select('Self identification', ['Male', 'Female', 'Non-binary'], { help: 'Voluntary gender self identification' })))
      .toBe('demographic');
  });

  it('checks the sensitive patterns before any other rule', () => {
    expect(classifyByRule(q('Upload your work permit', { kind: 'file' }))).toBe('personal');
    expect(classifyByRule(q('Cidade para onde aceita mudança'))).toBe('personal');
    expect(classifyByRule(q('I agree to a background check', { kind: 'boolean' }))).toBe('personal');
  });

  it('recognizes contact, file, source and consent questions', () => {
    expect(classifyByRule(q('E-mail'))).toBe('identity');
    expect(classifyByRule(q('Full name'))).toBe('identity');
    expect(classifyByRule(q('LinkedIn Profile (optional)'))).toBe('identity');
    expect(classifyByRule(q('Resume/CV', { kind: 'file' }))).toBe('file');
    expect(classifyByRule(q('How did you hear about this job?'))).toBe('origin');
    expect(classifyByRule(q('Como soube da vaga?'))).toBe('origin');
    expect(classifyByRule(q('I agree to the privacy policy', { kind: 'boolean' }))).toBe('consent');
    expect(classifyByRule(q('Have you ever worked for this company?'))).toBe('profile_fact');
  });

  it('leaves everything else to the model', () => {
    for (const label of ['Years of experience with React', 'Why do you want to work here?', 'Name of the person who referred you',
      'Have you worked with Kubernetes?'])
      expect(classifyByRule(q(label)), label).toBeNull();
  });
});

describe('answerByRule', () => {
  it('answers contact fields from the profile and the source question from the job', () => {
    expect(answerByRule(q('E-mail'), 'identity', ctx)).toBe('maria@exemplo.com');
    expect(answerByRule(q('LinkedIn URL'), 'identity', ctx)).toBe('https://www.linkedin.com/in/maria-exemplo');
    expect(answerByRule(q('Como soube da vaga?'), 'origin', ctx)).toBe('LinkedIn');
    expect(answerByRule(select('Have you previously worked at Acme?', ['Yes', 'No']), 'profile_fact', ctx)).toBe('No');
  });

  it('answers names, phone, location, country, links and the current job', () => {
    expect(answerByRule(q('Nome completo'), 'identity', ctx)).toBe('Maria Exemplo da Silva');
    expect(answerByRule(q('First name'), 'identity', ctx)).toBe('Maria');
    expect(answerByRule(q('Last name'), 'identity', ctx)).toBe('Exemplo da Silva');
    expect(answerByRule(q('Telefone'), 'identity', ctx)).toBe('+55 11 90000-0000');
    expect(answerByRule(q('Location'), 'identity', ctx)).toBe('São Paulo, SP, Brasil');
    expect(answerByRule(q('País'), 'identity', ctx)).toBe('Brasil');
    expect(answerByRule(select('Country', ['Argentina', 'Brazil', 'Chile']), 'identity', ctx)).toBe('Brazil');
    expect(answerByRule(q('GitHub'), 'identity', ctx)).toBe('https://github.com/maria-exemplo');
    expect(answerByRule(q('Portfolio URL'), 'identity', ctx)).toBe('https://maria.exemplo.dev');
    expect(answerByRule(q('Current company'), 'identity', ctx)).toBe('Empresa Fictícia Ltda');
    expect(answerByRule(q('Cargo atual'), 'identity', ctx)).toBe('Desenvolvedora Sênior');
  });

  it('knows nothing it cannot read from the profile', () => {
    const bare: RuleContext = { ...ctx, profile: { ...profile, experiences: [], links: [], contact: { ...profile.contact, phone: '', location: 'São Paulo, SP' } } };
    expect(answerByRule(q('Telefone'), 'identity', bare)).toBeUndefined();
    expect(answerByRule(q('LinkedIn'), 'identity', bare)).toBeUndefined();
    expect(answerByRule(q('Current company'), 'identity', bare)).toBeUndefined();
    expect(answerByRule(q('Country'), 'identity', bare)).toBeUndefined();
    expect(answerByRule(select('Country', ['Argentina', 'Chile']), 'identity', ctx)).toBeUndefined();
    expect(answerByRule(select('Where did you hear about us?', ['Indeed', 'Other']), 'origin', ctx)).toBeUndefined();
  });

  it('answers only what the rules recognize, whatever category the model gave', () => {
    expect(answerByRule(q('Name of the person who referred you'), 'identity', ctx)).toBeUndefined();
    expect(answerByRule(q('Who referred you?'), 'origin', ctx)).toBeUndefined();
    expect(answerByRule(q('I certify that everything I wrote is true', { kind: 'boolean' }), 'consent', ctx)).toBeUndefined();
    expect(answerByRule(q('Years of experience with React'), 'profile_fact', ctx)).toBeUndefined();
  });

  it('attaches the résumé only to a résumé field', () => {
    expect(answerByRule(q('Resume/CV', { kind: 'file' }), 'file', ctx)).toBe('Maria_Exemplo_CV.pdf');
    expect(answerByRule(q('Currículo', { kind: 'file' }), 'file', ctx)).toBe('Maria_Exemplo_CV.pdf');
    expect(answerByRule(q('Cover letter', { kind: 'file' }), 'file', ctx)).toBeUndefined();
    expect(answerByRule(q('Transcript', { kind: 'file' }), 'file', ctx)).toBeUndefined();
  });

  it('accepts a required consent and leaves an optional one alone', () => {
    expect(answerByRule(q('I agree to the privacy policy', { kind: 'boolean' }), 'consent', ctx)).toBe(true);
    expect(answerByRule(select('Li e concordo com a política de privacidade', ['Concordo', 'Não concordo']), 'consent', ctx)).toBe('Concordo');
    expect(answerByRule(q('I agree to receive news', { kind: 'boolean', required: false }), 'consent', ctx)).toBeUndefined();
  });

  it('compares the job company with the companies in the profile', () => {
    const before: RuleContext = { ...ctx, job: { ...ctx.job, company: 'Empresa Fictícia' } };
    expect(answerByRule(select('Have you previously worked at Empresa Fictícia?', ['Yes', 'No']), 'profile_fact', before)).toBe('Yes');
    expect(answerByRule(select('Você já trabalhou nesta empresa?', ['Sim', 'Não']), 'profile_fact', before)).toBe('Sim');
    expect(answerByRule(q('Have you ever worked for us?', { kind: 'boolean' }), 'profile_fact', ctx)).toBe(false);
    expect(answerByRule(q('Have you ever worked for us?'), 'profile_fact', ctx)).toBeUndefined();
  });
});

describe('declineOption', () => {
  it('finds the option of not answering, in Portuguese or English', () => {
    expect(declineOption(['Feminino', 'Masculino', 'Prefiro não informar'])).toBe('Prefiro não informar');
    expect(declineOption(['Yes', 'No', 'I prefer not to say'])).toBe('I prefer not to say');
    expect(declineOption(['Yes', 'No', 'Decline to self-identify'])).toBe('Decline to self-identify');
    expect(declineOption(['Yes', 'No', "I don't wish to answer"])).toBe("I don't wish to answer");
    expect(declineOption(['Yes', 'No'])).toBeNull();
  });
});
