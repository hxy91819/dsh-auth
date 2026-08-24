import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseCollaborationSessionId } from './auth-state.js'
import type { ResolvedConfig } from './config.js'
import { hasSameOrigin, HttpError, readForm, write, writeJson } from './http.js'
import type { PublicSessionCollaboration, SessionAuthentication, SessionStore } from './session.js'

interface CollaborationContext {
  readonly config: ResolvedConfig
  readonly sessions: SessionStore
  readonly now: () => number
  readonly validCsrf: (req: IncomingMessage, submitted: string | null) => boolean
  readonly renewalHeaders: (authenticated: SessionAuthentication) => Record<string, string | string[]>
}

export function collaborationDocument(collaboration: PublicSessionCollaboration | undefined): {
  readonly sessionId: string
  readonly createdAt: string
  readonly lastSeenAt: string
  readonly participants: readonly {
    readonly id: string
    readonly username: string
    readonly role: string
    readonly status: string
    readonly firstSeenAt: string
    readonly lastSeenAt: string
    readonly promptCount: number
    readonly current: boolean
  }[]
} | undefined {
  if (collaboration === undefined) return undefined
  return {
    sessionId: collaboration.sessionId,
    createdAt: new Date(collaboration.createdAt).toISOString(),
    lastSeenAt: new Date(collaboration.lastSeenAt).toISOString(),
    participants: collaboration.participants.map(participant => ({
      id: participant.id,
      username: participant.username,
      role: participant.role,
      status: participant.status,
      firstSeenAt: new Date(participant.firstSeenAt).toISOString(),
      lastSeenAt: new Date(participant.lastSeenAt).toISOString(),
      promptCount: participant.promptCount,
      current: participant.current,
    })),
  }
}

export function optionalCollaborationSessionId(value: string | null): string | undefined {
  if (value === null) return undefined
  try {
    return parseCollaborationSessionId(value)
  } catch {
    throw new HttpError(400, 'invalid collaboration session')
  }
}

function requiredCollaborationSessionId(form: URLSearchParams): string {
  if (form.getAll('sessionId').length !== 1) throw new HttpError(400, 'invalid collaboration session')
  try {
    return parseCollaborationSessionId(form.get('sessionId'))
  } catch {
    throw new HttpError(400, 'invalid collaboration session')
  }
}

function collaborationActivity(value: string | null): 'prompt' | 'view' {
  if (value === 'prompt' || value === 'view') return value
  throw new HttpError(400, 'invalid collaboration activity')
}

export async function handleCollaborationSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CollaborationContext,
): Promise<void> {
  if (req.method !== 'POST') {
    write(res, 405, 'method not allowed', { allow: 'POST', 'cache-control': 'no-store' })
    return
  }
  if (!hasSameOrigin(req, ctx.config)) throw new HttpError(403, 'cross-origin request denied')
  const form = await readForm(req)
  if (!ctx.validCsrf(req, form.get('csrf'))) throw new HttpError(403, 'invalid CSRF token')
  const authenticated = ctx.sessions.authenticate(req, ctx.now())
  if (authenticated === undefined) {
    writeJson(res, 401, { authenticated: false })
    return
  }
  const sessionId = requiredCollaborationSessionId(form)
  const activity = collaborationActivity(form.get('activity'))
  const collaboration = collaborationDocument(
    ctx.sessions.recordSessionActivity(sessionId, authenticated.session, ctx.now(), activity),
  )
  writeJson(res, 200, {
    recorded: collaboration !== undefined,
    ...(collaboration === undefined ? {} : { collaboration }),
  }, ctx.renewalHeaders(authenticated))
}
