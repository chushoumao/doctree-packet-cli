import { DtpError } from '../errors.js'
import { parseExtAssignments } from '../model/node.js'
import { hashWarnFields } from './_shared.js'
import { shortId, color, TYPE_COLOR, STATUS_COLOR, publicNode } from '../output.js'

export const command = {
  name: 'add',
  summary: '添加子节点',
  args: [{ name: 'parent', required: true, desc: '父节点 ID（支持唯一前缀）或 /语义路径' }],
  options: {
    title: { arg: 'text', desc: '节点标题（必填）' },
    type: { arg: 'type', default: 'document', desc: 'folder | document | requirement | knowledge | index' },
    description: { arg: 'text', desc: '描述' },
    content: { arg: 'text', desc: 'Markdown 正文' },
    tags: { arg: 'tags', multi: true, desc: '标签，逗号分隔或多次传入' },
    status: { arg: 'status', default: 'draft', desc: 'draft | review | approved | archived' },
    ext: { arg: 'k=v', multi: true, desc: '扩展字段，值支持 JSON 字面量，可多次传入' },
    id: { arg: 'id', desc: '自定义节点 ID（默认生成 UUID）' },
  },
  example: [
    'dtp add n_root --title "FR-001 用户认证" --type requirement --tags auth,P0',
    'dtp add fr001 --title "登录验证" --description "支持账号密码及验证码登录"',
  ],
  run(ctx) {
    if (!ctx.opts.title) throw new DtpError('USAGE', 'add 需要 --title <标题>')
    return ctx.withLock(() => {
      const packet = ctx.load()
      const node = packet.addNode({
        parentRef: ctx.args.parent,
        id: ctx.opts.id,
        nodeType: ctx.opts.type,
        title: ctx.opts.title,
        description: ctx.opts.description ?? '',
        content: ctx.opts.content ?? '',
        tags: ctx.opts.tags ?? [],
        status: ctx.opts.status,
        extensions: parseExtAssignments(ctx.opts.ext),
        user: ctx.user,
      })
      packet.save()
      const nodePath = packet.pathOf(node.id)
      ctx.out.ok({ node: publicNode(node), path: nodePath, ...hashWarnFields(packet) }, () => {
        console.log(
          `已添加 ${shortId(node.id)}「${node.title}」 ` +
            `${TYPE_COLOR[node.node_type]?.(node.node_type) ?? node.node_type}` +
            `·${STATUS_COLOR[node.status]?.(node.status) ?? node.status} v1`
        )
        console.log(color.dim(`路径: ${nodePath}`))
      })
    })
  },
}
