// TASK-010 回归：init 双态（缺省空壳已由 config 测试覆盖；本文件聚焦内置模版释放与保留字）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir, runDtp } from './helpers.js'

const j = (args, opts) => JSON.parse(runDtp([...args, '--json'], opts).stdout || 'null')
const raw = (args, opts) => runDtp([...args, '--json'], opts)

test('内置 user-stories：释放 .dtp/templates/ + bind 指向副本 + 派生包 lint 0/0', () => {
  const dir = tmpdir('builtin-us-')
  const r = j(['init', '故事包', '--template', 'user-stories'], { cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.file, '.dtp/故事包.dtp')
  assert.equal(r.nodes, 2, '根 + 故事池')

  const released = path.join(dir, '.dtp', 'templates', 'user-stories.schema.json')
  assert.ok(fs.existsSync(released), '释放副本存在')
  assert.equal(r.template.released, true)
  assert.equal(r.template.file, 'templates/user-stories.schema.json', 'bind 相对包目录')
  assert.equal(
    r.template.schema_sha256,
    createHash('sha256').update(fs.readFileSync(released)).digest('hex'),
    'sha256 与释放副本字节一致'
  )

  const lint = j(['lint'], { cwd: dir })
  assert.equal(lint.ok, true)
  assert.equal(lint.error_count, 0)
  assert.equal(lint.warn_count, 0, '硬指标：模版派生包过自己的 schema')
})

test('内置 dtp-regression：三容器派生 + lint 0/0', () => {
  const dir = tmpdir('builtin-reg-')
  const r = j(['init', '回归包', '--template', 'dtp-regression'], { cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.nodes, 4, '根 + 三收集夹')
  assert.equal(r.template.released, true)
  assert.equal(r.template.file, 'templates/dtp-regression.schema.json')
  const lint = j(['lint'], { cwd: dir })
  assert.equal(lint.error_count, 0)
  assert.equal(lint.warn_count, 0)
})

test('二次释放：同内容跳过（released:false）且不改动副本', () => {
  const dir = tmpdir('builtin-skip-')
  j(['init', '包一', '--template', 'user-stories'], { cwd: dir })
  const before = fs.readFileSync(path.join(dir, '.dtp', 'templates', 'user-stories.schema.json'))
  const r = j(['init', '包二', '--template', 'user-stories'], { cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.template.released, false)
  assert.ok(fs.readFileSync(path.join(dir, '.dtp', 'templates', 'user-stories.schema.json')).equals(before))
  // 两包各自 lint 0/0
  for (const p of ['.dtp/包一.dtp', '.dtp/包二.dtp']) {
    const lint = j(['lint', '--packet', p], { cwd: dir })
    assert.equal(lint.error_count, 0)
  }
})

test('释放冲突：已存在不同内容的模版 → USAGE 不覆盖（保护用户修改）', () => {
  const dir = tmpdir('builtin-conflict-')
  j(['init', '包一', '--template', 'user-stories'], { cwd: dir })
  const released = path.join(dir, '.dtp', 'templates', 'user-stories.schema.json')
  fs.writeFileSync(released, '{"name":"用户改过"}')
  const before = fs.readFileSync(released)

  const r = raw(['init', '包二', '--template', 'user-stories'], { cwd: dir })
  assert.equal(JSON.parse(r.stdout).error.code, 'USAGE')
  assert.equal(r.status, 2)
  assert.ok(fs.readFileSync(released).equals(before), '用户文件不被覆盖')
  assert.ok(!fs.existsSync(path.join(dir, '.dtp', '包二.dtp')), '拒绝时不建包')
})

test('保留字遮蔽：本地存在同名无扩展名文件时内置优先', () => {
  const dir = tmpdir('builtin-shadow-')
  fs.writeFileSync(path.join(dir, 'user-stories'), '本地垃圾文件不是 json')
  const r = j(['init', '遮蔽包', '--template', 'user-stories'], { cwd: dir })
  assert.equal(r.ok, true, '应走内置而非把本地垃圾文件当 schema 读')
  assert.equal(r.template.name, 'user-stories')
  const lint = j(['lint'], { cwd: dir })
  assert.equal(lint.ok, true)
})

test('内置名打错 → 按路径解析报不存在，错误信息列出可用内置名', () => {
  const dir = tmpdir('builtin-typo-')
  const r = raw(['init', 'x', '--template', 'user-story'], { cwd: dir })
  const out = JSON.parse(r.stdout)
  assert.equal(out.error.code, 'USAGE')
  assert.match(out.error.message, /user-stories \| dtp-regression/)
})

test('路径模式（旧用法）：bind 指向给定路径、无 released 字段、显式 --packet 不碰 .dtp/', () => {
  const dir = tmpdir('builtin-path-')
  const schemaFile = path.join(dir, 'my.schema.json')
  fs.copyFileSync(
    path.resolve(import.meta.dirname, '..', 'docs', 'templates', 'user-stories.schema.json'),
    schemaFile
  )
  const r = j(['init', '自管包', '--packet', 'p.dtp', '--template', 'my.schema.json'], { cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.template.file, 'my.schema.json')
  assert.equal(r.template.released, undefined, '路径模式不释放')
  assert.ok(!fs.existsSync(path.join(dir, '.dtp')), '显式 --packet 零副作用')
  assert.equal(j(['lint', '--packet', 'p.dtp'], { cwd: dir }).error_count, 0)
})

test('内置模版 + 显式 --packet：释放到包旁 templates/（自管布局也可用内置）', () => {
  const dir = tmpdir('builtin-explicit-')
  const r = j(['init', '自管内置包', '--packet', 'q.dtp', '--template', 'dtp-regression'], { cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.template.file, 'templates/dtp-regression.schema.json')
  assert.ok(fs.existsSync(path.join(dir, 'templates', 'dtp-regression.schema.json')))
  assert.equal(j(['lint', '--packet', 'q.dtp'], { cwd: dir }).error_count, 0)
})
