// TASK-011 回归：webui API 冒烟（由 webui/test-template.mjs / test-write.mjs 改写并入）。
// 起真实 dtp web 实例（子进程）→ HTTP 断言：空工作区如实空、init/add/update/mv/checkout/
// rm 写链路、ext 拒改与强改、模板 new/check/bind、tree/query/lint 读链路。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { tmpdir, runDtp } from './helpers.js'

// Node 18 兼容：import.meta.dirname 是 20.11+ API，用 fileURLToPath 先例
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dtp.js')
// 端口选 4761 产品段 + 随机偏移：避开 Linux ephemeral 段（32768+）降低 CI 偶发碰撞；套件串行无并发实例
const PORT = 4761 + 1 + Math.floor(Math.random() * 100)
const BASE = `http://127.0.0.1:${PORT}`
const WS = tmpdir('webui-smoke-')

let child = null

async function call(method, apiPath, { params, body } = {}) {
  let url = apiPath
  if (params) {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v != null) q.append(k, v)
    const s = q.toString()
    if (s) url += `?${s}`
  }
  const res = await fetch(BASE + url, {
    method,
    headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })
  return res.json()
}

before(async () => {
  child = spawn(process.execPath, [BIN, 'web', '--port', String(PORT), '--dir', WS], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // 轮询就绪（最长 5s）
  const t0 = Date.now()
  for (;;) {
    try {
      await fetch(`${BASE}/api/packets`)
      break
    } catch {
      if (Date.now() - t0 > 5000) throw new Error('dtp web 未在 5s 内就绪')
      await new Promise((r) => setTimeout(r, 100))
    }
  }
})

after(() => {
  child?.kill('SIGTERM')
})

// ---------- workspace 解析链四态（resolveWebWorkspace 纯函数级） ----------

test('web 工作区四态：--dir > DTP_WORKSPACE > config→.dtp/ > 报错指引 init', async () => {
  const { resolveWebWorkspace } = await import('../src/config.js')
  const dir = tmpdir('web-ws-')

  // ① --dir 显式优先
  assert.deepEqual(resolveWebWorkspace(dir, './my-ws'), { path: path.resolve(dir, 'my-ws'), source: 'dir' })

  // ② DTP_WORKSPACE 环境变量次之
  const prev = process.env.DTP_WORKSPACE
  process.env.DTP_WORKSPACE = '/tmp/env-ws-demo'
  try {
    assert.equal(resolveWebWorkspace(dir).source, 'env')
    // ① 仍优先于 ②
    assert.equal(resolveWebWorkspace(dir, './x').source, 'dir')
  } finally {
    if (prev === undefined) delete process.env.DTP_WORKSPACE
    else process.env.DTP_WORKSPACE = prev
  }

  // ③ config 存在 → .dtp/
  const cfgDir = tmpdir('web-ws2-')
  runDtp(['init', '包'], { cwd: cfgDir })  // 缺省落点：写 .dtp/config.json
  const r3 = resolveWebWorkspace(cfgDir)
  assert.equal(r3.source, 'config')
  assert.ok(r3.path.endsWith('.dtp'))

  // ④ 全无 → NO_PACKET 指引
  const empty = tmpdir('web-ws3-')
  assert.throws(() => resolveWebWorkspace(empty), (e) => e.code === 'NO_PACKET' && /dtp init/.test(e.message))
})

test('web：--port 非法值 USAGE exit 2（--json 单行）', async () => {
  const { status, stdout } = runDtp(['web', '--port', 'abc', '--dir', '/tmp/whatever', '--json'])
  assert.equal(status, 2)
  const out = JSON.parse(stdout)
  assert.equal(out.error.code, 'USAGE')
  assert.match(out.error.message, /--port/)
})

test('web：空工作区如实空（不播种不代写），响应带 workspace', async () => {
  const r = await call('GET', '/api/packets')
  assert.equal(r.ok, true)
  assert.deepEqual(r.packets, [])
  assert.ok(typeof r.workspace === 'string' && r.workspace.length > 0)
})

test('web：init 建包 → add → update → 树与查询可见', async () => {
  const init = await call('POST', '/api/init', { body: { name: '写作测试包', user: 'smoke' } })
  assert.equal(init.ok, true, JSON.stringify(init.error))
  assert.equal(init.meta.name, '写作测试包')

  const add = await call('POST', '/api/add', {
    body: { packet: '写作测试包.dtp', parentRef: '/写作测试包', title: '第一章', nodeType: 'document', tags: ['草稿'], ext: { priority: 'P0' }, content: '正文 v1', user: 'smoke' },
  })
  assert.equal(add.ok, true, JSON.stringify(add.error))
  assert.equal(add.node.version, 1)

  const up = await call('POST', '/api/update', { body: { packet: '写作测试包.dtp', ref: '/写作测试包/第一章', content: '正文 v2', status: 'review', user: 'smoke' } })
  assert.equal(up.ok, true)
  assert.equal(up.node.version, 2)

  const tree = await call('GET', '/api/tree', { params: { p: '写作测试包.dtp' } })
  assert.equal(tree.ok, true)
  assert.ok(JSON.stringify(tree).includes('第一章'))

  const q = await call('GET', '/api/query', { params: { p: '写作测试包.dtp', keyword: '第一章' } })
  assert.equal(q.ok, true)
  assert.equal(q.nodes.length, 1)

  // 同名拒绝（EXISTS 语义经 --json 错误契约透传）
  const dup = await call('POST', '/api/add', { body: { packet: '写作测试包.dtp', parentRef: '/写作测试包', title: '第一章', user: 'smoke' } })
  assert.equal(dup.ok, false)
  assert.equal(dup.error.code, 'EXISTS')
})

test('web：ext 拒改（append-only）与 --force 强改；mv/checkout/rm', async () => {
  const P = '写作测试包.dtp'
  const denied = await call('POST', '/api/update', { body: { packet: P, ref: '/写作测试包/第一章', ext: { priority: 'P1' }, user: 'smoke' } })
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'EXT_IMMUTABLE')

  const force = await call('POST', '/api/update', { body: { packet: P, ref: '/写作测试包/第一章', ext: { priority: 'P1' }, forceExt: true, user: 'smoke' } })
  assert.equal(force.ok, true)

  const add2 = await call('POST', '/api/add', { body: { packet: P, parentRef: '/写作测试包', title: '第二章', user: 'smoke' } })
  assert.equal(add2.ok, true)
  const mv = await call('POST', '/api/mv', { body: { packet: P, ref: '/写作测试包/第二章', newParentRef: '/写作测试包/第一章', user: 'smoke' } })
  assert.equal(mv.ok, true)
  assert.equal(mv.moved, true)

  const co = await call('POST', '/api/checkout', { body: { packet: P, ref: '/写作测试包/第一章', version: 1, user: 'smoke' } })
  assert.equal(co.ok, true)

  const rm = await call('POST', '/api/rm', { body: { packet: P, ref: '/写作测试包/第一章/第二章', user: 'smoke' } })
  assert.equal(rm.ok, true)
})

test('web：模板 new → check → bind → lint 全链（释放副本对齐 SCHEMA_DIR）', async () => {
  const P = '写作测试包.dtp'
  const nt = await call('POST', '/api/template/new', { body: { name: 'demo' } })
  assert.equal(nt.ok, true, JSON.stringify(nt.error))
  assert.equal(nt.file, 'templates/demo.schema.json')

  const ck = await call('POST', '/api/template/check', { body: { file: 'templates/demo.schema.json' } })
  assert.equal(ck.ok, true)
  assert.deepEqual(ck.problems, [])

  const bd = await call('POST', '/api/template/bind', { body: { template: 'templates/demo.schema.json', packet: P } })
  assert.equal(bd.ok, true, JSON.stringify(bd.error))

  const lint = await call('GET', '/api/lint', { params: { p: P } })
  assert.equal(lint.ok, true, JSON.stringify(lint.error))
  // demo 模版要求 f_items 容器，该包没有 → skeleton.missing 恰好证明 lint 经 API 真在管事
  assert.equal(lint.error_count, 1)
  assert.equal(lint.violations[0].rule, 'skeleton.missing')
  assert.ok(fs.existsSync(path.join(WS, 'templates', 'demo.schema.json')), '模板落在工作区 templates/（与 init 释放目录对齐）')
})

test('web：verify/stats/ledger 读链路与静态首页', async () => {
  const v = await call('GET', '/api/verify', { params: { p: '写作测试包.dtp' } })
  assert.equal(v.ok, true)
  assert.equal(v.checks.length > 0, true)

  const st = await call('GET', '/api/stats', { params: { p: '写作测试包.dtp' } })
  assert.equal(st.ok, true)

  const lg = await call('GET', '/api/ledger', { params: { p: '写作测试包.dtp' } })
  assert.equal(lg.ok, true)

  const page = await fetch(`${BASE}/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)
})
