import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeSegment, decodeSegment, splitSegments, pathKey, normalizePathString } from '../src/path.js'

test('基本路径解析', () => {
  assert.deepEqual(splitSegments('/a/b/c'), ['a', 'b', 'c'])
  assert.deepEqual(splitSegments('a/b/c'), ['a', 'b', 'c']) // 容忍缺省前导 /
  assert.deepEqual(splitSegments('/a/b/'), ['a', 'b']) // 容忍尾随 /
  assert.deepEqual(splitSegments(''), [])
  assert.deepEqual(splitSegments('/'), [])
})

test('标题含 / 时以 \\/ 转义', () => {
  assert.equal(encodeSegment('FR/001'), 'FR\\/001')
  assert.equal(decodeSegment('FR\\/001'), 'FR/001')
  assert.deepEqual(splitSegments('/FR\\/001/登录'), ['FR/001', '登录'])
  assert.equal(pathKey(['FR/001', '登录']), '/FR\\/001/登录')
})

test('normalizePathString 规范化输入', () => {
  assert.equal(normalizePathString('a/b'), '/a/b')
  assert.equal(normalizePathString('/a/b/'), '/a/b')
  assert.equal(normalizePathString('/a\\/b/c'), '/a\\/b/c')
})
