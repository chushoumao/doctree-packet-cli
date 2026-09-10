import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeNodeType,
  normalizeStatus,
  normalizeTags,
  validateTitle,
  computeNodeHash,
  parseExtAssignments,
} from '../src/model/node.js'
import { DtpError } from '../src/errors.js'

test('normalizeNodeType/Status 大小写不敏感', () => {
  assert.equal(normalizeNodeType('Requirement'), 'requirement')
  assert.equal(normalizeNodeType('FOLDER'), 'folder')
  assert.equal(normalizeStatus('Approved'), 'approved')
  assert.equal(normalizeStatus(undefined), 'draft')
  assert.throws(() => normalizeNodeType('bogus'), DtpError)
  assert.throws(() => normalizeStatus('done'), DtpError)
})

test('normalizeTags 逗号分隔 + 多次传入 + 去重', () => {
  assert.deepEqual(normalizeTags(['a,b', 'c', 'a']), ['a', 'b', 'c'])
  assert.deepEqual(normalizeTags([' x , y ']), ['x', 'y'])
  assert.deepEqual(normalizeTags([]), [])
})

test('validateTitle 拒绝空标题与换行，统一 trim', () => {
  assert.throws(() => validateTitle(''), DtpError)
  assert.throws(() => validateTitle('  '), DtpError)
  assert.throws(() => validateTitle('a\nb'), DtpError)
  assert.equal(validateTitle(' FR-001 '), 'FR-001')
})

test('computeNodeHash 不含版本与时间戳，内容相同则哈希相同', () => {
  const base = {
    parent_id: 'p', node_type: 'document', title: 't', description: 'd', content: 'c',
    tags: ['b', 'a'], status: 'draft', extensions: { x: 1 },
  }
  const h1 = computeNodeHash({ ...base, version: 1, created_at: 'A', updated_at: 'A' })
  const h2 = computeNodeHash({ ...base, version: 99, created_at: 'B', updated_at: 'B' })
  assert.equal(h1, h2)
  const h3 = computeNodeHash({ ...base, content: 'c2' })
  assert.notEqual(h1, h3)
})

test('computeNodeHash 对 tags 顺序与扩展键序不敏感', () => {
  const a = computeNodeHash({ node_type: 'd', title: 't', tags: ['a', 'b'], status: 'draft', extensions: { x: 1, y: 2 } })
  const b = computeNodeHash({ node_type: 'd', title: 't', tags: ['b', 'a'], status: 'draft', extensions: { y: 2, x: 1 } })
  assert.equal(a, b)
})

test('parseExtAssignments 解析 JSON 字面量与字符串', () => {
  assert.deepEqual(parseExtAssignments(['priority=P0', 'score=3', 'flag=true', 'obj={"a":1}']), {
    priority: 'P0',
    score: 3,
    flag: true,
    obj: { a: 1 },
  })
  // ISSUE-022：等号后空值拒绝（空串静默入库会让必填约束失效；置空用 null）
  assert.throws(() => parseExtAssignments(['empty=']), DtpError)
  assert.throws(() => parseExtAssignments(['noeq']), DtpError)
  assert.throws(() => parseExtAssignments(['a.b=1']), DtpError) // 点号与 changelog 字段名冲突
})
