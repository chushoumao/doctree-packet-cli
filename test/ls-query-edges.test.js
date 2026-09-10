// 新增摩擦点 OPTIM-010/011 回归：ls --limit 与 query --parent
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runJson, makePacket, tmpdir, path } from './helpers.js'

function seed() {
  const dir = tmpdir('dtp-lsq-')
  const file = path.join(dir, 'p.dtp')
  makePacket(file, { name: 'lsq 边缘包' }) // 根 id=n_root
  for (const [id, title, tags] of [
    ['a1', '任务A', 'P1'],
    ['a2', '任务B', 'P2'],
    ['f1', '子夹', ''],
  ]) {
    const extra = tags ? ['--tags', tags] : []
    const r = runJson(['add', 'n_root', '--id', id, '--title', title, '--type', 'requirement', ...extra, '--packet', file])
    assert.equal(r.status, 0, `add ${id} 失败 ${JSON.stringify(r.data)}`)
  }
  const sub = runJson(['add', 'f1', '--id', 'a3', '--title', '子任务', '--type', 'requirement', '--tags', 'P3', '--packet', file])
  assert.equal(sub.status, 0)
  return { file }
}

test('OPTIM-010: ls --limit 合法值截断并报 total', () => {
  const { file } = seed()

  const none = runJson(['ls', '--packet', file])
  assert.equal(none.status, 0)
  assert.equal(none.data.count, 3)
  assert.equal(none.data.total, 3)

  const lim = runJson(['ls', '--limit', '2', '--packet', file])
  assert.equal(lim.status, 0)
  assert.equal(lim.data.count, 2)
  assert.equal(lim.data.total, 3)

  // 人类输出含截断提示
  const human = runJson(['ls', '--limit', '1', '--packet', file])
  assert.equal(human.status, 0)
})

test('OPTIM-010: ls --limit 非法值报 USAGE exit2', () => {
  const { file } = seed()
  for (const bad of ['1.5', '2abc', '1e2', '0x10', '-1', 'abc']) {
    const r = runJson(['ls', '--limit', bad, '--packet', file])
    assert.equal(r.status, 2, `ls --limit ${bad} 应报用法错误`)
    assert.equal(r.data.error.code, 'USAGE')
  }
})

test('OPTIM-011: query --parent 按 id/前缀/路径仅返回直接子节点', () => {
  const { file } = seed()

  // 根的直接子节点 = 3（a1/a2/f1），不含 a3（f1 的子）
  const byId = runJson(['query', '--parent', 'n_root', '--packet', file])
  assert.equal(byId.status, 0)
  assert.equal(byId.data.total, 3)
  const ids = byId.data.nodes.map((n) => n.id).sort()
  assert.deepEqual(ids, ['a1', 'a2', 'f1'])

  // 前缀引用
  const byPrefix = runJson(['query', '--parent', 'f1', '--packet', file])
  assert.equal(byPrefix.status, 0)
  assert.equal(byPrefix.data.total, 1)
  assert.equal(byPrefix.data.nodes[0].id, 'a3')

  // 语义路径引用
  const byPath = runJson(['query', '--parent', '/lsq 边缘包/子夹', '--packet', file])
  assert.equal(byPath.status, 0)
  assert.equal(byPath.data.total, 1)

  // 可与其它维度组合（AND）
  const comb = runJson(['query', '--parent', 'n_root', '--tag', 'P1', '--packet', file])
  assert.equal(comb.status, 0)
  assert.equal(comb.data.total, 1)
  assert.equal(comb.data.nodes[0].id, 'a1')
})

test('OPTIM-011: query --parent 父节点不存在报 NOT_FOUND、空值报 USAGE', () => {
  const { file } = seed()

  const missing = runJson(['query', '--parent', 'no_such', '--packet', file])
  assert.equal(missing.status, 1)
  assert.equal(missing.data.error.code, 'NOT_FOUND')

  const empty = runJson(['query', '--parent', '', '--packet', file])
  assert.equal(empty.status, 2)
  assert.equal(empty.data.error.code, 'USAGE')
})
