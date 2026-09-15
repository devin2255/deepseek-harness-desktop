import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    include: [
      'scripts/desktop/**/*.spec.ts',
      'apps/desktop/tests/installer-e2e-app-data.spec.ts',
      'apps/desktop/tests/installer-support.spec.ts',
      'apps/desktop/tests/packaged-isolation.e2e.ts',
      'apps/desktop/tests/installer.e2e.ts',
    ],
    setupFiles: ['./scripts/test-invariants.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
