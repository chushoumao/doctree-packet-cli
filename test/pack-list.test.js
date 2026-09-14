// TASK-012 回归：npm pack 白名单契约（含/排清单逐项断言，防回潮）+ 发布闸门静态契约。
// pack 用 --dry-run --json --ignore-scripts：不落盘、不跑 prepack（套件内调用若跑脚本会无限递归）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function packFileList() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const files = JSON.parse(out)[0].files
  return files.map((f) => (typeof f === 'string' ? f : f.path ?? f.name))
}

test('npm pack 白名单：必含清单逐项在列', () => {
  const names = packFileList()
  const mustInclude = [
    'package.json',
    'README.md',
    'LICENSE',
    'bin/dtp.js',
    'src/main.js',
    'src/cli.js',
    'src/config.js',
    'src/template.js',
    'src/packet.js',
    'src/commands/index.js',
    'src/commands/web.js',
    'docs/templates/user-stories.schema.json',
    'docs/templates/dtp-regression.schema.json',
    'docs/templates/README.md',
    'docs/playbook-story-collab.md',
    'webui/server.js',
    'webui/api.js',
    'webui/README.md',
    'webui/public/index.html',
    'webui/public/app.js',
  ]
  for (const want of mustInclude) {
    assert.ok(names.includes(want), `包内应含 ${want}；实际清单：${names.join(', ')}`)
  }
})

test('npm pack 隐私红线与噪音排除：逐项不在列（防回潮）', () => {
  const names = packFileList()
  const forbidden = [
    (n) => n.startsWith('test/') || n.includes('/test/'),
    (n) => n === 'AGENTS.md',
    (n) => n === 'docs/dtp-regression.dtp' || n === 'docs/user-stories.dtp',
    (n) => n.startsWith('webui/gui-test-screenshots'),
    (n) => n.startsWith('webui/workspace'),
    (n) => n.endsWith('.mjs'),
    (n) => n.endsWith('.DS_Store'),
    (n) => n === 'opencode.json',
    (n) => n.startsWith('tmp/'),
    (n) => n.endsWith('.template.dtp') || n.endsWith('.template.dtp.bak.1'),
    (n) => n.includes('.bak.'),
    (n) => n.startsWith('.agents/'),
    (n) => n.startsWith('.github/'),
    (n) => n === 'docs/playbook-story-collab.md.bak.1',
  ]
  const violations = names.filter((n) => forbidden.some((rule) => rule(n)))
  assert.deepEqual(violations, [], `包内出现禁入文件：${violations.join(', ')}`)
})

test('发布闸门静态契约：prepack 与 prepublishOnly 均为 npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.prepack, 'npm test')
  assert.equal(pkg.scripts.prepublishOnly, 'npm test')
})
