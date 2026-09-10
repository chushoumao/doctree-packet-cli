// 扩展字段使用回归（ISSUE-022 + OPTIM-016）：空值拒绝、类型语义、数组分行展示、回填链路
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runJson, runDtp, makePacket, tmpdir, path } from './helpers.js'

function seed() {
  const dir = tmpdir('dtp-ext-')
  const file = path.join(dir, 'p.dtp')
  makePacket(file, { name: '扩展包' })
  const add = (args, label) => {
    const r = runJson(['add', 'n_root', ...args, '--packet', file])
    assert.equal(r.status, 0, `${label} 应成功 ${JSON.stringify(r.data)}`)
    return r
  }
  add(['--id', 'task001', '--title', 'TASK-001', '--type', 'requirement', '--tags', 'task',
    '--ext', 'story=US-001', '--ext', 'priority=P1',
    '--ext', 'acceptance=["GIVEN 有子树 WHEN export md THEN 层级递进","导出不压缩空行"]'], 'task001')
  add(['--id', 'task002', '--title', 'TASK-002', '--type', 'requirement', '--tags', 'task',
    '--ext', 'story=US-001', '--ext', 'note=1'], 'task002')
  return { file }
}

test('ISSUE-022: --ext 等号后空值报 USAGE（add/update/query 三面）', () => {
  const { file } = seed()

  const addEmpty = runJson(['add', 'n_root', '--id', 't9', '--title', 'T9', '--ext', 'acceptance=', '--packet', file])
  assert.equal(addEmpty.status, 2)
  assert.equal(addEmpty.data.error.code, 'USAGE')
  assert.match(addEmpty.data.error.message, /acceptance/)
  assert.match(addEmpty.data.error.message, /null/)

  const updEmpty = runJson(['update', 'task001', '--ext', 'done_evidence=', '--packet', file])
  assert.equal(updEmpty.status, 2)
  assert.equal(updEmpty.data.error.code, 'USAGE')

  const qryEmpty = runJson(['query', '--ext', 'story=', '--packet', file])
  assert.equal(qryEmpty.status, 2)
  assert.equal(qryEmpty.data.error.code, 'USAGE')
})

test('ISSUE-022: 显式引号空串与 null 仍允许（明确意图）', () => {
  const { file } = seed()

  const nul = runJson(['add', 'n_root', '--id', 't10', '--title', 'T10', '--ext', 'note=null', '--packet', file])
  assert.equal(nul.status, 0)
  assert.equal(nul.data.node.extensions.note, null)

  const emptyStr = runJson(['add', 'n_root', '--id', 't11', '--title', 'T11', '--ext', 'note=""', '--packet', file])
  assert.equal(emptyStr.status, 0)
  assert.equal(emptyStr.data.node.extensions.note, '')
})

test('JSON 字面量类型语义维持：数字/数组结构化存储', () => {
  const { file } = seed()
  const g = runJson(['get', 'task002', '--packet', file])
  assert.equal(g.data.node.extensions.note, 1)
  assert.equal(typeof g.data.node.extensions.note, 'number')

  const a = runJson(['get', 'task001', '--packet', file])
  assert.ok(Array.isArray(a.data.node.extensions.acceptance), 'acceptance 应为 JSON 数组')
  assert.equal(a.data.node.extensions.acceptance.length, 2)

  // 数组整组深比较命中；标量跨类型不命中（JSON 字面量精确语义）
  const hit = runJson(['query', '--ext', 'note=1', '--packet', file])
  assert.equal(hit.data.total, 1)
  const miss = runJson(['query', '--ext', 'note="1"', '--packet', file])
  assert.equal(miss.data.total, 0)
})

test('OPTIM-016: get 人类输出数组逐条编号分行，标量同行', () => {
  const { file } = seed()
  const human = runDtp(['get', 'task001', '--packet', file])
  assert.ok(human.stdout.includes('acceptance:'), '数组键以冒号引出')
  assert.ok(/ 1\. GIVEN 有子树/.test(human.stdout), '验收条目 1 编号行')
  assert.ok(/ 2\. 导出不压缩空行/.test(human.stdout), '验收条目 2 编号行')
  assert.ok(human.stdout.includes('story="US-001"'), '标量 ext 保持同行 k=v')

  const scalar = runDtp(['get', 'task002', '--packet', file])
  assert.ok(scalar.stdout.includes('note=1'), '标量 ext 维持原格式')
})

test('回填链路：EXT_IMMUTABLE 含 --force 指引，--force 后可覆盖', () => {
  const { file } = seed()

  runJson(['update', 'task001', '--status', 'review', '--packet', file])
  const first = runJson(['update', 'task001', '--ext', 'done_evidence=①通过②通过', '--packet', file])
  assert.equal(first.status, 0)

  const second = runJson(['update', 'task001', '--ext', 'done_evidence=补充', '--packet', file])
  assert.equal(second.status, 1)
  assert.equal(second.data.error.code, 'EXT_IMMUTABLE')
  assert.match(second.data.error.message, /--force/)

  const forced = runJson(['update', 'task001', '--ext', 'done_evidence=①通过②通过③补充', '--force', '--packet', file])
  assert.equal(forced.status, 0)
  assert.equal(forced.data.node.extensions.done_evidence, '①通过②通过③补充')
})
