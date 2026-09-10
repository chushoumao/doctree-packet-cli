import { DtpError } from '../errors.js'
import { publicNode } from '../output.js'
import { printNodeDetail } from './_shared.js'

export const command = {
  name: 'get-path',
  summary: '通过语义路径获取节点',
  args: [{ name: 'path', required: true, desc: '语义路径，如 "/智能客服系统/FR-001 用户认证/登录验证"' }],
  options: {},
  example: 'dtp get-path "/智能客服系统/FR-001 用户认证/登录验证"',
  run(ctx) {
    // 纯空白路径归一化后为根键 '/'，直接查会以误导性的 NOT_FOUND（原样回显不可见空白）收场；
    // 与 resolveRef 空引用先例（USAGE「节点引用为空」）对齐（ISSUE-018）
    if (!String(ctx.args.path ?? '').trim()) {
      throw new DtpError('USAGE', '路径为空')
    }
    const packet = ctx.load()
    const id = packet.findByPath(ctx.args.path)
    if (!id) throw new DtpError('NOT_FOUND', `路径不存在：${ctx.args.path}`)
    const node = packet.nodes.get(id)
    const changes = packet.changelog.filter((e) => e.node_id === id).length
    ctx.out.ok(
      { node: publicNode(node), path: packet.pathOf(id), changes },
      () => printNodeDetail(packet, node)
    )
  },
}
