// TASK-005 回归：init --template 骨架派生（容器等价、无示例节点、metadata.template、冲突/坏 schema 拒绝）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir, runDtp } from './helpers.js'
import { parsePacketText } from '../src/storage.js'
import { Packet } from '../src/packet.js'
import { evaluate } from '../src/template.js'

const j = (args, opts) => JSON.parse(runDtp([...args, '--json'], opts).stdout || 'null')

// 双容器 schema（folder + index，带 tags/description），与真实工作流同构
const SCHEMA = {
  name: 'tracker',
  version: '2.1.0',
  skeleton: [
    { id: 'f_open', title: '待办池', type: 'folder', description: '未完成条目', tags: ['todo'] },
    { id: 'f_done', title: '归档索引', type: 'index', tags: ['done'] },
  ],
  rules: [
    {
      id: 'todo',
      scope: { parent: 'f_open' },
      match: { id: '^todo\\d{3}$' },
      id_pattern: '^todo\\d{3}$',
      title_pattern: '^TODO-\\d{3} ',
      ext_required: ['owner'],
      tags_require: ['todo'],
      numbering: { title_prefix: 'TODO', id_prefix: 'todo', digits: 3 },
    },
  ],
}

const writeSchema = (dir, obj = SCHEMA, name = 'tracker.schema.json') => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify(obj, null, 2))
  return file
}

// ---------- acceptance ①：容器骨架等价 + metadata.template + verify 全绿 + 模块级 lint 等价校验 ----------

test('init --template：容器 id/type/title 与 schema 一致、无示例业务节点、template 记录齐备、verify 全绿', () => {
  const dir = tmpdir('init-tpl-')
  const schemaFile = writeSchema(dir)
  const pkt = path.join(dir, 't.dtp')

  const r = j(['init', '跟踪包', '--packet', pkt, '--template', 'tracker.schema.json'], { cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.nodes, 3) // 根 + 2 容器，无示例业务节点
  assert.equal(r.template.name, 'tracker')
  assert.equal(r.template.version, '2.1.0')
  assert.equal(r.template.schema_sha256, createHash('sha256').update(fs.readFileSync(schemaFile)).digest('hex'))
  assert.equal(r.template.file, 'tracker.schema.json')

  // 容器骨架等价：节点集合恰为 根+容器，逐字段比对
  const packet = new Packet(parsePacketText(fs.readFileSync(pkt, 'utf8')), pkt)
  assert.deepEqual([...packet.nodes.values()].map((n) => n.id).sort(), ['f_done', 'f_open', ...[packet.root().id]].sort())
  for (const c of SCHEMA.skeleton) {
    const node = packet.nodes.get(c.id)
    assert.ok(node, `容器 ${c.id} 存在`)
    assert.equal(node.parent_id, packet.root().id, '容器挂根下')
    assert.equal(node.node_type, c.type)
    assert.equal(node.title, c.title)
    assert.equal(node.description, c.description ?? '')
    assert.deepEqual(node.tags, c.tags ?? [])
  }
  assert.deepEqual(packet.meta.metadata.template, r.template)

  // verify 全绿
  assert.equal(runDtp(['verify', '--packet', pkt], { cwd: dir }).status, 0)

  // lint 等价（lint 命令 TASK-006 落地；此处用其内核 evaluate 断言零违规）
  assert.deepEqual(evaluate(SCHEMA, packet), [])
})

test('init --template：--force 覆盖已有包同样可用（备份机制复用）', () => {
  const dir = tmpdir('init-tpl2-')
  writeSchema(dir)
  const pkt = path.join(dir, 't.dtp')
  assert.equal(j(['init', '旧包', '--packet', pkt], { cwd: dir }).ok, true)
  const r = j(['init', '新包', '--packet', pkt, '--template', 'tracker.schema.json', '--force'], { cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.nodes, 3)
  assert.equal(runDtp(['verify', '--packet', pkt], { cwd: dir }).status, 0)
  assert.ok(fs.existsSync(pkt + '.bak.1'), '旧包已备份')
})

// ---------- acceptance ②：--id 与容器 id 冲突 → USAGE 且不落盘 ----------

test('init --template：--id 撞容器 id → USAGE exit 2 且包文件不落盘', () => {
  const dir = tmpdir('init-tpl3-')
  writeSchema(dir)
  const pkt = path.join(dir, 't.dtp')
  const r = j(['init', '冲突包', '--packet', pkt, '--template', 'tracker.schema.json', '--id', 'f_open'], { cwd: dir })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'USAGE')
  assert.match(r.error.message, /冲突/)
  assert.equal(runDtp(['init', '冲突包', '--packet', pkt, '--template', 'tracker.schema.json', '--id', 'f_open'], { cwd: dir }).status, 2)
  assert.ok(!fs.existsSync(pkt), '失败不得落盘')
})

// ---------- acceptance ③：坏 schema 拒绝并指引 template check ----------

test('init --template：坏 schema → SCHEMA_INVALID exit 1，提示先 check，不落盘', () => {
  const dir = tmpdir('init-tpl4-')
  const bad = { ...SCHEMA, rules: [{ id: 'x', scope: { parent: 'ghost' }, match: { id: '^x$' } }] }
  writeSchema(dir, bad, 'bad.schema.json')
  const pkt = path.join(dir, 't.dtp')
  const r = j(['init', '坏模版包', '--packet', pkt, '--template', 'bad.schema.json'], { cwd: dir })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'SCHEMA_INVALID')
  assert.match(r.error.message, /template check/)
  assert.equal(runDtp(['init', '坏模版包', '--packet', pkt, '--template', 'bad.schema.json'], { cwd: dir }).status, 1)
  assert.ok(!fs.existsSync(pkt), '失败不得落盘')

  // schema 文件不存在 → USAGE
  const r2 = j(['init', '缺模版', '--packet', pkt, '--template', 'nosuch.schema.json'], { cwd: dir })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'USAGE')
  assert.ok(!fs.existsSync(pkt))
})

test('init --template：普通 --meta 仍可用且不与 template 键冲突（自动绑定优先）', () => {
  const dir = tmpdir('init-tpl5-')
  writeSchema(dir)
  const pkt = path.join(dir, 't.dtp')
  const r = j(['init', '元数据包', '--packet', pkt, '--template', 'tracker.schema.json', '--meta', 'purpose=demo'], { cwd: dir })
  assert.equal(r.ok, true)
  const packet = new Packet(parsePacketText(fs.readFileSync(pkt, 'utf8')), pkt)
  assert.equal(packet.meta.metadata.purpose, 'demo')
  assert.equal(packet.meta.metadata.template.name, 'tracker')
})
