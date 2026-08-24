import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveRuntimeContext, type DesktopRuntimeApp } from '../src/runtime-context.ts'

function fakeApp(overrides: Partial<DesktopRuntimeApp> = {}): DesktopRuntimeApp {
  return {
    isPackaged: true,
    getPath: name => name === 'appData' ? 'C:\\Users\\tester\\AppData\\Roaming' : 'C:\\Users\\tester',
    getVersion: () => '1.2.3',
    ...overrides,
  }
}

describe('resolveRuntimeContext', () => {
  it('uses only installed resources and product-owned mutable paths when packaged', () => {
    const resources = 'C:\\Program Files\\DeepSeek Harness\\resources'
    const roaming = 'C:\\Users\\tester\\AppData\\Roaming'
    const home = 'C:\\Users\\tester'
    const resolveDevelopmentCli = vi.fn(() => 'must-not-resolve')

    const context = resolveRuntimeContext(fakeApp({
      getPath: name => name === 'appData' ? roaming : home,
    }), {
      resourcesPath: resources,
      environment: {
        DEEPSEEK_API_KEY: 'credential',
        DSH_HOME: 'C:\\Users\\tester\\.dsh',
        NODE_PATH: 'C:\\node',
        PNPM_HOME: 'C:\\pnpm',
        INIT_CWD: 'D:\\repository',
        npm_config_local_prefix: 'D:\\repository',
        npm_package_json: 'D:\\repository\\package.json',
        npm_lifecycle_event: 'start',
        npm_lifecycle_script: 'electron .',
        PNPM_SCRIPT_SRC_DIR: 'D:\\repository',
        ORDINARY: 'kept',
      },
      resolveDevelopmentCli,
    })

    const productData = join(roaming, 'DeepSeek Harness')
    expect(context).toEqual({
      cliEntry: join(resources, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      cwd: home,
      environment: {
        DEEPSEEK_API_KEY: 'credential',
        DSH_HOME: join(productData, 'Harness'),
        DSH_DESKTOP_APP_VERSION: '1.2.3',
        ORDINARY: 'kept',
      },
      harnessHome: join(productData, 'Harness'),
      logs: join(productData, 'logs'),
      productData,
    })
    expect(resolveDevelopmentCli).not.toHaveBeenCalled()
  })

  it('resolves the workspace CLI explicitly while retaining isolated runtime paths in development', () => {
    const resolveDevelopmentCli = vi.fn(() => 'D:\\repository\\apps\\cli\\lib\\bin.js')
    const environment: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'credential' }

    const context = resolveRuntimeContext(fakeApp({ isPackaged: false }), {
      resourcesPath: 'D:\\repository\\node_modules\\electron\\dist\\resources',
      environment,
      resolveDevelopmentCli,
    })

    expect(context.cliEntry).toBe('D:\\repository\\apps\\cli\\lib\\bin.js')
    expect(context.cwd).toBe('C:\\Users\\tester')
    expect(context.environment).toEqual({
      DEEPSEEK_API_KEY: 'credential',
      DSH_HOME: join('C:\\Users\\tester\\AppData\\Roaming', 'DeepSeek Harness', 'Harness'),
      DSH_DESKTOP_APP_VERSION: '1.2.3',
    })
    expect(environment).toEqual({ DEEPSEEK_API_KEY: 'credential' })
    expect(resolveDevelopmentCli).toHaveBeenCalledWith('@deepseek-ai/dsh/lib/bin.js')
  })

  it('scrubs redirecting Windows environment keys case-insensitively without mutating the input', () => {
    const environment: NodeJS.ProcessEnv = {
      dSh_HoMe: 'C:\\Users\\tester\\.dsh',
      dsh_desktop_app_version: 'spoofed',
      Node_Path: 'C:\\node',
      pnPm_Home: 'C:\\pnpm',
      init_cwd: 'D:\\repository',
      NPM_CONFIG_LOCAL_PREFIX: 'D:\\repository',
      Npm_Package_Json: 'D:\\repository\\package.json',
      NPM_LIFECYCLE_EVENT: 'start',
      Npm_Lifecycle_Script: 'electron .',
      pnpm_script_src_dir: 'D:\\repository',
      DEEPSEEK_API_KEY: 'credential',
      Ordinary_Value: 'kept',
    }
    const originalEnvironment = { ...environment }

    const context = resolveRuntimeContext(fakeApp(), {
      resourcesPath: 'C:\\Program Files\\DeepSeek Harness\\resources',
      environment,
      resolveDevelopmentCli: vi.fn(() => 'must-not-resolve'),
    })

    expect(context.environment).toEqual({
      DEEPSEEK_API_KEY: 'credential',
      Ordinary_Value: 'kept',
      DSH_HOME: join('C:\\Users\\tester\\AppData\\Roaming', 'DeepSeek Harness', 'Harness'),
      DSH_DESKTOP_APP_VERSION: '1.2.3',
    })
    expect(environment).toEqual(originalEnvironment)
  })
})
