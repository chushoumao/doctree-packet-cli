import { createHash } from 'node:crypto'

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// 稳定序列化：对象键排序、无空白，使同构数据在不同写入顺序下哈希一致
export function canonicalJson(value) {
  if (value === undefined) value = null
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v)).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

// 字段级哈希：changelog 中 old_hash/new_hash 记录的是“字段值”的哈希
export function hashValue(value) {
  return sha256(canonicalJson(value))
}
