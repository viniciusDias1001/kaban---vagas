import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openIndeedSession } from '../src/indeed';

// Uso: INDEED_HEADFUL=1 pnpm --filter @kv/connectors exec tsx scripts/record-indeed-detail.ts <jk>
const jk = process.argv[2];
if (!jk) {
  console.error('uso: record-indeed-detail.ts <jk de 16 caracteres>');
  process.exit(1);
}
const session = await openIndeedSession();
try {
  const html = await session.html(`https://br.indeed.com/viewjob?jk=${jk}`, 50_000, '#jobDescriptionText');
  const out = fileURLToPath(new URL('../fixtures/indeed-detail.html', import.meta.url));
  writeFileSync(out, html);
  console.log('gravado', out, `${html.length} bytes`);
} finally {
  await session.close();
}
