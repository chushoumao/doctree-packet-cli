import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { DtpError } from '../errors.js'
import { initPacketLines } from '../packet.js'
import { withLock, backupPacketFile, writeJsonlFresh } from '../storage.js'
import { parseExtAssignments, validateNodeId, validateTitle } from '../model/node.js'
import { parseSchema, checkSchema, skeletonLines, relativeSchemaFile } from '../template.js'
import { shortId, color } from '../output.js'

export const command = {
  name: 'init',
  summary: '创建新数据包（生成根节点）',
  args: [{ name: 'name', required: true, desc: '数据包名称（同时作为根节点标题）' }],
  options: {
    version: { arg: 'ver', default: 'v1.0.0', desc: '语义化版本号' },
    id: { arg: 'id', desc: '根节点自定义 ID（默认生成 UUID）' },
    meta: { arg: 'k=v', multi: true, desc: '包级元数据，可多次传入' },
    template: { arg: 'path', desc: '按模版 schema 派生骨架包（容器节点随包建立并绑定 metadata.template）' },
    force: { short: 'f', desc: '覆盖已存在的文件（原文件先备份）' },
  },
  example: [
    'dtp init "智能客服系统" --packet ./客服系统.dtp',
    'dtp init "周报包" --packet ./周报.dtp --template ./weekly.schema.json',
  ],
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

    // --template：先自检后建包；坏 schema 拒绝并指引用户先 template check
    let schema = null
    let templateMeta = null
    if (ctx.opts.template !== undefined) {
      const tFile = ctx.opts.template
      if (!fs.existsSync(tFile)) {
        throw new DtpError('USAGE', `schema 文件不存在：${tFile}（先用 dtp template new <name> 生成）`)
      }
      const text = fs.readFileSync(tFile, 'utf8')
      const problems = checkSchema(text)
      if (problems.length) {
        throw new DtpError('SCHEMA_INVALID', `schema 未通过自检（${problems.length} 处），拒绝建包。首条：${problems[0]}（先运行 dtp template check ${tFile}）`)
      }
      schema = parseSchema(text)
      const sha256 = createHash('sha256').update(fs.readFileSync(tFile)).digest('hex')
      // 与 bind 同一形状；file 相对包文件目录（包尚不存在，relativeSchemaFile 自动回退真实化父目录）
      templateMeta = {
        name: schema.name,
        version: schema.version,
        schema_sha256: sha256,
        file: relativeSchemaFile(file, tFile),
      }
      // 根 id 与容器 id 冲突在建包前拒绝（skeletonLines 内也有同道校验兜底）
      if (ctx.opts.id && schema.skeleton.some((c) => c.id === ctx.opts.id)) {
        throw new DtpError('USAGE', `--id "${ctx.opts.id}" 与模版容器 id 冲突（容器：${schema.skeleton.map((c) => c.id).join(', ')}）`)
      }
    }

    const { lines, meta, root } = withLock(file, () => {
      const metadata = { ...parseExtAssignments(ctx.opts.meta) }
      if (templateMeta) metadata.template = { ...templateMeta } // 自动绑定优先于同名 --meta
      const r = schema
        ? skeletonLines(schema, {
            name,
            packetId: 'pkt-' + randomUUID(),
            version: ctx.opts.version,
            rootId: ctx.opts.id ?? randomUUID(),
            metadata,
            user: ctx.user,
          })
        : initPacketLines({
            name,
            packetId: 'pkt-' + randomUUID(),
            version: ctx.opts.version,
            rootId: ctx.opts.id ?? randomUUID(),
            metadata,
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
        nodes: schema ? 1 + schema.skeleton.length : 1,
        ...(templateMeta ? { template: templateMeta } : {}),
      },
      () => {
        console.log(`已创建数据包「${meta.name}」(${color.dim(meta.version)}) → ${file}`)
        if (schema) {
          console.log(`模版派生：${templateMeta.name} v${templateMeta.version} · ${schema.skeleton.length} 个容器（无示例业务节点）`)
        }
        console.log(`根节点: ${shortId(root.id)}「${root.title}」`)
      }
    )
  },
}
