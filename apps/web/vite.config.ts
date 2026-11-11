import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const inPackages = (names: string[]) => new RegExp(`[\\\\/]node_modules[\\\\/](?:${names.join('|')})[\\\\/]`);

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
