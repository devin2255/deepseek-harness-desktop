import { describe, expect, it } from 'vitest'
import { normalizeAria, tokenizeAriaPath } from './scaffold.ts'

const roots = [
  String.raw`C:\Users\Test User\项目 "review"\workspace`,
  '/tmp/项目 "review"/workspace',
]

describe('run-local aria paths', () => {
  it.each(roots)('tokenizes plain and JSON-escaped paths under %s', (root) => {
    const plain = `${root}/a.txt`
    const escaped = JSON.stringify(`${root}/.dsh/skills/example`).slice(1, -1)
    const snapshot = `- code: ${plain}\n- text: "Base directory: ${escaped}"\n- button "workspace"`
    const expected = '- code: {{cwd}}/a.txt\n- text: "Base directory: {{cwd}}/.dsh/skills/example"'
      + '\n- button "{{workspace}}"'
    expect(normalizeAria(snapshot, root)).toBe(expected)
    expect(tokenizeAriaPath(expected, root, '{{cwd}}')).toBe(expected)
  })

  it('recognizes slash aliases and the immediate native child separator', () => {
    const root = String.raw`C:\Users\Test\workspace`
    expect(tokenizeAriaPath(`- code: ${root}\\my-agent`, root, '{{presetRoot}}'))
      .toBe('- code: {{presetRoot}}/my-agent')
    expect(tokenizeAriaPath(`- code: ${root.replaceAll('\\', '/')}/my-agent`, root, '{{presetRoot}}'))
      .toBe('- code: {{presetRoot}}/my-agent')
    expect(tokenizeAriaPath(JSON.stringify(`${root}\\my-agent`), root, '{{presetRoot}}'))
      .toBe('"{{presetRoot}}/my-agent"')
  })

  it('preserves unrelated paths, shell commands, and meaningful status differences', () => {
    const root = String.raw`C:\Users\Test\workspace`
    const unrelated = String.raw`- code: D:\elsewhere\file.txt
- text: printf '\\n'
- button "Failed Bash Error: unknown tool bash"`
    expect(normalizeAria(unrelated, root)).toBe(unrelated)
  })
})
