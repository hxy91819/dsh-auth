import { describe, expect, it } from 'vitest'
import { CADDY_PACKAGE_VERSION, CADDY_VERSION, renderCaddyfile, renderCaddyUnit, resolveCaddyPackage } from '../src/installer/caddy.js'
import type { ManagedPaths, SetupRequest } from '../src/installer/types.js'
import { FakeInstallerHost } from './installer-helpers.js'

function request(mode: 'http' | 'https', tls?: 'automatic' | 'manual'): SetupRequest {
  return {
    mode,
    profile: 'web',
    packageSource: 'dsh-auth@0.1.14',
    adminBootstrap: 'password',
    adminUsername: 'admin',
    loginTokenEnabled: false,
    upstream: '127.0.0.1:3080',
    listenAddress: mode === 'http' ? '10.0.0.20' : '0.0.0.0',
    httpPort: mode === 'http' ? 8080 : 80,
    httpsPort: 443,
    ...(mode === 'https' ? { serverName: 'auth.example.test', tls: tls ?? 'automatic' } : {}),
    ...(tls === 'manual' ? { certificate: '/etc/ssl/dsh-auth/cert.pem', certificateKey: '/etc/ssl/dsh-auth/key.pem' } : {}),
  }
}

function paths(): ManagedPaths {
  return {
    configDirectory: '/etc/dsh-auth',
    stateFile: '/etc/dsh-auth/install-state.json',
    environmentFile: '/etc/dsh-auth/dsh-auth.env',
    sessionSecretFile: '/etc/dsh-auth/session-secret',
    caddyfile: '/etc/dsh-auth/Caddyfile',
    caddyBinary: '/usr/lib/dsh-auth/caddy',
    caddyBinaryDirectory: '/usr/lib/dsh-auth',
    caddyUnitFile: '/etc/systemd/system/dsh-auth-caddy.service',
    caddyStateDirectory: '/var/lib/dsh-auth-caddy',
    authStateDirectory: '/var/lib/dsh-auth',
    authStateFile: '/var/lib/dsh-auth/auth-state.json',
    loginTokenDirectory: '/var/lib/dsh-auth/login-tokens',
    systemdDropInDirectory: '/etc/systemd/system/dsh-web.service.d',
    systemdDropInFile: '/etc/systemd/system/dsh-web.service.d/50-dsh-auth.conf',
  }
}

describe('Caddy installer contract', () => {
  it('renders HTTPS config with Admin API off and public /auth/verify denied', () => {
    const rendered = renderCaddyfile(request('https'), true)
    expect(rendered).toContain('admin off')
    expect(rendered).toContain('bind 0.0.0.0')
    expect(rendered).toContain('host auth.example.test')
    expect(rendered).toContain('path /auth/verify')
    expect(rendered).toContain('respond @public_verify 404')
    expect(rendered).toContain('forward_auth')
    expect(rendered).not.toContain('{{')
    expect(rendered).not.toContain('tls internal')
  })

  it('renders trusted-network HTTP without TLS claims', () => {
    const rendered = renderCaddyfile(request('http'), true)
    expect(rendered).toContain('admin off')
    expect(rendered).toContain('bind 10.0.0.20')
    expect(rendered).toContain('http://10.0.0.20:8080')
    expect(rendered).not.toContain('Strict-Transport-Security')
    expect(rendered).not.toContain('tls ')
  })

  it('renders a DynamicUser unit and systemd credentials only for manual TLS', () => {
    const automatic = renderCaddyUnit(request('https', 'automatic'), paths())
    expect(automatic).toContain('DynamicUser=yes')
    expect(automatic).toContain('NoNewPrivileges=yes')
    expect(automatic).toContain('CAP_NET_BIND_SERVICE')
    expect(automatic).toContain('validate --config /etc/dsh-auth/Caddyfile')
    expect(automatic).not.toContain('LoadCredential=')

    const manual = renderCaddyUnit(request('https', 'manual'), paths())
    expect(manual).toContain('LoadCredential=dsh-auth-cert:/etc/ssl/dsh-auth/cert.pem')
    expect(manual).toContain('LoadCredential=dsh-auth-key:/etc/ssl/dsh-auth/key.pem')
    const rendered = renderCaddyfile(request('https', 'manual'), true)
    expect(rendered).toContain('/run/credentials/dsh-auth-caddy.service/dsh-auth-cert')
    expect(rendered).not.toContain('/etc/ssl/dsh-auth/key.pem')
  })

  it('resolves the frozen linux-x64 platform package without downloading', () => {
    const host = new FakeInstallerHost()
    host.installCaddyPackage('linux-x64')
    const pkg = resolveCaddyPackage(host)
    expect(pkg.name).toBe('dsh-auth-caddy-linux-x64')
    expect(pkg.binarySha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(CADDY_VERSION).toBe('2.11.4')
    expect(CADDY_PACKAGE_VERSION).toBe('2.11.4-dsh.1')
  })

  it('resolves the frozen linux-arm64 platform package', () => {
    const host = new FakeInstallerHost()
    host.arch = 'arm64'
    host.installCaddyPackage('linux-arm64')
    expect(resolveCaddyPackage(host).name).toBe('dsh-auth-caddy-linux-arm64')
  })

  it('fails closed when the platform package is missing, unsupported, or tampered', () => {
    const missing = new FakeInstallerHost()
    expect(() => resolveCaddyPackage(missing)).toThrow(/not installed/u)

    const unsupported = new FakeInstallerHost()
    unsupported.arch = 'ppc64'
    expect(() => resolveCaddyPackage(unsupported)).toThrow(/Unsupported architecture/u)

    const tampered = new FakeInstallerHost()
    tampered.installCaddyPackage('linux-x64')
    tampered.addFile('/usr/lib/node_modules/dsh-auth-caddy-linux-x64/caddy', Buffer.from('mutated-caddy'), 0o755)
    expect(() => resolveCaddyPackage(tampered)).toThrow(/checksum/u)

    const unlicensed = new FakeInstallerHost()
    unlicensed.installCaddyPackage('linux-x64')
    unlicensed.removeFile('/usr/lib/node_modules/dsh-auth-caddy-linux-x64/LICENSE')
    expect(() => resolveCaddyPackage(unlicensed)).toThrow(/LICENSE/u)
  })
})
