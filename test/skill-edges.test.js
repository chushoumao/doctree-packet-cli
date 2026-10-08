// TASK-023 回归：skill 命令 + describeSchema 动态规约 + settings show 渲染收编（US-006）。
// 覆盖：describeSchema 逐字段断言与缓存透明性；skill 五节与 --section 边界；--json 两形状；
// 降级三态（有包/无包/显式缺失）；show 收编后快照；两真实包快照。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir, runDtp, runJson, makePacket, ROOT } from './helpers.js'
import { describeSchema } from '../src/template.js'

const j = (args, opts) => runJson(args, opts).data
const REGRESSION_PACKET = path.join(ROOT, 'docs', 'dtp-regression.dtp')
const STORIES_PACKET = path.join(ROOT, 'docs', 'user-stories.dtp')

// 与 settings-edges 同款最小 schema（1 容器 1 规则，约束键覆盖度足够逐字段断言）
const MIN_SCHEMA = {
  name: 'weekly',
  version: '1.0.0',
  skeleton: [{ id: 'f_items', title: '条目池', type: 'folder' }],
  rules: [
    {
      id: 'item',
      comment: '示例规则的最小可跑骨架',
      scope: { parent: 'f_items' },
      match: { id: '^item\\d{3}$', title: '^ITEM-\\d{3}' },
      id_pattern: '^item\\d{3}$',
      title_pattern: '^ITEM-\\d{3} ',
      tags_require: ['item'],
      ext_required: ['owner'],
      ext_arrays: ['acceptance'],
      content_sections: ['【讨论】'],
      ref_exists: ['story'],
      status_evidence: { approved: ['done_evidence'] },
      numbering: { title_prefix: 'ITEM', id_prefix: 'item', digits: 3 },
    },
  ],
}

// ---------- acceptance ①：describeSchema 逐字段断言 + 缓存透明性 ----------

test('describeSchema：逐字段投影（name/version/containers/rules + 规约行逐键）', () => {
  const d = describeSchema(MIN_SCHEMA)
  assert.equal(d.name, 'weekly')
  assert.equal(d.version, '1.0.0')
  assert.deepEqual(d.containers, [{ id: 'f_items', title: '条目池', type: 'folder', description: '' }])
  assert.equal(d.rules.length, 1)
  const r = d.rules[0]
  assert.equal(r.id, 'item')
  assert.equal(r.comment, '示例规则的最小可跑骨架')
  // 规约行逐键断言（约束键全覆盖、文案含 pattern 原文）
  assert.ok(r.lines.some((l) => l.includes('位置：挂在 f_items 之下')), '位置行')
  // ISSUE-033：pattern 字面即契约——引号包裹，尾随空格这类语义字符不 trimEnd 原样保留
  assert.ok(r.lines.some((l) => l.includes('认领：节点 id 命中 "^item\\d{3}$"') && l.includes('或') && l.includes('标题命中 "^ITEM-\\d{3}"')), '认领行（match 为 OR，pattern 引号包裹）')
  assert.ok(r.lines.some((l) => l === 'id 须匹配："^item\\d{3}$"'), 'id 行用原始 pattern')
  assert.ok(r.lines.some((l) => l === 'title 须匹配："^ITEM-\\d{3} "'), 'title 行尾随空格原样保留（不 trimEnd）')
  assert.ok(r.lines.some((l) => l.includes('必填扩展：owner')), 'ext_required 行')
  assert.ok(r.lines.some((l) => l.includes('扩展值须为 JSON 数组：acceptance')), 'ext_arrays 行')
  assert.ok(r.lines.some((l) => l.includes('必填标签：item（精确匹配、大小写敏感）')), 'tags 行（OPTIM-005 语义）')
  assert.ok(r.lines.some((l) => l.includes('正文段落（须含精确字面）：「【讨论】」')), 'content_sections 行（精确字面）')
  assert.ok(r.lines.some((l) => l.includes('引用核查：扩展 story 须指向存活节点')), 'ref_exists 行')
  assert.ok(r.lines.some((l) => l.includes('状态门：置 approved 前须回填扩展 done_evidence')), 'status_evidence 行')
  assert.ok(r.lines.some((l) => l.includes('编号：id 形如 item<N>、title 形如 ITEM-<N>（3 位补零约定）')), 'numbering 行')
})

test('describeSchema：无 match 被 checkSchema 源头拦截（永不生效的规则不合法）；坏 schema 抛 SCHEMA_INVALID；拓扑序先父后子', () => {
  // match 是 checkSchema 强制键：无 match 规则永不生效，在 schema 层即拒（ruleSpecLines 的无 match 分支仅为防御）
  const noMatch = { name: 'x', version: '1', skeleton: [{ id: 'f_a', title: 'A', type: 'folder' }], rules: [{ id: 'r', scope: { parent: 'f_a' } }] }
  assert.throws(() => describeSchema(noMatch), (e) => e.code === 'SCHEMA_INVALID')

  const bad = { ...MIN_SCHEMA, rules: [{ id: 'r', scope: { parent: 'f_items' }, match: { id: '^a[unclosed' } }] }
  assert.throws(() => describeSchema(bad), (e) => e.code === 'SCHEMA_INVALID')

  // 拓扑序：child 的 scope.parent 指向规则 id parent → parent 先输出（compileRules ordered）
  const dep = {
    name: 'dep', version: '1',
    skeleton: [{ id: 'f_a', title: 'A', type: 'folder' }],
    rules: [
      { id: 'child', scope: { parent: 'parent' }, match: { id: '^c\\d+$' } },
      { id: 'parent', scope: { parent: 'f_a' }, match: { id: '^p\\d+$' } },
    ],
  }
  assert.deepEqual(describeSchema(dep).rules.map((r) => r.id), ['parent', 'child'])
})

test('describeSchema：缓存透明性——同对象两次调用输出 identical', () => {
  const a = JSON.stringify(describeSchema(MIN_SCHEMA))
  const b = JSON.stringify(describeSchema(MIN_SCHEMA))
  assert.equal(a, b)
})

// ---------- acceptance ②③：skill 五节 + --section 边界 + --json 两形状 ----------

test('skill：五节齐全且非空（有包默认链），动态 rules 节含绑定 schema 规约', () => {
  const dir = tmpdir('skill-five-')
  runJson(['init', 'p'], { cwd: dir }) // 默认链：.dtp/p.dtp + config
  fs.writeFileSync(path.join(dir, 'weekly.schema.json'), JSON.stringify(MIN_SCHEMA, null, 2))
  j(['settings', 'template', 'bind', 'weekly.schema.json'], { cwd: dir })
  const r = runDtp(['skill'], { cwd: dir })
  assert.equal(r.status, 0)
  for (const s of ['contract', 'refs', 'usage', 'rules', 'pitfalls']) {
    assert.ok(r.stdout.includes(`━━━ ${s} ━━━`), `节标题 ${s}`)
  }
  assert.ok(r.stdout.includes('weekly v1.0.0 逐规则规约（1 条'), '动态层头部')
  assert.ok(r.stdout.includes('【item】') && r.stdout.includes('为什么：示例规则的最小可跑骨架'), '规则块与「为什么」')
})

test('skill --section：单节取用；未知节 USAGE exit 2 带五节枚举', () => {
  const dir = tmpdir('skill-sec-')
  const r = runDtp(['skill', '--section', 'contract'], { cwd: dir })
  assert.equal(r.status, 0)
  assert.ok(r.stdout.includes('--json'), 'contract 内容')
  assert.ok(!r.stdout.includes('━━━'), '单节不输出节标题框')

  const bad = runDtp(['skill', '--section', 'nope'], { cwd: dir })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /contract \| refs \| usage \| rules \| pitfalls/)
  const d = j(['skill', '--section', 'nope'], { cwd: dir })
  assert.equal(d.error.code, 'USAGE')
})

test('skill --json 两形状不混用：全量 {packet,sections} 无 section/content 键；过滤反之；content 与全量对应节全等', () => {
  const dir = tmpdir('skill-json-')
  const full = j(['skill', '--json'], { cwd: dir })
  assert.equal(full.ok, true)
  assert.equal(full.packet, null) // 空 cwd 无包 → 降级（见降级三态）
  assert.deepEqual(Object.keys(full.sections).sort(), ['contract', 'pitfalls', 'refs', 'rules', 'usage'])
  assert.equal(full.section, undefined)
  assert.equal(full.content, undefined)

  const filtered = j(['skill', '--json', '--section', 'pitfalls'], { cwd: dir })
  assert.equal(filtered.section, 'pitfalls')
  assert.equal(typeof filtered.content, 'string')
  assert.equal(filtered.content, full.sections.pitfalls, '过滤 content ≡ 全量对应节')
  assert.equal(filtered.sections, undefined)
})

// ---------- acceptance ④：降级三态 ----------

test('降级三态：无包裸 skill exit 0 + init 引导 + --json packet:null；显式 --packet 缺失 USAGE exit 2', () => {
  const dir = tmpdir('skill-degrade-')
  const r = runDtp(['skill'], { cwd: dir })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /未指定数据包/)
  assert.match(r.stdout, /dtp init/)

  const bad = runDtp(['skill', '--packet', 'nope.dtp'], { cwd: dir })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /数据包不存在/)
  const d = j(['skill', '--packet', 'nope.dtp'], { cwd: dir })
  assert.equal(d.error.code, 'USAGE')
})

test('降级三态：有包（显式 --packet 存在）→ packet 为路径、动态层生效', () => {
  const dir = tmpdir('skill-have-')
  const pkt = path.join(dir, 'p.dtp')
  makePacket(pkt)
  const d = j(['skill', '--json', '--packet', pkt], { cwd: tmpdir('skill-have-cwd-') })
  assert.equal(d.ok, true)
  assert.equal(d.packet, pkt)
  assert.match(d.sections.rules, /包未绑定模版/)
})

test('动态层配置态兜底：无绑提示 / schema 丢失警示 / 坏 JSON 警示（均 exit 0 不崩）', () => {
  const dir = tmpdir('skill-fallback-')
  const pkt = path.join(dir, 'p.dtp')
  makePacket(pkt)
  // 无绑
  assert.match(j(['skill', '--section', 'rules', '--packet', pkt], { cwd: dir }).content, /包未绑定模版/)
  // 丢失
  fs.writeFileSync(path.join(dir, 'w.schema.json'), JSON.stringify(MIN_SCHEMA))
  j(['settings', 'template', 'bind', 'w.schema.json', '--packet', pkt], { cwd: dir })
  fs.unlinkSync(path.join(dir, 'w.schema.json'))
  assert.match(j(['skill', '--section', 'rules', '--packet', pkt], { cwd: dir }).content, /schema 文件丢失/)
  // 坏 JSON
  fs.writeFileSync(path.join(dir, 'w.schema.json'), '{oops')
  assert.match(j(['skill', '--section', 'rules', '--packet', pkt], { cwd: dir }).content, /不是合法 JSON/)
  const human = runDtp(['skill', '--section', 'rules', '--packet', pkt], { cwd: dir })
  assert.equal(human.status, 0)
})

// ---------- acceptance ⑤：show 渲染收编后快照（settings show 人类输出 ≡ describeSchema 规约） ----------

test('show 收编快照：人类输出含「为什么」与规约行；--json rules 形状不变（无 comment 键）', () => {
  const dir = tmpdir('show-adopt-')
  const pkt = path.join(dir, 'p.dtp')
  makePacket(pkt)
  fs.writeFileSync(path.join(dir, 'w.schema.json'), JSON.stringify(MIN_SCHEMA, null, 2))
  j(['settings', 'template', 'bind', 'w.schema.json', '--packet', pkt], { cwd: dir })
  const r = runDtp(['settings', 'show', '--packet', pkt], { cwd: dir })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /【item】\s+为什么：示例规则的最小可跑骨架/, '收编后规则块带「为什么」')
  assert.match(r.stdout, /· 位置：挂在 f_items 之下/, 'describeSchema 规约行')
  assert.match(r.stdout, /规则：1 条（依赖拓扑序/)
  const d = j(['settings', 'show', '--packet', pkt], { cwd: dir })
  assert.ok(!('comment' in d.rules[0]), '--json rules 不含 comment')
  assert.deepEqual(d.rules[0].tags_require, ['item'], '--json 约束键原样保留')
})

// ---------- acceptance ⑥：两真实包快照 ----------

test('真实包快照：dtp-regression（3 规则、issue 状态门/必填扩展在案）', () => {
  const d = j(['skill', '--json', '--section', 'rules', '--packet', REGRESSION_PACKET], { cwd: tmpdir('snap1-') })
  assert.equal(d.ok, true)
  assert.match(d.content, /dtp-regression v1\.0\.0 逐规则规约（3 条/)
  assert.match(d.content, /【issue】/)
  assert.match(d.content, /必填扩展：severity、area/)
  assert.match(d.content, /【optim】/)
  assert.match(d.content, /【fix】/)
  assert.match(d.content, /状态门：置 approved 前须回填扩展 fixed_in/)
  assert.match(d.content, /为什么：缺陷登记：severity\/area 必填/)
})

test('真实包快照：user-stories（2 规则、story 四段正文、task acceptance/done_evidence）', () => {
  const d = j(['skill', '--json', '--section', 'rules', '--packet', STORIES_PACKET], { cwd: tmpdir('snap2-') })
  assert.equal(d.ok, true)
  assert.match(d.content, /user-stories v1\.0\.1 逐规则规约（2 条/)
  assert.match(d.content, /【story】[\s\S]*正文段落（须含精确字面）：「【背景与讨论】」 「【用户故事】」 「【需求拆分】」 「【验收口径】」/)
  assert.match(d.content, /【task】[\s\S]*扩展值须为 JSON 数组：acceptance/)
  assert.match(d.content, /【task】[\s\S]*状态门：置 approved 前须回填扩展 done_evidence/)
  // 拓扑序：story（容器父）先于 task（规则父）
  assert.ok(d.content.indexOf('【story】') < d.content.indexOf('【task】'))
})

test('真实包人类输出：skill 五节全量在两真实包上 exit 0（冒烟级）', () => {
  for (const p of [REGRESSION_PACKET, STORIES_PACKET]) {
    const r = runDtp(['skill', '--packet', p], { cwd: tmpdir('smoke-') })
    assert.equal(r.status, 0)
    assert.ok(r.stdout.includes('━━━ rules ━━━'))
  }
})
