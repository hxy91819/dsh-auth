/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-package',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'production-does-not-import-development-code',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^(?:tests|scripts)/' },
    },
    {
      name: 'browser-does-not-import-node',
      severity: 'error',
      from: { path: '^src/(?:client[.]tsx|browser-bootstrap[.]ts)$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'browser-does-not-import-server',
      severity: 'error',
      from: { path: '^src/(?:client[.]tsx|browser-bootstrap[.]ts)$' },
      to: { path: '^src/(?!client[.]tsx$|browser-bootstrap[.]ts$)' },
    },
    {
      name: 'installer-does-not-import-runtime-layers',
      severity: 'error',
      from: { path: '^src/installer/' },
      to: {
        path: '^src/(?:admin-password|application|browser-bootstrap|cli|client|config|cookies|crypto|html|http|index|limiter|preferences|session)[.](?:ts|tsx)$',
      },
    },
    {
      name: 'only-cli-enters-installer',
      severity: 'error',
      from: { path: '^src/(?!cli[.]ts$|installer/)' },
      to: { path: '^src/installer/' },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
      dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg'],
    },
    includeOnly: ['^src/'],
    moduleSystems: ['cjs', 'es6'],
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
}
