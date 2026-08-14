import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    include: ['apps/desktop/tests/**/*.e2e.ts'],
    setupFiles: ['./scripts/test-invariants.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})
