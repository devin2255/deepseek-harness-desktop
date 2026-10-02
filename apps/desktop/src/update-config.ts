/** Validates the signed Windows package's local update settings before enabling network checks. */
import yaml from 'js-yaml'

/**
 * Require the reviewed release owner and a code-signing publisher for automatic updates.
 * @param contents - Installed resources/app-update.yml text.
 * @returns The publisher name whose installer signature the updater must verify.
 */
export function requireDesktopUpdatePublisher(contents: string): string {
  const parsed: unknown = yaml.load(contents)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Desktop updates require packaged GitHub release settings')
  }
  const config = parsed as Record<string, unknown>
  const names = config.publisherName
  const keys = Object.keys(config).sort()
  if (
    JSON.stringify(keys) !== JSON.stringify(['owner', 'provider', 'publisherName', 'repo', 'updaterCacheDirName'])
    ||
    config.provider !== 'github'
    || config.owner !== 'devin2255'
    || config.repo !== 'deepseek-harness-desktop'
    || config.updaterCacheDirName !== '@deepseek-aidsh-desktop-updater'
    || !Array.isArray(names)
    || names.length !== 1
    || typeof names[0] !== 'string'
    || names[0].length === 0
    || names[0].length > 256
    || /[\u0000-\u001f\u007f]/u.test(names[0])
  ) {
    throw new Error('Desktop updates require the reviewed signed release configuration')
  }
  return names[0]
}
