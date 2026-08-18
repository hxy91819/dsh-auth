import type { UiLanguage, UiPreferences } from './preferences.js'
import type { AuthSession } from './session.js'

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

interface UiCopy {
  readonly signInTitle: string
  readonly username: string
  readonly password: string
  readonly signIn: string
  readonly invalidCredentials: string
  readonly rateLimited: string
  readonly accountTitle: string
  readonly accountLede: string
  readonly userId: string
  readonly roles: string
  readonly returnToHarness: string
  readonly signOut: string
  readonly tokenTitle: string
  readonly tokenLede: string
  readonly tokenNoscript: string
  readonly tokenFailure: string
}

const COPY: Readonly<Record<UiLanguage, UiCopy>> = {
  zh: {
    signInTitle: '登录 DeepSeek Harness',
    username: '用户名',
    password: '密码',
    signIn: '登录',
    invalidCredentials: '用户名或密码不正确。',
    rateLimited: '尝试次数过多，请稍后再试。',
    accountTitle: '账户',
    accountLede: '当前浏览器已登录 DeepSeek Harness。',
    userId: '用户 ID',
    roles: '角色',
    returnToHarness: '返回 Harness',
    signOut: '退出登录',
    tokenTitle: '一次性登录',
    tokenLede: '正在完成一次性登录…',
    tokenNoscript: '此登录链接需要启用 JavaScript。请回到云控制台，在允许 JavaScript 的浏览器中重新打开该链接。',
    tokenFailure: '登录链接无效、已过期或已被使用。请回到云控制台重新获取链接。',
  },
  en: {
    signInTitle: 'Sign in to DeepSeek Harness',
    username: 'Username',
    password: 'Password',
    signIn: 'Sign in',
    invalidCredentials: 'The username or password is incorrect.',
    rateLimited: 'Too many attempts. Try again later.',
    accountTitle: 'Account',
    accountLede: 'This browser is signed in to DeepSeek Harness.',
    userId: 'User ID',
    roles: 'Roles',
    returnToHarness: 'Return to Harness',
    signOut: 'Sign out',
    tokenTitle: 'One-time sign-in',
    tokenLede: 'Completing one-time sign-in…',
    tokenNoscript: 'This sign-in link requires JavaScript. Return to your cloud console and reopen the link in a browser with JavaScript enabled.',
    tokenFailure: 'The sign-in link is invalid, expired, or already used. Request a new link from your cloud console.',
  },
}

export type AuthMessage = 'invalidCredentials' | 'rateLimited'

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
): string {
  const copy = COPY[preferences.language]
  const notice = message === undefined ? '' : `<p class="notice" role="alert">${escapeHtml(copy[message])}</p>`
  return document(copy.signInTitle, `<section class="content">
    <h1>${escapeHtml(copy.signInTitle)}</h1>
    ${notice}
    <form class="login-form" method="post" action="${escapeHtml(basePath)}/login">
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
    </form>
  </section>`, preferences)
}

/** Render the standalone account and logout page. */
export function accountPage(
  basePath: string,
  session: AuthSession,
  csrfToken: string,
  preferences: UiPreferences,
): string {
  const copy = COPY[preferences.language]
  const roles = session.user.roles.join(', ')
  return document(copy.accountTitle, `<section class="content">
    <h1>${escapeHtml(copy.accountTitle)}</h1>
    <p class="lede">${escapeHtml(copy.accountLede)}</p>
    <div class="details"><dl>
      <div class="detail"><dt>${escapeHtml(copy.username)}</dt><dd>${escapeHtml(session.user.username)}</dd></div>
      <div class="detail"><dt>${escapeHtml(copy.userId)}</dt><dd>${escapeHtml(session.user.userId)}</dd></div>
      <div class="detail"><dt>${escapeHtml(copy.roles)}</dt><dd>${escapeHtml(roles)}</dd></div>
    </dl></div>
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
