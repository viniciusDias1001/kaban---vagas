import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchIndeedHtml } from '../src/indeed';

const html = await fetchIndeedHtml('https://br.indeed.com/jobs?q=react&fromage=7');
const out = fileURLToPath(new URL('../fixtures/indeed.html', import.meta.url));
writeFileSync(out, html);
console.log('gravado', out, `${html.length} bytes`);
