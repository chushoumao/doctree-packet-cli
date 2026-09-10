import { canonicalJson } from './hash.js'
import { normalizePathString } from './path.js'

// 组合过滤：同一维度多个取值为 OR（任一命中），跨维度为 AND
// 支持维度：tags / types / statuses / ext（key=value 深比较）/ keyword（标题+描述+正文）/ path（全路径前缀）
export function filterNodes(packet, criteria = {}) {
  let list = [...packet.nodes.values()]
  const { tags = [], types = [], statuses = [], ext = [], keyword, pathPrefix } = criteria

  if (types.length) list = list.filter((n) => types.includes(n.node_type))
  if (statuses.length) list = list.filter((n) => statuses.includes(n.status))
  if (tags.length) list = list.filter((n) => tags.some((t) => (n.tags ?? []).includes(t)))
  if (ext.length) {
    list = list.filter((n) => {
      const e = n.extensions ?? {}
      return ext.every(({ key, value }) => key in e && canonicalJson(e[key]) === canonicalJson(value))
    })
  }
  if (keyword) {
    const kw = String(keyword).toLowerCase()
    list = list.filter((n) =>
      [n.title, n.description, n.content].some((s) => String(s ?? '').toLowerCase().includes(kw))
    )
  }
  if (pathPrefix) {
    const pfx = normalizePathString(pathPrefix)
    list = list.filter((n) => {
      const p = packet.pathOf(n.id)
      return p === pfx || p.startsWith(pfx + '/')
    })
  }
  // 码点序保证跨 locale 稳定（localeCompare 对 CJK 结果随环境变化）
  list.sort((a, b) => {
    const pa = packet.pathOf(a.id)
    const pb = packet.pathOf(b.id)
    if (pa !== pb) return pa < pb ? -1 : 1
    return a.id < b.id ? -1 : 1
  })
  return list
}
