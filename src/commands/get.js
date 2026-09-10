import { publicNode } from '../output.js'
import { printNodeDetail } from './_shared.js'

export const command = {
  name: 'get',
  summary: '显示节点完整信息',
  args: [{ name: 'node', required: true, desc: '节点 ID（唯一前缀）或 /语义路径' }],
  options: {},
  example: ['dtp get fr001', 'dtp get fr001 --json'],
  run(ctx) {
    const packet = ctx.load()
    const node = packet.resolveRef(ctx.args.node)
    const changes = packet.changelog.filter((e) => e.node_id === node.id).length
    ctx.out.ok(
      { node: publicNode(node), path: packet.pathOf(node.id), changes },
      () => printNodeDetail(packet, node)
    )
  },
}
