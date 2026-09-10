import { DtpError } from '../errors.js'
import { color } from '../output.js'
import { printNodeTable, nodesJson } from './_shared.js'

export const command = {
  name: 'ls',
  summary: '列出节点（默认根的直接子节点）',
  args: [{ name: 'path', desc: '节点 ID（唯一前缀）或 /语义路径，默认根节点' }],
  options: {
    recursive: { short: 'r', desc: '递归列出整个子树' },
    limit: { arg: 'n', desc: '最多列出前 n 条' },
  },
  example: ['dtp ls', 'dtp ls "/智能客服系统/FR-001 用户认证"', 'dtp ls --limit 10'],
  run(ctx) {
    const packet = ctx.load()
    const node = ctx.args.path ? packet.resolveRef(ctx.args.path) : packet.root()
    const all = ctx.opts.recursive
      ? [node, ...collect(packet, node.id)]
      : packet.childrenOf(node.id)
    let list = all
    if (ctx.opts.limit !== undefined) {
      // 与 history/query --limit 一致：严格非负整数，parseInt 会把 1.5/2abc 静默截断
      const raw = String(ctx.opts.limit).trim()
      if (!/^\d+$/.test(raw)) {
        throw new DtpError('USAGE', `--limit 需要是非负整数，收到 "${ctx.opts.limit}"`)
      }
      list = all.slice(0, Number(raw))
    }
    ctx.out.ok(
      { nodes: nodesJson(packet, list), count: list.length, total: all.length, parent: node.id },
      () => {
        printNodeTable(packet, list, { withPath: Boolean(ctx.opts.recursive) })
        if (list.length < all.length) {
          console.log(color.dim(`共 ${all.length} 个节点（--limit 截断，已省略 ${all.length - list.length} 个）`))
        }
      }
    )
  },
}

function collect(packet, id) {
  const out = []
  const queue = [...packet.childrenOf(id)]
  while (queue.length) {
    const n = queue.shift()
    out.push(n)
    queue.push(...packet.childrenOf(n.id))
  }
  return out
}
