import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from './helpers.js'
import { Packet, initPacketLines } from '../src/packet.js'
import { writeJsonlFresh } from '../src/storage.js'
import { filterNodes } from '../src/query.js'

let dir, file, packet
beforeEach(() => {
  dir = tmpdir()
  file = path.join(dir, 'p.dtp')
  writeJsonlFresh(file, initPacketLines({ name: '根', packetId: 'pkt-q' }).lines)
  packet = Packet.load(file)
  const root = packet.root()
  packet.addNode({ parentRef: root.id, id: 'r1', title: '认证', nodeType: 'requirement', tags: ['P0', 'auth'], status: 'approved', content: '登录验证码' })
  packet.addNode({ parentRef: root.id, id: 'r2', title: '支付', nodeType: 'requirement', tags: ['P1'], status: 'review', description: '含验证码二次确认' })
  packet.addNode({ parentRef: 'r1', id: 'd1', title: '登录页', nodeType: 'document', tags: ['P0'], extensions: { priority: 'P0', sprint: 3 } })
  packet.addNode({ parentRef: root.id, id: 'k1', title: '术语表', nodeType: 'knowledge', status: 'archived' })
})

test('单维度过滤：tag / type / status', () => {
  assert.deepEqual(filterNodes(packet, { tags: ['P0'] }).map((n) => n.id), ['r1', 'd1']) // 按路径排序
  assert.deepEqual(filterNodes(packet, { types: ['requirement'] }).map((n) => n.id), ['r2', 'r1']) // 码点序：支 < 认
  assert.deepEqual(filterNodes(packet, { statuses: ['approved', 'archived'] }).map((n) => n.id), ['k1', 'r1'])
})

test('同维度 OR：多个标签任一命中', () => {
  const ids = filterNodes(packet, { tags: ['P1', 'auth'] }).map((n) => n.id)
  assert.deepEqual(ids.sort(), ['r1', 'r2'])
})

test('跨维度 AND 组合', () => {
  assert.deepEqual(filterNodes(packet, { tags: ['P0'], statuses: ['approved'] }).map((n) => n.id), ['r1'])
  assert.deepEqual(filterNodes(packet, { tags: ['P0'], types: ['document'] }).map((n) => n.id), ['d1'])
  assert.equal(filterNodes(packet, { tags: ['P0'], types: ['knowledge'] }).length, 0)
})

test('扩展字段匹配：字符串 / 数字 / 深比较', () => {
  assert.deepEqual(filterNodes(packet, { ext: [{ key: 'priority', value: 'P0' }] }).map((n) => n.id), ['d1'])
  assert.deepEqual(filterNodes(packet, { ext: [{ key: 'sprint', value: 3 }] }).map((n) => n.id), ['d1'])
  assert.deepEqual(filterNodes(packet, { ext: [{ key: 'priority', value: 'P1' }] }), [])
  assert.deepEqual(
    filterNodes(packet, { ext: [{ key: 'priority', value: 'P0' }, { key: 'sprint', value: 3 }] }).map((n) => n.id),
    ['d1']
  )
})

test('全文关键字：标题/描述/正文，不区分大小写', () => {
  assert.deepEqual(filterNodes(packet, { keyword: '验证码' }).map((n) => n.id).sort(), ['r1', 'r2'])
  assert.deepEqual(filterNodes(packet, { keyword: '不存在词' }), [])
})

test('路径前缀过滤', () => {
  assert.deepEqual(filterNodes(packet, { pathPrefix: '/根/认证' }).map((n) => n.id).sort(), ['d1', 'r1'])
  assert.deepEqual(filterNodes(packet, { pathPrefix: '/根' }).length, 5) // 含根自身
  // 前缀按段匹配，不按字符
  assert.notDeepEqual(filterNodes(packet, { pathPrefix: '/根/认' }).map((n) => n.id), ['r1'])
})
