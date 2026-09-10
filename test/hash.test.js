import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sha256, canonicalJson, hashValue } from '../src/hash.js'

test('canonicalJson 对象键排序且无空白', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(canonicalJson({ a: { c: 3, b: [2, 1] } }), '{"a":{"b":[2,1],"c":3}}')
})

test('canonicalJson 语义相同的不同键序产生相同哈希', () => {
  const x = JSON.stringify({ title: 'a', ext: { y: 1, x: 2 }, tags: ['b', 'a'] })
  const y = JSON.stringify({ tags: ['b', 'a'], ext: { x: 2, y: 1 }, title: 'a' })
  assert.equal(hashValue(JSON.parse(x)), hashValue(JSON.parse(y)))
})

test('canonicalJson 处理 null/undefined/unicode', () => {
  assert.equal(canonicalJson(null), 'null')
  assert.equal(canonicalJson(undefined), 'null')
  assert.equal(canonicalJson('中文/测试'), '"中文/测试"')
})

test('sha256 输出 64 位十六进制', () => {
  const h = sha256('abc')
  assert.equal(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.match(h, /^[0-9a-f]{64}$/)
})
