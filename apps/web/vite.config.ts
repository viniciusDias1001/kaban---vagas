import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const ZOD_STUB_ID = '\0kv:zod-stub';
/**
 * Um `z` que aceita qualquer encadeamento (`z.string().min(1)`, `z.object({...}).partial()`) e devolve a
 * si mesmo, sem validar nada. Tentar validar com ele é erro de programação e lança na hora.
 */
const ZOD_STUB_CODE = `
const fail = () => {
  throw new Error('Os schemas Zod de @kv/shared não são empacotados no web (ver vite.config.ts). Valide no servidor.');
};
const RUNTIME = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const stub = new Proxy(function () {}, {
  get: (_target, prop) => (RUNTIME.has(prop) ? fail : stub),
  apply: () => stub,
});
export const z = stub;
export default stub;
`;

/**
 * O web usa de `@kv/shared` só tipos e constantes (COLUMNS, LIMITS...), mas elas moram no mesmo módulo dos
 * schemas Zod, que são construídos ao carregar: o Zod inteiro (~85 kB) ia para o bundle e, ao criar o
 * primeiro `z.object`, testava `new Function("")`, que a CSP da API (`script-src 'self'`) bloqueia e
 * registra como violação. Aqui o `zod` importado PELO @kv/shared é trocado por um stub inerte; API, worker
 * e testes continuam com o Zod de verdade. Se um dia o web precisar validar com um schema, a saída é
 * separar as constantes dos schemas em `packages/shared` e remover este plugin.
 */
function sharedWithoutZod(): Plugin {
  return {
    name: 'kv:shared-without-zod',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'zod' && importer && /[\\/]packages[\\/]shared[\\/]src[\\/]/.test(importer)) return ZOD_STUB_ID;
      return null;
    },
    load(id) {
      return id === ZOD_STUB_ID ? ZOD_STUB_CODE : null;
    },
  };
}

const inPackages = (names: string[]) => new RegExp(`[\\\\/]node_modules[\\\\/](?:${names.join('|')})[\\\\/]`);

export default defineConfig({
  plugins: [sharedWithoutZod(), react(), tailwindcss()],
  resolve: {
    // Mesmo alias do tsconfig e do components.json (estrutura shadcn).
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rolldownOptions: {
      output: {
        // Bibliotecas grandes e estáveis em arquivos próprios: mudam pouco entre deploys e ficam em cache
        // (os arquivos de /assets são servidos como `immutable`). As telas secundárias e o painel da vaga
        // já saem em chunks separados pelos `lazy()` do App.
        codeSplitting: {
          groups: [
            { name: 'react', test: inPackages(['react', 'react-dom', 'scheduler']), priority: 30 },
            { name: 'motion', test: inPackages(['motion', 'motion-dom', 'motion-utils', 'framer-motion']), priority: 20 },
            { name: 'dnd-query', test: inPackages(['@dnd-kit', '@tanstack']), priority: 10 },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT ?? 3333}`,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
