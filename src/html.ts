import type { UiLanguage, UiPreferences } from './preferences.js'
import type { AuthSession } from './session.js'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface UiCopy {
  readonly signInTitle: string
  readonly username: string
  readonly password: string
  readonly confirmPassword: string
  readonly signIn: string
  readonly invalidCredentials: string
  readonly rateLimited: string
  readonly cloudConsole: string
  readonly accountTitle: string
  readonly accountLede: string
  readonly accountConfigured: string
  readonly accountUnconfigured: string
  readonly userId: string
  readonly roles: string
  readonly returnToHarness: string
  readonly signOut: string
  readonly resetPassword: string
  readonly resetPasswordTitle: string
  readonly resetPasswordLede: string
  readonly resetPasswordSave: string
  readonly currentPassword: string
  readonly newPassword: string
  readonly currentPasswordInvalid: string
  readonly passwordUpdatedTitle: string
  readonly passwordUpdatedLede: string
  readonly tokenTitle: string
  readonly tokenLede: string
  readonly tokenNoscript: string
  readonly tokenFailure: string
  readonly setupTitle: string
  readonly setupLede: string
  readonly setupSave: string
  readonly setupLater: string
  readonly setupCompleteTitle: string
  readonly setupCompleteLede: string
  readonly setupForbidden: string
  readonly usernameWhitespace: string
  readonly usernameInvalid: string
  readonly passwordInvalid: string
  readonly passwordMismatch: string
}

const COPY: Readonly<Record<UiLanguage, UiCopy>> = {
  zh: {
    signInTitle: '登录 DeepSeek Harness',
    username: '用户名',
    password: '密码',
    confirmPassword: '确认密码',
    signIn: '登录',
    invalidCredentials: '用户名或密码不正确。',
    rateLimited: '尝试次数过多，请稍后再试。',
    cloudConsole: '请从云控制台登录。',
    accountTitle: '账户',
    accountLede: '当前浏览器已登录 DeepSeek Harness。',
    accountConfigured: '管理员凭据已配置。',
    accountUnconfigured: '管理员凭据尚未配置。本次登录不会再次自动提醒。',
    userId: '用户 ID',
    roles: '角色',
    returnToHarness: '返回 Harness',
    signOut: '退出登录',
    resetPassword: '重设密码',
    resetPasswordTitle: '重设密码',
    resetPasswordLede: '输入当前密码并设置新密码。成功后，其他会话将退出。',
    resetPasswordSave: '保存新密码',
    currentPassword: '当前密码',
    newPassword: '新密码',
    currentPasswordInvalid: '当前密码不正确。',
    passwordUpdatedTitle: '密码已更新',
    passwordUpdatedLede: '新密码已生效。其他浏览器会话已退出，当前会话可以继续使用。',
    tokenTitle: '一次性登录',
    tokenLede: '正在完成一次性登录…',
    tokenNoscript: '此登录链接需要启用 JavaScript。请回到云控制台，在允许 JavaScript 的浏览器中重新打开该链接。',
    tokenFailure: '登录链接无效、已过期或已被使用。请回到云控制台重新获取链接。',
    setupTitle: '设置管理员账户',
    setupLede: '为此实例设置管理员用户名和密码，或选择稍后进入 Harness。',
    setupSave: '保存',
    setupLater: '稍后',
    setupCompleteTitle: '管理员已设置',
    setupCompleteLede: '管理员凭据已经建立。当前会话可以继续使用。',
    setupForbidden: '此页面仅用于首次令牌登录。',
    usernameWhitespace: '用户名不能包含首尾空白。',
    usernameInvalid: '用户名须为 1–64 个字符，且不能包含控制字符。',
    passwordInvalid: '密码须为 15–128 个字符，且不超过 1024 字节。',
    passwordMismatch: '两次输入的密码不一致。',
  },
  en: {
    signInTitle: 'Sign in to DeepSeek Harness',
    username: 'Username',
    password: 'Password',
    confirmPassword: 'Confirm password',
    signIn: 'Sign in',
    invalidCredentials: 'The username or password is incorrect.',
    rateLimited: 'Too many attempts. Try again later.',
    cloudConsole: 'Sign in from the cloud console.',
    accountTitle: 'Account',
    accountLede: 'This browser is signed in to DeepSeek Harness.',
    accountConfigured: 'Administrator credentials are configured.',
    accountUnconfigured: 'Administrator credentials are not configured. This session will not remind you again.',
    userId: 'User ID',
    roles: 'Roles',
    returnToHarness: 'Return to Harness',
    signOut: 'Sign out',
    resetPassword: 'Reset password',
    resetPasswordTitle: 'Reset password',
    resetPasswordLede: 'Enter the current password and choose a new one. Other sessions will be signed out after a successful change.',
    resetPasswordSave: 'Save new password',
    currentPassword: 'Current password',
    newPassword: 'New password',
    currentPasswordInvalid: 'The current password is incorrect.',
    passwordUpdatedTitle: 'Password updated',
    passwordUpdatedLede: 'The new password is in effect. Other browser sessions have been signed out. This session can continue.',
    tokenTitle: 'One-time sign-in',
    tokenLede: 'Completing one-time sign-in…',
    tokenNoscript: 'This sign-in link requires JavaScript. Return to your cloud console and reopen the link in a browser with JavaScript enabled.',
    tokenFailure: 'The sign-in link is invalid, expired, or already used. Request a new link from your cloud console.',
    setupTitle: 'Set up the administrator account',
    setupLede: 'Set an administrator username and password for this instance, or continue to Harness later.',
    setupSave: 'Save',
    setupLater: 'Later',
    setupCompleteTitle: 'Administrator already set up',
    setupCompleteLede: 'Administrator credentials are already configured. This session can continue.',
    setupForbidden: 'This page is only available during first-time token sign-in.',
    usernameWhitespace: 'Username must not have leading or trailing whitespace.',
    usernameInvalid: 'Username must be 1-64 characters without control characters.',
    passwordInvalid: 'Password must be 15-128 characters and at most 1024 bytes.',
    passwordMismatch: 'The passwords do not match.',
  },
}

export type AuthMessage = 'invalidCredentials' | 'rateLimited'
export type SetupMessage = 'usernameWhitespace' | 'usernameInvalid' | 'passwordInvalid' | 'passwordMismatch'
export type PasswordChangeMessage = 'currentPasswordInvalid' | 'passwordInvalid' | 'passwordMismatch' | 'rateLimited'

const STYLE = `
:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --dsw-static-deepseek-500: rgb(65, 118, 230);
  --dsw-static-neutral-bluish-00: rgb(255, 255, 255);
  --dsw-static-neutral-bluish-50: rgb(249, 250, 251);
  --dsw-static-neutral-bluish-60: rgb(245, 246, 247);
  --dsw-static-neutral-bluish-75: rgb(241, 243, 245);
  --dsw-static-neutral-bluish-100: rgb(235, 238, 242);
  --dsw-static-neutral-bluish-400: rgb(173, 178, 184);
  --dsw-static-neutral-bluish-600: rgb(129, 133, 140);
  --dsw-static-neutral-bluish-700: rgb(97, 102, 107);
  --dsw-static-neutral-bluish-750: rgb(67, 69, 74);
  --dsw-static-neutral-bluish-850: rgb(44, 44, 46);
  --dsw-static-neutral-bluish-875: rgb(35, 35, 36);
  --dsw-static-neutral-bluish-950: rgb(21, 21, 23);
  --dsw-static-neutral-bluish-1000: rgb(15, 17, 21);
  --dsw-static-red-50: rgb(254, 242, 242);
  --dsw-static-red-600: rgb(236, 19, 19);
}
* { box-sizing: border-box; }
body {
  --bg-canvas: var(--dsw-static-neutral-bluish-60);
  --bg-panel: var(--dsw-static-neutral-bluish-00);
  --bg-control: var(--dsw-static-neutral-bluish-60);
  --bg-control-hover: var(--dsw-static-neutral-bluish-75);
  --bg-control-active: var(--dsw-static-neutral-bluish-100);
  --label-primary: var(--dsw-static-neutral-bluish-1000);
  --label-secondary: var(--dsw-static-neutral-bluish-700);
  --label-tertiary: var(--dsw-static-neutral-bluish-600);
  --border-l2: rgb(0 0 0 / 10%);
  --border-l4: rgb(0 0 0 / 16%);
  --button-fill: var(--dsw-static-neutral-bluish-1000);
  --button-hover: var(--dsw-static-neutral-bluish-750);
  --button-label: var(--dsw-static-neutral-bluish-00);
  --error-label: var(--dsw-static-red-600);
  --error-bg: var(--dsw-static-red-50);
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg-canvas);
  color: var(--label-primary);
  font-family: inherit;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
body[data-theme='dark'] {
  color-scheme: dark;
  --bg-canvas: var(--dsw-static-neutral-bluish-950);
  --bg-panel: var(--dsw-static-neutral-bluish-850);
  --bg-control: var(--dsw-static-neutral-bluish-875);
  --bg-control-hover: var(--dsw-static-neutral-bluish-750);
  --bg-control-active: var(--dsw-static-neutral-bluish-700);
  --label-primary: var(--dsw-static-neutral-bluish-50);
  --label-secondary: rgb(207, 211, 214);
  --label-tertiary: var(--dsw-static-neutral-bluish-400);
  --border-l2: rgb(255 255 255 / 12%);
  --border-l4: rgb(255 255 255 / 20%);
  --button-fill: var(--dsw-static-neutral-bluish-50);
  --button-hover: var(--dsw-static-neutral-bluish-100);
  --button-label: var(--dsw-static-neutral-bluish-1000);
  --error-label: rgb(242, 90, 90);
  --error-bg: rgb(87, 12, 12);
}
@media (prefers-color-scheme: dark) {
  body[data-theme='system'] {
    color-scheme: dark;
    --bg-canvas: var(--dsw-static-neutral-bluish-950);
    --bg-panel: var(--dsw-static-neutral-bluish-850);
    --bg-control: var(--dsw-static-neutral-bluish-875);
    --bg-control-hover: var(--dsw-static-neutral-bluish-750);
    --bg-control-active: var(--dsw-static-neutral-bluish-700);
    --label-primary: var(--dsw-static-neutral-bluish-50);
    --label-secondary: rgb(207, 211, 214);
    --label-tertiary: var(--dsw-static-neutral-bluish-400);
    --border-l2: rgb(255 255 255 / 12%);
    --border-l4: rgb(255 255 255 / 20%);
    --button-fill: var(--dsw-static-neutral-bluish-50);
    --button-hover: var(--dsw-static-neutral-bluish-100);
    --button-label: var(--dsw-static-neutral-bluish-1000);
    --error-label: rgb(242, 90, 90);
    --error-bg: rgb(87, 12, 12);
  }
}
.panel {
  width: min(100%, 560px);
  overflow: hidden;
  border: 1px solid var(--border-l2);
  border-radius: 24px;
  background: var(--bg-panel);
  box-shadow: 0 24px 64px rgb(0 0 0 / 16%), 0 2px 8px rgb(0 0 0 / 8%);
}
.panel-header {
  display: flex;
  align-items: center;
  min-height: 68px;
  padding: 20px 28px;
  border-bottom: 1px solid var(--border-l2);
}
.brand { font-size: 16px; line-height: 24px; font-weight: 500; letter-spacing: -.01em; }
.content { padding: 32px 40px 36px; }
h1 { margin: 0; font-size: 24px; line-height: 32px; font-weight: 500; letter-spacing: -.02em; }
.lede { margin: 8px 0 28px; color: var(--label-secondary); font-size: 14px; line-height: 22px; }
form { display: flex; flex-direction: column; }
.login-form { margin-top: 28px; }
.field { display: flex; flex-direction: column; gap: 8px; }
.field + .field { margin-top: 18px; }
label { font-size: 14px; line-height: 22px; font-weight: 400; }
input {
  width: 100%;
  height: 44px;
  padding: 10px 14px;
  border: 1px solid var(--border-l2);
  border-radius: 12px;
  outline: none;
  background: var(--bg-control);
  color: var(--label-primary);
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
  transition: border-color .1s ease, box-shadow .1s ease, background-color .1s ease;
}
input:hover { border-color: var(--border-l4); }
input:focus-visible { border-color: var(--dsw-static-deepseek-500); box-shadow: 0 0 0 3px rgb(65 118 230 / 18%); background: var(--bg-panel); }
button, .button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 44px;
  margin-top: 24px;
  padding: 10px 16px;
  border: 1px solid transparent;
  border-radius: 12px;
  background: var(--button-fill);
  color: var(--button-label);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  text-decoration: none;
  cursor: pointer;
  transition: background-color .1s ease, box-shadow .1s ease;
}
button:hover, .button:hover { background: var(--button-hover); }
button:focus-visible, .button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgb(65 118 230 / 22%); }
.secondary { margin-top: 20px; border-color: var(--border-l2); background: transparent; color: var(--label-primary); }
.secondary:hover { background: var(--bg-control-hover); }
.notice { margin: 20px 0 0; padding: 11px 12px; border: 1px solid color-mix(in srgb, var(--error-label) 18%, transparent); border-radius: 12px; background: var(--error-bg); color: var(--error-label); font-size: 13px; line-height: 20px; }
.details { margin-top: 28px; padding: 4px 16px; border: 1px solid var(--border-l2); border-radius: 16px; background: var(--bg-control); }
dl { margin: 0; }
.detail { display: grid; grid-template-columns: minmax(80px, auto) 1fr; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--border-l2); font-size: 14px; line-height: 22px; }
.detail:last-child { border-bottom: 0; }
dt { color: var(--label-secondary); }
dd { margin: 0; overflow-wrap: anywhere; text-align: right; }
@media (max-width: 620px) {
  body { place-items: start center; padding: 20px 12px; }
  .panel { border-radius: 20px; }
  .panel-header { padding: 18px 22px; }
  .content { padding: 28px 24px 32px; }
}
@media (prefers-reduced-motion: reduce) { input, button, .button { transition: none; } }
`

function document(
  title: string,
  content: string,
  preferences: UiPreferences,
  extraHead = '',
): string {
  const languageTag = preferences.language === 'zh' ? 'zh-CN' : 'en'
  return `<!doctype html>
<html lang="${languageTag}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${escapeHtml(title)} · DeepSeek Harness</title>
  <style>${STYLE}</style>
${extraHead}</head>
<body data-theme="${preferences.theme}">
  <main class="panel" data-screen-label="Authentication">
    <header class="panel-header"><div class="brand">DeepSeek Harness</div></header>
    ${content}
  </main>
</body>
</html>`
}

/** Render the standalone accessible login page. */
export function loginPage(
  basePath: string,
  returnTo: string,
  csrfToken: string,
  preferences: UiPreferences,
  message?: AuthMessage,
  passwordLogin = true,
): string {
  const copy = COPY[preferences.language]
  const notice = message === undefined ? '' : `<p class="notice" role="alert">${escapeHtml(copy[message])}</p>`
  const form = passwordLogin
    ? `<form class="login-form" method="post" action="${escapeHtml(basePath)}/login">
      <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <div class="field">
        <label for="username">${escapeHtml(copy.username)}</label>
        <input id="username" name="username" type="text" autocomplete="username" maxlength="128" required autofocus>
      </div>
      <div class="field">
        <label for="password">${escapeHtml(copy.password)}</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
      </div>
      <button type="submit">${escapeHtml(copy.signIn)}</button>
    </form>`
    : `<p class="lede">${escapeHtml(copy.cloudConsole)}</p>`
  return document(copy.signInTitle, `<section class="content">
    <h1>${escapeHtml(copy.signInTitle)}</h1>
    ${notice}
    ${form}
  </section>`, preferences)
}

/** Render the standalone account and logout page. */
export function accountPage(
  basePath: string,
  session: AuthSession,
  csrfToken: string,
  preferences: UiPreferences,
  configured = true,
): string {
  const copy = COPY[preferences.language]
  const roles = session.user.roles.join(', ')
  const status = configured ? copy.accountConfigured : copy.accountUnconfigured
  return document(copy.accountTitle, `<section class="content">
    <h1>${escapeHtml(copy.accountTitle)}</h1>
    <p class="lede">${escapeHtml(copy.accountLede)}</p>
    <p class="lede">${escapeHtml(status)}</p>
    <div class="details"><dl>
      <div class="detail"><dt>${escapeHtml(copy.username)}</dt><dd>${escapeHtml(session.user.username)}</dd></div>
      <div class="detail"><dt>${escapeHtml(copy.userId)}</dt><dd>${escapeHtml(session.user.userId)}</dd></div>
      <div class="detail"><dt>${escapeHtml(copy.roles)}</dt><dd>${escapeHtml(roles)}</dd></div>
    </dl></div>
    ${configured ? `<a class="button secondary" href="${escapeHtml(basePath)}/admin/password">${escapeHtml(copy.resetPassword)}</a>` : ''}
    <a class="button secondary" href="/">${escapeHtml(copy.returnToHarness)}</a>
    <form method="post" action="${escapeHtml(basePath)}/logout">
      <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
      <button type="submit">${escapeHtml(copy.signOut)}</button>
    </form>
  </section>`, preferences)
}

/** Failure copy for the one-time token flow, honoring per-language operator overrides. */
export interface TokenFailureMessages {
  readonly zh?: string
  readonly en?: string
}

function tokenFailureMessage(preferences: UiPreferences, messages: TokenFailureMessages): string {
  return (preferences.language === 'zh' ? messages.zh : messages.en) ?? COPY[preferences.language].tokenFailure
}

/** Render the fragment bridge page; it never contains or consumes a token. */
export function tokenBridgePage(
  basePath: string,
  csrfToken: string,
  preferences: UiPreferences,
  failures: TokenFailureMessages,
): string {
  const copy = COPY[preferences.language]
  return document(copy.tokenTitle, `<section class="content">
    <h1>${escapeHtml(copy.tokenTitle)}</h1>
    <p class="lede">${escapeHtml(copy.tokenLede)}</p>
    <noscript><p class="notice" role="alert">${escapeHtml(copy.tokenNoscript)}</p></noscript>
    <p class="notice" role="alert" id="dsh-auth-token-error" hidden>${escapeHtml(tokenFailureMessage(preferences, failures))}</p>
  </section>`, preferences, `  <meta name="dsh-auth-csrf" content="${escapeHtml(csrfToken)}">
  <script src="${escapeHtml(basePath)}/token-bootstrap.js" defer></script>
`)
}

/** Render the unified token failure page used for every redemption denial. */
export function tokenFailurePage(preferences: UiPreferences, failures: TokenFailureMessages): string {
  const copy = COPY[preferences.language]
  return document(copy.tokenTitle, `<section class="content">
    <h1>${escapeHtml(copy.tokenTitle)}</h1>
    <p class="notice" role="alert">${escapeHtml(tokenFailureMessage(preferences, failures))}</p>
  </section>`, preferences)
}

/** Render the token flow rate-limit page without revealing token state. */
export function tokenRateLimitedPage(preferences: UiPreferences): string {
  const copy = COPY[preferences.language]
  return document(copy.tokenTitle, `<section class="content">
    <h1>${escapeHtml(copy.tokenTitle)}</h1>
    <p class="notice" role="alert">${escapeHtml(copy.rateLimited)}</p>
  </section>`, preferences)
}

/** Render the first-time administrator setup form for a login-token session. */
export function adminSetupPage(
  basePath: string,
  returnTo: string,
  csrfToken: string,
  preferences: UiPreferences,
  message?: SetupMessage,
): string {
  const copy = COPY[preferences.language]
  const notice = message === undefined ? '' : `<p class="notice" role="alert">${escapeHtml(copy[message])}</p>`
  return document(copy.setupTitle, `<section class="content">
    <h1>${escapeHtml(copy.setupTitle)}</h1>
    <p class="lede">${escapeHtml(copy.setupLede)}</p>
    ${notice}
    <form class="login-form" method="post" action="${escapeHtml(basePath)}/admin/setup">
      <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <div class="field">
        <label for="username">${escapeHtml(copy.username)}</label>
        <input id="username" name="username" type="text" autocomplete="username" required autofocus>
      </div>
      <div class="field">
        <label for="password">${escapeHtml(copy.password)}</label>
        <input id="password" name="password" type="password" autocomplete="new-password" required>
      </div>
      <div class="field">
        <label for="confirmPassword">${escapeHtml(copy.confirmPassword)}</label>
        <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required>
      </div>
      <button type="submit">${escapeHtml(copy.setupSave)}</button>
    </form>
    <a class="button secondary" href="${escapeHtml(returnTo)}">${escapeHtml(copy.setupLater)}</a>
  </section>`, preferences)
}

/** Render the friendly already-configured result for setup GET/POST. */
export function adminSetupCompletePage(preferences: UiPreferences, returnTo = '/'): string {
  const copy = COPY[preferences.language]
  return document(copy.setupCompleteTitle, `<section class="content">
    <h1>${escapeHtml(copy.setupCompleteTitle)}</h1>
    <p class="lede">${escapeHtml(copy.setupCompleteLede)}</p>
    <a class="button" href="${escapeHtml(returnTo)}">${escapeHtml(copy.returnToHarness)}</a>
  </section>`, preferences)
}

/** Render the authenticated password-change form. */
export function passwordChangePage(
  basePath: string,
  returnTo: string,
  csrfToken: string,
  preferences: UiPreferences,
  message?: PasswordChangeMessage,
): string {
  const copy = COPY[preferences.language]
  const notice = message === undefined ? '' : `<p class="notice" role="alert">${escapeHtml(copy[message])}</p>`
  return document(copy.resetPasswordTitle, `<section class="content">
    <h1>${escapeHtml(copy.resetPasswordTitle)}</h1>
    <p class="lede">${escapeHtml(copy.resetPasswordLede)}</p>
    ${notice}
    <form class="login-form" method="post" action="${escapeHtml(basePath)}/admin/password">
      <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <div class="field">
        <label for="currentPassword">${escapeHtml(copy.currentPassword)}</label>
        <input id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required autofocus>
      </div>
      <div class="field">
        <label for="password">${escapeHtml(copy.newPassword)}</label>
        <input id="password" name="password" type="password" autocomplete="new-password" required>
      </div>
      <div class="field">
        <label for="confirmPassword">${escapeHtml(copy.confirmPassword)}</label>
        <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required>
      </div>
      <button type="submit">${escapeHtml(copy.resetPasswordSave)}</button>
    </form>
    <a class="button secondary" href="${escapeHtml(returnTo)}">${escapeHtml(copy.returnToHarness)}</a>
  </section>`, preferences)
}

/** Render the successful password-change result. */
export function passwordChangeCompletePage(preferences: UiPreferences, returnTo = '/'): string {
  const copy = COPY[preferences.language]
  return document(copy.passwordUpdatedTitle, `<section class="content">
    <h1>${escapeHtml(copy.passwordUpdatedTitle)}</h1>
    <p class="lede">${escapeHtml(copy.passwordUpdatedLede)}</p>
    <a class="button" href="${escapeHtml(returnTo)}">${escapeHtml(copy.returnToHarness)}</a>
  </section>`, preferences)
}

/** Render the forbidden result for a non-token session on first-time setup. */
export function adminSetupForbiddenPage(preferences: UiPreferences): string {
  const copy = COPY[preferences.language]
  return document(copy.setupTitle, `<section class="content">
    <h1>${escapeHtml(copy.setupTitle)}</h1>
    <p class="notice" role="alert">${escapeHtml(copy.setupForbidden)}</p>
  </section>`, preferences)
}
