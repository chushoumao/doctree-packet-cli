import { sha256, canonicalJson } from '../hash.js'
import { DtpError } from '../errors.js'

export const NODE_TYPES = ['folder', 'document', 'requirement', 'knowledge', 'index']
export const STATUSES = ['draft', 'review', 'approved', 'archived']

export function normalizeNodeType(raw) {
  const v = String(raw ?? 'document').trim().toLowerCase()
  if (!NODE_TYPES.includes(v)) {
    throw new DtpError('INVALID_TYPE', `未知节点类型 "${raw}"，可选：${NODE_TYPES.join(' | ')}`)
  }
  return v
}

export function normalizeStatus(raw) {
  const v = String(raw ?? 'draft').trim().toLowerCase()
  if (!STATUSES.includes(v)) {
    throw new DtpError('INVALID_STATUS', `未知状态 "${raw}"，可选：${STATUSES.join(' | ')}`)
  }
  return v
}

// 标签来源：--tags a,b --tags c → ['a','b','c']，去重保序
export function normalizeTags(items) {
  const list = []
  for (const item of items ?? []) {
    for (const t of String(item).split(',')) {
      const v = t.trim()
      if (v) list.push(v)
    }
  }
  return [...new Set(list)]
}

export function validateTitle(title) {
  // 统一 trim：含前后空白的标题会让语义路径/查询静默不匹配（keyword 可查到但 path 查不到）
  const t = typeof title === 'string' ? title.trim() : title
  if (typeof t !== 'string' || t.length === 0) {
    throw new DtpError('USAGE', '标题不能为空')
  }
  if (t.includes('\n')) {
    throw new DtpError('USAGE', '标题不能包含换行符（会影响语义路径）')
  }
  return t
}

export function validateNodeId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
    throw new DtpError('USAGE', `非法节点 ID "${id}"（1-128 字符）`)
  }
  if (/\s|\//.test(id)) {
    throw new DtpError('USAGE', `非法节点 ID "${id}"（不能包含空白字符与 '/'）`)
  }
  return id
}

// 内容哈希只覆盖语义字段，不含 version/时间戳，保证同内容同哈希
export function computeNodeHash(node) {
  return sha256(
    canonicalJson({
      parent_id: node.parent_id ?? null,
      node_type: node.node_type,
      title: node.title,
      description: node.description,
      content: node.content,
      tags: [...(node.tags ?? [])].sort(),
      status: node.status,
      extensions: node.extensions ?? {},
    })
  )
}

// 解析 --ext key=value 序列；值先尝试 JSON.parse（支持数字/布尔/对象），失败按原字符串
export function parseExtAssignments(pairs) {
  const ext = {}
  for (const pair of pairs ?? []) {
    const s = String(pair)
    const eq = s.indexOf('=')
    if (eq <= 0) {
      throw new DtpError('USAGE', `--ext 需要 key=value 格式，收到 "${s}"`)
    }
    const key = s.slice(0, eq).trim()
    if (key.includes('.')) {
      throw new DtpError('USAGE', `扩展字段名不能包含 "."（"${key}"，与 changelog 字段名冲突）`)
    }
    const rawVal = s.slice(eq + 1)
    let val
    try {
      val = JSON.parse(rawVal)
    } catch {
      val = rawVal
    }
    ext[key] = val
  }
  return ext
}
