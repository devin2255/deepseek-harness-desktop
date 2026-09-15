/** Overview sizing and keyboard focus must survive narrow desktop columns. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('uses semantic tokens, wrapping content, and keyboard-visible controls', () => {
  const css = readFileSync(new URL('../src/client/TaskOverview.module.css', import.meta.url), 'utf8')
  expect(css).toContain('min-width: 0')
  expect(css).toContain('overflow-wrap: anywhere')
  expect(css).toContain(':focus-visible')
  expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i)
  expect(css).not.toMatch(/--dsw-color/)
})
