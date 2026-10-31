import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Use a non-default HMR port to avoid conflicts with other Vite instances
      // or tools that also use 24678. Set DISABLE_HMR=true to skip HMR entirely.
      hmr: process.env.DISABLE_HMR !== 'true'
        ? { port: 24679, host: 'localhost' }
        : false,
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
