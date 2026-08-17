import { dirname, isAbsolute, join } from 'node:path'
import type { InstallerHost, NginxDiscovery, SetupRequest } from './types.js'

const MINIMUM_NGINX_VERSION = [1, 24, 0] as const

function listenEndpoint(address: string, port: number): string {
  return address.includes(':') ? `[${address}]:${String(port)}` : `${address}:${String(port)}`
}

function protectedLocations(upstream: string, secure: boolean): string {
  const hsts = secure ? '        add_header Strict-Transport-Security "max-age=31536000" always;\n' : ''
  return `
    client_max_body_size 170m;

${hsts}    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "same-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Set-Cookie $dsh_auth_renew_cookie always;

    location = /_dsh_auth_verify {
        internal;
        proxy_pass http://dsh_auth_upstream/auth/verify;
        proxy_method GET;
        proxy_pass_request_body off;
        proxy_set_header Content-Length '';
        proxy_set_header Cookie $http_cookie;
        proxy_set_header X-Original-URI $request_uri;
        proxy_set_header X-Original-Method $request_method;
        proxy_set_header Host ${upstream};
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location = /auth/verify { return 404; }
    location = /auth { return 303 /auth/login; }

    location = /auth/login {
        client_max_body_size 20k;
        limit_req zone=dsh_auth_login burst=4 nodelay;
        limit_req_status 429;
        proxy_pass http://dsh_auth_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host ${upstream};
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location ^~ /auth/ {
        client_max_body_size 20k;
        proxy_pass http://dsh_auth_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host ${upstream};
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location = /api {
        auth_request /_dsh_auth_verify;
        auth_request_set $dsh_auth_renew_cookie $upstream_http_set_cookie;
        proxy_pass http://dsh_auth_upstream;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_set_header Host ${upstream};
        proxy_set_header Origin http://${upstream};
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $dsh_connection_upgrade;
        expires epoch;
    }

    location ^~ /api/ {
        auth_request /_dsh_auth_verify;
        auth_request_set $dsh_auth_renew_cookie $upstream_http_set_cookie;
        proxy_pass http://dsh_auth_upstream;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header Host ${upstream};
        proxy_set_header Origin http://${upstream};
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $dsh_connection_upgrade;
        expires epoch;
    }

    location = /plugins/events {
        auth_request /_dsh_auth_verify;
        auth_request_set $dsh_auth_renew_cookie $upstream_http_set_cookie;
        auth_request_set $dsh_auth_login_url $upstream_http_x_dsh_auth_login;
        error_page 401 = @dsh_auth_login;
        proxy_pass http://dsh_auth_upstream;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
        proxy_set_header Host ${upstream};
    }

    location / {
        auth_request /_dsh_auth_verify;
        auth_request_set $dsh_auth_renew_cookie $upstream_http_set_cookie;
        auth_request_set $dsh_auth_login_url $upstream_http_x_dsh_auth_login;
        error_page 401 = @dsh_auth_login;
        proxy_pass http://dsh_auth_upstream;
        proxy_http_version 1.1;
        proxy_set_header Host ${upstream};
        proxy_set_header Origin http://${upstream};
    }

    location @dsh_auth_login {
        add_header Cache-Control "no-store, max-age=0" always;
${hsts}        add_header X-Content-Type-Options "nosniff" always;
        add_header X-Frame-Options "DENY" always;
        add_header Referrer-Policy "same-origin" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
        return 303 $dsh_auth_login_url;
    }
`
}

/**
 * Render the complete project-owned Nginx http include.
 * @param request - validated setup values.
 * @returns Nginx configuration without unresolved operator placeholders.
 */
export function renderNginxConfig(request: SetupRequest): string {
  const upstream = request.upstream
  const common = `# Managed by dsh-auth. Use dsh-auth setup/uninstall; do not edit in place.
map $http_upgrade $dsh_connection_upgrade {
    default upgrade;
    '' close;
}

map $request_method $dsh_auth_login_limit_key {
    default '';
    POST $binary_remote_addr;
}

limit_req_zone $dsh_auth_login_limit_key zone=dsh_auth_login:10m rate=5r/m;

upstream dsh_auth_upstream {
    server ${upstream};
    keepalive 32;
}

`
  if (request.mode === 'http') {
    return `${common}server {
    listen ${listenEndpoint(request.listenAddress, request.httpPort)};
    server_name _;
${protectedLocations(upstream, false)}}
`
  }
  const serverName = request.serverName ?? ''
  const certificate = request.certificate ?? ''
  const certificateKey = request.certificateKey ?? ''
  const redirectAuthority = request.httpsPort === 443 ? serverName : `${serverName}:${String(request.httpsPort)}`
  return `${common}map $host $dsh_public_host_allowed {
    default 0;
    ${serverName} 1;
}

server {
    listen ${listenEndpoint(request.listenAddress, request.httpPort)};
    server_name ${serverName};
    if ($dsh_public_host_allowed = 0) { return 421; }
    return 308 https://${redirectAuthority}$request_uri;
}

server {
    listen ${listenEndpoint(request.listenAddress, request.httpsPort)} ssl http2;
    server_name ${serverName};
    if ($dsh_public_host_allowed = 0) { return 421; }

    ssl_certificate ${certificate};
    ssl_certificate_key ${certificateKey};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:DSHAuthTLS:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
${protectedLocations(upstream, true)}}
`
}

function versionSupported(version: string): boolean {
  const parts = version.split('.').map(Number)
  const actual = [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
  for (let index = 0; index < MINIMUM_NGINX_VERSION.length; index += 1) {
    const difference = (actual[index] ?? 0) - (MINIMUM_NGINX_VERSION[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

function resolveInclude(configPath: string, config: string): string | undefined {
  const activeConfig = config.split('\n').map(line => line.replace(/#.*$/u, '')).join('\n')
  const tokens = activeConfig.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[{};]|[^\s{};]+/gu) ?? []
  const blocks: string[] = []
  let directive: string[] = []
  const matches: string[] = []
  for (const token of tokens) {
    if (token === '{') {
      blocks.push(directive[0] ?? '')
      directive = []
    } else if (token === '}') {
      blocks.pop()
      directive = []
    } else if (token === ';') {
      if (blocks.length === 1 && blocks[0] === 'http' && directive[0] === 'include' && directive[1] !== undefined) {
        matches.push(directive[1].replace(/^(?:"|')|(?:"|')$/gu, ''))
      }
      directive = []
    } else {
      directive.push(token)
    }
  }
  for (const suffix of ['/conf.d/*.conf', '/sites-enabled/*']) {
    const selected = matches.find(value => value.endsWith(suffix))
    if (selected !== undefined) {
      const pattern = isAbsolute(selected) ? selected : join(dirname(configPath), selected)
      return join(dirname(pattern), 'dsh-auth.conf')
    }
  }
  return undefined
}

/** Discover Nginx without changing host state. */
export function discoverNginx(host: InstallerHost): NginxDiscovery {
  const executable = ['/usr/sbin/nginx', '/usr/bin/nginx', '/sbin/nginx'].find(candidate => host.regularFile(candidate))
  const systemctl = ['/usr/bin/systemctl', '/bin/systemctl'].find(candidate => host.regularFile(candidate))
  if (executable === undefined) {
    return {
      installed: false,
      versionSupported: false,
      authRequestModule: false,
      serviceManager: systemctl === undefined ? 'none' : 'systemd',
      ...(systemctl === undefined ? {} : { serviceName: 'nginx.service' as const }),
    }
  }
  let serviceLoadState: string | undefined
  if (systemctl !== undefined) {
    const service = host.run({ executable: systemctl, args: ['show', 'nginx.service', '--property=LoadState', '--value'] })
    if (service.status === 0 && service.error === undefined) serviceLoadState = service.stdout.trim()
  }
  const result = host.run({ executable, args: ['-V'] })
  const output = `${result.stdout}\n${result.stderr}`
  const version = /nginx\/([0-9]+(?:\.[0-9]+){1,2})/u.exec(output)?.[1]
  const configPath = /--conf-path=([^\s]+)/u.exec(output)?.[1]
  let includePath: string | undefined
  if (configPath !== undefined && isAbsolute(configPath) && host.regularFile(configPath)) {
    includePath = resolveInclude(configPath, host.readFile(configPath))
  }
  return {
    installed: true,
    executable,
    ...(version === undefined ? {} : { version }),
    versionSupported: version !== undefined && versionSupported(version),
    authRequestModule: output.includes('--with-http_auth_request_module'),
    ...(configPath === undefined ? {} : { configPath }),
    ...(includePath === undefined ? {} : { includePath }),
    serviceManager: systemctl === undefined ? 'none' : 'systemd',
    ...(serviceLoadState === 'loaded' ? { serviceName: 'nginx.service' as const, serviceLoadState } : serviceLoadState === undefined ? {} : { serviceLoadState }),
  }
}
