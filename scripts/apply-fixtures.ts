/** Grava de novo as fixtures locais dos sites reais (só leitura). Uso: pnpm apply:fixtures [--site greenhouse] [--board <b>] [--job <id>] */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { site: { type: 'string', default: 'greenhouse' }, board: { type: 'string', default: 'gitlab' }, job: { type: 'string', default: '8704363002' } },
});
const root = fileURLToPath(new URL('..', import.meta.url));
const record = (args: string[]): void => {
  const run = spawnSync('pnpm', ['exec', 'tsx', 'packages/apply/scripts/record-fixture.ts', ...args], { cwd: root, stdio: 'inherit', shell: true });
  if (run.status !== 0) process.exit(run.status ?? 1);
};

if (values.site !== 'greenhouse') {
  console.error(`site sem gravação configurada: ${values.site}`);
  process.exit(1);
}
const { board, job } = values;
record(['json', '--url', `"https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${job}?questions=true"`, '--out', 'packages/apply/fixtures/greenhouse/job.json']);
record(['replay', '--url', `"https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${job}"`, '--out', 'packages/apply/fixtures/greenhouse/form']);
