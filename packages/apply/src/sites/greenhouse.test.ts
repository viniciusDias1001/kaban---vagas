import { describe, expect, it } from 'vitest';
import { SiteLayoutError } from '../types';
import { job } from './fixtures';
import { greenhouseTarget, mapGreenhouseQuestions } from './greenhouse';
import { matchOption } from './shared';

describe('greenhouseTarget', () => {
  it.each([
    ['https://job-boards.greenhouse.io/gitlab/jobs/8638232002', 'gitlab-8638232002', 'gitlab', '8638232002'],
    ['https://boards.greenhouse.io/acme-corp/jobs/4012345?gh_jid=4012345', 'acme-corp-4012345', 'acme-corp', '4012345'],
    ['https://job-boards.greenhouse.io/embed/job_app?for=acme-corp&token=4012345', '', 'acme-corp', '4012345'],
    ['https://stripe.com/jobs/search?gh_jid=7001234', 'stripe-7001234', 'stripe', '7001234'],
    ['https://careers.acme.com/open?gh_jid=4012345', 'acme-corp-4012345', 'acme-corp', '4012345'],
  ])('recognises %s', (url, externalId, board, jobId) => {
    expect(greenhouseTarget(job({ url, externalId }))).toEqual({
      site: 'greenhouse',
      url: `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${jobId}`,
      ref: { board, jobId },
    });
  });

  it('does not recognise what the rule leaves out', () => {
    expect(greenhouseTarget(job({ source: 'remotive', url: 'https://careers.acme.com/open?gh_jid=1', externalId: 'x' }))).toBeNull();
    expect(greenhouseTarget(job({ url: 'https://careers.acme.com/open/123', externalId: 'acme-123' }))).toBeNull();
    expect(greenhouseTarget(job({ url: 'https://job-boards.greenhouse.io/gitlab', externalId: 'gitlab-1' }))).toBeNull();
    expect(greenhouseTarget(job({ url: 'não é url', externalId: 'acme-1' }))).toBeNull();
  });
});

describe('mapGreenhouseQuestions', () => {
  it('maps field types, options and the optional demographic block', () => {
    const list = (name: string, type: string, labels: string[]) => ({ name, type, values: labels.map((label, value) => ({ label, value })) });
    const api = {
      questions: [
        { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text', values: [] }] },
        { label: 'Resume/CV', required: true, fields: [{ name: 'resume_text', type: 'textarea', values: [] }, { name: 'resume', type: 'input_file', values: [] }] },
        { label: 'Work authorization', required: true, fields: [list('question_2', 'multi_value_single_select', ['Yes', 'No'])] },
        { label: 'Languages', required: false, fields: [list('question_3[]', 'multi_value_multi_select', ['English', 'Portuguese'])] },
        { label: 'Widget', required: false, fields: [{ name: 'question_4', type: 'tipo_novo', values: [] }] },
      ],
      compliance: [{ type: 'eeoc', questions: [{ label: 'Gender', required: false, fields: [list('gender', 'multi_value_single_select', ['Male', 'Female', 'Decline To Self Identify'])] }] }],
    };
    expect(mapGreenhouseQuestions(api).map((q) => [q.id, q.kind, q.required, q.options])).toEqual([
      ['first_name', 'text', true, []], ['resume', 'file', true, []], ['question_2', 'select', true, ['Yes', 'No']],
      ['question_3[]', 'multiselect', false, ['English', 'Portuguese']], ['gender', 'select', false, ['Male', 'Female', 'Decline To Self Identify']],
    ]);
    api.questions[4].required = true;
    expect(() => mapGreenhouseQuestions(api)).toThrow(SiteLayoutError);
  });
});

describe('matchOption', () => {
  it('compares options without approximating', () => {
    expect(matchOption(['Yes', 'No', 'Prefer not to say'], '  prefer NOT to  say ')).toBe('Prefer not to say');
    expect(matchOption(['Yes', 'No'], 'Yes, with sponsorship')).toBeNull();
    expect(matchOption(['Sim', 'Não'], 'Nao')).toBeNull();
  });
});
