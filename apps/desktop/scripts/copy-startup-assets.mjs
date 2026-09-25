import { copyBuiltAssets } from './built-asset-copy.mjs'

await copyBuiltAssets(new URL('../', import.meta.url))
