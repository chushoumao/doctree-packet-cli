import { hashWarnFields } from './_shared.js'
import { color, publicNode } from '../output.js'

export const command = {
  name: 'mv',
  summary: '移动节点到新的父节点（路径索引自动更新）',
  args: [
    { name: 'node', required: true, desc: '节点 ID（唯一前缀）或 /语义路径' },
    { name: 'newParent', required: true, desc: '新父节点 ID（唯一前缀）或 /语义路径' },
  ],
  options: {},
  example: 'dtp mv fr001 n_archived',
  run(ctx) {
    return ctx.withLock(() => {
      const packet = ctx.load()
      const res = packet.moveNode(ctx.args.node, ctx.args.newParent, { user: ctx.user })
      packet.save()
      if (!res.moved) {
        ctx.out.ok({ moved: false, path: res.newPath, ...hashWarnFields(packet) }, () => {
          console.log(color.dim(`节点已是该父节点的子节点，未变更（${res.newPath}）`))
        })
        return
      }
      ctx.out.ok(
        { moved: true, node: publicNode(res.node), old_path: res.oldPath, new_path: res.newPath, ...hashWarnFields(packet) },
        () => {
          console.log(`已移动「${res.node.title}」`)
          console.log(color.dim(`${res.oldPath} → ${res.newPath}`))
        }
      )
    })
  },
}
