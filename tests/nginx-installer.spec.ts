import { describe, expect, it } from 'vitest'
import { discoverNginx, renderNginxConfig } from '../src/installer/nginx.js'
import type { SetupRequest } from '../src/installer/types.js'
import { FakeInstallerHost } from './installer-helpers.js'

function request(mode: 'http' | 'https'): SetupRequest {
  return {
    mode,
    nginxPolicy: 'skip',
    authorizeNginxInstall: false,
    outputDirectory: '/output',
    profile: 'web',
    packageSource: 'dsh-auth@0.1.11',
    userId: 'admin',
    username: 'admin',
    roles: ['admin'],
    upstream: '127.0.0.1:3080',
    listenAddress: mode === 'http' ? '10.0.0.20' : '0.0.0.0',
    httpPort: mode === 'http' ? 8080 : 80,
    httpsPort: 443,
    ...(mode === 'https' ? { serverName: 'auth.example.test', certificate: '/run/tls/cert.pem', certificateKey: '/run/tls/key.pem' } : {}),
  }
}

describe('Nginx renderer', () => {
  it('renders explicit HTTPS inputs and preserves auth coverage', () => {
    const rendered = renderNginxConfig(request('https'))
    expect(rendered).toContain('listen 0.0.0.0:443 ssl http2;')
    expect(rendered).toContain('ssl_certificate /run/tls/cert.pem;')
    expect(rendered).toContain('auth_request /_dsh_auth_verify;')
    expect(rendered).toContain('location = /auth/verify { return 404; }')
    expect(rendered).not.toContain('${DSH_')
  })

  it('renders explicit trusted-network HTTP without TLS claims', () => {
    const rendered = renderNginxConfig(request('http'))
    expect(rendered).toContain('listen 10.0.0.20:8080;')
    expect(rendered).not.toContain('ssl_certificate')
    expect(rendered).not.toContain('Strict-Transport-Security')
    expect(rendered).toContain('auth_request /_dsh_auth_verify;')
  })

  it('does not treat a commented include as an active configuration entry', () => {
    const host = new FakeInstallerHost()
    host.installNginx()
    host.addFile('/etc/nginx/nginx.conf', 'events {}\nhttp { # include /etc/nginx/conf.d/*.conf;\n}\n')

    expect(discoverNginx(host).includePath).toBeUndefined()
  })

  it('does not accept an include outside the top-level http block', () => {
    const host = new FakeInstallerHost()
    host.installNginx()
    host.addFile('/etc/nginx/nginx.conf', 'events {}\nstream { include /etc/nginx/conf.d/*.conf; }\nhttp {}\n')

    expect(discoverNginx(host).includePath).toBeUndefined()
  })
})
