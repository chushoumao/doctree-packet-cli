import { printNodeTable, nodesJson } from './_shared.js'

export const command = {
  name: 'ls',
  summary: '列出节点（默认根的直接子节点）',
  args: [{ name: 'path', desc: '节点 ID（唯一前缀）或 /语义路径，默认根节点' }],
  options: {
    recursive: { short: 'r', desc: '递归列出整个子树' },
  },
  example: ['dtp ls', 'dtp ls "/智能客服系统/FR-001 用户认证"'],
  run(ctx) {
    const packet = ctx.load()
    const node = ctx.args.path ? packet.resolveRef(ctx.args.path) : packet.root()
    const list = ctx.opts.recursive
      ? [node, ...collect(packet, node.id)]
      : packet.childrenOf(node.id)
    ctx.out.ok(
      { nodes: nodesJson(packet, list), count: list.length, parent: node.id },
      () => printNodeTable(packet, list, { withPath: Boolean(ctx.opts.recursive) })
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
