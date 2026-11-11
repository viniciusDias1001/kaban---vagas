import type { Connector } from './types';

/** Conector determinístico para testes e2e. Ativado por FAKE_CONNECTORS=1. */
export const fake: Connector = {
  id: 'fake',
  name: 'Fake',
  async search() {
    return [
      {
        source: 'fake', externalId: 'fake-1', url: 'https://example.com/jobs/fake-1',
        title: 'Fake React Developer', company: 'Fake Corp', location: 'Remoto', country: 'BR',
        remote: true, stacks: ['react'], description: 'Vaga de teste com React.', postedAt: Date.now(),
      },
      {
        source: 'fake', externalId: 'fake-2', url: 'https://example.com/jobs/fake-2',
        title: 'Fake Node Engineer', company: 'Fake Corp', location: 'Remoto', country: 'BR',
        remote: true, stacks: ['node'], description: 'Vaga de teste com Node.', postedAt: Date.now(),
      },
    ];
  },
};
