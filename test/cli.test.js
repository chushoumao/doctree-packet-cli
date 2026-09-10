import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir, runDtp, runJson, makePacket } from './helpers.js'
import { acquireLock, releaseLock } from '../src/storage.js'

let dir, packetFile
beforeEach(() => {
  dir = tmpdir()
  packetFile = path.join(dir, 'packet.dtp')
})

test('init → add → update → query → history 全流程（文档 §4.3 场景）', () => {
  const init = runJson(['init', '智能客服系统', '--packet', packetFile, '--id', 'n_root'])
  assert.equal(init.status, 0)
  assert.equal(init.data.ok, true)
  assert.equal(init.data.root_node_id, 'n_root')

  const add = runJson(['add', 'n_root', '--id', 'fr001', '--title', 'FR-001 用户认证', '--type', 'requirement', '--tags', 'auth,P0', '--packet', packetFile])
  assert.equal(add.status, 0)
  assert.equal(add.data.node.id, 'fr001')
  assert.equal(add.data.path, '/智能客服系统/FR-001 用户认证')

  const add2 = runJson(['add', 'fr001', '--title', '登录验证', '--description', '支持账号密码及验证码登录', '--tags', 'P0', '--packet', packetFile])
  const loginId = add2.data.node.id

  const upd = runJson(['update', loginId, '--content', '新内容', '--ext', 'priority=P0', '--ext', 'owner=张三', '--user', '张三', '--packet', packetFile])
  assert.equal(upd.data.node.version, 2)
  assert.deepEqual(upd.data.fields.sort(), ['content', 'extensions.owner', 'extensions.priority'])

  // append-only：改旧扩展键被拒，--force 放行
  const refuse = runJson(['update', loginId, '--ext', 'priority=P1', '--packet', packetFile])
  assert.equal(refuse.status, 1)
  assert.equal(refuse.data.error.code, 'EXT_IMMUTABLE')
  const forced = runJson(['update', loginId, '--ext', 'priority=P1', '--force', '--packet', packetFile])
  assert.equal(forced.status, 0)

  const approved = runJson(['update', loginId, '--status', 'approved', '--packet', packetFile])
  assert.equal(approved.data.node.status, 'approved')

  const q = runJson(['query', '--tag', 'P0', '--status', 'approved', '--packet', packetFile])
  assert.equal(q.data.count, 1)
  assert.equal(q.data.nodes[0].id, loginId)

  const h = runJson(['history', loginId, '--packet', packetFile])
  assert.equal(h.data.total_versions, 4)
  assert.equal(h.data.deleted, false)
  assert.ok(h.data.versions.length >= 1)
})

test('get-path / mv / 路径索引自动更新', () => {
  makePacket(packetFile)
  const a = runJson(['add', 'n_root', '--id', 'a', '--title', '模块A', '--packet', packetFile])
  assert.equal(a.status, 0)
  const b = runJson(['add', 'a', '--id', 'b', '--title', '子页', '--packet', packetFile])
  const gp = runJson(['get-path', '/测试包/模块A/子页', '--packet', packetFile])
  assert.equal(gp.status, 0)
  assert.equal(gp.data.node.id, 'b')

  runJson(['add', 'n_root', '--id', 'c', '--title', '模块C', '--packet', packetFile])
  const mv = runJson(['mv', 'b', 'c', '--packet', packetFile])
  assert.equal(mv.data.moved, true)
  assert.equal(mv.data.new_path, '/测试包/模块C/子页')
  assert.equal(runJson(['get-path', '/测试包/模块C/子页', '--packet', packetFile]).status, 0)
  assert.equal(runJson(['get-path', '/测试包/模块A/子页', '--packet', packetFile]).status, 1)

  // 成环拒绝
  const cycle = runJson(['mv', 'c', 'b', '--packet', packetFile])
  assert.equal(cycle.status, 1)
  assert.equal(cycle.data.error.code, 'MOVE_CYCLE')
})

test('rm 级联删除 + 已删除节点可查历史 + 非 TTY 需 --yes', () => {
  makePacket(packetFile)
  runJson(['add', 'n_root', '--id', 'm', '--title', 'M', '--packet', packetFile])
  runJson(['add', 'm', '--id', 'l', '--title', 'L', '--packet', packetFile])

  const no = runJson(['rm', 'm', '--packet', packetFile])
  assert.equal(no.status, 2) // 非交互环境缺 --yes 属用法错误
  assert.equal(no.data.error.code, 'USAGE')

  const yes = runJson(['rm', 'm', '--yes', '--packet', packetFile])
  assert.equal(yes.data.count, 2)
  assert.deepEqual(yes.data.removed.sort(), ['l', 'm'])

  const hist = runJson(['history', 'm', '--packet', packetFile])
  assert.equal(hist.status, 0)
  assert.equal(hist.data.deleted, true)

  const gone = runJson(['get', 'm', '--packet', packetFile])
  assert.equal(gone.status, 1)
  assert.equal(gone.data.error.code, 'NODE_DELETED')
})

test('checkout 回滚 + export + verify', () => {
  makePacket(packetFile)
  runJson(['add', 'n_root', '--id', 'x', '--title', 'X', '--content', 'v1 内容', '--packet', packetFile])
  runJson(['update', 'x', '--content', 'v2 内容', '--packet', packetFile])
  const co = runJson(['checkout', 'x', '1', '--packet', packetFile])
  assert.equal(co.status, 0)
  assert.equal(co.data.node.version, 3)
  assert.equal(co.data.node.content, 'v1 内容')

  const md = runDtp(['export', 'n_root', '--format', 'md', '--packet', packetFile])
  assert.match(md.stdout, /# 测试包/)
  assert.match(md.stdout, /v1 内容/)

  const html = runDtp(['export', '--format', 'html', '--output', path.join(dir, 'out.html'), '--packet', packetFile])
  assert.equal(html.status, 0)
  assert.ok(fs.existsSync(path.join(dir, 'out.html')))

  const v = runJson(['verify', '--packet', packetFile])
  assert.equal(v.status, 0)
  assert.equal(v.data.ok, true)
})

test('pack → unpack 往返，gzip 可透明读取', () => {
  makePacket(packetFile)
  runJson(['add', 'n_root', '--id', 'p1', '--title', 'P1', '--packet', packetFile])
  const pack = runJson(['pack', '--gzip', '--output', path.join(dir, 'snap.dtp.gz'), '--packet', packetFile])
  assert.equal(pack.status, 0)

  const target = path.join(dir, 'restored.dtp')
  const up = runJson(['unpack', path.join(dir, 'snap.dtp.gz'), '--packet', target])
  assert.equal(up.status, 0)
  assert.equal(up.data.nodes, 2)

  const v = runJson(['verify', '--packet', target])
  assert.equal(v.data.ok, true)
  const gp = runJson(['get-path', '/测试包/P1', '--packet', target])
  assert.equal(gp.status, 0)
})

test('verify 检出篡改：哈希不匹配退出码非 0', () => {
  makePacket(packetFile)
  runJson(['add', 'n_root', '--id', 't1', '--title', 'T1', '--packet', packetFile])
  // 篡改文件中最后一个 node 行的标题（不更新哈希）
  const lines = fs.readFileSync(packetFile, 'utf8').trim().split('\n')
  let tampered = false
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = JSON.parse(lines[i])
    if (obj.type === 'node' && obj.id === 't1') {
      obj.title = '被篡改'
      lines[i] = JSON.stringify(obj)
      tampered = true
      break
    }
  }
  assert.ok(tampered, '应找到 t1 的 node 行')
  fs.writeFileSync(packetFile, lines.join('\n') + '\n')
  const v = runJson(['verify', '--packet', packetFile])
  assert.equal(v.status, 1)
  assert.equal(v.data.ok, false)
  const hashCheck = v.data.checks.find((c) => c.name === '节点哈希匹配')
  assert.equal(hashCheck.ok, false)
})

test('文件锁互斥：持锁时变更命令失败', async () => {
  makePacket(packetFile)
  const lock = acquireLock(packetFile)
  try {
    const r = runJson(['add', 'n_root', '--title', 'X', '--packet', packetFile])
    assert.equal(r.status, 1)
    assert.equal(r.data.error.code, 'LOCKED')
  } finally {
    releaseLock(lock)
  }
})

test('--quiet 静默与错误 JSON 输出', () => {
  makePacket(packetFile)
  const quiet = runDtp(['ls', '--quiet', '--packet', packetFile])
  assert.equal(quiet.status, 0)
  assert.equal(quiet.stdout.trim(), '')

  const err = runJson(['get', '不存在的节点', '--packet', packetFile])
  assert.equal(err.status, 1)
  assert.equal(err.data.ok, false)
  assert.equal(err.data.error.code, 'NOT_FOUND')
})

test('update --tags 增量增删：+tag / -tag，且整体替换向后兼容', () => {
  makePacket(packetFile)
  runJson(['add', 'n_root', '--id', 't1', '--title', 'T1', '--tags', 'P0,cli', '--packet', packetFile])

  const addTag = runJson(['update', 't1', '--tags', '+P3', '--packet', packetFile])
  assert.equal(addTag.status, 0)
  assert.deepEqual(addTag.data.node.tags, ['P0', 'cli', 'P3'])

  const rmTag = runJson(['update', 't1', '--tags', '-cli', '--packet', packetFile])
  assert.deepEqual(rmTag.data.node.tags, ['P0', 'P3'])

  const mix = runJson(['update', 't1', '--tags', '+P9', '--tags', '-P0', '--packet', packetFile])
  assert.deepEqual(mix.data.node.tags, ['P3', 'P9'])

  const replace = runJson(['update', 't1', '--tags', 'Q1,Q2', '--packet', packetFile])
  assert.deepEqual(replace.data.node.tags, ['Q1', 'Q2'])

  const query = runJson(['query', '--tag', 'Q2', '--packet', packetFile])
  assert.equal(query.data.count, 1)
  assert.equal(query.data.nodes[0].id, 't1')
})

test('recover 从备份恢复', () => {
  makePacket(packetFile)
  runJson(['add', 'n_root', '--id', 'a1', '--title', 'A1', '--packet', packetFile])
  runJson(['rm', 'a1', '--yes', '--packet', packetFile])
  const list = runJson(['recover', '--packet', packetFile])
  assert.ok(list.data.backups.length >= 1)
  const rec = runJson(['recover', '--from', '1', '--packet', packetFile])
  assert.equal(rec.status, 0)
  const gp = runJson(['get', 'a1', '--packet', packetFile])
  assert.equal(gp.status, 0) // 删除前的状态被恢复
})
