// TASK-003 回归：模版模块四段 API（parseSchema / checkSchema / evaluate / skeletonLines）
// 覆盖 acceptance 五条 + 十二个 rule id 的触发路径、只读纯度、骨架派生
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePacketText } from '../src/storage.js'
import { Packet } from '../src/packet.js'
import { computeNodeHash } from '../src/model/node.js'
import { parseSchema, checkSchema, evaluate, skeletonLines, RULE_IDS } from '../src/template.js'
import { DtpError } from '../src/errors.js'

const NOW = '2026-09-11T00:00:00.000Z'

const nodeLine = (id, parentId, title, { type = 'document', ext = {}, tags = [], status = 'draft', content = '', desc = '' } = {}) => {
  const n = {
    type: 'node',
    id,
    parent_id: parentId,
    node_type: type,
    title,
    description: desc,
    content,
    extensions: ext,
    created_at: NOW,
    updated_at: NOW,
    version: 1,
    hash: '',
    tags,
    status,
  }
  n.hash = computeNodeHash(n)
  return n
}

const metaLine = (rootId, metadata = {}) => ({
  type: 'packet_meta',
  packet_id: 'pkt-test',
  name: '测试包',
  version: 'v1',
  created_at: NOW,
  updated_at: NOW,
  root_node_id: rootId,
  metadata,
})

const deleteLine = (id) => ({ type: 'node_delete', id })

// 直接由行对象构造内存 Packet（不经文件系统）
const buildPacket = (lines) => new Packet(parsePacketText(lines.map((l) => JSON.stringify(l)).join('\n')), 'mem.dtp')

const STORY_CONTENT = '【背景与讨论】x\n【用户故事】y\n【需求拆分】z\n【验收口径】w'

// 与真实 user-stories 工作流同构的最小 schema：story 挂容器，task 挂 story（规则引用拓扑）
const SCHEMA = {
  name: 'test-stories',
  version: '1.0.0',
  comment: '顶层注释，求值忽略',
  skeleton: [{ id: 'f_stories', title: '故事池', type: 'folder', description: '故事容器' }],
  rules: [
    {
      id: 'story',
      comment: '故事规则',
      scope: { parent: 'f_stories' },
      match: { id: '^us\\d{3}$', title: '^US-\\d{3}' },
      id_pattern: '^us\\d{3}$',
      title_pattern: '^US-\\d{3} ',
      ext_required: ['priority'],
      tags_require: ['story'],
      content_sections: ['【用户故事】'],
      status_evidence: { approved: ['done_evidence'] },
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
    },
  ],
}

// 合法基线包：1 故事 + 1 任务，evaluate 零违规
const baseLines = () => [
  metaLine('root'),
  nodeLine('root', null, '测试包', { type: 'folder' }),
  nodeLine('f_stories', 'root', '故事池', { type: 'folder' }),
  nodeLine('us001', 'f_stories', 'US-001 示例故事', {
    type: 'requirement',
    ext: { priority: 'P1' },
    tags: ['story'],
    content: STORY_CONTENT,
  }),
  nodeLine('task001', 'us001', 'TASK-001 示例任务', {
    type: 'requirement',
    ext: { story: 'US-001', acceptance: ['GIVEN x WHEN y THEN z'] },
    tags: ['task'],
  }),
]

const rulesOf = (violations) => violations.map((v) => v.rule)

// ---------- acceptance ①：parseSchema 保留 comment，checkSchema 零错误 ----------

test('parseSchema：合法 schema 返回对象且保留 comment 键，checkSchema 零错误', () => {
  const obj = parseSchema(JSON.stringify(SCHEMA))
  assert.equal(obj.comment, '顶层注释，求值忽略')
  assert.equal(obj.rules[0].comment, '故事规则')
  assert.deepEqual(checkSchema(obj), [])
  assert.deepEqual(checkSchema(JSON.stringify(SCHEMA)), []) // 文本入参同样通过
})

// ---------- acceptance ②：坏 schema 逐条可读报错、无未捕获异常 ----------

test('parseSchema：坏 JSON 抛 SCHEMA_INVALID；checkSchema 文本入参降级为单条问题', () => {
  assert.throws(() => parseSchema('{oops'), (e) => e instanceof DtpError && e.code === 'SCHEMA_INVALID')
  const problems = checkSchema('{oops')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /不是合法 JSON/)
})

test('checkSchema：未知键（顶层/规则/scope/match）各自报错', () => {
  const bad = {
    ...SCHEMA,
    unknown_top: 1,
    rules: [{ ...SCHEMA.rules[0], bad_key: 1, scope: { parent: 'f_stories', extra: 1 }, match: { id: '^us\\d{3}$', bad: 1 } }],
  }
  const problems = checkSchema(bad)
  assert.ok(problems.some((p) => p.includes('顶层出现未知键 "unknown_top"')))
  assert.ok(problems.some((p) => p.includes('未知规则键 "bad_key"')))
  assert.ok(problems.some((p) => p.includes('scope 出现未知键 "extra"')))
  assert.ok(problems.some((p) => p.includes('match 出现未知键 "bad"')))
})

test('checkSchema：正则不可编译逐条报错', () => {
  const bad = {
    ...SCHEMA,
    rules: [
      { ...SCHEMA.rules[0], match: { id: '^us\\d{3}$', title: '^US-[\\d{3}$' }, title_pattern: '^US-(' },
      { ...SCHEMA.rules[1], match: { id: '^task[unclosed' } },
    ],
  }
  const problems = checkSchema(bad)
  assert.ok(problems.some((p) => p.includes('match.title 正则不可编译')))
  assert.ok(problems.some((p) => p.includes('title_pattern 正则不可编译')))
  assert.ok(problems.some((p) => p.includes('match.id 正则不可编译')))
})

test('checkSchema：scope.parent 引用不存在 / 引用自身 / 引用成环 / 与容器 id 冲突', () => {
  const bad = {
    ...SCHEMA,
    rules: [
      { id: 'a', scope: { parent: 'f_stories' }, match: { id: '^a\\d+$' } },
      { id: 'b', scope: { parent: 'nope' }, match: { id: '^b\\d+$' } },
      { id: 'c', scope: { parent: 'c' }, match: { id: '^c\\d+$' } },
      { id: 'd', scope: { parent: 'e' }, match: { id: '^d\\d+$' } },
      { id: 'e', scope: { parent: 'd' }, match: { id: '^e\\d+$' } },
      { id: 'f_stories', scope: { parent: 'f_stories' }, match: { id: '^f\\d+$' } },
    ],
  }
  const problems = checkSchema(bad)
  assert.ok(problems.some((p) => p.includes('scope.parent "nope" 不是已声明的容器 id 或规则 id')))
  assert.ok(problems.some((p) => p.includes('scope.parent 不能引用自身')))
  assert.ok(problems.some((p) => p.includes('规则引用成环：d → e → d')))
  assert.ok(problems.some((p) => p.includes('规则 id "f_stories" 与容器 id 冲突')))
})

test('checkSchema：skeleton id 重复 / 空骨架 / 坏类型逐条报；畸形输入不抛异常', () => {
  const dup = { ...SCHEMA, skeleton: [...SCHEMA.skeleton, { ...SCHEMA.skeleton[0] }] }
  assert.ok(checkSchema(dup).some((p) => p.includes('容器 id 重复：f_stories')))
  assert.ok(checkSchema({ ...SCHEMA, skeleton: [] }).some((p) => p.includes('至少需要 1 个容器')))
  assert.ok(
    checkSchema({ ...SCHEMA, skeleton: [{ id: 'x', title: 't', type: 'nope' }] }).some((p) => p.includes(
      '不是合法节点类型'
    ))
  )
  // 无未捕获异常契约
  for (const weird of [null, 42, 'str', [], {}, { name: '', version: 1, skeleton: 'x', rules: 3 }]) {
    assert.ok(Array.isArray(checkSchema(weird)), `checkSchema(${JSON.stringify(weird)}) 应返回数组`)
  }
})

test('checkSchema：match 缺失 / status_evidence / numbering / 数组字段类型错误', () => {
  const bad = {
    ...SCHEMA,
    rules: [
      { id: 'r1', scope: { parent: 'f_stories' }, match: {} },
      {
        id: 'r2',
        scope: { parent: 'f_stories' },
        match: { id: '^r2\\d+$' },
        ext_required: 'priority',
        status_evidence: { approved: 'x' },
        numbering: { title_prefix: 'R', digits: 0, extra: 1 },
      },
    ],
  }
  const problems = checkSchema(bad)
  assert.ok(problems.some((p) => p.includes('match 至少需要 id 或 title 中的一个模式')))
  assert.ok(problems.some((p) => p.includes('ext_required 必须是非空字符串数组')))
  assert.ok(problems.some((p) => p.includes('status_evidence["approved"]：值必须是非空字符串数组')))
  assert.ok(problems.some((p) => p.includes('numbering：digits 必须是正整数')))
  assert.ok(problems.some((p) => p.includes('numbering 出现未知键 "extra"')))
})

// ---------- acceptance ③：scope.parent 指向规则 id → 拓扑求值父集 ----------

test('evaluate：合法包零违规（task 挂 story 规则认领的节点集下，规则引用生效）', () => {
  const packet = buildPacket(baseLines())
  assert.deepEqual(evaluate(SCHEMA, packet), [])
})

test('evaluate：仅骨架 schema（省略 rules）合法，容器校验照常', () => {
  const schema = { name: 's', version: '1.0.0', skeleton: SCHEMA.skeleton }
  assert.deepEqual(checkSchema(schema), [])
  const packet = buildPacket(baseLines())
  assert.deepEqual(evaluate(schema, packet), [])
  // 容器缺失仍报（容器连同子树一起移除，避免悬空父引用触发结构短路）
  const lines = baseLines().filter((l) => !['f_stories', 'us001', 'task001'].includes(l.id))
  const violations = evaluate(schema, buildPacket(lines))
  assert.deepEqual(rulesOf(violations), ['skeleton.missing'])
})

// ---------- acceptance ④：structuralErrors 短路 ----------

test('evaluate：结构破损的包返回单条 packet.structure，跳过逐条评估', () => {
  const lines = [
    ...baseLines(),
    nodeLine('us002', 'f_stories', 'US-002 缺 priority 且会挂孤儿', { ext: {} }), // 无 priority，正常应报 ext.required
    nodeLine('ghost-child', 'nonexistent', '孤儿节点'), // 制造悬空父引用 → structuralErrors
  ]
  const packet = buildPacket(lines)
  assert.ok(packet.structuralErrors.length > 0)
  const violations = evaluate(SCHEMA, packet)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].rule, 'packet.structure')
  assert.equal(violations[0].severity, 'error')
  assert.ok(violations[0].hint.includes('verify'))
  assert.equal(violations[0].node_id, undefined)
})

// ---------- acceptance ⑤：未认领节点放行 ----------

test('evaluate：容器内不被任何规则认领的节点放行不报', () => {
  const lines = [
    ...baseLines(),
    nodeLine('free-node', 'f_stories', '随便一个自由节点', { type: 'folder' }),
    nodeLine('another', 'us001', '任务下随手记', { type: 'document' }),
  ]
  assert.deepEqual(evaluate(SCHEMA, buildPacket(lines)), [])
})

// ---------- 逐规则触发路径 ----------

test('evaluate：skeleton.missing 覆盖缺失/类型不符/标题不符三种情况', () => {
  const missing = evaluate(SCHEMA, buildPacket(baseLines().filter((l) => !['f_stories', 'us001', 'task001'].includes(l.id))))
  assert.equal(missing.length, 1)
  assert.match(missing[0].message, /容器 f_stories「故事池」不存在/)

  const wrongType = baseLines()
  wrongType[2] = nodeLine('f_stories', 'root', '故事池', { type: 'index' })
  assert.match(evaluate(SCHEMA, buildPacket(wrongType))[0].message, /类型不符/)

  const wrongTitle = baseLines()
  wrongTitle[2] = nodeLine('f_stories', 'root', '故事池（改名）', { type: 'folder' })
  assert.match(evaluate(SCHEMA, buildPacket(wrongTitle))[0].message, /标题不符/)
})

test('evaluate：parent.container——task 挂容器根 / story 挂根，均按认领报挂错父', () => {
  const lines = [
    ...baseLines(),
    nodeLine('task002', 'f_stories', 'TASK-002 挂错父的任务', {
      ext: { story: 'US-001', acceptance: ['x'] },
    }), // 挂到容器而非故事下
  ]
  const violations = evaluate(SCHEMA, buildPacket(lines))
  assert.deepEqual(rulesOf(violations), ['parent.container'])
  assert.equal(violations[0].node_id, 'task002')
  assert.match(violations[0].message, /被规则 task 认领/)

  const lines2 = [
    ...baseLines(),
    nodeLine('us002', 'root', 'US-002 挂根下的故事', { ext: { priority: 'P2' }, tags: ['story'], content: STORY_CONTENT }),
  ]
  const violations2 = evaluate(SCHEMA, buildPacket(lines2))
  assert.deepEqual(rulesOf(violations2), ['parent.container'])
  assert.equal(violations2[0].node_id, 'us002')

  // 挂错父时不再叠加字段检查噪音（即使 ext 也缺失）
  const lines3 = [
    ...baseLines(),
    nodeLine('task003', 'f_stories', 'TASK-003 挂错父且缺字段', {}),
  ]
  const violations3 = evaluate(SCHEMA, buildPacket(lines3))
  assert.deepEqual(rulesOf(violations3), ['parent.container'])
})

test('evaluate：id.pattern / title.pattern——按认领来源互补校验', () => {
  const lines = [
    ...baseLines(),
    // 被 title 认领（^US-\d{3}）但 id 不符 → id.pattern（标题用 009 避免与 id 号池重叠）
    nodeLine('bad_id', 'f_stories', 'US-009 标题合规但 id 乱写', { ext: { priority: 'P2' }, tags: ['story'], content: STORY_CONTENT }),
    // 被 id 认领（^us\d{3}$）但标题不符 → title.pattern
    nodeLine('us002', 'f_stories', '故事二号（没有编号前缀）', { ext: { priority: 'P2' }, tags: ['story'], content: STORY_CONTENT }),
  ]
  const violations = evaluate(SCHEMA, buildPacket(lines))
  assert.deepEqual(rulesOf(violations), ['id.pattern', 'title.pattern'])
  assert.equal(violations[0].node_id, 'bad_id')
  assert.equal(violations[1].node_id, 'us002')
})

test('evaluate：ext.required（缺失/null/空串）与 ext.arrays（非数组）', () => {
  const lines = [
    ...baseLines(),
    nodeLine('us002', 'f_stories', 'US-002 缺 priority', { tags: ['story'], content: STORY_CONTENT }),
    nodeLine('us003', 'f_stories', 'US-003 priority 为 null', {
      ext: { priority: null },
      tags: ['story'],
      content: STORY_CONTENT,
    }),
    nodeLine('task002', 'us001', 'TASK-002 acceptance 是字符串', {
      ext: { story: 'US-001', acceptance: 'GIVEN x' },
    }),
  ]
  const violations = evaluate(SCHEMA, buildPacket(lines))
  assert.deepEqual(rulesOf(violations), ['ext.required', 'ext.required', 'ext.arrays'])
  assert.match(violations[0].message, /缺少必填扩展字段 "priority"/)
  assert.match(violations[2].message, /"acceptance" 必须是数组/)
})

test('evaluate：tags.require 与 content.sections', () => {
  const lines = [
    ...baseLines(),
    nodeLine('us002', 'f_stories', 'US-002 缺标签缺段落', { ext: { priority: 'P2' }, content: '正文没有段落标题' }),
  ]
  const violations = evaluate(SCHEMA, buildPacket(lines))
  assert.deepEqual(rulesOf(violations), ['tags.require', 'content.sections'])
  assert.match(violations[0].message, /缺少必填标签 "story"/)
  assert.match(violations[1].message, /缺少段落「【用户故事】」/)
})

test('evaluate：ref_exists——编号全等 / id 全等通过，悬空引用与非字符串报错', () => {
  const lines = [
    ...baseLines(),
    nodeLine('task002', 'us001', 'TASK-002 引用编号 US-001', { ext: { story: 'US-001', acceptance: ['x'] } }), // 编号段全等 → 过
    nodeLine('task003', 'us001', 'TASK-003 引用 id us001', { ext: { story: 'us001', acceptance: ['x'] } }), // id 全等 → 过
    nodeLine('task004', 'us001', 'TASK-004 悬空引用', { ext: { story: 'US-999', acceptance: ['x'] } }),
    nodeLine('task005', 'us001', 'TASK-005 引用非字符串', { ext: { story: 42, acceptance: ['x'] } }),
  ]
  const violations = evaluate(SCHEMA, buildPacket(lines))
  assert.deepEqual(rulesOf(violations), ['ref_exists', 'ref_exists'])
  assert.equal(violations[0].node_id, 'task004')
  assert.match(violations[1].message, /缺失或非字符串/)
})

test('evaluate：status.evidence——approved 缺 done_evidence', () => {
  const lines = [...baseLines()]
  lines[3] = nodeLine('us001', 'f_stories', 'US-001 示例故事', {
    type: 'requirement',
    status: 'approved',
    ext: { priority: 'P1' }, // approved 但无 done_evidence
    tags: ['story'],
    content: STORY_CONTENT,
  })
  const violations = evaluate(SCHEMA, buildPacket(lines))
  assert.deepEqual(rulesOf(violations), ['status.evidence'])
  assert.match(violations[0].message, /状态为 approved 但缺少 "done_evidence"/)
})

test('evaluate：id.continuity——空洞 warn（含 tombstone 补号不报）；title/id 编号不一致 warn', () => {
  // us001、us003 → 空洞 2
  const gapped = buildPacket([
    ...baseLines(),
    nodeLine('us003', 'f_stories', 'US-003 跳过二号', {
      ext: { priority: 'P2' },
      tags: ['story'],
      content: STORY_CONTENT,
    }),
  ])
  const v1 = evaluate(SCHEMA, gapped).filter((v) => v.rule === 'id.continuity')
  assert.equal(v1.length, 1)
  assert.equal(v1[0].severity, 'warn')
  assert.match(v1[0].message, /编号空洞：2/)
  assert.equal(v1[0].node_id, undefined)

  // us002 存在后被删（tombstone）→ versions 仍含 us002，不算空洞
  const tombstoned = buildPacket([
    ...baseLines(),
    nodeLine('us002', 'f_stories', 'US-002 会被删除', { ext: { priority: 'P2' }, tags: ['story'], content: STORY_CONTENT }),
    nodeLine('us003', 'f_stories', 'US-003 接在删除的二号后', {
      ext: { priority: 'P2' },
      tags: ['story'],
      content: STORY_CONTENT,
    }),
    deleteLine('us002'),
  ])
  const v2 = evaluate(SCHEMA, tombstoned).filter((v) => v.rule === 'id.continuity' && !v.node_id)
  assert.equal(v2.length, 0, '删除过的编号不应产生空洞 warn')

  // id us007 但 title 写 US-008 → 不一致 warn（带 node_id）；同时存在空洞 warn（2-6）
  const mismatch = buildPacket([
    ...baseLines(),
    nodeLine('us007', 'f_stories', 'US-008 编号对不上', { ext: { priority: 'P2' }, tags: ['story'], content: STORY_CONTENT }),
  ])
  const v3 = evaluate(SCHEMA, mismatch).filter((v) => v.rule === 'id.continuity')
  const mismatchWarn = v3.find((v) => v.node_id === 'us007')
  assert.ok(mismatchWarn, '应存在带 node_id 的编号不一致 warn')
  assert.match(mismatchWarn.message, /与 id 编号 7 不一致/)
  const gapWarn = v3.find((v) => v.node_id === undefined)
  assert.ok(gapWarn, '应同时存在空洞 warn')
  assert.match(gapWarn.message, /2, 3, 4, 5, 6/)
})

// ---------- 契约与纯度 ----------

test('evaluate：violation 形状契约（rule 在命名空间内、severity 枚举、hint 非空）', () => {
  const packet = buildPacket([
    ...baseLines(),
    nodeLine('us003', 'f_stories', 'US-003 全违规', {}),
  ])
  const violations = evaluate(SCHEMA, packet)
  assert.ok(violations.length >= 3)
  for (const v of violations) {
    assert.ok(RULE_IDS.includes(v.rule), `未知 rule: ${v.rule}`)
    assert.ok(v.severity === 'error' || v.severity === 'warn')
    assert.equal(typeof v.hint, 'string')
    assert.ok(v.hint.length > 0)
    assert.ok(v.node_id === undefined || typeof v.node_id === 'string')
  }
})

test('evaluate：只读纯度——前后包状态逐字节不变', () => {
  const packet = buildPacket([
    ...baseLines(),
    nodeLine('us003', 'f_stories', 'US-003 有违规', {}),
  ])
  const snapshot = JSON.stringify([
    packet.meta,
    [...packet.nodes.entries()],
    [...packet.versions.entries()],
    packet.changelog,
    packet.tombstones,
  ])
  evaluate(SCHEMA, packet)
  const after = JSON.stringify([
    packet.meta,
    [...packet.nodes.entries()],
    [...packet.versions.entries()],
    packet.changelog,
    packet.tombstones,
  ])
  assert.equal(snapshot, after)
  assert.equal(packet.pending.length, 0, '不得产生待写行')
})

test('evaluate：schema 未过自检时快速失败（SCHEMA_INVALID）', () => {
  const packet = buildPacket(baseLines())
  assert.throws(
    () => evaluate({ ...SCHEMA, rules: [{ id: 'x', scope: { parent: 'nope' }, match: { id: '^x$' } }] }, packet),
    (e) => e instanceof DtpError && e.code === 'SCHEMA_INVALID'
  )
})

test('evaluate：正则运行时异常捕获为 regex.runtime 违规而非崩溃', () => {
  const packet = buildPacket(baseLines())
  const orig = RegExp.prototype.test
  // 编译期检查无法拦截的运行期异常（如深度回溯栈溢出）：stub 出确定性复现
  RegExp.prototype.test = function () {
    throw new RangeError('Maximum call stack size exceeded')
  }
  try {
    const violations = evaluate(SCHEMA, packet)
    assert.ok(violations.length > 0)
    for (const v of violations) {
      assert.equal(v.rule, 'regex.runtime')
      assert.equal(v.severity, 'error')
      assert.match(v.message, /正则执行失败/)
    }
  } finally {
    RegExp.prototype.test = orig
  }
  // 恢复后同一包零违规（兑底不产生残留）
  assert.deepEqual(evaluate(SCHEMA, packet), [])
})

// ---------- 第四段：skeletonLines ----------

test('skeletonLines：根 + 容器（父=根、声明顺序、tags/description 透传），可被解析器完整回读', () => {
  const schema = {
    name: 'sk',
    version: '1.0.0',
    skeleton: [
      { id: 'f_a', title: '容器A', type: 'folder', description: 'A 的说明', tags: ['x', 'y'] },
      { id: 'f_b', title: '容器B', type: 'index' },
    ],
  }
  const r = skeletonLines(schema, { name: '我的包', packetId: 'pkt-x', rootId: 'rt1', user: 'tester', metadata: { purpose: 'test' } })
  assert.equal(r.meta.metadata.purpose, 'test')
  assert.equal(r.root.id, 'rt1')

  const packet = buildPacket(r.lines)
  assert.equal(packet.meta.name, '我的包')
  assert.deepEqual([...packet.nodes.keys()].sort(), ['f_a', 'f_b', 'rt1'])
  const fa = packet.nodes.get('f_a')
  assert.equal(fa.parent_id, 'rt1')
  assert.equal(fa.node_type, 'folder')
  assert.equal(fa.title, '容器A')
  assert.equal(fa.description, 'A 的说明')
  assert.deepEqual(fa.tags, ['x', 'y'])
  assert.equal(computeNodeHash(fa), fa.hash, '容器节点哈希须自洽（verify 可过）')
  assert.ok(packet.changelog.some((c) => c.node_id === 'f_a' && c.field === '*created'))
  assert.equal(packet.structuralErrors.length, 0)
})

test('skeletonLines：容器 id 与根 id 冲突拒绝；缺 skeleton 快速失败', () => {
  const schema = { name: 's', version: '1.0.0', skeleton: [{ id: 'rt1', title: '冲突容器', type: 'folder' }] }
  assert.throws(() => skeletonLines(schema, { rootId: 'rt1' }), (e) => e instanceof DtpError && e.code === 'USAGE')
  assert.throws(() => skeletonLines({ name: 's', version: '1' }), (e) => e.code === 'SCHEMA_INVALID')
})
