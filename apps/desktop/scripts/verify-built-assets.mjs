import { verifyBuiltAssets } from './built-asset-root.mjs'

await verifyBuiltAssets(new URL('../', import.meta.url))
