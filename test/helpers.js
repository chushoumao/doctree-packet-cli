import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export { ROOT }
export const BIN = path.join(ROOT, 'bin', 'dtp.js')

export function tmpdir(prefix = 'dtp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// 不经 shell 调用 CLI，避免 MSYS 路径改写与引号问题。
// 用 spawnSync 而非 execFileSync：后者丢弃成功路径的 stderr，弃用提示/警告类断言拿不到真值
export function runDtp(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: String(r.error) }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
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
