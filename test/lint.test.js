// TASK-006 回归：lint 命令（三态发现、漂移二分、前置短路、violations 契约、exit 纪律）
// 全程 CLI 子进程级自举：template schema → init --template → add/rm/update 制造场景 → lint
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir, runDtp } from './helpers.js'
import { checkSchema } from '../src/template.js'

const j = (args, opts) => JSON.parse(runDtp([...args, '--json'], opts).stdout || 'null')

// 与 user-stories 工作流同构：story 挂容器、task 挂 story（ext/ref/status/numbering 全启用）
const SCHEMA = {
  name: 'us',
  version: '1.0.0',
  skeleton: [{ id: 'f_stories', title: '故事池', type: 'folder', tags: ['story'] }],
  rules: [
    {
      id: 'story',
      scope: { parent: 'f_stories' },
      match: { id: '^us\\d{3}$', title: '^US-\\d{3}' },
      id_pattern: '^us\\d{3}$',
      title_pattern: '^US-\\d{3} ',
      ext_required: ['priority'],
      tags_require: ['story'],
      numbering: { title_prefix: 'US', id_prefix: 'us', digits: 3 },
    },
    {
      id: 'task',
      scope: { parent: 'story' },
      match: { id: '^task\\d{3}$' },
      id_pattern: '^task\\d{3}$',
      ext_required: ['story', 'acceptance'],
      ext_arrays: ['acceptance'],
      ref_exists: ['story'],
      status_evidence: { approved: ['done_evidence'] },
    },
  ],
}

// 建一个绑定了模版的包，返回 {dir, pkt, add, upd, rmNode}
function setup(prefix) {
  const dir = tmpdir(prefix)
  const pkt = path.join(dir, 'us.dtp')
  fs.writeFileSync(path.join(dir, 'us.schema.json'), JSON.stringify(SCHEMA, null, 2))
  j(['init', '故事包', '--packet', pkt, '--template', 'us.schema.json'], { cwd: dir })
  return {
    dir,
    pkt,
    schemaFile: path.join(dir, 'us.schema.json'),
    add: (args) => j(['add', ...args, '--packet', pkt], { cwd: dir }),
    upd: (ref, args) => j(['update', ref, ...args, '--packet', pkt], { cwd: dir }),
    rmNode: (ref) => j(['rm', ref, '--yes', '--packet', pkt], { cwd: dir }),
    lint: (extra = []) => j(['lint', ...extra, '--packet', pkt], { cwd: dir }),
    lintRaw: (extra = []) => runDtp(['lint', ...extra, '--packet', pkt], { cwd: dir }),
  }
}

const goodStory = (id, n) => ['f_stories', '--id', id, '--title', `US-${n} 示例故事`, '--type', 'requirement', '--tags', 'story', '--ext', 'priority=P1']
const goodTask = (id, n, parent) => [parent, '--id', id, '--title', `TASK-${n} 示例任务`, '--type', 'requirement', '--ext', 'story=US-001', '--ext', 'acceptance=["GIVEN x WHEN y THEN z"]']

// ---------- acceptance ①：零参数按 metadata.template.file 发现 ----------

test('lint：绑定包零参数发现 schema，合规包 ok:true / 0 违规 / exit 0（含异 cwd 相对解析）', () => {
  const s = setup('lint-ok-')
  s.add(goodStory('us001', '001'))
  s.add(goodTask('task001', '001', 'us001'))

  const r = s.lint()
  assert.equal(r.ok, true)
  assert.equal(r.error_count, 0)
  assert.equal(r.warn_count, 0)
  assert.deepEqual(r.violations, [])
  assert.deepEqual(r.template, { name: 'us', version: '1.0.0', enforce: false }, '绑定态带 enforce 可见性字段（US-005）')
  assert.equal(s.lintRaw().status, 0)

  // 换 cwd（包绝对路径）：schema 按「包目录」而非进程 cwd 解析
  const other = tmpdir('lint-ok-cwd-')
  const r2 = j(['lint', '--packet', s.pkt], { cwd: other })
  assert.equal(r2.ok, true)
})

// ---------- acceptance ②：未绑 / 文件丢 / JSON 坏 ----------

test('lint：未绑包 → TEMPLATE_MISSING exit 1 单行；--schema 可临时指定', () => {
  const dir = tmpdir('lint-unbound-')
  const pkt = path.join(dir, 'p.dtp')
  j(['init', '裸包', '--packet', pkt], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'us.schema.json'), JSON.stringify(SCHEMA, null, 2))
  // 裸包手工补容器（无 template 派生），--schema 校验路径可走通
  j(['add', '/', '--id', 'f_stories', '--title', '故事池', '--type', 'folder', '--packet', pkt], { cwd: dir })

  const raw = runDtp(['lint', '--packet', pkt, '--json'], { cwd: dir })
  const r = JSON.parse(raw.stdout)
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'TEMPLATE_MISSING')
  assert.match(r.error.message, /template bind|--schema/)
  assert.equal(raw.status, 1)
  assert.equal(raw.stdout.trim().split('\n').length, 1, '错误也是单行 JSON')

  const r2 = j(['lint', '--schema', 'us.schema.json', '--packet', pkt], { cwd: dir })
  assert.equal(r2.ok, true, '--schema 临时指定可绕过未绑定')
})

test('lint：绑定记录指向的文件丢失 / JSON 坏 → 快速失败，不产生 violations', () => {
  const s = setup('lint-missing-')
  fs.rmSync(s.schemaFile)
  const raw = s.lintRaw(['--json'])
  const r = JSON.parse(raw.stdout)
  assert.equal(r.error.code, 'TEMPLATE_MISSING')
  assert.match(r.error.message, /schema 文件不存在/)
  assert.equal(raw.status, 1)
  assert.equal(raw.stdout.includes('violations'), false, '快速失败不输出 violations')

  const s2 = setup('lint-bad-')
  fs.writeFileSync(s2.schemaFile, '{oops')
  const raw2 = s2.lintRaw(['--json'])
  assert.equal(JSON.parse(raw2.stdout).error.code, 'SCHEMA_INVALID')
  assert.equal(raw2.status, 1)
})

// ---------- acceptance ③：漂移二分（version 不同 warn / 同 version 不同 sha256 error） ----------

test('lint：schema 升版 → schema.drift warn（含两版本与 re-bind 提示），ok:true exit 0', () => {
  const s = setup('lint-up-')
  s.add(goodStory('us001', '001'))
  const upgraded = { ...SCHEMA, version: '2.0.0' }
  fs.writeFileSync(s.schemaFile, JSON.stringify(upgraded, null, 2))

  const r = s.lint()
  assert.equal(r.ok, true, '版本演进是 warn，不阻断')
  assert.equal(r.warn_count, 1)
  assert.equal(r.error_count, 0)
  const v = r.violations[0]
  assert.equal(v.rule, 'schema.drift')
  assert.equal(v.severity, 'warn')
  assert.match(v.message, /v1\.0\.0/)
  assert.match(v.message, /v2\.0\.0/)
  assert.match(v.message, /re-bind|重新绑定/)
  assert.equal(s.lintRaw().status, 0)
})

test('lint：同 version 内容变更 → SCHEMA_DRIFT 快速失败 exit 1', () => {
  const s = setup('lint-drift-')
  const tampered = { ...SCHEMA, rules: [...SCHEMA.rules, { id: 'extra', scope: { parent: 'f_stories' }, match: { id: '^x\\d+$' } }] }
  fs.writeFileSync(s.schemaFile, JSON.stringify(tampered, null, 2))

  const raw = s.lintRaw(['--json'])
  const r = JSON.parse(raw.stdout)
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'SCHEMA_DRIFT')
  assert.match(r.error.message, /v1\.0\.0/)
  assert.match(r.error.message, /bump.*version|版本/, '指引 bump version 后 re-bind')
  assert.equal(raw.status, 1)
})

// ---------- acceptance ④：违规包逐条报对应 rule，含 hint，exit 1 ----------

test('lint：五类违规逐条报出（ext.required/ext.arrays/parent.container/title.pattern/status.evidence）', () => {
  const s = setup('lint-bad-pack-')
  s.add(goodStory('us001', '001'))
  s.add(goodTask('task001', '001', 'us001'))
  s.upd('task001', ['--status', 'approved']) // approved 无 done_evidence → status.evidence
  s.add(['us001', '--id', 'task002', '--title', 'TASK-002 缺 acceptance', '--type', 'requirement', '--ext', 'story=US-001']) // ext.required
  s.add(['us001', '--id', 'task003', '--title', 'TASK-003 acceptance 非数组', '--type', 'requirement', '--ext', 'story=US-001', '--ext', 'acceptance=GIVEN x']) // ext.arrays
  s.add(['f_stories', '--id', 'task004', '--title', 'TASK-004 挂错父', '--type', 'requirement', '--ext', 'story=US-001', '--ext', 'acceptance=["x"]']) // parent.container
  s.add(goodStory('us002', '002'))
  s.upd('us002', ['--title', '故事二没有编号前缀']) // title.pattern（被 id 认领）

  const raw = s.lintRaw(['--json'])
  const r = JSON.parse(raw.stdout)
  assert.equal(r.ok, false)
  assert.equal(raw.status, 1)
  const rules = r.violations.map((v) => v.rule)
  for (const want of ['status.evidence', 'ext.required', 'ext.arrays', 'parent.container', 'title.pattern']) {
    assert.ok(rules.includes(want), `应报 ${want}，实际 ${rules.join(',')}`)
  }
  assert.equal(r.error_count, 5)
  // 契约形状：每条含 severity/message/hint，error 级 node_id 可定位
  for (const v of r.violations) {
    assert.ok(v.hint && v.hint.length > 0)
    assert.ok(typeof v.message === 'string' && v.message.length > 0)
  }
  const pe = r.violations.find((v) => v.rule === 'parent.container')
  assert.equal(pe.node_id, 'task004')

  // 人类模式输出可读（含 rule 与 ✗）
  const human = s.lintRaw()
  assert.equal(human.status, 1)
  assert.match(human.stdout, /parent\.container/)
  assert.match(human.stdout, /✗/)
})

// ---------- acceptance ⑤⑥：编号空洞 warn 独立成立；tombstone 不误报 ----------

test('lint：仅编号空洞 warn → ok:true / exit 0，输出 error_count 与 warn_count', () => {
  const s = setup('lint-gap-')
  s.add(goodStory('us001', '001'))
  s.add(goodStory('us003', '003'))
  const r = s.lint()
  assert.equal(r.ok, true)
  assert.equal(r.error_count, 0)
  assert.equal(r.warn_count, 1)
  assert.equal(r.violations[0].rule, 'id.continuity')
  assert.match(r.violations[0].message, /2/)
  assert.equal(s.lintRaw().status, 0)
})

// ---------- 补充：空容器全新包 / bind→升版→re-bind 升级闭环 ----------

test('lint：init --template 全新包（空容器）直接 lint 通过', () => {
  const s = setup('lint-fresh-')
  // 不登记任何业务节点，空容器直接 lint
  const r = s.lint()
  assert.equal(r.ok, true)
  assert.deepEqual(r.violations, [])
  assert.equal(s.lintRaw().status, 0)
})

test('lint：bind → schema 升版（drift warn）→ re-bind 后 warn 消失（升级闭环）', () => {
  const s = setup('lint-rebind-')
  // 升版 schema → warn
  fs.writeFileSync(s.schemaFile, JSON.stringify({ ...SCHEMA, version: '2.0.0' }, null, 2))
  const r1 = s.lint()
  assert.equal(r1.warn_count, 1)
  assert.equal(r1.violations[0].rule, 'schema.drift')
  // re-bind 刷新记录 → 干净
  const b = j(['template', 'bind', 'us.schema.json', '--packet', s.pkt], { cwd: s.dir })
  assert.equal(b.ok, true)
  assert.equal(b.rebound, true)
  assert.equal(b.template.version, '2.0.0')
  const r2 = s.lint()
  assert.equal(r2.ok, true)
  assert.equal(r2.warn_count, 0)
  assert.deepEqual(r2.violations, [])
})

test('lint：rm 中间编号（tombstone）不误报跳号', () => {
  const s = setup('lint-rm-')
  s.add(goodStory('us001', '001'))
  s.add(goodStory('us002', '002'))
  s.add(goodStory('us003', '003'))
  s.rmNode('us002')
  const r = s.lint()
  assert.equal(r.ok, true)
  assert.equal(r.warn_count, 0, '已删除编号计入历史池，不产生空洞 warn')
  assert.deepEqual(r.violations, [])
})

// ---------- OPTIM-030：scope.exclusive 独占认领（warn 级 opt-in） ----------

const EX_SCHEMA = {
  name: 'ex',
  version: '1.0.0',
  skeleton: [{ id: 'f_box', title: '盒子', type: 'folder' }],
  rules: [{ id: 'item', scope: { parent: 'f_box', exclusive: true }, match: { id: '^it\\d{3}$' } }],
}

test('OPTIM-030：独占容器下无主节点 → lint warn（不阻断）；认领后归零', () => {
  const dir = tmpdir('ex30-')
  const pkt = path.join(dir, 'ex.dtp')
  fs.writeFileSync(path.join(dir, 'ex.schema.json'), JSON.stringify(EX_SCHEMA, null, 2))
  j(['init', '独占包', '--packet', pkt, '--template', 'ex.schema.json'], { cwd: dir })
  const add = (args) => j(['add', ...args, '--packet', pkt], { cwd: dir })
  const lint = () => j(['lint', '--packet', pkt], { cwd: dir })

  add(['f_box', '--id', 'free1', '--title', '无主节点'])
  const r = lint()
  assert.equal(r.ok, true, 'warn 不阻断，exit 语义照旧')
  assert.equal(r.error_count, 0)
  assert.equal(r.warn_count, 1)
  const v = r.violations.find((x) => x.rule === 'scope.exclusive')
  assert.equal(v.severity, 'warn')
  assert.equal(v.node_id, 'free1')
  assert.match(v.message, /未被任何规则认领/)
  assert.ok(v.hint, 'HINTS 随 violation 附带')

  // 认领节点加入后，free1 仍无主 → warn 持续（warn 按无主节点计，不随他人认领消失）
  add(['f_box', '--id', 'it001', '--title', '认领项'])
  assert.equal(lint().warn_count, 1)
  // rm 掉无主节点 → 归零
  j(['rm', 'free1', '--yes', '--packet', pkt], { cwd: dir })
  const r2 = lint()
  assert.equal(r2.warn_count, 0)
  assert.deepEqual(r2.violations, [])
})

test('OPTIM-030：非独占容器零变化（同类无主节点无 warn）；checkSchema 仅接受 true', () => {
  // 对照组：SCHEMA 无 exclusive 键，f_stories 下无主节点照旧放行
  const s = setup('ex30ctl-')
  s.add(['f_stories', '--id', 'free9', '--title', '无主但放行'])
  assert.equal(s.lint().warn_count, 0)

  // checkSchema：exclusive 仅接受 true（缺省即非独占，false/字符串无意义）
  for (const bad of [false, 'yes', 1]) {
    const schema = {
      name: 'x', version: '1',
      skeleton: [{ id: 'f_a', title: 'A', type: 'folder' }],
      rules: [{ id: 'r', scope: { parent: 'f_a', exclusive: bad }, match: { id: '^a$' } }],
    }
    const problems = checkSchema(schema)
    assert.ok(problems.some((p) => p.includes('scope.exclusive 仅接受 true')), `exclusive=${JSON.stringify(bad)} 应被拒`)
  }
  assert.deepEqual(checkSchema({ ...EX_SCHEMA }), [])
})

test('OPTIM-030：enforce 写路径——无主候选 warn 随 schema_warnings 透传（写入不被阻断）', () => {
  const dir = tmpdir('ex30w-')
  const pkt = path.join(dir, 'ex.dtp')
  fs.writeFileSync(path.join(dir, 'ex.schema.json'), JSON.stringify(EX_SCHEMA, null, 2))
  j(['init', '独占写包', '--packet', pkt, '--template', 'ex.schema.json'], { cwd: dir })
  j(['settings', 'template', 'bind', 'ex.schema.json', '--packet', pkt, '--enforce'], { cwd: dir })
  const r = j(['add', 'f_box', '--id', 'free1', '--title', '无主但可写', '--packet', pkt], { cwd: dir })
  assert.equal(r.ok, true, 'warn 不拦截写入')
  assert.ok(Array.isArray(r.schema_warnings), 'schema_warnings 透传')
  assert.ok(r.schema_warnings.some((w) => w.rule === 'scope.exclusive'))
})
