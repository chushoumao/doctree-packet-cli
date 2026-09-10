import { DtpError } from '../errors.js'
import { shortId, color, publicNode } from '../output.js'
import { confirm, hashWarnFields } from './_shared.js'

export const command = {
  name: 'rm',
  summary: '删除节点及其全部子孙节点',
  args: [{ name: 'node', required: true, desc: '节点 ID（唯一前缀）或 /语义路径' }],
  options: {
    yes: { short: 'y', desc: '跳过确认（非交互环境必须）' },
  },
  example: 'dtp rm fr001 --yes',
  async run(ctx) {
    // 先无锁读取，确认后再加锁执行，避免持锁等待用户输入
    const preview = ctx.load()
    const target = preview.resolveRef(ctx.args.node)
    const subtree = [target.id, ...preview.descendantsOf(target.id)]

    if (!ctx.opts.yes) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const names = subtree
          .slice(0, 3)
          .map((id) => preview.nodes.get(id))
          .filter(Boolean)
          .map((n) => `「${n.title}」`)
          .join(' ')
        const ok = await confirm(
          `将删除 ${names}${subtree.length > 3 ? ' 等' : ''}共 ${subtree.length} 个节点（含子孙），确认？[y/N] `
        )
        if (!ok) {
          ctx.out.ok({ cancelled: true }, () => console.log(color.dim('已取消')))
          return
        }
      } else {
        throw new DtpError('USAGE', '非交互环境下删除需要 --yes 跳过确认')
      }
    }

    return ctx.withLock(() => {
      const packet = ctx.load()
      const { removed } = packet.removeNode(ctx.args.node, { user: ctx.user })
      packet.save()
      ctx.out.ok({ removed: removed.map((id) => id), count: removed.length, ...hashWarnFields(packet) }, () => {
        console.log(`已删除 ${removed.length} 个节点（根: ${shortId(target.id)}「${target.title}」）`)
      })
    })
  },
}
