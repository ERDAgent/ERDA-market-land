import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { execSync } from 'node:child_process';

const commitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
})();

// Dev server binds localhost only (charter.md). Access is always via SSH tunnel.
export default defineConfig({
  plugins: [vue()],
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
});