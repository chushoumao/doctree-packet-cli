import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DtpError } from '../errors.js'
import { initPacketLines } from '../packet.js'
import { withLock, backupPacketFile, writeJsonlFresh } from '../storage.js'
import { parseExtAssignments, validateNodeId, validateTitle } from '../model/node.js'
import { shortId, color } from '../output.js'

export const command = {
  name: 'init',
  summary: '创建新数据包（生成根节点）',
  args: [{ name: 'name', required: true, desc: '数据包名称（同时作为根节点标题）' }],
  options: {
    version: { arg: 'ver', default: 'v1.0.0', desc: '语义化版本号' },
    id: { arg: 'id', desc: '根节点自定义 ID（默认生成 UUID）' },
    meta: { arg: 'k=v', multi: true, desc: '包级元数据，可多次传入' },
    force: { short: 'f', desc: '覆盖已存在的文件（原文件先备份）' },
  },
  example: 'dtp init "智能客服系统" --packet ./客服系统.dtp',
  run(ctx) {
    const file = ctx.packetPath
    // 包名同时是根节点标题：与 add/update 走同一规范化（trim、拒绝空白）
    if (typeof ctx.args.name !== 'string' || ctx.args.name.trim().length === 0) {
      throw new DtpError('USAGE', '包名不能为空（名称同时作为根节点标题）')
    }
    const name = validateTitle(ctx.args.name)
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    const exists = fs.existsSync(file)
    if (exists && !ctx.opts.force) {
      throw new DtpError('EXISTS', `文件已存在：${file}（确需重建请加 --force）`)
    }
    if (ctx.opts.id) validateNodeId(ctx.opts.id)
    const { lines, meta, root } = withLock(file, () => {
      const r = initPacketLines({
        name,
        packetId: 'pkt-' + randomUUID(),
        version: ctx.opts.version,
        rootId: ctx.opts.id ?? randomUUID(),
        metadata: parseExtAssignments(ctx.opts.meta),
        user: ctx.user,
      })
      if (exists) backupPacketFile(file)
      writeJsonlFresh(file, r.lines)
      return r
    })
    ctx.out.ok(
      {
        packet_id: meta.packet_id,
        name: meta.name,
        version: meta.version,
        root_node_id: root.id,
        file,
        nodes: 1,
      },
      () => {
        console.log(`已创建数据包「${meta.name}」(${color.dim(meta.version)}) → ${file}`)
        console.log(`根节点: ${shortId(root.id)}「${root.title}」`)
      }
    )
  },
}
