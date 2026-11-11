// Configuração do Railway (Infrastructure as Code): UM serviço, construído pelo Dockerfile da raiz.
//
// Este arquivo substitui o antigo railway.json: o "Config as Code" foi descontinuado pelo Railway (serviços
// novos não podem usá-lo e os arquivos existentes deixam de ser lidos em 2026-12-01).
// Docs: https://docs.railway.com/infrastructure-as-code
//
// NADA aqui é aplicado sozinho. Só `railway config apply` (depois de `railway config plan`) cria ou altera
// alguma coisa no Railway, e ele precisa do pacote `railway` instalado no repo (`pnpm add -D -w railway`).
//
// ATENÇÃO: o app ainda NÃO TEM LOGIN. Este arquivo não declara domínio público de propósito (sem `domains`,
// sem proxy TCP). Não gere domínio para o serviço no painel enquanto não existir autenticação.
import { defineRailway, github, preserve, project, service } from 'railway/iac';

export default defineRailway(() => {
  const app = service('kanban-vagas', {
    source: github('viniciusDias1001/kaban---vagas', { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    deploy: {
      // Barata e prova que a API alcança o Postgres (um count na tabela jobs).
      healthcheckPath: '/api/stats',
      // Segundos até o deploy ser dado como falho. O start aplica as migrations antes de subir a API.
      healthcheckTimeout: 120,
      // scripts/start-prod.mjs sai com código != 0 se a API ou o worker caírem: o Railway reinicia o container.
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      // Tempo entre o SIGTERM e o SIGKILL no deploy anterior. API e worker encerram sozinhos em até ~9 s.
      drainingSeconds: 15,
    },
    // Uma réplica só: o worker (busca horária + fila) e as migrations do start não foram feitos para rodar em paralelo.
    replicas: 1,
    env: {
      // Connection string do Postgres (Supabase). Defina o valor no painel do Railway; ele nunca fica no repo.
      DATABASE_URL: preserve(),
    },
  });

  return project('kanban-vagas', { resources: [app] });
});
