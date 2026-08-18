import type { ManagedPaths } from './types.js'

export function expectedManagedOwners(paths: ManagedPaths, serviceUid: number, serviceGid: number): ReadonlyMap<string, readonly [number, number]> {
  return new Map([
    [paths.configDirectory, [0, serviceGid]],
    [paths.stateFile, [0, 0]],
    [paths.environmentFile, [0, serviceGid]],
    [paths.passwordHashFile, [0, serviceGid]],
    [paths.sessionSecretFile, [0, serviceGid]],
    [paths.sessionDirectory, [serviceUid, serviceGid]],
    [paths.systemdDropInFile, [0, 0]],
    [paths.nginxConfigFile, [0, 0]],
  ])
}
