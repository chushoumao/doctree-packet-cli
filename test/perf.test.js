import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from './helpers.js'
import { Packet } from '../src/packet.js'
import { writeJsonlFresh } from '../src/storage.js'
import { computeNodeHash } from '../src/model/node.js'
import { filterNodes } from '../src/query.js'

// 性能需求（文档 §6.1）：加载 10,000 节点（每节点约 2KB）< 500ms；
// 组合过滤查询 < 100ms。直接构造 JSONL（不经 CLI，排除进程启动开销）。

const N = 10_000
const BUDGET_LOAD_MS = Number(process.env.DTP_PERF_BUDGET_MS ?? 500)
const BUDGET_QUERY_MS = Number(process.env.DTP_QUERY_BUDGET_MS ?? 100)

function buildBigPacket(file) {
  const meta = {
    type: 'packet_meta', packet_id: 'pkt-perf', name: '性能包', version: 'v1.0.0',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    root_node_id: 'root', metadata: {},
  }
  const root = {
    type: 'node', id: 'root', parent_id: null, node_type: 'folder', title: '性能包',
    description: '', content: '', extensions: {}, created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z', version: 1, hash: '', tags: [], status: 'draft',
  }
  root.hash = computeNodeHash(root)
  const lines = [meta, root]
  const filler = 'x'.repeat(2048) // ~2KB/节点
  for (let i = 0; i < N; i++) {
    const parent = i === 0 ? 'root' : `n${Math.max(0, i - 1 - (i % 7))}` // 树+少量链
    const node = {
      type: 'node', id: `n${i}`, parent_id: parent,
      node_type: i % 3 === 0 ? 'requirement' : 'document',
      title: `节点 ${i} 某功能需求标题`,
      description: '用于性能测试的描述文本',
      content: filler,
      extensions: i % 5 === 0 ? { priority: 'P0', sprint: i } : {},
      created_at: new Date(2026, 0, 1, 0, 0, 0, i).toISOString(),
      updated_at: new Date(2026, 0, 1, 0, 0, 0, i).toISOString(),
      version: 1, hash: '', tags: i % 2 === 0 ? ['P0'] : ['P1'], status: i % 4 === 0 ? 'approved' : 'draft',
    }
    node.hash = computeNodeHash(node)
    lines.push(node)
  }
  writeJsonlFresh(file, lines)
  return lines
}

test(`加载 ${N} 节点 < ${BUDGET_LOAD_MS}ms；组合过滤 < ${BUDGET_QUERY_MS}ms`, () => {
  const dir = tmpdir('dtp-perf-')
  const file = path.join(dir, 'big.dtp')
  buildBigPacket(file)
  const sizeMb = fs.statSync(file).size / 1024 / 1024

  const t0 = process.hrtime.bigint()
  const packet = Packet.load(file)
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6
  assert.equal(packet.nodes.size, N + 1)

  const t1 = process.hrtime.bigint()
  const hits = filterNodes(packet, { tags: ['P0'], types: ['requirement'], statuses: ['approved'], keyword: '功能' })
  const queryMs = Number(process.hrtime.bigint() - t1) / 1e6
  assert.ok(hits.length > 0, '组合过滤应有命中')

  console.log(`  性能：加载 ${N} 节点（${sizeMb.toFixed(1)} MB）= ${loadMs.toFixed(0)}ms（预算 ${BUDGET_LOAD_MS}ms），组合过滤 ${hits.length} 命中 = ${queryMs.toFixed(1)}ms（预算 ${BUDGET_QUERY_MS}ms）`)
  assert.ok(loadMs < BUDGET_LOAD_MS, `加载超时：${loadMs.toFixed(0)}ms`)
  assert.ok(queryMs < BUDGET_QUERY_MS, `查询超时：${queryMs.toFixed(1)}ms`)
})
