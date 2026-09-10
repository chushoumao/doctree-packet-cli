import { DtpError } from '../errors.js'
import { color, shortId } from '../output.js'
import { nodeLabel } from './_shared.js'

export const command = {
  name: 'tree',
  summary: '以树形打印整个子树',
  args: [{ name: 'node', desc: '节点 ID（唯一前缀）或 /语义路径，默认根节点' }],
  options: {
    depth: { arg: 'n', desc: '最大显示深度（默认不限）' },
  },
  example: ['dtp tree', 'dtp tree fr001'],
  run(ctx) {
    const packet = ctx.load()
    const root = ctx.args.node ? packet.resolveRef(ctx.args.node) : packet.root()
    let maxDepth = Infinity
    if (ctx.opts.depth !== undefined) {
      maxDepth = Number.parseInt(ctx.opts.depth, 10)
      if (!Number.isInteger(maxDepth) || maxDepth < 0) {
        throw new DtpError('USAGE', `--depth 需要是非负整数，收到 "${ctx.opts.depth}"`)
      }
    }

    const lines = []
    const walk = (id, prefix, depth, connector) => {
      const node = packet.nodes.get(id)
      if (!node) return
      lines.push(prefix + connector + nodeLabel(node))
      const kids = packet.childrenOf(id)
      if (depth >= maxDepth) {
        if (kids.length) lines.push(prefix + (connector === '└── ' ? '    ' : connector === '' ? '' : '│   ') + color.dim('…'))
        return
      }
      kids.forEach((k, i) => {
        const last = i === kids.length - 1
        const childPrefix = depth === 0 ? '' : prefix + (connector === '└── ' ? '    ' : '│   ')
        walk(k.id, childPrefix, depth + 1, last ? '└── ' : '├── ')
      })
    }
    walk(root.id, '', 0, '')

    const treeJson = (id, depth) => {
      const n = packet.nodes.get(id)
      const kids = depth >= maxDepth ? [] : packet.childrenOf(id).map((k) => treeJson(k.id, depth + 1))
      return { id: n.id, title: n.title, node_type: n.node_type, status: n.status, version: n.version, children: kids }
    }

    ctx.out.ok({ root: treeJson(root.id, 0), count: packet.nodes.size }, () => {
      console.log(lines.join('\n'))
      console.log(color.dim(`\n${packet.nodes.size} 个节点 · 根 ${shortId(root.id)}`))
    })
  },
}
