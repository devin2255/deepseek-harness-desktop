/** Cordis Loader configuration file discovery. */

import { globSync } from 'node:fs'

/**
 * Return repository-relative Cordis Loader YAML paths under `root`.
 *
 * Translation consistency records are YAML sidecars, never Loader inputs.
 *
 * @param root Repository root to scan.
 * @returns Sorted repository-relative Loader configuration paths with `/` separators.
 */
export function cordisConfigFiles(root: string): string[] {
  return globSync(['**/*cordis*.yml', '**/*cordis*.yaml'], {
    cwd: root,
    exclude: ['.claude/**', 'node_modules/**', 'vendor/**', '**/*.i18n.yaml'],
  }).map(normalizeCordisConfigPath).sort()
}

/**
 * Normalize a repository-relative Loader config path for prefix and set checks.
 * @param path The path returned by a host filesystem glob.
 * @returns The same path with `/` separators.
 */
export function normalizeCordisConfigPath(path: string): string {
  return path.replaceAll('\\', '/')
}
