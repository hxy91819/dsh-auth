import type { Diagnostic, ExitCodeValue } from './types.js'

/** Installer failure carrying a stable exit code and structured diagnostics. */
export class InstallerError extends Error {
  readonly exitCode: ExitCodeValue
  readonly diagnostics: readonly Diagnostic[]

  /**
   * Create an operator-safe failure.
   * @param message - concise failure summary without secret material.
   * @param exitCode - stable process exit code.
   * @param diagnostics - structured causes and remediation.
   */
  constructor(message: string, exitCode: ExitCodeValue, diagnostics: readonly Diagnostic[] = []) {
    super(message)
    this.name = 'InstallerError'
    this.exitCode = exitCode
    this.diagnostics = diagnostics
  }
}
