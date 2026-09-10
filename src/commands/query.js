import { DtpError } from '../errors.js'
import { filterNodes } from '../query.js'
import { normalizeNodeType, normalizeStatus, parseExtAssignments } from '../model/node.js'
import { printNodeTable, nodesJson } from './_shared.js'
import { color } from '../output.js'

export const command = {
  name: 'query',
  summary: '多维度组合过滤查询',
  args: [],
  options: {
    tag: { arg: 'tag', multi: true, desc: '标签（同维度多个为“或”，逗号分隔或多次传入）' },
    type: { arg: 'type', multi: true, desc: '节点类型，可多个' },
    status: { arg: 'status', multi: true, desc: '状态，可多个' },
    ext: { arg: 'k=v', multi: true, desc: '扩展字段精确匹配（跨字段为“与”）' },
    keyword: { arg: 'text', desc: '全文关键字（标题+描述+正文，不区分大小写）' },
    path: { arg: 'path', desc: '语义路径前缀（从根开始）' },
    limit: { arg: 'n', desc: '最多返回条数' },
  },
  example: ['dtp query --tag P0 --status approved', 'dtp query --keyword 验证码 --type requirement'],
  run(ctx) {
    const o = ctx.opts
    const split = (items) =>
      (items ?? []).flatMap((s) => String(s).split(',').map((x) => x.trim())).filter(Boolean)

    // 显式提供但解析为空的过滤值必须拒绝：静默忽略会让查询 fail-open 返回全集
    const requireNonEmpty = (name, values) => {
      if (o[name] !== undefined && values.length === 0) {
        throw new DtpError('USAGE', `--${name} 需要非空值（收到空字符串）`)
      }
    }
    const requireNonEmptyRaw = (name) => {
      if (o[name] !== undefined && String(o[name]).trim() === '') {
        throw new DtpError('USAGE', `--${name} 需要非空值（收到空字符串）`)
      }
    }
    const tags = split(o.tag)
    const types = split(o.type)
    const statuses = split(o.status)
    requireNonEmpty('tag', tags)
    requireNonEmpty('type', types)
    requireNonEmpty('status', statuses)
    requireNonEmptyRaw('keyword')
    requireNonEmptyRaw('path')

    const criteria = {
      tags,
      types: types.map((t) => normalizeNodeType(t)),
      statuses: statuses.map((s) => normalizeStatus(s)),
      ext: Object.entries(parseExtAssignments(o.ext)).map(([key, value]) => ({ key, value })),
      keyword: o.keyword,
      pathPrefix: o.path,
    }
    const packet = ctx.load()
    // 不可解析的路径前缀永远 0 命中：与其静默空集，不如与 get-path 一致报 NOT_FOUND
    // （打错路径 / Git Bash MSYS 转换损坏时给调用方明确信号）
    if (o.path && !packet.findByPath(o.path)) {
      throw new DtpError('NOT_FOUND', `路径不存在：${o.path}`)
    }
    let list = filterNodes(packet, criteria)
    const total = list.length
    if (o.limit !== undefined) {
      // 严格匹配非负整数：parseInt 会把 1.5/2abc/1e2/0x10 静默截断为 1/2/1/0
      const raw = String(o.limit).trim()
      if (!/^\d+$/.test(raw)) {
        throw new DtpError('USAGE', `--limit 需要是非负整数，收到 "${o.limit}"`)
      }
      list = list.slice(0, Number(raw))
    }
    ctx.out.ok(
      { nodes: nodesJson(packet, list), count: list.length, total },
      () => {
        printNodeTable(packet, list, { withPath: true })
        if (list.length < total) {
          console.log(color.dim(`共 ${total} 个节点（--limit 截断，已省略 ${total - list.length} 个）`))
        }
      }
    )
  },
}
