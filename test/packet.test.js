import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from './helpers.js'
import { Packet, initPacketLines } from '../src/packet.js'
import { writeJsonlFresh } from '../src/storage.js'
import { DtpError } from '../src/errors.js'

let dir, file
beforeEach(() => {
  dir = tmpdir()
  file = path.join(dir, 'p.dtp')
  const { lines } = initPacketLines({ name: '根', packetId: 'pkt-x' })
  writeJsonlFresh(file, lines)
})

const load = () => Packet.load(file)

test('init：根节点就位，路径索引含根', () => {
  const p = load()
  assert.equal(p.nodes.size, 1)
  const root = p.root()
  assert.equal(root.parent_id, null)
  assert.equal(p.pathOf(root.id), '/根')
  assert.equal(p.findByPath('/根'), root.id)
})

test('add：版本 1、*created 记录、路径与维度索引更新', () => {
  const p = load()
  const root = p.root()
  const n = p.addNode({ parentRef: root.id, id: 'fr001', title: '用户认证', nodeType: 'requirement', tags: ['auth', 'P0'] })
  assert.equal(n.version, 1)
  assert.equal(p.pathOf(n.id), '/根/用户认证')
  assert.equal(p.findByPath('/根/用户认证'), 'fr001')
  assert.ok(p.tagIndex.get('P0').has('fr001'))
  assert.ok(p.typeIndex.get('requirement').has('fr001'))
  const created = p.changelog.find((e) => e.node_id === 'fr001')
  assert.equal(created.field, '*created')
  assert.equal(created.new_hash, n.hash)
})

test('add 拒绝：空标题 / 重复 ID（含已删除）/ 不存在的父节点', () => {
  const p = load()
  const root = p.root()
  assert.throws(() => p.addNode({ parentRef: root.id, title: '' }), DtpError)
  assert.throws(() => p.addNode({ parentRef: root.id, title: 'x', id: root.id }), (e) => e.code === 'ID_EXISTS')
  assert.throws(() => p.addNode({ parentRef: 'ghost', title: 'x' }), (e) => e.code === 'NOT_FOUND')
})

test('update：版本递增、逐字段 changelog、无变更不落盘', () => {
  const p = load()
  const n = p.addNode({ parentRef: p.root().id, id: 'a', title: 'A', content: 'v1' })
  const r1 = p.updateNode('a', { content: 'v2', title: 'A2' }, { user: 'u1' })
  assert.equal(r1.changed, true)
  assert.equal(r1.node.version, 2)
  assert.deepEqual(r1.changes.map((c) => c.field).sort(), ['content', 'title'])
  const entries = p.changelog.filter((e) => e.node_id === 'a' && e.version === 2)
  assert.equal(entries.length, 2)
  assert.equal(entries.find((e) => e.field === 'title').user, 'u1')

  const before = p.pending.length
  const r2 = p.updateNode('a', { content: 'v2' }, {})
  assert.equal(r2.changed, false)
  assert.equal(p.pending.length, before)
})

test('update extensions：append-only —— 新键自由添加，改旧键需 force', () => {
  const p = load()
  p.addNode({ parentRef: p.root().id, id: 'a', title: 'A' })
  p.updateNode('a', { extensions: { owner: '张三' } }, {})
  assert.throws(
    () => p.updateNode('a', { extensions: { owner: '李四' } }, {}),
    (e) => e.code === 'EXT_IMMUTABLE'
  )
  // 同值写入视为无变更
  assert.equal(p.updateNode('a', { extensions: { owner: '张三' } }, {}).changed, false)
  // force 覆盖
  const r = p.updateNode('a', { extensions: { owner: '李四' } }, { forceExt: true })
  assert.equal(r.changed, true)
  assert.deepEqual(r.changes.map((c) => c.field), ['extensions.owner'])
})

test('rm：级联删除子孙、tombstone、changelog 记录、再引用报 NODE_DELETED', () => {
  const p = load()
  const mid = p.addNode({ parentRef: p.root().id, id: 'mid', title: 'M' })
  p.addNode({ parentRef: 'mid', id: 'leaf1', title: 'L1' })
  p.addNode({ parentRef: 'mid', id: 'leaf2', title: 'L2' })
  const { removed } = p.removeNode('mid', { user: 'u' })
  assert.deepEqual(removed.sort(), ['leaf1', 'leaf2', 'mid'])
  assert.equal(p.nodes.size, 1)
  assert.ok(p.tombstones.has('leaf1'))
  const del = p.changelog.filter((e) => e.field === '*deleted')
  assert.equal(del.length, 3)
  assert.throws(() => p.resolveRef('mid'), (e) => e.code === 'NODE_DELETED')
  assert.throws(() => p.removeNode(p.root().id), DtpError)
})

test('mv：路径索引更新、成环拒绝、同父 no-op', () => {
  const p = load()
  const a = p.addNode({ parentRef: p.root().id, id: 'a', title: 'A' })
  p.addNode({ parentRef: 'a', id: 'b', title: 'B' })
  const c = p.addNode({ parentRef: p.root().id, id: 'c', title: 'C' })

  const r = p.moveNode('b', 'c', { user: 'u' })
  assert.equal(r.moved, true)
  assert.equal(r.oldPath, '/根/A/B')
  assert.equal(r.newPath, '/根/C/B')
  assert.equal(p.findByPath('/根/C/B'), 'b')
  assert.equal(p.findByPath('/根/A/B'), null)
  const moved = p.changelog.find((e) => e.field === '*moved')
  assert.equal(moved.old_path, '/根/A/B')

  assert.throws(() => p.moveNode('c', 'b'), (e) => e.code === 'MOVE_CYCLE') // b 在 c 的子树内
  assert.throws(() => p.moveNode('a', 'a'), DtpError)
  assert.equal(p.moveNode('b', 'c').moved, false)
})

test('checkout：回滚内容到旧版本，以新版本落盘，不改变树位置', () => {
  const p = load()
  p.addNode({ parentRef: p.root().id, id: 'a', title: 'A', content: '第一版' })
  p.updateNode('a', { content: '第二版', status: 'approved' }, {})

  const r = p.checkoutNode('a', 1, { user: 'u' })
  assert.equal(r.changed, true)
  assert.equal(r.node.version, 3)
  assert.equal(r.node.content, '第一版')
  assert.equal(r.node.status, 'draft')
  assert.deepEqual(r.changes.map((c) => c.field).sort(), ['content', 'status'])
  const co = p.changelog.find((e) => e.field === '*checkout')
  assert.equal(co.target_version, 1)
  assert.equal(r.node.parent_id, p.root().id) // 回滚不影响树位置

  assert.throws(() => p.checkoutNode('a', 99), (e) => e.code === 'VERSION_NOT_FOUND')
  assert.equal(p.checkoutNode('a', 3).changed, false) // 已处于该内容状态
})

test('resolveRef：精确 / 唯一前缀 / 歧义 / 语义路径', () => {
  const p = load()
  p.addNode({ parentRef: p.root().id, id: 'node-a1', title: 'X1' })
  p.addNode({ parentRef: p.root().id, id: 'node-a2', title: 'X2' })
  p.addNode({ parentRef: p.root().id, id: 'other', title: 'Y' })
  assert.equal(p.resolveRef('node-a1').id, 'node-a1') // 精确命中
  assert.equal(p.resolveRef('oth').id, 'other') // 唯一前缀
  assert.throws(() => p.resolveRef('node-a'), (e) => e.code === 'AMBIGUOUS_ID')
  assert.equal(p.resolveRef('/根/X1').id, 'node-a1') // 语义路径
  assert.throws(() => p.resolveRef('/不存在'), (e) => e.code === 'NOT_FOUND')
})
