// TASK-022 回归：settings 命名空间 + template 弃用转发壳（US-006）。
// 核心：快照矩阵（action × {人类,--json} × {成功,USAGE,…}）两入口 stdout 逐字节等价、
// stderr 恰差一行弃用提示；settings show 四态；未知 topic/action USAGE exit 2。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir, runDtp, runJson, makePacket, ROOT } from './helpers.js'

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
  // 「check 文件缺失」自 OPTIM-031 起报错含 cwd 解析绝对路径，天然随 tmp 目录名变化，
  // 不再适合逐字节矩阵（两入口行为一致性由下方 OPTIM-031 专项测试覆盖）
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

// ---------- OPTIM-031：schema 路径报告口径（相对包目录 + 绝对路径） ----------

test('OPTIM-031：settings show --json schema.abs 绝对且可达（跨 cwd 调用一致）；丢失态给期望位置', () => {
  const dir = tmpdir('p31-')
  setupPacket(dir)
  fs.writeFileSync(path.join(dir, 'weekly.schema.json'), MIN_SCHEMA)
  j(['settings', 'template', 'bind', 'weekly.schema.json', '--packet', 'p.dtp'], { cwd: dir })
  const d = j(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.ok(path.isAbsolute(d.schema.abs))
  assert.equal(d.schema.abs, fs.realpathSync(path.join(dir, 'weekly.schema.json')))
  // 跨 cwd 调用照旧可达（abs 相对包文件目录解析，与调用方 cwd 无关）
  const d2 = j(['settings', 'show', '--packet', path.join(dir, 'p.dtp')], { cwd: tmpdir('p31cwd-') })
  assert.equal(d2.schema.abs, d.schema.abs)

  fs.unlinkSync(path.join(dir, 'weekly.schema.json'))
  const lost = j(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(lost.schema.found, false)
  assert.ok(path.isAbsolute(lost.schema.abs))
  assert.match(runDtp(['settings', 'show', '--packet', 'p.dtp'], { cwd: dir }).stdout, /期望位置：/)
})

test('OPTIM-031：check 缺文件报错附 cwd 解析绝对路径；init --template 响应带 abs（不落盘）', () => {
  const dir = tmpdir('p31b-')
  const d = j(['settings', 'template', 'check', 'nope.json'], { cwd: dir })
  assert.equal(d.error.code, 'USAGE')
  assert.ok(d.error.message.includes(path.join(dir, 'nope.json')), '报错含 cwd 解析后的绝对路径')

  fs.writeFileSync(path.join(dir, 'w.schema.json'), MIN_SCHEMA)
  const r = j(['init', '路径包', '--packet', path.join(dir, 'p.dtp'), '--template', 'w.schema.json'], { cwd: dir })
  assert.equal(r.template.abs, fs.realpathSync(path.join(dir, 'w.schema.json')))
  // abs 是响应派生字段，不进 append-only metadata（与 bind 记录形状一致）
  assert.ok(!('abs' in JSON.parse(fs.readFileSync(path.join(dir, 'p.dtp'), 'utf8').split('\n').find((l) => l.includes('packet_meta')) ?? '{}')))
})

// ---------- OPTIM-034：settings show 的 file 照抄可达（跨 cwd）+ OPTIM-032 旧命令文案清除 ----------

test('OPTIM-034：schema 存包外时 file 为包相对路径，照抄 check/bind 跨 cwd 仍可达', () => {
  const outer = tmpdir('p34-')
  const inner = path.join(outer, 'a', 'b')
  fs.mkdirSync(inner, { recursive: true })
  const schemaFile = path.join(outer, 'ops.schema.json')
  const pkt = path.join(inner, 'p.dtp')
  fs.writeFileSync(schemaFile, MIN_SCHEMA)
  j(['init', '变更包', '--packet', pkt, '--id', 'n_root'], { cwd: outer })
  j(['settings', 'template', 'bind', path.join(outer, 'ops.schema.json'), '--packet', pkt], { cwd: outer })

  const d = j(['settings', 'show', '--packet', pkt], { cwd: outer })
  // file 是包相对契约字段（跨到包外即 ../.. 形态）；abs 是照抄可用的绝对路径
  assert.equal(d.schema.file, '../../ops.schema.json')
  assert.ok(path.isAbsolute(d.schema.abs))

  // 异 cwd 照抄 file：按包目录回退解析（修复前指到 cwd 之外 → USAGE exit 2）
  const other = tmpdir('p34cwd-')
  const chk = j(['settings', 'template', 'check', d.schema.file, '--packet', pkt], { cwd: other })
  assert.equal(chk.ok, true, JSON.stringify(chk))
  assert.equal(chk.problems.length, 0)
  const bind = j(['settings', 'template', 'bind', d.schema.file, '--packet', pkt], { cwd: other })
  assert.equal(bind.ok, true, JSON.stringify(bind))
  assert.equal(bind.template.file, '../../ops.schema.json', '回退解析后包相对值不变')

  // 两处都找不到时报错同时给出 cwd 与包目录解析结果
  const miss = j(['settings', 'template', 'check', '../../nope.json', '--packet', pkt], { cwd: other })
  assert.equal(miss.error.code, 'USAGE')
  assert.match(miss.error.message, /cwd 解析：/)
  assert.match(miss.error.message, /包目录解析：/)
})

test('OPTIM-032：src 内提示文案无旧命令名残留（dtp template 仅存于弃用别名文件）', () => {
  const files = ['src/template.js', 'src/commands/settings.js', 'src/commands/lint.js', 'src/commands/init.js', 'src/enforce.js']
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8')
    // 只查用户可见文案行；以 // 开头的架构/历史注释（如别名机制说明）不在清理范围
    const leftovers = text
      .split('\n')
      .filter((l) => l.includes('dtp template') && !l.includes('dtp settings template') && !l.trimStart().startsWith('//'))
    assert.deepEqual(leftovers, [], `${f} 残留旧命令名：${leftovers.join(' | ')}`)
  }
  // 弃用别名文件保留自身用法示例（别名依然可用，标注本身不动）
  const alias = fs.readFileSync(path.join(ROOT, 'src/commands/template.js'), 'utf8')
  assert.ok(alias.includes('dtp template new weekly'), '别名示例保留')
})

// ---------- OPTIM-035：settings template unbind（配置态退出路径）+ 前置门受影响节点清单 ----------

test('OPTIM-035：unbind 成功（非 enforce）→ template null、append-only 留痕、包仍 verify 通过', () => {
  const dir = tmpdir('ub-')
  const pkt = path.join(dir, 'p.dtp')
  makePacket(pkt, { name: '解绑包' })
  fs.writeFileSync(path.join(dir, 'w.schema.json'), MIN_SCHEMA)
  j(['settings', 'template', 'bind', 'w.schema.json', '--packet', pkt], { cwd: dir })
  const r = j(['settings', 'template', 'unbind', '--packet', pkt], { cwd: dir })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.unbound.name, 'weekly')
  assert.equal(r.enforce_cleared, false)
  // 解绑以新增 packet_meta 行表达：当前 metadata.template 为 null，历史绑定行未改写
  const d = j(['settings', 'show', '--packet', pkt], { cwd: dir })
  assert.equal(d.template, null)
  assert.equal(d.schema, null)
  assert.equal(runDtp(['verify', '--packet', pkt], { cwd: dir }).status, 0)
})

test('OPTIM-035：未绑定包 unbind → USAGE exit 2（不静默成功）；unbind 带位置参数亦 USAGE', () => {
  const dir = tmpdir('ub2-')
  const pkt = path.join(dir, 'p.dtp')
  makePacket(pkt, { name: '空绑包' })
  const r = j(['settings', 'template', 'unbind', '--packet', pkt], { cwd: dir })
  assert.equal(r.error.code, 'USAGE')
  assert.match(r.error.message, /未绑定模版/)
  assert.equal(runDtp(['settings', 'template', 'unbind', '--packet', pkt], { cwd: dir }).status, 2)
  const bad = j(['settings', 'template', 'unbind', 'x', '--packet', pkt], { cwd: dir })
  assert.equal(bad.error.code, 'USAGE')
})

test('OPTIM-035：enforce 态解绑需 --force（强制随绑定一并解除）；--force 后生效', () => {
  const dir = tmpdir('ub3-')
  const pkt = path.join(dir, 'p.dtp')
  fs.writeFileSync(path.join(dir, 'w.schema.json'), MIN_SCHEMA)
  j(['init', '强制包', '--packet', pkt, '--template', 'w.schema.json'], { cwd: dir })
  j(['settings', 'template', 'bind', 'w.schema.json', '--packet', pkt, '--enforce'], { cwd: dir })
  assert.equal(j(['settings', 'show', '--packet', pkt], { cwd: dir }).template.enforce, true)

  // 未确认 → USAGE exit 2（避免静默关掉保护）
  const blocked = j(['settings', 'template', 'unbind', '--packet', pkt], { cwd: dir })
  assert.equal(blocked.error.code, 'USAGE')
  assert.match(blocked.error.message, /一并解除强制/)
  assert.equal(runDtp(['settings', 'template', 'unbind', '--packet', pkt], { cwd: dir }).status, 2)

  // 确认后解绑，强制一并解除
  const ok = j(['settings', 'template', 'unbind', '--packet', pkt, '--force'], { cwd: dir })
  assert.equal(ok.ok, true)
  assert.equal(ok.enforce_cleared, true)
  assert.equal(j(['settings', 'show', '--packet', pkt], { cwd: dir }).template, null)
})

test('前置门被拒提示附受影响节点清单（id/标题），拦截语义不变', () => {
  const dir = tmpdir('gate-')
  const pkt = path.join(dir, 'p.dtp')
  fs.writeFileSync(path.join(dir, 'w.schema.json'), MIN_SCHEMA)
  j(['init', '脏包', '--packet', pkt, '--template', 'w.schema.json'], { cwd: dir })
  // 认领但缺必填标签 → error 级违规（前置门必然拒绝）
  j(['add', 'f_items', '--id', 'item001', '--title', 'ITEM-001 缺标签', '--packet', pkt], { cwd: dir })
  j(['add', 'f_items', '--id', 'item002', '--title', 'ITEM-002 也缺', '--packet', pkt], { cwd: dir })
  const r = j(['settings', 'template', 'bind', 'w.schema.json', '--packet', pkt, '--enforce'], { cwd: dir })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'SCHEMA_VIOLATION', '拦截语义不变')
  assert.match(r.error.message, /受影响节点（2）/)
  assert.match(r.error.message, /item001「ITEM-001 缺标签」/)
  assert.match(r.error.message, /item002「ITEM-002 也缺」/)
  // 违规明细照旧随 error 携带（提示增强不改形状）
  assert.ok(Array.isArray(r.error.violations))
  assert.equal(runDtp(['settings', 'template', 'bind', 'w.schema.json', '--packet', pkt, '--enforce'], { cwd: dir }).status, 1)
})

// ---------- OPTIM-033：template new 骨架示范完整键集 ----------

test('OPTIM-033：new 骨架示范完整键集（约束键各至少一处）+ 每键用途注释，自举通过', () => {
  const dir = tmpdir('sk-')
  const r = j(['settings', 'template', 'new', 'weekly'], { cwd: dir })
  assert.equal(r.ok, true)
  const schema = JSON.parse(fs.readFileSync(path.join(dir, 'weekly.schema.json'), 'utf8'))
  const keys = new Set(Object.keys(schema.rules[0]))
  for (const k of ['scope', 'match', 'id_pattern', 'title_pattern', 'content_sections', 'ext_required', 'ext_arrays', 'tags_require', 'status_evidence', 'numbering']) {
    assert.ok(keys.has(k), `骨架 item 规则应示范 ${k}`)
  }
  // 第二规则示范 ref_exists 引用核查
  const note = schema.rules.find((x) => x.id === 'note')
  assert.ok(note, 'note 规则在（ref_exists 示范）')
  assert.ok(Array.isArray(note.ref_exists))
  // 每键用途写进 comment（agent/用户不必回头读 DSL 文档）
  for (const kw of ['scope.parent', 'match', 'content_sections', 'ext_required', 'ext_arrays', 'tags_require', 'status_evidence', 'numbering', 'scope.exclusive']) {
    assert.ok(schema.rules[0].comment.includes(kw), `comment 应说明 ${kw}`)
  }
  // 自举：产物过自身 check；用骨架建包 lint 也应通过
  const c = j(['settings', 'template', 'check', 'weekly.schema.json'], { cwd: dir })
  assert.equal(c.ok, true)
  const init = j(['init', '骨架包', '--packet', path.join(dir, 'p.dtp'), '--template', 'weekly.schema.json'], { cwd: dir })
  assert.equal(init.ok, true, JSON.stringify(init))
  const lint = j(['lint', '--packet', 'p.dtp'], { cwd: dir })
  assert.equal(lint.ok, true, JSON.stringify(lint.violations))
})
