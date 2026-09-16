import readline from 'node:readline/promises'
import fs from 'node:fs'
import path from 'node:path'
import { DtpError } from '../errors.js'
import { renderTable, TYPE_COLOR, STATUS_COLOR, shortId, color, publicNode, visualWidth } from '../output.js'

// ---------- 节点表格 / 详情（ls / query / get 共用） ----------

// 视觉宽度感知截断（CJK 计 2 列）：超 max 截断加 …，保证表格列宽可控
function truncateVisual(s, max) {
  if (visualWidth(s) <= max) return s
  let w = 0
  let out = ''
  for (const ch of String(s)) {
    const cw = visualWidth(ch)
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

// EXT 摘要段（US-004 OPTIM-017）：表格 TITLE 后的扩展字段速览。
// 数组 → key×N（计数不展开内容）；标量 → key=value；对象 → key={…}；键序按字母稳定。
// 无扩展字段返回空串（整列不出现摘要段）；截断上限 60 与 renderTable 的 maxCol 对齐
export function extSummary(n) {
  const ext = n.extensions ?? {}
  const keys = Object.keys(ext).sort()
  if (!keys.length) return ''
  const parts = keys.map((k) => {
    const v = ext[k]
    if (Array.isArray(v)) return `${k}×${v.length}`
    if (v !== null && typeof v === 'object') return `${k}={…}`
    return `${k}=${String(v)}`
  })
  return truncateVisual(parts.join(' '), 60)
}

export function nodeRow(packet, n, { withPath = false } = {}) {
  const row = [shortId(n.id), n.node_type, n.status, 'v' + n.version, n.title, extSummary(n)]
  if (withPath) row.push(packet.pathOf(n.id))
  return row
}

export function printNodeTable(packet, nodes, { withPath = false } = {}) {
  const headers = ['ID', 'TYPE', 'STATUS', 'VER', 'TITLE', 'EXT']
  if (withPath) headers.push('PATH')
  const lines = renderTable(headers, nodes.map((n) => nodeRow(packet, n, { withPath })))
  console.log(lines.join('\n'))
  console.log(color.dim(`${nodes.length} 个节点`))
}

export function nodesJson(packet, nodes) {
  return nodes.map((n) => ({ ...publicNode(n), path: packet.pathOf(n.id) }))
}

export function printNodeDetail(packet, node) {
  const label = (k) => color.dim(k.padEnd(4, '　') + ' ')
  console.log(label('ID') + node.id)
  console.log(label('标题') + node.title)
  console.log(
    label('属性') +
      `${TYPE_COLOR[node.node_type]?.(node.node_type) ?? node.node_type} · ${STATUS_COLOR[node.status]?.(node.status) ?? node.status} · v${node.version}`
  )
  console.log(label('路径') + packet.pathOf(node.id))
  console.log(label('时间') + `${node.created_at} 创建 · ${node.updated_at} 更新`)
  console.log(label('哈希') + color.dim(node.hash))
  console.log(label('标签') + (node.tags?.length ? node.tags.join(', ') : color.dim('（无）')))
  const ext = Object.entries(node.extensions ?? {})
  if (ext.length) {
    // OPTIM-016：数组值逐条编号分行（验收标准对照场景），标量保持同行；--json 契约不变
    const parts = ext.map(([k, v]) => {
      if (Array.isArray(v) && v.length) {
        const items = v
          .map((item, i) => `  ${String(i + 1).padStart(2)}. ${typeof item === 'string' ? item : JSON.stringify(item)}`)
          .join('\n     ')
        return `${k}:\n     ${items}`
      }
      return `${k}=${JSON.stringify(v)}`
    })
    console.log(label('扩展') + parts.join('\n     '))
  } else {
    console.log(label('扩展') + color.dim('（无）'))
  }
  if (node.description) console.log(label('描述') + node.description.replaceAll('\n', '\n     '))
  if (node.content) {
    console.log(color.dim('── 正文 ──'))
    console.log(node.content)
  }
}

export function nodeLabel(node) {
  return `${node.title} ${color.dim(`[${node.node_type}·${node.status}]`)} ${color.dim(`(${shortId(node.id)})`)}`
}

// ---------- rm 交互确认 ----------

export async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(question)
    return /^[yY](?:es)?$/.test(answer.trim())
  } finally {
    rl.close()
  }
}

// ---------- 篡改巡检透传（写命令 JSON 输出用） ----------

export function hashWarnFields(packet) {
  return packet.__hashWarnings?.length ? { warnings: packet.__hashWarnings } : {}
}

// 写路径校验 warn 透传（US-005）：与 warnings（篡改巡检）分键，避免语义混淆
export function schemaWarnFields(packet) {
  return packet.__schemaWarnings?.length ? { schema_warnings: packet.__schemaWarnings } : {}
}

// ---------- 输出文件预检（export / pack 共用） ----------

// 目录不存在时 writeFileSync 会抛原始 ENOENT（被归类 INTERNAL，对调用方无行动指引），
// 预检转成明确的 USAGE 错误
export function assertWritableOutput(file) {
  const dir = path.dirname(path.resolve(file))
  if (!fs.existsSync(dir)) {
    throw new DtpError('USAGE', `输出目录不存在：${dir}（请先创建目录）`)
  }
}
