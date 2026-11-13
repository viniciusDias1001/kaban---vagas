import { describe, expect, it } from 'vitest';
import type { CandidateProfile, Question } from '@kv/shared';
import { answerByRule, classifyByRule, declineOption, hasLastNameField, isWorkedHereQuestion, type RuleContext } from './rules';

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
    expect(answerByRule(q('I commit to the on-call rotation', { kind: 'boolean' }), 'consent', ctx)).toBeUndefined();
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

  it('answers "no" only when the job company shares no significant word with any company in the profile', () => {
    expect(answerByRule(select('Você já trabalhou nesta empresa?', ['Sim', 'Não']), 'profile_fact', ctx)).toBe('Não');
    expect(answerByRule(q('Have you ever worked for us?', { kind: 'boolean' }), 'profile_fact', ctx)).toBe(false);
    expect(answerByRule(q('Have you ever worked for us?'), 'profile_fact', ctx)).toBeUndefined();
  });

  it('never answers "yes", and leaves to the owner any job company that shares a word with a former employer', () => {
    const at = (company: string, experiences: string[]): RuleContext => ({
      ...ctx, job: { ...ctx.job, company },
      profile: { ...profile, experiences: experiences.map((c, i) => ({ ...profile.experiences[0]!, id: `exp_ccccccc${i}`, company: c })) },
    });
    const worked = select('Have you ever worked for this company?', ['Yes', 'No']);
    expect(answerByRule(worked, 'profile_fact', at('Indra', ['Minsait (Indra)']))).toBeUndefined();
    expect(answerByRule(worked, 'profile_fact', at('ACME', ['Acme Tecnologia Ltda']))).toBeUndefined();
    expect(answerByRule(worked, 'profile_fact', at('Empresa Fictícia', ['Empresa Fictícia Ltda']))).toBeUndefined();
    expect(answerByRule(worked, 'profile_fact', at('Grupo Boticário Brasil', ['Boticário']))).toBeUndefined();
    expect(answerByRule(worked, 'profile_fact', at('Beta Technologies Inc', ['Acme Technologies Ltda', 'Gama Group']))).toBe('No');
    // Nada sobra do nome da empresa da vaga: a regra não sabe.
    expect(answerByRule(worked, 'profile_fact', at('Tecnologia Brasil Ltda', ['Acme']))).toBeUndefined();
  });

  it('answers "no" only with a plain negative option', () => {
    expect(answerByRule(select('Have you ever worked for this company?', ['Yes, I have', 'No, never']), 'profile_fact', ctx)).toBeUndefined();
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

  it('also finds the other common wordings of not answering', () => {
    for (const option of ['I do not want to answer', "I don't wish to answer", 'Prefer not to say', 'Prefer not to disclose',
      'Decline to self-identify', 'Não desejo informar', 'Prefiro não responder'])
      expect(declineOption(['Sim', 'Não', option]), option).toBe(option);
    for (const option of ['No', 'Não', 'Other', 'Not applicable']) expect(declineOption(['Yes', option]), option).toBeNull();
  });
});

describe('fix round 1: consent only for privacy, terms and truthfulness', () => {
  const box = (label: string) => q(label, { kind: 'boolean' });
  it('an agreement to anything else is personal and never answered by rule', () => {
    for (const label of ['I agree to work on-site 5 days a week', 'Aceito trabalhar em regime PJ', 'I consent to a drug test',
      'Concordo em viajar 50% do tempo', 'I agree to travel up to 50%', 'I accept a 6-month probation period',
      'I acknowledge this role requires on-call shifts', 'Concordo com a jornada de 44 horas semanais', 'Declaro que tenho CNH categoria B',
      'I agree to receive marketing emails', 'Do you agree to work weekends?', 'Você aceita trabalhar aos sábados?']) {
      expect(classifyByRule(box(label)), label).toBe('personal');
      expect(answerByRule(box(label), 'consent', ctx), label).toBeUndefined();
    }
  });

  it('the privacy policy, the terms and the truthfulness of the application are consent, in Portuguese and English', () => {
    for (const label of ['I agree to the privacy policy', 'I have read the Privacy Notice', 'I acknowledge the candidate privacy statement',
      'Li e concordo com a política de privacidade', 'Estou ciente do aviso de privacidade', 'I accept the terms of use',
      'I agree to the Terms and Conditions', 'Aceito os termos de uso', 'Concordo com os termos de serviço',
      'I consent to the processing of my personal data', 'Autorizo o tratamento dos meus dados pessoais conforme a LGPD',
      'I consent to data processing under the GDPR', 'I certify that the information provided is true and complete',
      'Declaro que as informações prestadas são verdadeiras']) {
      expect(classifyByRule(box(label)), label).toBe('consent');
      expect(answerByRule(box(label), 'consent', ctx), label).toBe(true);
    }
  });

  it('a consent with a second commitment joined to it is personal', () => {
    for (const label of ['I agree to the privacy policy and to work on-site', 'Aceito os termos de uso e a jornada de 44 horas',
      'I have read the privacy policy and I accept the on-call schedule']) {
      expect(classifyByRule(box(label)), label).toBe('personal');
      expect(answerByRule(box(label), 'consent', ctx), label).toBeUndefined();
    }
  });

  it('a résumé field whose label says what it accepts is still a file', () => {
    expect(classifyByRule(q('Resume (accepted formats: PDF, DOCX)', { kind: 'file' }))).toBe('file');
  });
});

describe('fix round 1: worked here only about employment at the employer', () => {
  it('does not fire on work with, for or near something else', () => {
    for (const label of ['Have you worked with US-based clients?', 'Have you worked for US companies before?',
      'Você já trabalhou com Java aqui no Brasil?', 'Você já trabalhou remotamente? Conte para nós aqui', 'Have you worked with Acme products before?',
      'Have you worked at a startup?', 'Have you worked for a company like Acme?', 'Have you previously worked at Acme? If so, when?',
      'Você já trabalhou com a gente em algum projeto aqui?', 'Have you ever worked in a team that used us-east-1?']) {
      expect(classifyByRule(q(label)), label).not.toBe('profile_fact');
      expect(isWorkedHereQuestion(q(label), ctx), label).toBe(false);
      expect(answerByRule(select(label, ['Yes', 'No']), 'profile_fact', ctx), label).toBeUndefined();
    }
  });

  it('fires on past employment at the job company or at "us"', () => {
    for (const label of ['Have you previously worked at Acme?', 'Have you ever worked for us?', 'Have you ever worked for this company?',
      'Have you been employed by Acme before?', 'Have you ever worked for our company?', 'Have you consulted for Acme in the past?',
      'Você já trabalhou na Acme?', 'Você já trabalhou nesta empresa?', 'Você já trabalhou aqui?', 'Já foi funcionário da Acme?',
      'Já prestou serviço para a Acme?'])
      expect(isWorkedHereQuestion(q(label), ctx), label).toBe(true);
  });
});

describe('fix round 1: sensitive wordings', () => {
  it('catches eligibility, citizenship, pay, availability, moving, arrests, sex, race, age and pronouns', () => {
    const personal = ['Are you legally eligible to work in the United States?', 'Are you a US citizen?', 'Do you hold an EU passport?',
      'Green card holder?', 'Are you a permanent resident?', 'Desired hourly rate', 'Quanto você espera ganhar?', 'Expectativa de ganhos',
      'Expected annual income', 'Minimum wage you would accept', 'What is your availability to start?', 'How soon could you join?',
      'Quando você pode começar?', 'Would you be willing to move to Lisbon?', 'Você se mudaria para São Paulo?', 'Aceita mudar para Curitiba?',
      'Have you ever been arrested?', 'Have you been charged with a crime?', 'Você já foi preso?',
      // Achados da sondagem própria (fix round 1).
      'Tell us about your expected rate', 'Have you ever been dismissed from employment?', 'Já foi demitido por justa causa?',
      'Are you open to travel?', 'Você tem disponibilidade para viagens?', 'Can you commute to our office?',
      'What is your date of availability?', 'What are your salary expectations in USD?'];
    const demographic = ['Sexo', 'Ano de nascimento', 'Are you at least 18 years old?', 'How old are you?', 'Você é maior de 18 anos?',
      'Are you over 18?', 'Você se autodeclara negro ou pardo?', 'Pronouns', 'Pronomes', 'Qual a sua cor ou raça?'];
    for (const label of personal) expect(classifyByRule(q(label)), label).toBe('personal');
    for (const label of demographic) expect(classifyByRule(q(label)), label).toBe('demographic');
  });

  it('does not catch ordinary questions', () => {
    for (const label of ['Years of experience with React', 'Rate your English from 1 to 5', 'Which programming languages do you know?',
      'Describe a project you are proud of', 'What is your current job title?', 'Do you have experience with payments systems?',
      'Link to your GitHub', 'Qual o seu nível de inglês?', 'Você tem experiência com AWS?', 'Por que você quer trabalhar aqui?'])
      expect(['personal', 'demographic'], label).not.toContain(classifyByRule(q(label)));
  });
});

describe('fix round 1: a bare name field', () => {
  it('is the first name when the step also asks for the last name, the full name otherwise', () => {
    expect(answerByRule(q('Nome'), 'identity', ctx)).toBe('Maria Exemplo da Silva');
    expect(answerByRule(q('Name'), 'identity', { ...ctx, splitName: true })).toBe('Maria');
    expect(hasLastNameField([q('Nome'), q('Sobrenome')])).toBe(true);
    expect(hasLastNameField([q('Name'), q('Surname')])).toBe(true);
    expect(hasLastNameField([q('Name'), q('E-mail')])).toBe(false);
  });
});
