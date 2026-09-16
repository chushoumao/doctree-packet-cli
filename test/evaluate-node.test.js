// TASK-017 回归：evaluateNode 单节点评估（US-005 写路径的评估内核）
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from './helpers.js'
import { Packet, initPacketLines } from '../src/packet.js'
import { writeJsonlFresh } from '../src/storage.js'
import { evaluate, evaluateNode } from '../src/template.js'

let dir, packet, schema

const STORY_CONTENT = '【背景与讨论】x\n【用户故事】y\n【需求拆分】z\n【验收口径】w'

beforeEach(() => {
  dir = tmpdir('eval-node-')
  const file = path.join(dir, 'p.dtp')
  writeJsonlFresh(file, initPacketLines({ name: '根', packetId: 'pkt-en' }).lines)
  packet = Packet.load(file)
  const root = packet.root()
  packet.addNode({ parentRef: root.id, id: 'f_stories', title: '故事池', nodeType: 'folder' })
  packet.addNode({
    parentRef: 'f_stories', id: 'us001', title: 'US-001 已有故事', nodeType: 'requirement',
    tags: ['story'], extensions: { priority: 'P1' }, content: STORY_CONTENT,
  })
  schema = {
    name: 'en', version: '1.0.0',
    skeleton: [{ id: 'f_stories', title: '故事池', type: 'folder' }],
    rules: [
      {
        id: 'story', scope: { parent: 'f_stories' },
        match: { id: '^us\\d{3}$', title: '^US-\\d{3}' },
        id_pattern: '^us\\d{3}$', title_pattern: '^US-\\d{3} ',
        ext_required: ['priority'], tags_require: ['story'],
        content_sections: ['【用户故事】'], status_evidence: { approved: ['done_evidence'] },
        numbering: { title_prefix: 'US', id_prefix: 'us', digits: 3 },
      },
      {
        id: 'task', scope: { parent: 'story' }, match: { id: '^task\\d{3}$' },
        id_pattern: '^task\\d{3}$', ext_required: ['story', 'acceptance'],
        ext_arrays: ['acceptance'], ref_exists: ['story'],
      },
    ],
  }
})

const candidate = (over = {}) => ({
  id: 'us002',
  parent_id: packet.nodes.get('f_stories').id,
  title: 'US-002 新故事',
  node_type: 'requirement',
  status: 'draft',
  tags: ['story'],
  content: STORY_CONTENT,
  extensions: { priority: 'P2' },
  version: 1,
  ...over,
})

const rulesOf = (vs) => vs.map((v) => `${v.rule}@${v.node_id ?? '-'}:${v.severity}`)

test('合规候选零违规（task 挂 story 认领集下，规则引用 scope 生效）', () => {
  packet.addNode({ parentRef: 'us001', id: 'task001', title: 'TASK-001 任务', nodeType: 'requirement', extensions: { story: 'US-001', acceptance: ['x'] } })
  const task = { ...packet.nodes.get('task001') }
  assert.deepEqual(evaluateNode(schema, task, packet), [])
})

test('字段违规逐条报出（id/title/ext/tags/content/status）', () => {
  const bad = candidate({
    title: '没有编号前缀',
    tags: [],
    content: '缺段落',
    extensions: {},
    status: 'approved',
  })
  const vs = evaluateNode(schema, bad, packet)
  const rules = rulesOf(vs)
  for (const want of ['title.pattern', 'ext.required', 'tags.require', 'content.sections', 'status.evidence']) {
    assert.ok(rules.some((r) => r.startsWith(want)), `应报 ${want}，实际 ${rules}`)
  }
  assert.ok(vs.every((v) => v.hint))
})

test('挂错父：candidate 在根下 → parent.container 单条（不做字段叠加）', () => {
  const bad = candidate({ parent_id: packet.root().id })
  const vs = evaluateNode(schema, bad, packet)
  assert.deepEqual(rulesOf(vs), ['parent.container@us002:error'])
})

test('规则引用 scope：task 挂 story 认领的父集下通过，挂普通容器下被拒', () => {
  const okTask = { id: 'task002', parent_id: 'us001', title: 'TASK-002', node_type: 'requirement', status: 'draft', tags: [], content: '', extensions: { story: 'US-001', acceptance: ['x'] }, version: 1 }
  assert.deepEqual(evaluateNode(schema, okTask, packet), [])

  const badTask = { ...okTask, id: 'task003', parent_id: 'f_stories', title: 'TASK-003' }
  const vs = evaluateNode(schema, badTask, packet)
  assert.deepEqual(rulesOf(vs), ['parent.container@task003:error'])
})

test('ref_exists：引用存活编号通过、悬空拒绝；候选自身不计入存活集（防自引用）', () => {
  const okT = { id: 'task002', parent_id: 'us001', title: 'TASK-002', node_type: 'requirement', status: 'draft', tags: [], content: '', extensions: { story: 'US-001', acceptance: ['x'] }, version: 1 }
  assert.deepEqual(evaluateNode(schema, okT, packet), [])

  const dangling = { ...okT, id: 'task004', title: 'TASK-004 悬空', extensions: { story: 'US-999', acceptance: ['x'] } }
  const vs = evaluateNode(schema, dangling, packet)
  assert.deepEqual(rulesOf(vs), ['ref_exists@task004:error'])

  const selfRef = { ...okT, id: 'task005', title: 'TASK-005 自引用', extensions: { story: 'task005', acceptance: ['x'] } }
  const vsSelf = evaluateNode(schema, selfRef, packet)
  assert.deepEqual(rulesOf(vsSelf), ['ref_exists@task005:error'])
})

test('未认领候选放行（v1 语义与 evaluate 一致）', () => {
  const free = { id: 'free', parent_id: 'f_stories', title: '自由节点', node_type: 'document', status: 'draft', tags: [], content: '', extensions: {}, version: 1 }
  assert.deepEqual(evaluateNode(schema, free, packet), [])
})

test('连续性 warn 透传：新增跳号 + title/id 不一致；update（version>1）不报跳号', () => {
  const gap = evaluateNode(schema, candidate({ id: 'us005', title: 'US-005 跳号' }), packet)
  assert.deepEqual(rulesOf(gap), ['id.continuity@-:warn'])
  assert.equal(gap[0].severity, 'warn')
  assert.match(gap[0].message, /跳过未用编号 2\.\.4/)

  const updateVer = evaluateNode(schema, candidate({ id: 'us005', title: 'US-005 更新', version: 2 }), packet)
  assert.equal(updateVer.filter((v) => v.rule === 'id.continuity' && !v.node_id).length, 0, 'update 不报跳号')

  const mismatch = evaluateNode(schema, candidate({ id: 'us007', title: 'US-008 对不上' }), packet)
  const mm = mismatch.find((v) => v.node_id === 'us007')
  assert.ok(mm && /不一致/.test(mm.message))
})

test('结构破损包 → 单条 packet.structure；schema 未过自检 → SCHEMA_INVALID', async () => {
  const { parsePacketText } = await import('../src/storage.js')
  const { Packet: P } = await import('../src/packet.js')
  const now = '2026-09-16T00:00:00Z'
  const lines = [
    JSON.stringify({ type: 'packet_meta', packet_id: 'p', name: 't', version: 'v1', created_at: now, updated_at: now, root_node_id: 'root', metadata: {} }),
    JSON.stringify({ type: 'node', id: 'orphan', parent_id: 'ghost', node_type: 'document', title: '孤儿', description: '', content: '', extensions: {}, created_at: now, updated_at: now, version: 1, hash: '', tags: [], status: 'draft' }),
  ]
  const broken = new P(parsePacketText(lines.join('\n')), 'broken.dtp')
  assert.ok(broken.structuralErrors.length > 0)
  const vs = evaluateNode(schema, candidate(), broken)
  assert.deepEqual(rulesOf(vs), ['packet.structure@-:error'])

  assert.throws(() => evaluateNode({ ...schema, skeleton: 'bad' }, candidate(), packet), (e) => e.code === 'SCHEMA_INVALID')
})

test('纯度：evaluateNode 前后 packet 状态不变', () => {
  const snap = () => JSON.stringify([packet.meta, [...packet.nodes.entries()], [...packet.versions.entries()], packet.changelog])
  const pendingBase = packet.pending.length // fixture addNode 的待写行是基线，非评估产生
  const before = snap()
  evaluateNode(schema, candidate(), packet)
  evaluateNode(schema, candidate({ id: 'task002', parent_id: 'us001', title: 'TASK-002', extensions: { story: 'US-001', acceptance: ['x'] } }), packet)
  assert.equal(snap(), before)
  assert.equal(packet.pending.length, pendingBase, '不得产生新待写行')
})

test('WeakMap 缓存：同 schema 对象重复评估结果一致（缓存透明）', () => {
  const c = candidate()
  const a = evaluateNode(schema, c, packet)
  const b = evaluateNode(schema, c, packet)
  assert.deepEqual(a, b)
  // evaluate 与 evaluateNode 共享编译缓存互不污染
  assert.deepEqual(evaluate(schema, packet).filter((v) => v.node_id === 'us002'), [])
})

test('evaluate 与 evaluateNode 等价性：同一违规节点两路评估 rule 集一致', () => {
  packet.addNode({ parentRef: 'us001', id: 'task001', title: 'TASK-001 好任务', nodeType: 'requirement', extensions: { story: 'US-001', acceptance: ['x'] } })
  const badNode = { id: 'task002', parent_id: 'us001', title: 'TASK-002 坏任务', node_type: 'requirement', status: 'draft', tags: [], content: '', extensions: { story: 'US-001' }, version: 1 }
  // 全包视角：先入包再 evaluate
  packet.addNode({ parentRef: 'us001', id: badNode.id, title: badNode.title, nodeType: 'requirement', extensions: badNode.extensions })
  const viaEvaluate = rulesOf(evaluate(schema, packet)).filter((r) => r.includes('task002'))
  // 单节点视角：直接评估候选
  const viaNode = rulesOf(evaluateNode(schema, badNode, packet))
  assert.deepEqual(viaNode.sort(), viaEvaluate.sort().map((r) => r.replace(':error', ':error')), `两路应同构：${viaEvaluate} vs ${viaNode}`)
  assert.ok(viaNode.length >= 1)
})
