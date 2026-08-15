#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { hashPassword } from './password.js'

function writeError(message: string): never {
  process.stderr.write(`dsh-auth: ${message}\n`)
  process.exit(1)
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '')
}

function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error('interactive input requires a TTY; pipe the password to `dsh-auth hash --stdin`'))
  }
  return new Promise((resolve, reject) => {
    let value = ''
    const decoder = new StringDecoder('utf8')
    const cleanup = (): void => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.off('data', onData)
    }
    const onData = (chunk: Buffer): void => {
      for (const character of decoder.write(chunk)) {
        const code = character.codePointAt(0)
        if (code === 3) {
          cleanup()
          process.stdout.write('\n')
          reject(new Error('cancelled'))
          return
        }
        if (code === 13 || code === 10) {
          cleanup()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (code === 127 || code === 8) {
          value = Array.from(value).slice(0, -1).join('')
          continue
        }
        if (code !== undefined && code >= 32) value += character
      }
    }
    process.stdout.write(prompt)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

async function main(): Promise<void> {
  const [command, option, ...extra] = process.argv.slice(2)
  if (extra.length > 0) writeError('too many arguments')
  if (command === 'secret' && option === undefined) {
    process.stdout.write(`${randomBytes(32).toString('base64url')}\n`)
    return
  }
  if (command === 'hash' && (option === undefined || option === '--stdin')) {
    const first = option === '--stdin' ? await readAllStdin() : await readHidden('Password: ')
    if (first.length === 0) writeError('password must not be empty')
    if (Buffer.byteLength(first, 'utf8') > 16 * 1024) writeError('password input is too large')
    if (option === undefined) {
      const second = await readHidden('Confirm password: ')
      if (first !== second) writeError('passwords do not match')
    }
    process.stdout.write(`${await hashPassword(first)}\n`)
    return
  }
  process.stderr.write('Usage:\n  dsh-auth hash [--stdin]\n  dsh-auth secret\n')
  process.exit(command === undefined ? 0 : 1)
}

main().catch((error: unknown) => {
  writeError(error instanceof Error ? error.message : String(error))
})
