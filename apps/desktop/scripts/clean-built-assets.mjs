import { cleanBuiltAssets } from './built-asset-root.mjs'

await cleanBuiltAssets(new URL('../', import.meta.url))
