// TASK-020 回归：bind --enforce 三态 + lint 前置门 + 开关可见性
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir, runDtp } from './helpers.js'

const j = (args, opts) => JSON.parse(runDtp([...args, '--json'], opts).stdout || 'null')
const raw = (args, opts) => runDtp([...args, '--json'], opts)

// schema：容器 f_items 下 item### 节点需 tags item + ext owner（便于造 error）
const SCHEMA = {
  name: 'items',
  version: '1.0.0',
  skeleton: [{ id: 'f_items', title: '条目池', type: 'folder' }],
  rules: [
    {
      id: 'item',
      scope: { parent: 'f_items' },
      match: { id: '^item\\d{3}$' },
      id_pattern: '^item\\d{3}$',
      tags_require: ['item'],
      ext_required: ['owner'],
      numbering: { title_prefix: 'ITEM', id_prefix: 'item', digits: 3 },
    },
  ],
}

function setup(prefix, { seedBad = false, seedWarn = false } = {}) {
  const dir = tmpdir(prefix)
  const pkt = path.join(dir, 'p.dtp')
  const schemaFile = path.join(dir, 'items.schema.json')
  fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA, null, 2))
  j(['init', '演示', '--packet', pkt], { cwd: dir })
  j(['add', '/', '--id', 'f_items', '--title', '条目池', '--type', 'folder', '--packet', pkt], { cwd: dir })
  if (seedBad) {
    // 缺 owner / 缺 item 标签 → error 级违规
    j(['add', 'f_items', '--id', 'item001', '--title', 'ITEM-001 坏条目', '--packet', pkt], { cwd: dir })
  }
  if (seedWarn) {
    // 合规但编号跳号：item002 用 003 号 → 仅 warn（id.continuity）
    j(['add', 'f_items', '--id', 'item003', '--title', 'ITEM-003 跳号', '--tags', 'item', '--ext', 'owner=a', '--packet', pkt], { cwd: dir })
  }
  return { dir, pkt, schemaFile, bind: (extra = []) => j(['template', 'bind', 'items.schema.json', ...extra, '--packet', pkt], { cwd: dir }) }
}

test('首绑不给 flag：元数据最小（不写 enforce 字段）', () => {
  const s = setup('be-first-')
  const r = s.bind()
  assert.equal(r.ok, true)
  assert.equal('enforce' in r.template, false, '首绑最小元数据')
  const lint = j(['lint', '--packet', s.pkt], { cwd: s.dir })
  assert.equal(lint.template.enforce, false, '未开启态可见')
})

test('三态：--enforce=true → 保持（rebind 不带 flag）→ --no-enforce=false', () => {
  const s = setup('be-three-')
  const r1 = s.bind(['--enforce'])
  assert.equal(r1.template.enforce, true, '--enforce 设 true')
  assert.equal(j(['lint', '--packet', s.pkt], { cwd: s.dir }).template.enforce, true)

  const r2 = s.bind() // rebind 不带 flag → 保持
  assert.equal(r2.template.enforce, true, 'rebind 保持现值（防静默关闭）')
  assert.equal(r2.rebound, true)

  const r3 = s.bind(['--no-enforce'])
  assert.equal(r3.template.enforce, false)
  assert.equal(j(['lint', '--packet', s.pkt], { cwd: s.dir }).template.enforce, false)

  const r4 = s.bind(['--enforce'])
  assert.equal(r4.template.enforce, true, '可再次开启')
})

test('互斥：同时给 --enforce 与 --no-enforce → USAGE exit 2', () => {
  const s = setup('be-mutex-')
  const r = raw(['template', 'bind', 'items.schema.json', '--enforce', '--no-enforce', '--packet', s.pkt], { cwd: s.dir })
  assert.equal(JSON.parse(r.stdout).error.code, 'USAGE')
  assert.equal(r.status, 2)
})

test('前置门：包有 error 级违规 → --enforce 被拒（SCHEMA_VIOLATION + violations + 指引），包零写入', () => {
  const s = setup('be-gate-', { seedBad: true })
  const before = fs.readFileSync(s.pkt, 'utf8')
  const r = raw(['template', 'bind', 'items.schema.json', '--enforce', '--packet', s.pkt], { cwd: s.dir })
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'SCHEMA_VIOLATION')
  assert.match(out.error.message, /dtp lint/)
  assert.ok(Array.isArray(out.error.violations) && out.error.violations.length > 0, '附违规明细')
  assert.equal(r.status, 1)
  assert.equal(fs.readFileSync(s.pkt, 'utf8'), before, '被拒时包零写入（连绑定都不写）')
  // 人类模式输出 hint
  const human = runDtp(['template', 'bind', 'items.schema.json', '--enforce', '--packet', s.pkt], { cwd: s.dir })
  assert.match(human.stderr + human.stdout, /ext\.required|tags\.require/)
})

test('前置门：仅 warn（编号跳号）不挡 --enforce', () => {
  const s = setup('be-warn-', { seedWarn: true })
  s.bind() // 先绑定（不给 flag）才能零参数 lint
  const lint0 = j(['lint', '--packet', s.pkt], { cwd: s.dir })
  assert.equal(lint0.error_count, 0)
  assert.ok(lint0.warn_count >= 1, '确有 warn')
  const r = s.bind(['--enforce'])
  assert.equal(r.ok, true, 'warn 不挡开强制')
  assert.equal(r.template.enforce, true)
})

test('lint 前置门以「待绑 schema」评估：包对旧 schema 合规但对新 schema 违规时也拦', () => {
  const s = setup('be-gate2-')
  // 先用宽松 schema 绑定（无规则）
  const loose = { name: 'loose', version: '1.0.0', skeleton: [{ id: 'f_items', title: '条目池', type: 'folder' }] }
  fs.writeFileSync(path.join(s.dir, 'loose.schema.json'), JSON.stringify(loose))
  j(['template', 'bind', 'loose.schema.json', '--packet', s.pkt], { cwd: s.dir })
  j(['add', 'f_items', '--id', 'item001', '--title', '任意标题', '--packet', s.pkt], { cwd: s.dir })
  // 换严格 schema 开强制 → 现有 item001 违规 → 拒
  const r = raw(['template', 'bind', 'items.schema.json', '--enforce', '--packet', s.pkt], { cwd: s.dir })
  const out = JSON.parse(r.stdout)
  assert.equal(out.error.code, 'SCHEMA_VIOLATION')
  const rules = out.error.violations.map((v) => v.rule)
  assert.ok(rules.some((x) => ['ext.required', 'tags.require', 'title.pattern', 'id.pattern'].includes(x)), `应检出规则违规，实际 ${rules}`)
})

test('未绑定包 bind 无 enforce 语义：不给 flag 首绑干净、给 flag 走前置门', () => {
  const s = setup('be-unbound-')
  const r = s.bind()
  assert.equal(r.ok, true)
  assert.equal(r.rebound, false)
  assert.equal('enforce' in r.template, false)

  // TASK-019 接线后：enforce=true 即拦截（中间态断言已反转）
  const r2 = s.bind(['--enforce'])
  assert.equal(r2.template.enforce, true)
  const add = raw(['add', 'f_items', '--id', 'item009', '--title', '无标签无 owner', '--packet', s.pkt], { cwd: s.dir })
  assert.equal(JSON.parse(add.stdout).error.code, 'SCHEMA_VIOLATION', 'enforce 包写违规被拦（US-005 接线生效）')
  assert.equal(add.status, 1)
})
