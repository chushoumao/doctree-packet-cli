import { parseExtAssignments, normalizeTags } from '../model/node.js'
import { hashWarnFields } from './_shared.js'
import { shortId, color, publicNode } from '../output.js'

export const command = {
  name: 'update',
  summary: '更新节点字段（自动递增版本并记录 changelog）',
  args: [{ name: 'node', required: true, desc: '节点 ID（唯一前缀）或 /语义路径' }],
  options: {
    title: { arg: 'text', desc: '新标题' },
    description: { arg: 'text', desc: '新描述' },
    content: { arg: 'text', desc: '新正文' },
    status: { arg: 'status', desc: 'draft | review | approved | archived' },
    tags: { arg: 'tags', multi: true, desc: '整体替换全部标签；或 +标签 增量添加 / -标签 增量移除（逗号分隔或多次传入）' },
    ext: { arg: 'k=v', multi: true, desc: '扩展字段（append-only：默认只允许新增键）' },
    force: { short: 'f', desc: '允许覆盖已存在的扩展字段键' },
  },
  example: [
    'dtp update fr001 --content "新内容..." --ext priority=P0 --ext owner=张三',
    'dtp update fr001 --status approved --tags auth,P0,密码',
  ],
  run(ctx) {
    const patch = {}
    for (const key of ['title', 'description', 'content', 'status']) {
      if (ctx.opts[key] !== undefined) patch[key] = ctx.opts[key]
    }
    if (ctx.opts.tags !== undefined) patch.tags = ctx.opts.tags
    const ext = parseExtAssignments(ctx.opts.ext)
    if (Object.keys(ext).length) patch.extensions = ext

    return ctx.withLock(() => {
      const packet = ctx.load()
      if (ctx.opts.tags !== undefined && Array.isArray(ctx.opts.tags)) {
        const marks = ctx.opts.tags.filter((t) => /^[+-]/.test(String(t).trimStart()))
        if (marks.length) {
          const cur = new Set(packet.resolveRef(ctx.args.node).tags ?? [])
          for (const t of ctx.opts.tags) {
            const s = String(t).trimStart()
            if (!s) continue
            const op = s[0]
            const v = normalizeTags([s.slice(1)])
            if (op === '-') v.forEach((x) => cur.delete(x))
            else v.forEach((x) => cur.add(x))
          }
          patch.tags = [...cur]
        }
      }
      const { node, changes, changed } = packet.updateNode(ctx.args.node, patch, {
        user: ctx.user,
        forceExt: Boolean(ctx.opts.force),
      })
      packet.save()
      const nodePath = packet.pathOf(node.id)
      if (!changed) {
        ctx.out.ok({ changed: false, node: publicNode(node), path: nodePath, ...hashWarnFields(packet) }, () => {
          console.log(color.dim('无变更（所有字段与当前值一致）'))
        })
        return
      }
      ctx.out.ok(
        {
          changed: true,
          node: publicNode(node),
          fields: changes.map((c) => c.field),
          ...hashWarnFields(packet),
          path: nodePath,
        },
        () => {
          console.log(`已更新 ${shortId(node.id)}「${node.title}」 → v${node.version}`)
          console.log(color.dim(`变更字段: ${changes.map((c) => c.field).join(', ')}`))
        }
      )
    })
  },
}
