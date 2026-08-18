import type { ManagedPaths } from './types.js'

export function expectedManagedOwners(paths: ManagedPaths, serviceUid: number, serviceGid: number): ReadonlyMap<string, readonly [number, number]> {
  return new Map([
    [paths.configDirectory, [0, serviceGid]],
    [paths.stateFile, [0, 0]],
    [paths.environmentFile, [0, serviceGid]],
    [paths.sessionSecretFile, [0, serviceGid]],
    [paths.caddyfile, [0, 0]],
    [paths.caddyBinary, [0, 0]],
    [paths.caddyBinaryDirectory, [0, 0]],
    [paths.caddyUnitFile, [0, 0]],
    [paths.authStateDirectory, [serviceUid, serviceGid]],
    [paths.authStateFile, [serviceUid, serviceGid]],
    [paths.loginTokenDirectory, [serviceUid, serviceGid]],
    [paths.systemdDropInFile, [0, 0]],
  ])
}
