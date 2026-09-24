/** Verify that the published Windows update manifest names the exact installer bytes. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import yaml from 'js-yaml'

/**
 * Render only the reviewed GitHub update provider for packaged applications.
 * @param builderConfig - Full electron-builder configuration text.
 * @returns The update provider configuration embedded in the application.
 */
export function renderPackagedUpdateConfig(builderConfig: string): string {
  const config: unknown = yaml.load(builderConfig)
  if (config === null || typeof config !== 'object' || Array.isArray(config) || !('publish' in config)) {
    throw new Error('desktop packaging: missing explicit update publisher')
  }
  const publish = config.publish
  if (
    publish === null || typeof publish !== 'object' || Array.isArray(publish)
    || Object.keys(publish).sort().join(',') !== 'owner,provider,repo'
    || !('provider' in publish) || publish.provider !== 'github'
    || !('owner' in publish) || publish.owner !== 'devin2255'
    || !('repo' in publish) || publish.repo !== 'deepseek-harness-desktop'
  ) {
    throw new Error('desktop packaging: update publisher must be this repository')
  }
  return yaml.dump({ provider: publish.provider, owner: publish.owner, repo: publish.repo })
}

/**
 * Verify that installed update settings still match the reviewed builder publisher.
 * @param configPath - Embedded app-update.yml file.
 * @param builderConfigPath - Reviewed electron-builder configuration file.
 */
export async function verifyPackagedUpdateConfig(configPath: string, builderConfigPath: string): Promise<void> {
  const status = await lstat(configPath)
  if (!status.isFile() || status.isSymbolicLink()) throw new Error('desktop update: packaged publisher must be an ordinary file')
  const expected = renderPackagedUpdateConfig(await readFile(builderConfigPath, 'utf8'))
  if (await readFile(configPath, 'utf8') !== expected) {
    throw new Error('desktop update: packaged publisher differs from reviewed configuration')
  }
}

/**
 * Reject a release manifest that points outside its installer directory or names different bytes.
 * @param manifestPath - Exact `latest.yml` file emitted by electron-builder.
 * @param installerPath - Installer that the release publishes.
 * @param expectedVersion - Desktop package version.
 */
export async function verifyWindowsUpdateManifest(
  manifestPath: string,
  installerPath: string,
  expectedVersion: string,
): Promise<void> {
  const manifest = resolve(manifestPath)
  const installer = resolve(installerPath)
  if (dirname(manifest) !== dirname(installer) || basename(manifest) !== 'latest.yml') {
    throw new Error('desktop update: manifest and installer must share one exact output directory')
  }
  const manifestStatus = await lstat(manifest)
  const installerStatus = await lstat(installer)
  if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink() || !installerStatus.isFile() || installerStatus.isSymbolicLink()) {
    throw new Error('desktop update: manifest and installer must be ordinary files')
  }
  const parsed: unknown = yaml.load(await readFile(manifest, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('desktop update: invalid Windows release manifest')
  }
  const { version, files, path, sha512 } = parsed as Record<string, unknown>
  if (version !== expectedVersion || path !== basename(installer) || !Array.isArray(files) || files.length !== 1) {
    throw new Error('desktop update: release manifest version or installer identity differs')
  }
  const file: unknown = files[0]
  if (file === null || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error('desktop update: invalid installer entry')
  }
  const { url, sha512: fileHash, size } = file as Record<string, unknown>
  if (url !== basename(installer) || typeof fileHash !== 'string' || fileHash !== sha512) {
    throw new Error('desktop update: installer entry differs from the release manifest')
  }
  if (size !== undefined && size !== installerStatus.size) {
    throw new Error('desktop update: installer size differs from the release manifest')
  }
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(installer)) hash.update(chunk as Buffer)
  if (hash.digest('base64') !== fileHash) {
    throw new Error('desktop update: installer SHA-512 differs from the release manifest')
  }
}
