/** dsh-auth Cordis plugin: mounts standalone authentication routes on the DSH WebServer. */
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { AuthApplication } from './application.js'
import { injectAuthBasePath, injectBrowserBootstrap } from './browser-bootstrap.js'
import { Config } from './config.js'
import type { ResolvedConfig } from './config.js'
import { createAuthEventLogger } from './logging.js'

export { Config }
export type { ConfigInput, ResolvedConfig } from './config.js'
export { hashPassword, parsePasswordHash, verifyPassword } from './password.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-auth'

const LOCALE_NAMESPACE = settingsNamespace('locale')
const THEME_NAMESPACE = settingsNamespace('ui-theme')

/** DSH services required before the authentication route can register. */
export const inject = ['webServer', 'settings']

/** Register the `/auth` prefix using the WebServer's reversible route effect. */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const hostLogger = ctx.logger(name)
  const logger = createAuthEventLogger(
    hostLogger,
    () => ctx.logger.exporters.size > 1,
    line => { process.stderr.write(line) },
  )
  const application = new AuthApplication(config, Date.now, () => ({
    locale: ctx.settings.get(LOCALE_NAMESPACE),
    theme: ctx.settings.get(THEME_NAMESPACE),
  }), logger)
  logger.info({
    event: 'auth.runtime.ready',
    secureCookies: config.secureCookies,
    loginTokenEnabled: config.loginTokenEnabled,
  })
  const route: WebRoute = {
    kind: 'prefix',
    path: config.basePath,
    handler: (req, res) => application.handle(req, res),
  }
  ctx.effect(() => ctx.webServer.register(route), `dsh-auth: ${config.basePath} route`)
  ctx.effect(
    () => ctx.webServer.tapIndex((html) => {
      const withBasePath = injectAuthBasePath(html, config.basePath)
      return config.secureCookies ? withBasePath : injectBrowserBootstrap(withBasePath, config.basePath)
    }),
    'dsh-auth: browser metadata and optional HTTP bootstrap',
  )
}
