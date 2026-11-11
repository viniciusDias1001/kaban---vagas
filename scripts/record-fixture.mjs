// Uso: node scripts/record-fixture.mjs <url> <arquivo-saida> [chave-do-array] [n]
// Grava a resposta de <url>. Se for JSON, corta o array (raiz ou em <chave>) para n itens.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [url, out, key = '', n = '5'] = process.argv.slice(2);
if (!url || !out) {
  console.error('uso: node scripts/record-fixture.mjs <url> <saida> [chave] [n]');
  process.exit(1);
}
const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; kanban-vagas/0.1)' } });
const text = await res.text();
let body = text;
try {
  const json = JSON.parse(text);
  const trim = (a) => a.slice(0, Number(n));
  if (Array.isArray(json)) body = JSON.stringify(trim(json), null, 1);
  else if (key && Array.isArray(json[key])) body = JSON.stringify({ ...json, [key]: trim(json[key]) }, null, 1);
  else body = JSON.stringify(json, null, 1);
} catch {
  // não é JSON: grava como veio
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, body);
console.log(res.status, out, `${body.length} bytes`);
