/**
 * Grava de novo as fixtures locais dos sites reais (só leitura, nunca envia).
 * Uso: pnpm apply:fixtures [--site greenhouse|lever|all] [--board <b>] [--job <id>] [--company <c>] [--posting <id>]
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    site: { type: 'string', default: 'all' },
    board: { type: 'string', default: 'gitlab' },
    job: { type: 'string', default: '8704363002' },
    company: { type: 'string', default: 'palantir' },
    posting: { type: 'string', default: '6ed76ce8-4156-4b60-b120-403538bd66cd' },
  },
});
const root = fileURLToPath(new URL('..', import.meta.url));
const record = (args: string[]): void => {
  const run = spawnSync('pnpm', ['exec', 'tsx', 'packages/apply/scripts/record-fixture.ts', ...args], { cwd: root, stdio: 'inherit', shell: true });
  if (run.status !== 0) process.exit(run.status ?? 1);
};

const sites = ['greenhouse', 'lever'];
if (values.site !== 'all' && !sites.includes(values.site!)) {
  console.error(`site sem gravação configurada: ${values.site}`);
  process.exit(1);
}
const wanted = (site: string): boolean => values.site === 'all' || values.site === site;

if (wanted('greenhouse')) {
  const { board, job } = values;
  record(['json', '--url', `"https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${job}?questions=true"`, '--out', 'packages/apply/fixtures/greenhouse/job.json']);
  record(['replay', '--url', `"https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${job}"`, '--out', 'packages/apply/fixtures/greenhouse/form']);
}
if (wanted('lever')) {
  const { company, posting } = values;
  record(['replay', '--url', `"https://jobs.lever.co/${company}/${posting}/apply"`, '--out', 'packages/apply/fixtures/lever/form']);
  // As páginas do Lever podem não ter `main`: guarda o `body`. A segunda é a de uma vaga que não existe.
  record(['snapshot', '--url', `"https://jobs.lever.co/${company}/${posting}/apply"`, '--keep', 'body', '--out', 'packages/apply/fixtures/lever/rendered.html']);
  record(['snapshot', '--url', `"https://jobs.lever.co/${company}/00000000-0000-0000-0000-000000000000/apply"`, '--keep', 'body', '--out', 'packages/apply/fixtures/lever/closed.html']);
}
