// v1.3.0 边缘回归：2026-09-10 第二轮 dogfooding（ISSUE-006 ~ 010、OPTIM-002）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDtp, runJson, makePacket, tmpdir, fs, path } from './helpers.js'

function freshPacket() {
  const dir = tmpdir('dtp-edges-')
  const file = path.join(dir, 'p.dtp')
  makePacket(file, { name: '边缘包' })
  return { dir, file }
}

test('ISSUE-006: export/pack --output 目录不存在 → USAGE 指明目录', () => {
  const { dir, file } = freshPacket()
  const bad = path.join(dir, 'no', 'dir', 'x.md')

  const r1 = runJson(['export', 'n_root', '--format', 'md', '--output', bad, '--packet', file])
  assert.equal(r1.status, 2)
  assert.equal(r1.data.error.code, 'USAGE')
  assert.match(r1.data.error.message, /输出目录不存在/)

  const r2 = runJson(['pack', '--output', path.join(dir, 'no', 'x.dtp'), '--packet', file])
  assert.equal(r2.status, 2)
  assert.equal(r2.data.error.code, 'USAGE')
  assert.match(r2.data.error.message, /输出目录不存在/)
})

test('ISSUE-007: verify 对不存在的包 → NO_PACKET 标准错误契约', () => {
  const { dir } = freshPacket()
  const r = runJson(['verify', '--packet', path.join(dir, 'nosuch.dtp')])
  assert.equal(r.status, 1)
  assert.equal(r.data.error.code, 'NO_PACKET')
  assert.match(r.data.error.error?.message ?? r.data.error.message, /数据包不存在/)
})

test('ISSUE-008: query --path 不可解析 → NOT_FOUND；可解析子树过滤不变', () => {
  const { file } = freshPacket()
  runJson(['add', 'n_root', '--id', 'c1', '--title', 'C1', '--packet', file])
  runJson(['add', 'c1', '--id', 'c11', '--title', 'C11', '--packet', file])

  const bad = runJson(['query', '--path', '/边缘包/不存在', '--packet', file])
  assert.equal(bad.status, 1)
  assert.equal(bad.data.error.code, 'NOT_FOUND')

  const good = runJson(['query', '--path', '/边缘包/C1', '--packet', file])
  assert.equal(good.status, 0)
  assert.equal(good.data.total, 2) // C1 + C11
})

test('ISSUE-009: 标题/包名统一 trim', () => {
  const { dir, file } = freshPacket()

  const a = runJson(['add', 'n_root', '--title', '  Q  ', '--packet', file])
  assert.equal(a.status, 0)
  assert.equal(a.data.node.title, 'Q')

  const u = runJson(['update', a.data.node.id, '--title', '  W  ', '--packet', file])
  assert.equal(u.status, 0)
  assert.equal(u.data.node.title, 'W')

  // init：纯空白名拒绝，带空白名 trim
  const i1 = runJson(['init', '   ', '--packet', path.join(dir, 'x1.dtp')])
  assert.equal(i1.status, 2)
  assert.equal(i1.data.error.code, 'USAGE')
  const i2 = runJson(['init', '  名字  ', '--packet', path.join(dir, 'x2.dtp')])
  assert.equal(i2.status, 0)
  assert.equal(i2.data.name, '名字')
})

test('ISSUE-010: 零位置参数命令的多余参数提示 --packet', () => {
  const { file } = freshPacket()
  const r = runJson(['verify', file])
  assert.equal(r.status, 2)
  assert.equal(r.data.error.code, 'USAGE')
  assert.match(r.data.error.message, /--packet/)

  // 带位置参数的命令保持原提示
  const r2 = runJson(['get', 'a', 'b', '--packet', file])
  assert.equal(r2.status, 2)
  assert.doesNotMatch(r2.data.error.message, /不接受位置参数/)
})

test('OPTIM-002: query --limit 截断时人类输出提示总数', () => {
  const { file } = freshPacket()
  for (let i = 1; i <= 3; i++) runJson(['add', 'n_root', '--title', `T${i}`, '--packet', file])
  const r = runDtp(['query', '--limit', '2', '--packet', file])
  assert.equal(r.status, 0)
  assert.match(r.stdout, /共 4 个节点/)
})

test('边缘基线不受影响：转义寻址 / 同位 mv / checkout 相同版本', () => {
  const { dir, file } = freshPacket()
  runJson(['add', 'n_root', '--title', '模块A/B', '--packet', file])
  const esc = runJson(['get-path', '/边缘包/模块A\\/B', '--packet', file])
  assert.equal(esc.status, 0)
  assert.equal(esc.data.node.title, '模块A/B')

  runJson(['add', 'n_root', '--id', 'm1', '--title', 'M1', '--packet', file])
  const mv = runJson(['mv', 'm1', 'n_root', '--packet', file])
  assert.equal(mv.status, 0)
  assert.equal(mv.data.moved, false)
  assert.equal(mv.data.node?.version ?? 1, 1) // 未升版

  runJson(['update', 'm1', '--description', 'd', '--packet', file])
  const co = runJson(['checkout', 'm1', '2', '--packet', file])
  assert.equal(co.status, 0)
  assert.equal(co.data.changed, false) // 与当前内容相同的版本不升版
})
