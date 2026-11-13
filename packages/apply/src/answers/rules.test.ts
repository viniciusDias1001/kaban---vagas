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

describe('fix round 2: consent by remainder', () => {
  const box = (label: string) => q(label, { kind: 'boolean' });
  const at = (company: string): RuleContext => ({ ...ctx, job: { ...ctx.job, company } });
  const isNotConsent = (label: string, expected: 'personal' | null, rc: RuleContext = ctx) => {
    expect(classifyByRule(box(label), rc.job.company), label).toBe(expected);
    expect(answerByRule(box(label), 'consent', rc), label).toBeUndefined();
  };
  const isConsent = (label: string, rc: RuleContext = ctx) => {
    expect(classifyByRule(box(label), rc.job.company), label).toBe('consent');
    expect(answerByRule(box(label), 'consent', rc), label).toBe(true);
  };

  it('a label without an agreement expression is not consent and is left to the model', () => {
    for (const label of ['Do you have experience with GDPR compliance?', 'Você tem experiência com LGPD?',
      'Have you implemented a privacy policy page?'])
      isNotConsent(label, null);
    expect(answerByRule(select('Do you have experience with GDPR compliance?', ['Yes', 'No']), 'consent', ctx)).toBeUndefined();
    expect(answerByRule(select('Você tem experiência com LGPD?', ['Sim', 'Não']), 'consent', ctx)).toBeUndefined();
  });

  it('an allowed object joined to a second commitment is personal', () => {
    for (const label of ['Li a política de privacidade e concordo em trabalhar aos sábados',
      'I accept the privacy policy plus a 3-month trial period', 'I agree to the privacy policy; I will work on-site',
      'I acknowledge the privacy notice. I agree to work on-site 5 days a week.',
      'I acknowledge the privacy notice and that this role requires on-call shifts',
      'Concordo com a política de privacidade bem como com a jornada de 6x1',
      'I agree to the terms of use, including mandatory overtime',
      'Concordo com os termos de uso, inclusive com a cláusula de exclusividade',
      'I agree to data processing, and accept a 90-day probation',
      'I agree to the privacy policy and consent to receive SMS marketing',
      'Aceito a política de privacidade e autorizo o envio de mensagens pelo WhatsApp'])
      isNotConsent(label, 'personal');
  });

  it('a loose object phrase is personal', () => {
    for (const label of ['I agree to the terms and conditions of employment', 'Aceito os termos e condições do contrato de trabalho',
      'I agree to share my data with third-party recruiters under the GDPR', 'I consent to video recording of my interview under the GDPR'])
      isNotConsent(label, 'personal');
  });

  it('the terms of use together with the privacy policy is consent', () => {
    isConsent('Li e concordo com os termos de uso e a política de privacidade');
    isConsent('Li e concordo com os termos de uso e as políticas de privacidade');
  });

  it('each allowed object is consent in Portuguese and English, with and without the company name', () => {
    for (const label of [
      // Privacidade.
      'I agree to the privacy policy', 'I have read and understood the Privacy Notice', 'I acknowledge the candidate privacy statement',
      "Please review and acknowledge Acme's Candidate Privacy Policy", "I have read Acme's privacy policy",
      'Li e concordo com a política de privacidade', 'Estou ciente do aviso de privacidade', 'Declaro que li a Política de Privacidade da Acme',
      'Privacy Policy', 'Política de privacidade',
      // Termos.
      'I accept the terms of use', 'I agree to the Terms and Conditions', "I agree to Acme's Terms of Service", 'Termos de uso',
      'Aceito os termos de uso', 'Concordo com os termos de serviço da Acme',
      // Tratamento dos dados.
      'I consent to the processing of my personal data', 'I consent to data processing under the GDPR',
      'I consent to Acme processing my personal data for recruitment purposes',
      'Autorizo o tratamento dos meus dados pessoais conforme a LGPD',
      // Veracidade.
      'I certify that the information provided is true and complete', 'I confirm that all information in this application is accurate',
      'Declaro que as informações prestadas são verdadeiras',
      'Confirmo que todas as informações fornecidas são verídicas e corretas',
    ])
      isConsent(label);
  });

  it('the company name after "a" or "to" is a remainder (fix round 4, R6b: not one of the two accepted positions)', () => {
    for (const label of ['Autorizo a Acme o tratamento dos meus dados pessoais para fins de recrutamento',
      'I certify to Acme that the information in my application is true'])
      isNotConsent(label, 'personal');
  });

  it('the name of another company is a remainder', () => {
    isNotConsent("Please review and acknowledge Acme's Candidate Privacy Policy", 'personal', at('Beta'));
    isNotConsent('Aceito os termos de uso da Beta', 'personal');
    // Fix round 4, R6: só o nome inteiro sai; "Beta" sozinho de "Beta Tecnologia Ltda" sobra.
    isNotConsent('Aceito os termos de uso da Beta', 'personal', at('Beta Tecnologia Ltda'));
    isConsent('Aceito os termos de uso da Beta Tecnologia', at('Beta Tecnologia Ltda'));
  });

  it('own probes: more consent wordings', () => {
    for (const label of ['I have read and agree to the Terms of Service and Privacy Policy',
      'By submitting this application, I agree to the Privacy Policy', 'Ao enviar esta candidatura, concordo com a Política de Privacidade',
      'I acknowledge that I have read the Acme Applicant Privacy Notice', 'Do you agree to the privacy policy?',
      'Você concorda com os termos de uso?', 'I hereby certify that all the information I have provided is true, accurate and complete',
      'GDPR consent', 'Consentimento LGPD', 'Li e aceito os Termos e Condições', 'I agree to the Privacy Policy (required)',
      'Estou de acordo com a política de privacidade',
      "I've read the privacy notice", 'Consinto com o tratamento de dados pessoais para fins de recrutamento',
      'Termos de uso e política de privacidade', 'Eu li e concordo com a política de privacidade',
      'I give my consent to the processing of my personal data for this application',
      'I consent to the processing of my personal data in accordance with the Privacy Policy',
      'I agree to the privacy policy and the terms of use'])
      isConsent(label);
  });

  it('own probes: words with a second meaning are a remainder (the US, the EU, "no")', () => {
    for (const label of ['I consent to the processing of my personal data in the US',
      'I consent to the processing of my personal data in the EU', 'I consent to the processing of my personal data in Brazil',
      'I agree to the privacy policy: no', 'Eu concordo em trabalhar presencialmente', 'I agree to the Privacy Policy and Cookie Policy',
      'Concordo com o tratamento de dados sensíveis', 'I agree that Acme may contact me about future roles',
      'I confirm that my answers are true and I am available to start', 'Li e concordo', 'Aceito os termos'])
      isNotConsent(label, 'personal');
  });

  it('own probes: ordinary questions that only look like agreements are left alone', () => {
    for (const label of ['Confirm your email', 'Are you AWS certified?', 'Have you read our privacy policy?'])
      isNotConsent(label, null);
  });

  it('own probes: more labels that say something else', () => {
    for (const label of ['I agree to the terms', 'I accept the terms of use and the code of conduct',
      'Concordo com a política de privacidade e com o banco de talentos', 'I consent to Acme keeping my CV for future openings',
      'I agree to the privacy policy of our partner Beta', 'I certify that I hold a valid driving licence',
      'I confirm that the information is true and that I can start immediately',
      'Declaro que as informações são verdadeiras e que possuo veículo próprio', 'I agree to the privacy policy, and to take a coding test',
      'I understand this position is fully on-site', 'Estou de acordo com o modelo de trabalho presencial',
      'I acknowledge receipt of the employee handbook', 'I accept the terms and conditions of the offer',
      'Aceito os termos e condições de trabalho', 'I do not agree to the privacy policy', 'Não concordo com a política de privacidade',
      'I agree to receive the privacy policy by mail', 'I agree to the processing of my biometric data',
      'I agree to the processing of my personal data by third parties', 'I consent to the transfer of my personal data outside the EU'])
      isNotConsent(label, 'personal');
    for (const label of ['Read our privacy policy here', 'Link to the privacy policy of your last project', 'Have you worked with LGPD compliance?'])
      isNotConsent(label, null);
  });

  it('answerByRule applies the same test whatever category the model gave', () => {
    expect(answerByRule(select('Privacy Policy', ['I agree', 'I do not agree']), 'consent', ctx)).toBe('I agree');
    expect(answerByRule(select('I agree to the privacy policy; I will work on-site', ['Yes', 'No']), 'consent', ctx)).toBeUndefined();
    expect(answerByRule(select('Have you implemented a privacy policy page?', ['Yes', 'No']), 'consent', ctx)).toBeUndefined();
  });
});

describe('fix round 2: sensitive wordings', () => {
  it('catches pay, work authorisation, availability, race, veteran status and age', () => {
    for (const label of ['What is your expected annual package?', 'Quanto você quer receber por mês?',
      'Do you need employer support to work in Germany?', 'Em quanto tempo você pode assumir a vaga?',
      'How many weeks notice do you need to give?'])
      expect(classifyByRule(q(label)), label).toBe('personal');
    for (const label of ['Como você se declara quanto à cor?', 'Já serviu às Forças Armadas?', 'What is your age?', 'Quantos anos você tem?',
      'Você tem mais de 18 anos?', 'Are you 18 or older?'])
      expect(classifyByRule(q(label)), label).toBe('demographic');
  });

  it('still leaves years of experience and a privacy notice alone', () => {
    expect(classifyByRule(q('Quantos anos de experiência com React?'))).toBeNull();
    expect(classifyByRule(q('Quantos anos você tem de experiência com Java?'))).toBeNull();
    expect(classifyByRule(q('What is the average team size you managed?'))).toBeNull();
    expect(classifyByRule(q('I have read the Privacy Notice', { kind: 'boolean' }))).toBe('consent');
  });
});

describe('fix round 3: words that point elsewhere, purposes, help text, military', () => {
  const box = (label: string, help = '') => q(label, { kind: 'boolean', help });
  const verdict = (label: string, help = '') => [classifyByRule(box(label, help), 'Acme'), answerByRule(box(label, help), 'consent', ctx)];
  const consent = (label: string, help = '') => expect(verdict(label, help), `${label} | ${help}`).toEqual(['consent', true]);
  const personal = (label: string, help = '') => expect(verdict(label, help), `${label} | ${help}`).toEqual(['personal', undefined]);

  it('agreeing to "the above", "this", "these" or "it" next to an allowed object is not consent', () => {
    for (const label of ['I agree to all of the above and to the privacy policy',
      'I have read and agree to all of the above and the Privacy Policy', 'Li e concordo com o acima e com a política de privacidade',
      'I accept these and the privacy policy', 'I accept this and the privacy policy', 'I accept it and the terms of use',
      'Concordo com esta e com a política de privacidade', 'I agree to the privacy policy linked here and above'])
      personal(label);
  });

  it('a pointing word is accepted as the determiner of an object or of the application', () => {
    // Fix round 4, R2: "the above privacy policy" e "the following terms of use" passaram para a recusa (teste do round 4).
    for (const label of ['I agree to this privacy policy', 'I accept these terms of use',
      'By submitting this form, I agree to the privacy policy',
      'I consent to the processing of my personal data for this recruitment process',
      'Concordo com esta política de privacidade', 'Aceito estes termos de uso', 'Ao enviar esta candidatura, concordo com a política de privacidade',
      'Autorizo o tratamento dos meus dados pessoais neste processo seletivo', 'Declaro que as informações desta candidatura são verdadeiras'])
      consent(label);
  });

  it('a locative right after an object is no longer accepted (fix round 4, R2)', () => {
    for (const label of ['I agree to the privacy policy above', 'I accept the terms of use below', 'I have read the privacy notice linked here',
      'Concordo com a política de privacidade acima', 'Aceito os termos de uso disponíveis aqui', 'I agree to the privacy policy linked below',
      'Li o aviso de privacidade abaixo', 'Li os termos de uso a seguir'])
      personal(label);
    // "available" cai antes no padrão sensível de disponibilidade (over-catch aceito); a resposta segue o classificador.
    personal('I agree to the privacy policy available here');
  });

  it('the same pointing words anywhere else are a remainder', () => {
    for (const label of ['I agree to this', 'I agree to the above', 'Concordo com o acima', 'Aceito isto e os termos de uso',
      'I agree to the privacy policy and the following', 'I accept the same and the privacy policy', 'I agree to the privacy policy this',
      'Concordo com a política de privacidade e com isso', 'I acknowledge the terms of use herein', 'Click here to accept the privacy policy'])
      personal(label);
  });

  it('"that" and "que" are filler only when they open a clause', () => {
    personal('I accept that and the privacy policy');
    personal('I agree to that.');
    consent('Declaro que li a política de privacidade');
    consent('I confirm that I have read the privacy policy');
  });

  it('"hereby" and "por meio desta" point at the act and are fine', () => {
    consent('I hereby accept the terms of use');
    consent('Por meio desta, declaro que as informações prestadas são verdadeiras');
  });

  it('"purposes" and "fins" count only inside the application phrase', () => {
    for (const label of ['I consent to the processing of my personal data for all purposes',
      'I consent to the processing of my personal data for marketing purposes', 'Autorizo o tratamento dos meus dados para quaisquer fins',
      'Declaro, para os devidos fins, que as informações prestadas são verdadeiras'])
      personal(label);
    for (const label of ['I consent to the processing of my personal data',
      'I consent to the processing of my personal data for the purposes of this application',
      'I consent to the processing of my personal data for recruitment purposes',
      'Autorizo o tratamento dos meus dados pessoais para fins de processo seletivo',
      'Autorizo o tratamento dos meus dados pessoais para os fins do recrutamento'])
      consent(label);
  });

  it('a help text must pass the same test', () => {
    personal('Privacy Policy', 'By checking this you also agree to work weekends');
    personal('I agree to the privacy policy', 'Você também concorda em trabalhar aos sábados');
    consent('Privacy Policy', 'Required to process your application');
    // Fix round 4, R2: "aqui"/"here" sobram também no texto de ajuda.
    personal('Política de privacidade', 'Leia a política de privacidade aqui');
    personal('I agree to the privacy policy', 'Read our privacy policy here');
  });

  it('own probes: refused', () => {
    for (const label of ['I agree to these privacy policies and the above', 'I accept this privacy policy and this',
      'I agree to the terms of use above and below', 'I agree to everything above and the privacy policy',
      'Concordo com o exposto acima e com os termos de uso', 'Li e concordo com os termos acima', 'I agree that', 'Declaro que',
      'I agree to the privacy policy and that', 'Aceito a política de privacidade e isso', 'I agree to the privacy policy herein',
      'I consent to the processing of my personal data for any purpose', 'Autorizo o tratamento dos meus dados para fins comerciais',
      'Autorizo o tratamento dos meus dados pessoais para fins de marketing', 'Li e aceito a política de privacidade desta empresa'])
      personal(label);
    personal('Privacy Policy', 'You also agree to be contacted for other roles');
    personal('Termos de uso', 'Ao marcar, você aceita a cláusula de exclusividade');
    personal('Privacy Policy', 'See https://acme.com/privacy');
    personal('I agree to the privacy policy', 'This includes on-call shifts');
  });

  it('own probes: accepted', () => {
    // Fix round 4, R2: "linked above" e as ajudas com "linked here"/"abaixo" passaram para a recusa.
    personal('I agree to the privacy policy linked above');
    personal('Privacy Policy', 'Please read our privacy policy linked here');
    personal('Termos de uso', 'Consulte os termos de uso abaixo');
    for (const label of ['Concordo com estes termos de uso',
      'Li e concordo com a política de privacidade deste processo seletivo', 'I confirm the information in this form is accurate',
      'I consent to the processing of my personal data for the purpose of this recruitment process',
      'Autorizo o tratamento dos meus dados para fins de seleção'])
      consent(label);
    consent('I agree to the privacy policy', 'Required');
    consent('Aceito a política de privacidade', 'Obrigatório');
  });

  it('any mention of the military is demographic', () => {
    for (const label of ['Have you served in the military?', 'Do you have military experience?', 'Você é reservista?',
      'Have you served in the army?', 'Já foi militar?', 'Have you served in the Navy?', 'Você prestou serviço militar?'])
      expect(classifyByRule(q(label)), label).toBe('demographic');
    expect(classifyByRule(select('Status', ['Militar', 'Civil']))).toBe('demographic');
    expect(classifyByRule(q('Situação', { help: 'Informe se é militar da ativa' }))).toBe('demographic');
  });
});

describe('fix round 4: a closed rule set for pointing words, boundaries, the company name and "all"', () => {
  const box = (label: string, help = '') => q(label, { kind: 'boolean', help });
  const verdict = (label: string, help = '', company = 'Acme') => {
    const rc: RuleContext = { ...ctx, job: { ...ctx.job, company } };
    return [classifyByRule(box(label, help), company), answerByRule(box(label, help), 'consent', rc)];
  };
  const consent = (label: string, help = '', company = 'Acme') =>
    expect(verdict(label, help, company), `${label} | ${help} | ${company}`).toEqual(['consent', true]);
  const personal = (label: string, help = '', company = 'Acme') =>
    expect(verdict(label, help, company), `${label} | ${help} | ${company}`).toEqual(['personal', undefined]);

  it('the inputs of the review are refused', () => {
    for (const label of ['I agree to the above, privacy policy and terms of use', 'I agree to all of the above. Privacy Policy',
      'I accept all the above, Terms of Use and Privacy Policy', 'Concordo com o acima, política de privacidade e termos de uso',
      'I agree to it. Privacy Policy', 'Li e concordo com isso política de privacidade', 'I agree to same privacy policy',
      'I agree to that, the privacy policy', 'I accept that, the privacy policy and the terms of use',
      'I agree to the above process and the privacy policy', 'I accept the following process and the privacy policy',
      'I accept the above selection and the privacy policy', 'I agree to the above form and the privacy policy',
      'I certify that the statements above are true', 'I confirm all of the above information and answers are true'])
      personal(label);
    personal('I agree to the privacy policy', 'Read the above form');
    personal('I agree to the privacy policy', 'Read this process');
  });

  it('R1: punctuation is a boundary', () => {
    personal('I agree to this, privacy policy');
    consent('I agree to this privacy policy');
    personal('Concordo com esta, política de privacidade');
    consent('Concordo com esta política de privacidade');
    // Hífen e apóstrofo dentro da palavra não são fronteira.
    consent("I've read the privacy notice");
    consent("I agree to Acme's privacy policy");
  });

  it('R2: a pointing word is never filler, also after an object', () => {
    for (const label of ['I agree to the privacy policy above', 'I accept the terms of use below', 'I have read the privacy notice linked here',
      'Concordo com a política de privacidade acima', 'Aceito os termos de uso disponíveis aqui', 'I agree to the privacy policy linked below',
      'Li o aviso de privacidade abaixo', 'Li os termos de uso a seguir', 'I have read the above privacy policy',
      'I accept the following terms of use', 'I agree to the privacy policy attached', 'I accept the aforementioned terms of use',
      'Concordo com os referidos termos de uso', 'Aceito os mesmos termos de uso', 'Aceito tais termos de uso', 'I accept such terms of use',
      'Declaro que as informações acima são verdadeiras'])
      personal(label);
    personal('Política de privacidade', 'Leia a política de privacidade aqui');
    personal('Privacy Policy', 'Please read our privacy policy linked here');
  });

  it('R3: a demonstrative is accepted only before an allowed object or an application phrase', () => {
    for (const label of ['I agree to this privacy policy', 'I accept these terms of use', 'Concordo com esta política de privacidade',
      'Aceito estes termos de uso', 'By submitting this application, I agree to the privacy policy',
      'By submitting this job application, I agree to the privacy policy', 'By submitting this form, I agree to the privacy policy',
      'I consent to the processing of my personal data for this recruitment process',
      'I consent to the processing of my personal data for this hiring process',
      'Ao enviar esta candidatura, concordo com a política de privacidade', 'Ao enviar este formulário, concordo com a política de privacidade',
      'Autorizo o tratamento dos meus dados pessoais neste processo seletivo',
      'Autorizo o tratamento dos meus dados pessoais neste processo de recrutamento',
      'Li e concordo com a política de privacidade deste processo de seleção',
      'I certify that the information provided in this application is true and complete'])
      consent(label);
    for (const label of ['I agree to the privacy policy for this role', 'Concordo com a política de privacidade e com esta jornada',
      'I agree to the privacy policy for this process', 'I agree to the privacy policy for this selection',
      'Autorizo o tratamento dos meus dados neste processo', 'I accept this and the privacy policy', 'I agree to these: privacy policy'])
      personal(label);
  });

  it('R4: "that" and "que" before a conjunction, a boundary or nothing are a remainder', () => {
    personal('I agree to that, the privacy policy');
    personal('I accept that and the privacy policy');
    personal('Aceito a política de privacidade e que.');
    consent('I confirm that I have read the privacy policy');
  });

  it('R6: the company is removed only as its whole name', () => {
    personal('I agree to the privacy policy and remote work', '', 'Acme Remote Work');
    consent('I agree to the privacy policy of Acme Remote Work', '', 'Acme Remote Work');
    consent("Please review and acknowledge Acme's Candidate Privacy Policy", '', 'Acme');
    consent("I agree to Acme Inc's privacy policy", '', 'Acme Inc.');
    consent('Concordo com a política de privacidade da Acme', '', 'Acme S.A.');
    consent('Concordo com a política de privacidade da Acme Ltda', '', 'Acme');
    personal('Aceito os termos de uso da Beta', '', 'Beta Tecnologia Ltda');
  });

  it('R6b: the company name is removed only right before an object or right after a preposition', () => {
    personal('I agree to the privacy policy and remote', '', 'Remote');
    consent('I agree to the Remote privacy policy', '', 'Remote');
    consent('I agree to the privacy policy of Remote', '', 'Remote');
    personal('I agree to the privacy policy and Acme Remote Work', '', 'Acme Remote Work');
    consent('I agree to the privacy policy of the Acme', '', 'Acme');
    consent('I consent to the processing of my data by Acme', '', 'Acme');
    personal('Acme: I agree to the privacy policy', '', 'Acme');
    personal('I agree to the privacy policy, Acme', '', 'Acme');
    personal('I agree to Acme, privacy policy', '', 'Acme');
    personal('I agree to the privacy policy for Acme', '', 'Acme');
  });

  it('R7: "all" and "any" only directly before the information noun of a truthfulness phrase', () => {
    personal('I agree to the processing of my personal data for all applications');
    personal('I agree to all terms of use');
    personal('Aceito todos os termos de uso');
    personal('Autorizo o tratamento dos meus dados em qualquer processo seletivo');
    for (const label of ['I certify that all information provided is true', 'I certify that all of the information is accurate',
      'Declaro que todas as informações são verdadeiras', 'I hereby certify that all the information I have provided is true, accurate and complete'])
      consent(label);
  });

  it('the positive forms of rounds 2 and 3 still pass', () => {
    for (const label of ['I agree to the privacy policy', 'Li e concordo com a política de privacidade', 'I accept the terms of use',
      'Aceito os termos de uso', 'I consent to the processing of my personal data', 'Autorizo o tratamento dos meus dados pessoais conforme a LGPD',
      'I certify that the information provided is true and complete', 'Declaro que as informações prestadas são verdadeiras',
      'Privacy Policy', 'Termos de uso', 'Li e concordo com os termos de uso e a política de privacidade'])
      consent(label);
  });

  it('own probes: wrong acceptances are refused', () => {
    // Pontuação.
    for (const label of ['I accept this - the privacy policy', 'I agree to this (privacy policy)', 'Concordo com esta; política de privacidade',
      'I agree to "this" privacy policy', 'I agree to the privacy policy.\nThat', 'I certify that the information is true. All',
      'I agree to that\nprivacy policy', 'I agree to the privacy policy / and the following']) personal(label);
    // Palavras de ligação que somadas diriam algo.
    for (const label of ['I agree to the privacy policy and you may submit my data', 'I agree to the privacy policy for any form',
      'I agree to the privacy policy for every application', 'Aceito a política de privacidade para qualquer processo seletivo',
      'Concordo com a política de privacidade de todo o processo']) personal(label);
    // Nome da empresa.
    personal('I agree to the privacy policy and Acme Remote', '', 'Acme Remote Work');
    personal('I agree to the privacy policy of Remote Work', '', 'Acme Remote Work');
    personal('I agree to the privacy policy, Acme, Remote Work', '', 'Acme Remote Work');
    personal('I agree to the privacy policy of Inc', '', 'Acme Inc');
    // Texto de ajuda.
    personal('I agree to the privacy policy', 'Including all of the above');
    personal('I agree to the privacy policy', 'This');
    personal('Privacy Policy', 'Privacy Policy, Terms of Use, and the above');
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
