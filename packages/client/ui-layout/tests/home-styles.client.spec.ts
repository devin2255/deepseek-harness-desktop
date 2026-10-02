/** Hidden conversation content must leave keyboard and accessibility navigation. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('honors the native hidden attribute despite the flex column rule', () => {
  const css = readFileSync(new URL('../src/client/AppFrame.module.css', import.meta.url), 'utf8')
  expect(css).toMatch(/\.centerCol\[hidden\],\s*\.detailsCol\[hidden\]\s*\{\s*display:\s*none;/)
})
