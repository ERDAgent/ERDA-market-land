import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Dev server binds localhost only (charter.md). Access is always via SSH tunnel.
export default defineConfig({
  plugins: [vue()],
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
});