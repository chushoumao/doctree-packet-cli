// v1.4.0 query 参数回归：2026-09-10 第三轮 dogfooding（ISSUE-011 ~ 013）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runJson, makePacket, tmpdir, path } from './helpers.js'

function freshPacket() {
  const dir = tmpdir('dtp-qedges-')
  const file = path.join(dir, 'p.dtp')
  makePacket(file, { name: '查询边缘包' })
  return { file }
}

test('ISSUE-011: query --limit 非整数报 USAGE，不再静默截断', () => {
  const { file } = freshPacket()
  for (let i = 1; i <= 3; i++) runJson(['add', 'n_root', '--title', `T${i}`, '--packet', file])

  for (const bad of ['1.5', '2abc', '1e2', '0x10', '-1', 'abc']) {
    const r = runJson(['query', '--limit', bad, '--packet', file])
    assert.equal(r.status, 2, `--limit ${bad} 应报用法错误`)
    assert.equal(r.data.error.code, 'USAGE')
  }

  const ok = runJson(['query', '--limit', '2', '--packet', file])
  assert.equal(ok.status, 0)
  assert.equal(ok.data.count, 2)
})

test('ISSUE-012: query 非法 --type/--status 退出码为 2', () => {
  const { file } = freshPacket()

  const t = runJson(['query', '--type', 'bogus', '--packet', file])
  assert.equal(t.status, 2)
  assert.equal(t.data.error.code, 'INVALID_TYPE')

  const s = runJson(['query', '--status', 'bogus', '--packet', file])
  assert.equal(s.status, 2)
  assert.equal(s.data.error.code, 'INVALID_STATUS')
})

test('ISSUE-013: query 空过滤值报 USAGE，不再 fail-open 返回全集', () => {
  const { file } = freshPacket()
  runJson(['add', 'n_root', '--title', 'T1', '--packet', file])

  const emptyFilters = [
    ['--tag', ''],
    ['--type', ''],
    ['--status', ''],
    ['--keyword', ''],
    ['--path', ''],
  ]
  for (const args of emptyFilters) {
    const r = runJson(['query', ...args, '--packet', file])
    assert.equal(r.status, 2, `query ${args.join(' ')} 应报用法错误`)
    assert.equal(r.data.error.code, 'USAGE')
  }

  // 逗号列表中的空段仍按既有语义丢弃，全空才拒绝
  runJson(['add', 'n_root', '--title', 'T2', '--tags', 'P0', '--packet', file])
  const listy = runJson(['query', '--tag', 'P0,', '--packet', file])
  assert.equal(listy.status, 0)
  assert.equal(listy.data.count, 1)
})
