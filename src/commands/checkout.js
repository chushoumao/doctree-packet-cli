import { DtpError } from '../errors.js'
import { shortId, color, publicNode } from '../output.js'
import { hashWarnFields } from './_shared.js'

export const command = {
  name: 'checkout',
  summary: '将节点回滚到指定版本（以新增变更的方式实现，不抹除历史）',
  args: [
    { name: 'node', required: true, desc: '节点 ID（唯一前缀）' },
    { name: 'version', required: true, desc: '目标版本号（正整数）' },
  ],
  options: {},
  example: 'dtp checkout fr001 1',
  run(ctx) {
    const version = Number.parseInt(ctx.args.version, 10)
    if (!Number.isInteger(version) || version <= 0) {
      throw new DtpError('USAGE', `版本号需为正整数，收到 "${ctx.args.version}"`)
    }
    return ctx.withLock(() => {
      const packet = ctx.load()
      const res = packet.checkoutNode(ctx.args.node, version, { user: ctx.user })
      packet.save()
      if (!res.changed) {
        ctx.out.ok({ changed: false, node: publicNode(res.node), ...hashWarnFields(packet) }, () => {
          console.log(color.dim(`节点已处于 v${res.to} 的内容状态，无变更`))
        })
        return
      }
      ctx.out.ok(
        {
          changed: true,
          node: publicNode(res.node),
          from_version: res.from,
          target_version: res.to,
          new_version: res.node.version,
          fields: res.changes.map((c) => c.field),
          ...hashWarnFields(packet),
        },
        () => {
          console.log(
            `已回滚 ${shortId(res.node.id)}「${res.node.title}」至 v${res.to} 的内容（v${res.from} → v${res.node.version}）`
          )
          if (res.changes.length) console.log(color.dim(`恢复字段: ${res.changes.map((c) => c.field).join(', ')}`))
        }
      )
    })
  },
}
