import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { execSync } from 'node:child_process'

// Build-time git SHA + timestamp so the footer can show what's running.
// On Vercel: prefer VERCEL_GIT_COMMIT_SHA (env-injected by the platform).
// Locally: fall back to `git rev-parse`. If neither works, "dev".
function gitSha(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
  }
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

// @aztec/aztec.js was designed for Node and touches `process`, `Buffer`,
// and a few other Node globals at import time. Polyfill them so the browser
// bundle can load the SDK.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
    }),
  ],
  define: {
    __APP_GIT_SHA__: JSON.stringify(gitSha()),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
})
