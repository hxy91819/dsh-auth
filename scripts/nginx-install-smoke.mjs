/** Exercise the installer's supported missing-Nginx package recipe inside a disposable OS image. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = process.argv[2]
if (packageRoot === undefined) {
  process.stderr.write('Usage: node scripts/nginx-install-smoke.mjs /installed/dsh-auth\n')
  process.exit(2)
}
const [{ discoverPackageManager }, { NodeInstallerHost }, { discoverNginx }] = await Promise.all([
  import(pathToFileURL(join(packageRoot, 'lib/installer/discovery.js')).href),
  import(pathToFileURL(join(packageRoot, 'lib/installer/host.js')).href),
  import(pathToFileURL(join(packageRoot, 'lib/installer/nginx.js')).href),
])
const host = new NodeInstallerHost()
if (discoverNginx(host).installed) throw new Error('smoke image must start without Nginx')
const packageManager = discoverPackageManager(host)
if (packageManager === undefined) throw new Error('smoke image is not an explicitly supported distribution')
for (const command of packageManager.commands) {
  const result = host.run(command)
  if (result.error !== undefined || result.status !== 0) throw new Error(`${packageManager.kind} failed with status ${String(result.status)}`)
}
const nginx = discoverNginx(host)
if (!nginx.installed || !nginx.versionSupported || !nginx.authRequestModule || nginx.includePath === undefined) {
  throw new Error('installed Nginx did not satisfy version, auth_request, and include discovery')
}
process.stdout.write(`Missing Nginx installed from ${packageManager.source} and passed installer discovery.\n`)
