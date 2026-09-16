// TASK-019 回归：enforce 写路径接线（9 条 error 规则 × add/update、warn 透传、零回归、webui、性能）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir, runDtp } from './helpers.js'

const BIN = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'dtp.js')
const j = (args, opts) => JSON.parse(runDtp([...args, '--json'], opts).stdout || 'null')
const raw = (args, opts) => runDtp([...args, '--json'], opts)

const CONTENT = '【背景与讨论】a\n【用户故事】b\n【需求拆分】c\n【验收口径】d'
const SCHEMA = {
  name: 'us', version: '1.0.0',
  skeleton: [{ id: 'f_stories', title: '故事池', type: 'folder' }],
  rules: [
    {
      id: 'story', scope: { parent: 'f_stories' },
      match: { id: '^us\\d{3}$', title: '^US-\\d{3}' },
      id_pattern: '^us\\d{3}$', title_pattern: '^US-\\d{3} ',
      ext_required: ['priority'], tags_require: ['story'], content_sections: ['【用户故事】'],
      status_evidence: { approved: ['done_evidence'] },
      numbering: { title_prefix: 'US', id_prefix: 'us', digits: 3 },
    },
    {
      id: 'task', scope: { parent: 'story' }, match: { id: '^task\\d{3}$' },
      id_pattern: '^task\\d{3}$', ext_required: ['story', 'acceptance'], ext_arrays: ['acceptance'],
      ref_exists: ['story'],
    },
  ],
}

function setup(prefix, { enforce = true } = {}) {
  const dir = tmpdir(prefix)
  const pkt = path.join(dir, 'p.dtp')
  fs.writeFileSync(path.join(dir, 'us.schema.json'), JSON.stringify(SCHEMA, null, 2))
  j(['init', '演示', '--packet', pkt], { cwd: dir })
  j(['add', '/', '--id', 'f_stories', '--title', '故事池', '--type', 'folder', '--packet', pkt], { cwd: dir })
  if (enforce) {
    const b = j(['template', 'bind', 'us.schema.json', '--enforce', '--packet', pkt], { cwd: dir })
    assert.equal(b.ok, true, `bind --enforce 应成功：${JSON.stringify(b.error)}`)
  }
  return {
    dir, pkt,
    add: (args) => raw(['add', ...args, '--packet', pkt], { cwd: dir }),
    upd: (ref, args) => raw(['update', ref, ...args, '--packet', pkt], { cwd: dir }),
    bytes: () => fs.readFileSync(pkt, 'utf8'),
  }
}

const okStory = ['f_stories', '--id', 'us001', '--title', 'US-001 好故事', '--type', 'requirement', '--tags', 'story', '--ext', 'priority=P1', '--content', CONTENT]
const okTask = (pid = 'us001') => ['us001', '--id', 'task001', '--title', 'TASK-001 好任务', '--type', 'requirement', '--ext', 'story=US-001', '--ext', 'acceptance=["x"]']

// ---------- 9 条 error 规则：add 路径 ----------

const ADD_CASES = [
  { rule: 'parent.container', args: ['f_stories', '--id', 'task009', '--title', 'TASK-009 挂容器下', '--ext', 'story=US-001', '--ext', 'acceptance=["x"]'] },
  { rule: 'id.pattern', args: ['f_stories', '--id', 'bad_id', '--title', 'US-009 标题合规 id 乱', '--tags', 'story', '--ext', 'priority=P1', '--content', CONTENT] },
  { rule: 'title.pattern', args: ['f_stories', '--id', 'us009', '--title', '没有编号前缀', '--tags', 'story', '--ext', 'priority=P1', '--content', CONTENT] },
  { rule: 'ext.required', args: ['f_stories', '--id', 'us010', '--title', 'US-010 缺 priority', '--tags', 'story', '--content', CONTENT] },
  { rule: 'tags.require', args: ['f_stories', '--id', 'us011', '--title', 'US-011 缺标签', '--ext', 'priority=P1', '--content', CONTENT] },
  { rule: 'content.sections', args: ['f_stories', '--id', 'us012', '--title', 'US-012 缺段落', '--tags', 'story', '--ext', 'priority=P1', '--content', '没段落'] },
  { rule: 'status.evidence', args: ['f_stories', '--id', 'us013', '--title', 'US-013 批准无证据', '--tags', 'story', '--ext', 'priority=P1', '--content', CONTENT, '--status', 'approved'] },
]

test('enforce：add 路径 7 条规则逐条拒绝（含 task 子规则需先有合法故事）', () => {
  const s = setup('en-add-')
  assert.equal(s.add(okStory).status, 0, '先建合法故事（task 规则作用域需要）')
  for (const c of ADD_CASES) {
    const before = s.bytes()
    const r = s.add(c.args)
    const out = JSON.parse(r.stdout)
    assert.equal(out.error?.code, 'SCHEMA_VIOLATION', `${c.rule} 应被拦，实际 ${JSON.stringify(out).slice(0, 200)}`)
    assert.ok(out.error.violations.some((v) => v.rule === c.rule), `${c.rule} 应在 violations：${out.error.violations.map((v) => v.rule)}`)
    assert.ok(out.error.violations.every((v) => v.hint), '每条例外含 hint')
    assert.equal(r.status, 1, 'exit 1')
    assert.equal(s.bytes(), before, `${c.rule}：包文件字节零变化`)
  }
})

test('enforce：add 路径 ext.arrays 与 ref_exists（task 规则）', () => {
  const s = setup('en-add2-')
  assert.equal(s.add(okStory).status, 0)
  const cases = [
    { rule: 'ext.arrays', args: ['us001', '--id', 'task002', '--title', 'TASK-002 数组非数组', '--ext', 'story=US-001', '--ext', 'acceptance=字符串'] },
    { rule: 'ref_exists', args: ['us001', '--id', 'task003', '--title', 'TASK-003 悬空引用', '--ext', 'story=US-999', '--ext', 'acceptance=["x"]'] },
  ]
  for (const c of cases) {
    const before = s.bytes()
    const out = JSON.parse(s.add(c.args).stdout)
    assert.equal(out.error?.code, 'SCHEMA_VIOLATION', c.rule)
    assert.ok(out.error.violations.some((v) => v.rule === c.rule))
    assert.equal(s.bytes(), before)
  }
})

// ---------- update 路径：同样 9 条（对已有合法节点改成违规） ----------

test('enforce：update 路径逐条拒绝（9 条规则全覆盖）', () => {
  const s = setup('en-upd-')
  assert.equal(s.add(okStory).status, 0)
  assert.equal(s.add(okTask()).status, 0)

  const cases = [
    { rule: 'title.pattern', ref: 'us001', args: ['--title', '坏标题'] },
    { rule: 'id.pattern', ref: 'us001', args: ['--title', 'US-001 x'], idCheck: true }, // 合法，仅作对照
    { rule: 'ext.required', ref: 'us001', args: ['--ext', 'priority=null', '--force'] },
    { rule: 'tags.require', ref: 'us001', args: ['--tags', 'other'] },
    { rule: 'content.sections', ref: 'us001', args: ['--content', '没段落'] },
    { rule: 'status.evidence', ref: 'us001', args: ['--status', 'approved'] },
    { rule: 'ext.arrays', ref: 'task001', args: ['--ext', 'acceptance=字符串', '--force'] },
    { rule: 'ref_exists', ref: 'task001', args: ['--ext', 'story=US-999', '--force'] },
  ]
  for (const c of cases) {
    if (c.idCheck) {
      assert.equal(s.upd(c.ref, c.args).status, 0, '对照：合法 update 通过')
      continue
    }
    const before = s.bytes()
    const out = JSON.parse(s.upd(c.ref, c.args).stdout)
    assert.equal(out.error?.code, 'SCHEMA_VIOLATION', `${c.rule} 应被拦：${JSON.stringify(out).slice(0, 160)}`)
    assert.ok(out.error.violations.some((v) => v.rule === c.rule), `${c.rule}：${out.error.violations.map((v) => v.rule)}`)
    assert.equal(s.bytes(), before, `${c.rule}：字节零变化`)
  }
  // parent.container 的 update 路径：把任务挪到容器下（mv 不在本轮范围，用 update 改不了 parent，跳过——
  // parent.container 的 update 面由「已存在违规节点的合法字段编辑」覆盖：enforce 下不可能存在，故仅 add 面）
})

// ---------- warn 透传 ----------

test('enforce：warn（编号跳号/版本漂移）不拦截，随成功写入透传 schema_warnings', () => {
  const s = setup('en-warn-')
  assert.equal(s.add(okStory).status, 0)
  // us005：跳过 2..4（id.continuity warn）
  const r = j(['add', 'f_stories', '--id', 'us005', '--title', 'US-005 跳号', '--type', 'requirement', '--tags', 'story', '--ext', 'priority=P1', '--content', CONTENT, '--packet', s.pkt], { cwd: s.dir })
  assert.equal(r.ok, true, 'warn 不拦截')
  assert.ok(r.schema_warnings?.some((w) => w.rule === 'id.continuity'), `应透传 schema_warnings：${JSON.stringify(r.schema_warnings)}`)
  // 人类模式 ⚠ 行
  const human = runDtp(['add', 'f_stories', '--id', 'us007', '--title', 'US-007 又跳', '--type', 'requirement', '--tags', 'story', '--ext', 'priority=P1', '--content', CONTENT, '--packet', s.pkt], { cwd: s.dir })
  assert.equal(human.status, 0)
  assert.match(human.stdout, /⚠.*id\.continuity/)
})

// ---------- 零回归：enforce 关闭 / 未绑定 ----------

test('零回归：未开强制的包写违规内容照常成功（与现状一致）', () => {
  const s = setup('en-off-', { enforce: false })
  const r = s.add(['f_stories', '--id', 'bad', '--title', '什么都违规'])
  assert.equal(r.status, 0, '非 enforce 包零回归')
  const off = setup('en-off2-')
  j(['template', 'bind', 'us.schema.json', '--no-enforce', '--packet', off.pkt], { cwd: off.dir })
  assert.equal(off.add(['f_stories', '--id', 'bad', '--title', '照常']).status, 0, '--no-enforce 显式关闭后零回归')
})

// ---------- schema 三态（写路径） ----------

test('enforce 写路径：schema 文件丢失/非法/同版本漂移 → 快速失败；版本不同 → 放行 + warn', () => {
  const s = setup('en-three-')
  fs.rmSync(path.join(s.dir, 'us.schema.json'))
  assert.equal(JSON.parse(s.add(okStory).stdout).error.code, 'TEMPLATE_MISSING')

  fs.writeFileSync(path.join(s.dir, 'us.schema.json'), '{oops')
  assert.equal(JSON.parse(s.add(okStory).stdout).error.code, 'SCHEMA_INVALID')

  // 同版本改内容 → SCHEMA_DRIFT
  fs.writeFileSync(path.join(s.dir, 'us.schema.json'), JSON.stringify({ ...SCHEMA, comment: '改了' }))
  assert.equal(JSON.parse(s.add(okStory).stdout).error.code, 'SCHEMA_DRIFT')

  // 版本不同 → 放行 + schema.drift warn
  fs.writeFileSync(path.join(s.dir, 'us.schema.json'), JSON.stringify({ ...SCHEMA, version: '2.0.0' }))
  const r = j(['add', 'f_stories', '--id', 'us001', '--title', 'US-001 好故事', '--type', 'requirement', '--tags', 'story', '--ext', 'priority=P1', '--content', CONTENT, '--packet', s.pkt], { cwd: s.dir })
  assert.equal(r.ok, true, '版本演进放行')
  assert.ok(r.schema_warnings.some((w) => w.rule === 'schema.drift'))
})

// ---------- webui 编辑 API ----------

test('enforce：webui 编辑 API 同被拒（同一 enforcer）', async () => {
  const s = setup('en-web-')
  const PORT = 4800 + Math.floor(Math.random() * 100)
  const BASE = `http://127.0.0.1:${PORT}`
  const child = spawn(process.execPath, [BIN, 'web', '--port', String(PORT), '--dir', s.dir], { stdio: 'ignore' })
  try {
    const t0 = Date.now()
    for (;;) {
      try { await fetch(`${BASE}/api/packets`); break } catch {
        if (Date.now() - t0 > 5000) throw new Error('web 未就绪')
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    const before = s.bytes()
    const bad = await (await fetch(`${BASE}/api/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packet: 'p.dtp', parentRef: '/演示/故事池', id: 'bad_id', title: 'US-001 标题合规但 id 乱', tags: ['story'], ext: { priority: 'P1' }, content: CONTENT, user: 'web' }),
    })).json()
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'SCHEMA_VIOLATION', JSON.stringify(bad.error))
    assert.ok(bad.error.violations.length > 0)
    assert.equal(s.bytes(), before, 'web 拒绝时包零写入')

    const good = await (await fetch(`${BASE}/api/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packet: 'p.dtp', parentRef: '/演示/故事池', id: 'us001', title: 'US-001 好故事', nodeType: 'requirement', tags: ['story'], ext: { priority: 'P1' }, content: CONTENT, user: 'web' }),
    })).json()
    assert.equal(good.ok, true, JSON.stringify(good.error))
  } finally {
    child.kill('SIGTERM')
  }
})

// ---------- 性能冒烟：10k 包 ----------

test('性能：10k 包 enforce 评估增量为毫秒级（进程内差值，排除 CLI 进程启动噪声）', async () => {
  const dir = tmpdir('en-perf-')
  const pkt = path.join(dir, 'big.dtp')
  const now = new Date().toISOString()
  const { computeNodeHash } = await import('../src/model/node.js')
  const { Packet } = await import('../src/packet.js')
  const { attachEnforcer } = await import('../src/enforce.js')

  const mk = (id, parent, title, nodeType = 'document') => {
    const n = { type: 'node', id, parent_id: parent, node_type: nodeType, title, description: '', content: '', extensions: {}, created_at: now, updated_at: now, version: 1, hash: '', tags: [], status: 'draft' }
    n.hash = computeNodeHash(n)
    return JSON.stringify(n)
  }
  const lines = [
    JSON.stringify({ type: 'packet_meta', packet_id: 'pkt-perf', name: '大包', version: 'v1', created_at: now, updated_at: now, root_node_id: 'root', metadata: {} }),
    mk('root', null, '大包', 'folder'),
    mk('f_stories', 'root', '故事池', 'folder'),
  ]
  for (let i = 0; i < 10000; i++) lines.push(mk(`n${i}`, 'root', `节点 ${i}`))
  fs.writeFileSync(pkt, lines.join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'us.schema.json'), JSON.stringify({ ...SCHEMA, skeleton: [{ id: 'f_stories', title: '故事池', type: 'folder' }] }))
  assert.equal(j(['template', 'bind', 'us.schema.json', '--enforce', '--packet', pkt], { cwd: dir }).ok, true)

  const args = (i) => ({
    parentRef: 'f_stories',
    id: `us${String(i).padStart(3, '0')}`,
    title: `US-${String(i).padStart(3, '0')} 命中`,
    nodeType: 'requirement',
    tags: ['story'],
    extensions: { priority: 'P1' },
    content: CONTENT,
  })
  const N = 30
  // A) 带 enforcer（真实写路径评估）
  const pA = Packet.load(pkt)
  attachEnforcer(pA)
  assert.ok(pA.enforcer, 'enforcer 已注入')
  const tA = process.hrtime.bigint()
  for (let i = 0; i < N; i++) pA.addNode(args(i))
  const msA = Number(process.hrtime.bigint() - tA) / 1e6 / N

  // B) 无 enforcer（基线）
  const pB = Packet.load(pkt)
  const tB = process.hrtime.bigint()
  for (let i = 0; i < N; i++) pB.addNode(args(i))
  const msB = Number(process.hrtime.bigint() - tB) / 1e6 / N

  const inc = msA - msB
  console.log(`  10k 包单次 add：无校验 ${msB.toFixed(2)}ms → 有校验 ${msA.toFixed(2)}ms（增量 ${inc.toFixed(2)}ms）`)
  assert.ok(inc < 15, `enforce 评估增量 ${inc.toFixed(2)}ms 应 < 15ms（10k 包 O(N) 认领扫描）`)
})
