// v1.4.0 history 回归：2026-09-10 第四轮 dogfooding（ISSUE-014 ~ 016）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDtp, runJson, makePacket, tmpdir, path } from './helpers.js'

function freshPacket() {
  const dir = tmpdir('dtp-hedges-')
  const file = path.join(dir, 'p.dtp')
  makePacket(file, { name: '历史边缘包' })
  return { dir, file }
}

test('ISSUE-014: history --limit 非整数报 USAGE，不再静默截断', () => {
  const { file } = freshPacket()
  runJson(['add', 'n_root', '--id', 'a', '--title', 'A', '--packet', file])
  runJson(['update', 'a', '--description', 'd2', '--packet', file])
  runJson(['update', 'a', '--content', 'c3', '--packet', file])

  for (const bad of ['1.5', '2abc', '1e2', '0x10', '0', '-1', 'abc']) {
    const r = runJson(['history', 'a', '--limit', bad, '--packet', file])
    assert.equal(r.status, 2, `--limit ${bad} 应报用法错误`)
    assert.equal(r.data.error.code, 'USAGE')
  }

  const one = runJson(['history', 'a', '--limit', '1', '--packet', file])
  assert.equal(one.status, 0)
  assert.equal(one.data.versions.length, 1)
  assert.equal(one.data.total_versions, 3)
})

test('ISSUE-015: 前缀歧义列出候选（history 与 get 一致）', () => {
  const { file } = freshPacket()
  runJson(['add', 'n_root', '--id', 'amb1', '--title', '歧义一', '--packet', file])
  runJson(['add', 'n_root', '--id', 'amb2', '--title', '歧义二', '--packet', file])

  const h = runJson(['history', 'amb', '--packet', file])
  assert.equal(h.status, 1)
  assert.equal(h.data.error.code, 'AMBIGUOUS_ID')
  assert.match(h.data.error.message, /amb1/)
  assert.match(h.data.error.message, /amb2/)

  const g = runJson(['get', 'amb', '--packet', file])
  assert.equal(g.data.error.code, 'AMBIGUOUS_ID')
  assert.match(g.data.error.message, /amb1/)
  assert.match(g.data.error.message, /amb2/)
})

test('ISSUE-016: pack 后 history 旧值回退哈希并标记 compacted', () => {
  const { dir, file } = freshPacket()
  runJson(['add', 'n_root', '--id', 'a', '--title', 'A', '--description', '初始', '--packet', file])
  runJson(['update', 'a', '--description', '改后', '--packet', file])

  const before = runJson(['history', 'a', '--packet', file])
  assert.equal(before.data.compacted, false)
  assert.equal(before.data.total_versions, 2)

  const packed = path.join(dir, 'snap.dtp')
  const pk = runJson(['pack', '--output', packed, '--packet', file])
  assert.equal(pk.status, 0)

  const after = runJson(['history', 'a', '--packet', packed])
  assert.equal(after.data.compacted, true)
  assert.equal(after.data.total_versions, 1)
  assert.equal(after.data.total_entries, 2)
  const fields = after.data.versions.flatMap((v) => v.fields)
  assert.ok(fields.every((f) => !f.includes('∅')), `不应把不可考旧值显示为 ∅：${fields.join(' | ')}`)
  assert.match(fields.join(' '), /description:/)

  const human = runDtp(['history', 'a', '--packet', packed])
  assert.match(human.stdout, /快照已压缩/)
})
