import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const BIN = path.join(ROOT, 'bin', 'dtp.js')

export function tmpdir(prefix = 'dtp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// 不经 shell 调用 CLI，避免 MSYS 路径改写与引号问题
export function runDtp(args, { cwd, env } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', ...env },
      maxBuffer: 64 * 1024 * 1024,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

export function runJson(args, opts = {}) {
  const r = runDtp([...args, '--json'], opts)
  return { status: r.status, data: r.stdout ? JSON.parse(r.stdout) : null }
}

export function makePacket(file, { name = '测试包' } = {}) {
  const r = runJson(['init', name, '--packet', file, '--id', 'n_root'])
  if (r.status !== 0) throw new Error(`init 失败: ${JSON.stringify(r)}`)
  return r.data
}

export { fs, path }
