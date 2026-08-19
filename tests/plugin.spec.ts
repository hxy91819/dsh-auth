import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.js'
import { testConfig, testCredentials } from './helpers.js'

const contexts: Context[] = []

class HarnessSettings extends SettingsProvider {
  readonly writable = false
  private readonly values = new Map<string, unknown>()

  set(namespace: string, value: unknown): void {
    this.values.set(namespace, value)
  }

  override get(namespace: SettingsNamespace): unknown {
    return this.values.get(namespace)
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  protected persist(): Promise<void> {
    return Promise.reject(new Error('read-only test settings'))
  }
}

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
})

describe('Cordis plugin integration', () => {
  it('registers one real WebServer route and removes it on plugin disposal', async () => {
    const credentials = await testCredentials()
    const context = new Context()
    contexts.push(context)
    const settingsFiber = context.plugin(HarnessSettings)
    await settingsFiber
    const settings = context.settings as HarnessSettings
    settings.set('locale', { preference: 'zh' })
    settings.set('ui-theme', { preference: 'dark' })
    const web = context.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    await web
    const auth = context.plugin({ name, inject, apply }, testConfig(credentials, { secureCookies: false }))
    await auth
    expect(context.logger.buffer.some(message => message.name === 'dsh-auth'
      && (message.args[0] as { event?: string } | undefined)?.event === 'auth.runtime.ready')).toBe(true)

    const index = '<!doctype html><body><div id="root"></div><script type="module">start()</script></body>'
    const bootstrapped = context.webServer.applyIndexTaps(index)
    expect(bootstrapped).toContain('<script src="/auth/browser-bootstrap.js"></script>')
    expect(bootstrapped).toContain('<meta name="dsh-auth-base-path" content="/auth">')
    expect(bootstrapped.indexOf('browser-bootstrap.js')).toBeLessThan(bootstrapped.indexOf('type="module"'))

    const url = `http://127.0.0.1:${String(context.webServer.port)}/auth/login`
    const active = await fetch(url)
    expect(active.status).toBe(200)
    const activeHtml = await active.text()
    expect(activeHtml).toContain('登录 DeepSeek Harness')
    expect(activeHtml).toContain('<body data-theme="dark">')
    expect(activeHtml).not.toContain('class="preferences"')

    settings.set('locale', { preference: 'en' })
    settings.set('ui-theme', { preference: 'light' })
    const updatedHtml = await (await fetch(url)).text()
    expect(updatedHtml).toContain('Sign in to DeepSeek Harness')
    expect(updatedHtml).toContain('<body data-theme="light">')
    const bootstrap = await fetch(`http://127.0.0.1:${String(context.webServer.port)}/auth/browser-bootstrap.js`)
    expect(bootstrap.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await bootstrap.text()).toContain('getRandomValues')

    await auth.dispose()
    expect((await fetch(url)).status).toBe(404)
    expect(context.webServer.applyIndexTaps(index)).toBe(index)

    const secureAuth = context.plugin({ name, inject, apply }, testConfig(credentials, { secureCookies: true }))
    await secureAuth
    expect(context.webServer.applyIndexTaps(index)).toContain('<meta name="dsh-auth-base-path" content="/auth">')
    expect(context.webServer.applyIndexTaps(index)).not.toContain('browser-bootstrap.js')
    expect((await fetch(`http://127.0.0.1:${String(context.webServer.port)}/auth/browser-bootstrap.js`)).status).toBe(404)
    await secureAuth.dispose()
    expect(context.webServer.applyIndexTaps(index)).toBe(index)
  }, 30_000)
})
