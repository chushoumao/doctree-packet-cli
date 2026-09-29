// TASK-022 回归：settings 命名空间 + template 弃用转发壳（US-006）。
// 核心：快照矩阵（action × {人类,--json} × {成功,USAGE,…}）两入口 stdout 逐字节等价、
// stderr 恰差一行弃用提示；settings show 四态；未知 topic/action USAGE exit 2。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir, runDtp, runJson, makePacket } from './helpers.js'

const j = (args, opts) => runJson(args, opts).data

// 弃用提示常量：与 src/commands/template.js 壳逐字一致（stderr，尾随换行由 console.error 补）
const DEP = 'dtp: 提示：dtp template 已更名 dtp settings template，本版本行为完全等价（弃用别名，后续版本可能移除）'

// 最小合法 schema（1 容器 1 规则），供 check/bind 场景 setup 写入
const MIN_SCHEMA = JSON.stringify(
  {
    name: 'weekly',
    version: '1.0.0',
    skeleton: [{ id: 'f_items', title: '条目池', type: 'folder' }],
    rules: [
      {
        id: 'item',
        scope: { parent: 'f_items' },
        match: { id: '^item\\d{3}$', title: '^ITEM-\\d{3}' },
        id_pattern: '^item\\d{3}$',
        title_pattern: '^ITEM-\\d{3} ',
        tags_require: ['item'],
        numbering: { title_prefix: 'ITEM', id_prefix: 'item', digits: 3 },
      },
    ],
  },
  null,
  2
) + '\n'

const BAD_SCHEMA = JSON.stringify({
  name: 'bad',
  version: '1.0.0',
  skeleton: [{ id: 'f_a', title: 'A', type: 'folder' }],
  rules: [{ id: 'a', unknown_key: 1, scope: { parent: 'f_a' }, match: { id: '^a[unclosed' } }],
})

// 建包 + 补 f_items 容器（enforce 前置门要求 skeleton 声明的容器存在且一致）
function setupPacket(dir, { withContainer = false } = {}) {
  makePacket(path.join(dir, 'p.dtp'), { name: '等价包' })
  if (withContainer) {
    const r = runJson(['add', '/', '--type', 'folder', '--title', '条目池', '--id', 'f_items', '--packet', 'p.dtp'], { cwd: dir })
    if (r.status !== 0) throw new Error(`setup add 失败: ${JSON.stringify(r.data)}`)
  }
}

// 快照矩阵核心：两入口在独立同构目录跑同一场景，stdout 逐字节等、status 等、
// stderr 恰差一行弃用提示（转发壳仅此一处差异）
function assertEquiv(baseArgs, { setup } = {}) {
  const da = tmpdir('eq-a-')
  const db = tmpdir('eq-b-')
  for (const d of [da, db]) setup?.(d)
  const ra = runDtp(baseArgs, { cwd: da })
  const rb = runDtp(['settings', ...baseArgs], { cwd: db })
  assert.equal(rb.status, ra.status, `status 等价: ${baseArgs.join(' ')}（${ra.status} vs ${rb.status}）`)
  assert.equal(rb.stdout, ra.stdout, `stdout 逐字节等价: ${baseArgs.join(' ')}\n--- A ---\n${ra.stdout}\n--- B ---\n${rb.stdout}`)
  // 壳 run 首行即打弃用提示，之后才走 dispatch（含报错）——DEP 恒为 template 侧 stderr 前缀
  assert.equal(ra.stderr, DEP + '\n' + rb.stderr, `stderr 恰差弃用提示（template 侧前缀）: ${baseArgs.join(' ')}\n--- A ---\n${ra.stderr}\n--- B ---\n${rb.stderr}`)
  return { ra, rb }
}

// ---------- acceptance ①：快照矩阵 action × {人类,--json} × {成功,USAGE} stdout 全等 ----------

const MATRIX = [
  { name: 'new 成功', args: ['template', 'new', 'weekly'] },
  { name: 'new EXISTS', args: ['template', 'new', 'weekly'], setup: (d) => fs.writeFileSync(path.join(d, 'weekly.schema.json'), MIN_SCHEMA) },
  { name: 'new 非法名 USAGE', args: ['template', 'new', 'bad name'] },
  { name: 'check 成功', args: ['template', 'check', 'weekly.schema.json'], setup: (d) => fs.writeFileSync(path.join(d, 'weekly.schema.json'), MIN_SCHEMA) },
  { name: 'check 缺 target USAGE', args: ['template', 'check'] },
  { name: 'check 文件缺失 USAGE', args: ['template', 'check', 'nope.json'] },
  { name: 'bind 成功', args: ['template', 'bind', 'weekly.schema.json', '--packet', 'p.dtp'], setup: (d) => { setupPacket(d); fs.writeFileSync(path.join(d, 'weekly.schema.json'), MIN_SCHEMA) } },
  { name: 'bind 缺 target USAGE', args: ['template', 'bind', '--packet', 'p.dtp'], setup: (d) => setupPacket(d) },
  { name: 'bind 坏 schema SCHEMA_INVALID', args: ['template', 'bind', 'bad.schema.json', '--packet', 'p.dtp'], setup: (d) => { setupPacket(d); fs.writeFileSync(path.join(d, 'bad.schema.json'), BAD_SCHEMA) } },
  { name: '未知 action USAGE', args: ['template', 'badact'] },
]

for (const m of MATRIX) {
test(`快照矩阵（人类）${m.name}`, () => {
const { rb } = assertEquiv(m.args, { setup: m.setup })
    // 人类错误走 stderr 的场景，弃用提示应拼在其后（顺序：原 stderr 内容在前、提示在后）
    assert.ok(!rb.stdout.includes(DEP), '弃用提示不得进 stdout')
  })
  test(`快照矩阵（--json）${m.name}`, () => {
    const args = [...m.args, '--json']
    const { ra, rb } = assertEquiv(args, { setup: m.setup })
    // --json stdout 单行契约在转发路径同样成立（console.log 尾随 \n 除外）
    assert.ok(!rb.stdout.trimEnd().includes('\n'), '--json stdout 单行')
    const parsed = JSON.parse(rb.stdout)
    assert.equal(parsed.ok, JSON.parse(ra.stdout).ok)
  })
}

// ---------- acceptance ②：弃用提示只进 stderr（--json 时 stdout 不受污染） ----------

test('弃用提示：人类模式 stderr 恰一行为 DEP 文案；--json stdout 仍单行 JSON', () => {
  const dir = tmpdir('dep-')
  const r = runDtp(['template', 'new', 'weekly'], { cwd: dir })
  assert.equal(r.stderr, DEP + '\n')
  const rj = runDtp(['template', 'new', 'weekly2', '--json'], { cwd: dir })
  assert.equal(rj.stderr, DEP + '\n')
  assert.ok(!rj.stdout.trimEnd().includes('\n'), '--json stdout 除尾随换行外单行')
  assert.equal(JSON.parse(rj.stdout).ok, true)
})

test('settings 入口无弃用提示（stderr 干净）', () => {
  const dir = tmpdir('nodep-')
  const r = runDtp(['settings', 'template', 'new', 'weekly'], { cwd: dir })
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
})

// ---------- acceptance ③：settings show 四态 ----------

test('show 态一（无绑定）：template/schema/skeleton/rules 全 null，人类提示绑定入口', () => {
  const dir = tmpdir('show1-')
  setupPacket(dir)
  const r = runDtp(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /绑定模版：无/)
  const d = j(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(d.template, null)
  assert.equal(d.schema, null)
  assert.equal(d.skeleton, null)
  assert.equal(d.rules, null)
})

test('show 态二（绑定未设置 enforce）：enforce:null；人类「未设置」', () => {
  const dir = tmpdir('show2-')
  setupPacket(dir)
  fs.writeFileSync(path.join(dir, 'weekly.schema.json'), MIN_SCHEMA)
  j(['settings', 'template', 'bind', 'weekly.schema.json', '--packet', 'p.dtp'], { cwd: dir })
  const d = j(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(d.template.enforce, null)
  assert.equal(d.schema.found, true)
  assert.equal(d.schema.drift, false)
  assert.deepEqual(d.schema.problems, [])
  assert.equal(d.skeleton.length, 1)
  assert.equal(d.rules.length, 1)
  assert.equal(d.rules[0].id, 'item')
  // 逐规则摘要剔除注释肥字段，约束键原样保留（MIN_SCHEMA 的 item 规则带 tags_require）
  assert.ok(!('comment' in d.rules[0]))
  assert.deepEqual(d.rules[0].tags_require, ['item'])
  const r = runDtp(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.match(r.stdout, /强制校验：未设置/)
})

test('show 态三（enforce 开启）：前置门过（容器一致）后 enforce:true；人类「开启」', () => {
  const dir = tmpdir('show3-')
  setupPacket(dir, { withContainer: true })
  fs.writeFileSync(path.join(dir, 'weekly.schema.json'), MIN_SCHEMA)
  const b = j(['settings', 'template', 'bind', 'weekly.schema.json', '--packet', 'p.dtp', '--enforce'], { cwd: dir })
  assert.equal(b.ok, true)
  const d = j(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(d.template.enforce, true)
  assert.match(runDtp(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir }).stdout, /强制校验：开启/)
})

test('show 态三b（enforce 显式关闭）：--no-enforce → enforce:false', () => {
  const dir = tmpdir('show3b-')
  setupPacket(dir)
  fs.writeFileSync(path.join(dir, 'weekly.schema.json'), MIN_SCHEMA)
  j(['settings', 'template', 'bind', 'weekly.schema.json', '--packet', 'p.dtp', '--no-enforce'], { cwd: dir })
  const d = j(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(d.template.enforce, false)
})

test('show 态四（schema 丢失降级）：found:false、skeleton/rules 置 null、sha 仍在案；人类「丢失」', () => {
  const dir = tmpdir('show4-')
  setupPacket(dir)
  fs.writeFileSync(path.join(dir, 'weekly.schema.json'), MIN_SCHEMA)
  j(['settings', 'template', 'bind', 'weekly.schema.json', '--packet', 'p.dtp'], { cwd: dir })
  fs.unlinkSync(path.join(dir, 'weekly.schema.json'))
  const d = j(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(d.status ?? 0, 0)
  assert.equal(d.schema.found, false)
  assert.equal(d.schema.file, 'weekly.schema.json')
  assert.equal(d.template.schema_sha256.length, 64)
  assert.equal(d.skeleton, null)
  assert.equal(d.rules, null)
  const r = runDtp(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /丢失/)
})

test('show 态四b（sha 漂移）：drift:true 警告；摘要按当前文件照给', () => {
  const dir = tmpdir('show4b-')
  setupPacket(dir)
  fs.writeFileSync(path.join(dir, 'weekly.schema.json'), MIN_SCHEMA)
  j(['settings', 'template', 'bind', 'weekly.schema.json', '--packet', 'p.dtp'], { cwd: dir })
  const drifted = JSON.parse(MIN_SCHEMA)
  drifted.version = '1.0.1'
  fs.writeFileSync(path.join(dir, 'weekly.schema.json'), JSON.stringify(drifted, null, 2) + '\n')
  const d = j(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(d.schema.drift, true)
  assert.notEqual(d.schema.sha256, d.template.schema_sha256)
  assert.equal(d.skeleton.length, 1) // 当前文件可解析，摘要照给
  assert.match(runDtp(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir }).stdout, /漂移/)
})

test('show 前置门联动：空包缺容器时 bind --enforce 被拒（SCHEMA_VIOLATION），包零写入', () => {
  const dir = tmpdir('show-gate-')
  setupPacket(dir)
  fs.writeFileSync(path.join(dir, 'weekly.schema.json'), MIN_SCHEMA)
  const b = j(['settings', 'template', 'bind', 'weekly.schema.json', '--packet', 'p.dtp', '--enforce'], { cwd: dir })
  assert.equal(b.ok, false)
  assert.equal(b.error.code, 'SCHEMA_VIOLATION')
  const d = j(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(d.template, null) // 被拒则包零写入
})

// ---------- acceptance ④：未知 topic / show 带位置参数 / 缺 action → USAGE exit 2 ----------

test('settings：未知 topic USAGE exit 2（--json 带可用 topic 列表）', () => {
  const dir = tmpdir('topic-')
  const r = runDtp(['settings', 'badtopic'], { cwd: dir })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知 topic/)
  const d = j(['settings', 'badtopic'], { cwd: dir })
  assert.equal(d.ok, false)
  assert.equal(d.error.code, 'USAGE')
  assert.match(d.error.message, /template \| show/)
})

test('settings show 带位置参数 → USAGE；settings template 缺 action → USAGE', () => {
  const dir = tmpdir('showextra-')
  assert.equal(runDtp(['settings', 'show', 'extra'], { cwd: dir }).status, 2)
  const r = runDtp(['settings', 'template'], { cwd: dir })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /需要 <action>/)
  const d = j(['settings', 'show', 'x', 'y'], { cwd: dir })
  assert.equal(d.error.code, 'USAGE')
})

// ---------- 注册与帮助面 ----------

test('settings 已注册：根 help 列出、settings --help 渲染 show 示例', () => {
  const root = runDtp(['--help'], { cwd: tmpdir('reg-') })
  assert.match(root.stdout, /settings/)
  const h = runDtp(['settings', '--help'], { cwd: tmpdir('reg2-') })
  assert.match(h.stdout, /settings show/)
  assert.match(h.stdout, /topic/)
})

test('包缺失：settings show 显式 --packet 指向不存在文件 → NO_PACKET（走 ctx.load 惯例）', () => {
  const dir = tmpdir('showmiss-')
  const d = j(['settings', 'show', '--packet', 'nope.dtp'], { cwd: dir })
  assert.equal(d.ok, false)
  assert.equal(d.error.code, 'NO_PACKET')
})
