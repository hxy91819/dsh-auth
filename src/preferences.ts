import type { IncomingMessage } from 'node:http'

/** Languages rendered by the standalone authentication UI. */
export const UI_LANGUAGES = ['zh', 'en'] as const

/** Appearance preferences rendered by the standalone authentication UI. */
export const UI_THEMES = ['light', 'dark', 'system'] as const

export type UiLanguage = typeof UI_LANGUAGES[number]
export type UiTheme = typeof UI_THEMES[number]

/** Harness-owned settings sections sampled for one authentication page request. */
export interface HarnessUiSettings {
  readonly locale?: unknown
  readonly theme?: unknown
}

/** Language and appearance resolved from Harness settings and the browser locale. */
export interface UiPreferences {
  readonly language: UiLanguage
  readonly theme: UiTheme
}

function isLanguage(value: unknown): value is UiLanguage {
  return UI_LANGUAGES.some(language => language === value)
}

function isTheme(value: unknown): value is UiTheme {
  return UI_THEMES.some(theme => theme === value)
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value.join(',') : value
}

function browserLanguage(req: IncomingMessage): UiLanguage {
  const header = headerValue(req, 'accept-language')
  if (header === undefined) return 'en'
  const candidates = header.split(',').map((entry, index) => {
    const [tag = '', ...parameters] = entry.trim().toLowerCase().split(';')
    const qValue = parameters.find(parameter => parameter.trim().startsWith('q='))?.trim().slice(2)
    const parsed = qValue === undefined ? 1 : Number(qValue)
    const quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0
    return { tag, quality, index }
  }).sort((left, right) => right.quality - left.quality || left.index - right.index)
  for (const candidate of candidates) {
    if (candidate.quality === 0) continue
    if (candidate.tag === 'zh' || candidate.tag.startsWith('zh-')) return 'zh'
    if (candidate.tag === 'en' || candidate.tag.startsWith('en-')) return 'en'
  }
  return 'en'
}

function preference(section: unknown): unknown {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  return (section as Record<string, unknown>).preference
}

/** Resolve the same locale fallback and theme preference used by Harness. */
export function resolveUiPreferences(req: IncomingMessage, settings: HarnessUiSettings = {}): UiPreferences {
  const locale = preference(settings.locale)
  const theme = preference(settings.theme)
  return {
    language: isLanguage(locale) ? locale : browserLanguage(req),
    theme: isTheme(theme) ? theme : 'system',
  }
}
