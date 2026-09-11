// TASK-004 回归：template 子命令 new / check / bind（子进程级，覆盖注册、exit 码、--json 契约）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir, runDtp, runJson } from './helpers.js'

// runJson 返回 {status, data}；j() 直接取解析后的 JSON 对象
const j = (args, opts) => runJson(args, opts).data
import { parsePacketText } from '../src/storage.js'
import { resolveSchemaFile } from '../src/template.js'

const BAD_SCHEMA = {
  name: 'bad',
  version: '1.0.0',
  skeleton: [{ id: 'f_a', title: 'A', type: 'folder' }],
  rules: [
    {
      id: 'a',
      unknown_key: 1,
      scope: { parent: 'f_a' },
      match: { id: '^a[unclosed' },
    },
  ],
}

// ---------- acceptance ①：new 生成含 comment 的最小可跑骨架，自过 check ----------

test('template new：生成骨架（三层 comment 键齐备）且产物通过 template check', () => {
  const dir = tmpdir('tpl-new-')
  const r = j(['template', 'new', 'weekly'], { cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.schema_file, './weekly.schema.json')

  const file = path.join(dir, 'weekly.schema.json')
  assert.ok(fs.existsSync(file))
  const schema = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(schema.name, 'weekly')
  assert.ok(schema.comment.length > 0, '顶层 comment')
  assert.ok(schema.skeleton[0].comment.length > 0, '容器 comment')
  assert.ok(schema.rules[0].comment.length > 0, '规则 comment')

  // 产物必须过自身 check
  const c = j(['template', 'check', 'weekly.schema.json'], { cwd: dir })
  assert.equal(c.ok, true)
  assert.deepEqual(c.problems, [])
})

test('template new：默认路径 ./<name>.schema.json，--out 可指定；重名 EXISTS exit 2；非法名 USAGE exit 2', () => {
  const dir = tmpdir('tpl-new2-')
  j(['template', 'new', 'alpha'], { cwd: dir })
  assert.ok(fs.existsSync(path.join(dir, 'alpha.schema.json')))

  // --out 目录不存在报 USAGE（与 export/pack 的 ISSUE-006 语义一致）；先建目录则成功
  const missDir = j(['template', 'new', 'gamma', '--out', path.join(dir, 'nodir', 'g.json')], { cwd: dir })
  assert.equal(missDir.ok, false)
  assert.equal(missDir.error.code, 'USAGE')
  fs.mkdirSync(path.join(dir, 'custom'))
  j(['template', 'new', 'beta', '--out', path.join(dir, 'custom', 'b.json')], { cwd: dir })
  assert.ok(fs.existsSync(path.join(dir, 'custom', 'b.json')))

  const dup = j(['template', 'new', 'alpha'], { cwd: dir })
  assert.equal(dup.ok, false)
  assert.equal(dup.error.code, 'EXISTS')
  assert.equal(runDtp(['template', 'new', 'alpha'], { cwd: dir }).status, 2)

  const badName = j(['template', 'new', 'a/b'], { cwd: dir })
  assert.equal(badName.ok, false)
  assert.equal(badName.error.code, 'USAGE')
  assert.equal(runDtp(['template', 'new', 'a/b'], { cwd: dir }).status, 2)
})

// ---------- acceptance ②：坏 schema 逐条报、exit 1、--json 单行 ----------

test('template check：坏 schema 逐条列出问题且 exit 1；--json 输出单行', () => {
  const dir = tmpdir('tpl-check-')
  fs.writeFileSync(path.join(dir, 'bad.schema.json'), JSON.stringify(BAD_SCHEMA))

  const r = j(['template', 'check', 'bad.schema.json'], { cwd: dir })
  assert.equal(r.ok, false)
  const raw = runDtp(['template', 'check', 'bad.schema.json', '--json'], { cwd: dir })
  assert.ok(r.problems.some((p) => p.includes('未知规则键 "unknown_key"')))
  assert.ok(r.problems.some((p) => p.includes('正则不可编译')))
  assert.equal(runDtp(['template', 'check', 'bad.schema.json'], { cwd: dir }).status, 1)
  // 单行 JSON 契约
  assert.equal(raw.stdout.trim().split('\n').length, 1)

  // 坏 JSON 与不存在的文件
  fs.writeFileSync(path.join(dir, 'broken.json'), '{oops')
  const r2 = j(['template', 'check', 'broken.json'], { cwd: dir })
  assert.equal(r2.ok, false)
  assert.match(r2.problems[0], /不是合法 JSON/)
  const r3 = j(['template', 'check', 'nosuch.json'], { cwd: dir })
  assert.equal(r3.ok, false)
  assert.equal(r3.error.code, 'USAGE')
  assert.match(r3.error.message, /不存在/)
})

// ---------- acceptance ③：bind 写 metadata.template（append-only）；无效 schema 拒绝写入 ----------

test('template bind：有效 schema 写入 name/version/sha256/file，append-only 追加 meta 行，re-bind 幂等更新', () => {
  const dir = tmpdir('tpl-bind-')
  const pkt = path.join(dir, 'p.dtp')
  j(['init', '测试包', '--packet', pkt], { cwd: dir })
  j(['template', 'new', 'weekly'], { cwd: dir })
  const schemaPath = path.join(dir, 'weekly.schema.json')

  const r = j(['template', 'bind', 'weekly.schema.json', '--packet', pkt], { cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.rebound, false)
  assert.equal(r.template.name, 'weekly')
  assert.equal(r.template.version, '1.0.0')
  // sha256 为文件字节哈希
  const expectSha = createHash('sha256').update(fs.readFileSync(schemaPath)).digest('hex')
  assert.equal(r.template.schema_sha256, expectSha)
  // file 相对包文件目录
  assert.equal(r.template.file, 'weekly.schema.json')

  // 包内最新 meta 已带 template 记录（append-only：原文首行 meta 无 template）
  const rec = parsePacketText(fs.readFileSync(pkt, 'utf8'))
  assert.deepEqual(rec.meta.metadata.template, {
    name: 'weekly',
    version: '1.0.0',
    schema_sha256: expectSha,
    file: 'weekly.schema.json',
  })

  // re-bind：幂等更新，仍单条权威 meta
  const r2 = j(['template', 'bind', 'weekly.schema.json', '--packet', pkt], { cwd: dir })
  assert.equal(r2.ok, true)
  assert.equal(r2.rebound, true)
  const rec2 = parsePacketText(fs.readFileSync(pkt, 'utf8'))
  assert.equal(rec2.meta.metadata.template.schema_sha256, expectSha)

  // 记录的 file 能按包目录解析回真实 schema（lint 将用同一约定）
  assert.equal(resolveSchemaFile(pkt, r2.template.file), fs.realpathSync(schemaPath))
})

test('template bind：schema 在子目录时 file 记相对路径；包在子目录时允许 ../', () => {
  const dir = tmpdir('tpl-bind2-')
  fs.mkdirSync(path.join(dir, 'schemas'))
  j(['template', 'new', 'demo', '--out', path.join('schemas', 'demo.schema.json')], { cwd: dir })
  const pkt = path.join(dir, 'p.dtp')
  j(['init', '包一', '--packet', pkt], { cwd: dir })
  const r = j(['template', 'bind', path.join('schemas', 'demo.schema.json'), '--packet', pkt], { cwd: dir })
  assert.equal(r.template.file, path.join('schemas', 'demo.schema.json'))

  // 包在子目录、schema 在上层 → ../ 形式
  fs.mkdirSync(path.join(dir, 'pkts'))
  const pkt2 = path.join(dir, 'pkts', 'p2.dtp')
  j(['init', '包二', '--packet', pkt2], { cwd: dir })
  const r2 = j(['template', 'bind', path.join('schemas', 'demo.schema.json'), '--packet', pkt2], { cwd: dir })
  assert.equal(r2.template.file, path.join('..', 'schemas', 'demo.schema.json'))
})

test('template bind：无效 schema 拒绝写入，包文件字节不变', () => {
  const dir = tmpdir('tpl-bind3-')
  const pkt = path.join(dir, 'p.dtp')
  j(['init', '测试包', '--packet', pkt], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'bad.schema.json'), JSON.stringify(BAD_SCHEMA))
  const before = fs.readFileSync(pkt)

  const r = j(['template', 'bind', 'bad.schema.json', '--packet', pkt], { cwd: dir })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'SCHEMA_INVALID')
  assert.equal(runDtp(['template', 'bind', 'bad.schema.json', '--packet', pkt], { cwd: dir }).status, 1)
  assert.ok(fs.readFileSync(pkt).equals(before), '拒绝绑定时包文件不得有任何写入')

  // 绑定不存在的包 → NO_PACKET（ctx.load 契约）
  const r2 = j(['template', 'bind', 'bad.schema.json', '--packet', path.join(dir, 'none.dtp')], { cwd: dir })
  assert.equal(r2.ok, false)
})

// ---------- acceptance ④：未知子命令 USAGE exit 2 ----------

test('template：未知子命令与缺参 → USAGE exit 2，--json 单行错误', () => {
  const dir = tmpdir('tpl-usage-')
  const r = j(['template', 'foo'], { cwd: dir })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'USAGE')
  assert.match(r.error.message, /new \| check \| bind/)
  const raw = runDtp(['template', 'foo', '--json'], { cwd: dir })
  assert.equal(raw.status, 2)
  // 单行 JSON 契约
  assert.equal(raw.stdout.trim().split('\n').length, 1)

  // 缺 action / check·bind 缺文件同样 USAGE exit 2
  assert.equal(runDtp(['template'], { cwd: dir }).status, 2)
  assert.equal(j(['template'], { cwd: dir }).error.code, 'USAGE')
  assert.equal(runDtp(['template', 'check'], { cwd: dir }).status, 2)
  assert.equal(runDtp(['template', 'bind'], { cwd: dir }).status, 2)
  // 多余位置参数由解析层拦截
  assert.equal(runDtp(['template', 'new', 'a', 'b'], { cwd: dir }).status, 2)
})
