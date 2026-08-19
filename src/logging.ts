import { createHmac } from 'node:crypto'

type AuthLogValue = boolean | number | string

/** Secret-free authentication event emitted through the host's logger. */
export interface AuthLogRecord {
  readonly event: string
  readonly [field: string]: AuthLogValue
}

export interface AuthEventLogger {
  info(record: AuthLogRecord): void
  warn(record: AuthLogRecord): void
  error(record: AuthLogRecord): void
}

interface HostLogger {
  info(record: AuthLogRecord): void
  warn(record: AuthLogRecord): void
  error(record: AuthLogRecord): void
}

type AuthLogLevel = keyof HostLogger

const DIAGNOSTIC_WINDOW_MS = 60_000
const DIAGNOSTIC_MAX_EVENTS = 60

/** Use stderr only when Harness has not installed a persistent Cordis exporter. */
export function createAuthEventLogger(
  host: HostLogger,
  hasExternalExporter: () => boolean,
  writeFallback: (line: string) => void,
): AuthEventLogger {
  let windowStartedAt = Date.now()
  let diagnosticEvents = 0
  let suppressedEvents = 0

  const emitUnbudgeted = (level: AuthLogLevel, record: AuthLogRecord): void => {
    host[level](record)
    if (hasExternalExporter()) return
    try {
      writeFallback(`${JSON.stringify({ level, logger: 'dsh-auth', ...record })}\n`)
    } catch {
      // Authentication must remain available if its diagnostic sink closes.
    }
  }

  const beginCurrentWindow = (): void => {
    const now = Date.now()
    if (now >= windowStartedAt && now - windowStartedAt < DIAGNOSTIC_WINDOW_MS) return
    if (suppressedEvents > 0) {
      emitUnbudgeted('warn', {
        event: 'auth.logging.suppressed',
        count: suppressedEvents,
        maxEvents: DIAGNOSTIC_MAX_EVENTS,
        windowSeconds: DIAGNOSTIC_WINDOW_MS / 1000,
      })
    }
    windowStartedAt = now
    diagnosticEvents = 0
    suppressedEvents = 0
  }

  const emit = (level: AuthLogLevel, record: AuthLogRecord): void => {
    beginCurrentWindow()
    if (level !== 'info') {
      if (diagnosticEvents >= DIAGNOSTIC_MAX_EVENTS) {
        suppressedEvents += 1
        return
      }
      diagnosticEvents += 1
    }
    emitUnbudgeted(level, record)
  }
  return {
    info: record => { emit('info', record) },
    warn: record => { emit('warn', record) },
    error: record => { emit('error', record) },
  }
}

export const silentAuthLogger: AuthEventLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Correlate abusive clients without retaining their network address in application logs. */
export function clientLogId(sessionSecret: Buffer, address: string): string {
  return createHmac('sha256', sessionSecret).update(address).digest('hex').slice(0, 16)
}

export function errorLogFields(error: unknown): { readonly errorName: string; readonly errorCode?: string } {
  if (!(error instanceof Error)) return { errorName: 'UnknownError' }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  return { errorName: error.name || 'Error', ...(code === undefined ? {} : { errorCode: code }) }
}
