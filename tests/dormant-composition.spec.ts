import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const checkout = fileURLToPath(new URL('..', import.meta.url))
const compositionFiles = ['cordis.patch.yml', 'cordis.overlay.yml'] as const

interface CompositionRow {
  readonly disabledExpression: string
  readonly configExpressions: readonly string[]
}

function loadRow(fileName: (typeof compositionFiles)[number]): CompositionRow {
  const text = readFileSync(`${checkout}${fileName}`, 'utf8')
  const disabled = [...text.matchAll(/^ {6}disabled: !!js (.+)$/gmu)]
  expect(disabled, `${fileName} must carry exactly one loader disabled expression`).toHaveLength(1)
  const configExpressions = [...text.matchAll(/^ {8}(\w+): !!js (.+)$/gmu)]
    .map(match => `${match[1] ?? ''}: ${match[2] ?? ''}`)
  expect(configExpressions.length, `${fileName} must keep env-backed config expressions`).toBeGreaterThan(0)
  return { disabledExpression: disabled[0]?.[1] ?? '', configExpressions }
}

function dormancy(expression: string, env: Record<string, string | undefined>): boolean {
  // Mirrors the loader's own evaluate(): the composition contract is an eval'd
  // JS expression, so the test must execute it the same way.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- 复现 Loader 对 disabled 表达式的 eval 语义，除执行仓库自身 YAML 外不接受任何输入。
  const evaluate = new Function('process', `"use strict"; return (${expression})`) as (process: { env: Record<string, string | undefined> }) => boolean
  return evaluate({ env })
}

describe('dormant composition contract', () => {
  it.for(compositionFiles)('keeps %s dormant only when both core variables are absent', (fileName) => {
    const row = loadRow(fileName)
    expect(row.disabledExpression).toContain('DSH_AUTH_STATE_FILE')
    expect(row.disabledExpression).toContain('DSH_AUTH_SESSION_SECRET_FILE')
    expect(dormancy(row.disabledExpression, {})).toBe(true)
  })

  it.for(compositionFiles)('keeps %s active for partial, empty, and full core configuration', (fileName) => {
    const row = loadRow(fileName)
    expect(dormancy(row.disabledExpression, { DSH_AUTH_STATE_FILE: '/var/lib/dsh-auth/state.json' })).toBe(false)
    expect(dormancy(row.disabledExpression, { DSH_AUTH_SESSION_SECRET_FILE: '/var/lib/dsh-auth/secret' })).toBe(false)
    expect(dormancy(row.disabledExpression, { DSH_AUTH_STATE_FILE: '' })).toBe(false)
    expect(dormancy(row.disabledExpression, {
      DSH_AUTH_STATE_FILE: '/var/lib/dsh-auth/state.json',
      DSH_AUTH_SESSION_SECRET_FILE: '/var/lib/dsh-auth/secret',
    })).toBe(false)
  })

  it.for(compositionFiles)('keeps %s routing core variables into strict plugin config', (fileName) => {
    const row = loadRow(fileName)
    expect(row.configExpressions).toContain('authStateFile: process.env.DSH_AUTH_STATE_FILE')
    expect(row.configExpressions).toContain('sessionSecretFile: process.env.DSH_AUTH_SESSION_SECRET_FILE')
  })
})
