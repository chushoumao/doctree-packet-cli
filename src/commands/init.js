import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { DtpError } from '../errors.js'
import { initPacketLines } from '../packet.js'
import { withLock, backupPacketFile, writeJsonlFresh } from '../storage.js'
import { parseExtAssignments, validateNodeId, validateTitle } from '../model/node.js'
import { parseSchema, checkSchema, skeletonLines, relativeSchemaFile } from '../template.js'
import { ensureDefault, configPathOf } from '../config.js'
import { shortId, color } from '../output.js'

// 内置模版（US-003）：--template 保留字 → 包内 docs/templates/；相对模块自身解析而非 cwd
const BUILTIN_TEMPLATES = new Map([
  ['user-stories', 'docs/templates/user-stories.schema.json'],
  ['dtp-regression', 'docs/templates/dtp-regression.schema.json'],
])
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const command = {
  name: 'init',
  summary: '创建新数据包（生成根节点）',
  args: [{ name: 'name', required: true, desc: '数据包名称（同时作为根节点标题）' }],
  options: {
    version: { arg: 'ver', default: 'v1.0.0', desc: '语义化版本号' },
    id: { arg: 'id', desc: '根节点自定义 ID（默认生成 UUID）' },
    meta: { arg: 'k=v', multi: true, desc: '包级元数据，可多次传入' },
    template: { arg: 'tpl', desc: '按模版派生骨架包：user-stories | dtp-regression 释放内置模版到包旁 templates/，或 <schema 路径>（内置名为保留字，遮蔽本地同名文件）' },
    force: { short: 'f', desc: '覆盖已存在的文件（原文件先备份）' },
  },
  example: [
    'dtp init "智能客服系统" --packet ./客服系统.dtp',
    'dtp init "周报包" --template weekly.schema.json',
    'dtp init "故事包" --template user-stories   # 内置模版，释放到 .dtp/templates/',
  ],
  run(ctx) {
    // 落点（US-003）：显式 --packet = 用户自管布局（零副作用，不建 .dtp/ 不写 config）；
    // 缺省 = 项目约定 .dtp/<名>.dtp（首建自动设 config.default）
    const explicit = ctx.explicitPacket
    const name0 = typeof ctx.args.name === 'string' ? ctx.args.name.trim() : ''
    if (!name0) {
      throw new DtpError('USAGE', '包名不能为空（名称同时作为根节点标题）')
    }
    // 名字整体须为安全文件名：只查 basename 会被名字里的 '/' 穿透（.dtp/a/b.dtp → basename b.dtp 合法）
    const SAFE_NAME_RE = /^[-\w\u4e00-\u9fff][\w\u4e00-\u9fff.\- ]*$/
    if (!explicit && !SAFE_NAME_RE.test(name0)) {
      throw new DtpError('USAGE', `包名 "${ctx.args.name}" 不能用作 .dtp/ 文件名（安全字符集：字母数字/中文/._- 与空格；或用 --packet 自定路径）`)
    }
    const name = validateTitle(ctx.args.name)
    const file = explicit ? ctx.packetPath : `.dtp/${name0}.dtp`
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    const exists = fs.existsSync(file)
    if (exists && !ctx.opts.force) {
      throw new DtpError('EXISTS', `文件已存在：${file}（确需重建请加 --force）`)
    }
    if (ctx.opts.id) validateNodeId(ctx.opts.id)

    // --template 双态（US-003）：保留字（user-stories|dtp-regression）→ 内置模版，从包内
    // docs/templates/ 解析并拷贝释放到包目录的 templates/ 下（bind 指向释放副本，用户可本地演进）；
    // 其余值按路径解析（旧用法）。先自检后建包；坏 schema 拒绝并指引用户先 template check
    let schema = null
    let templateMeta = null
    if (ctx.opts.template !== undefined) {
      const builtinRel = BUILTIN_TEMPLATES.get(ctx.opts.template)
      let schemaFile = ctx.opts.template
      let released = null
      if (builtinRel) {
        schemaFile = path.join(PKG_ROOT, builtinRel)
        if (!fs.existsSync(schemaFile)) {
          throw new DtpError('INTERNAL', `内置模版缺失：${schemaFile}（安装包不完整，请重装 doctree-packet-cli）`)
        }
      } else if (!fs.existsSync(schemaFile)) {
        throw new DtpError('USAGE', `schema 文件不存在：${schemaFile}（先用 dtp template new <name> 生成；内置模版：${[...BUILTIN_TEMPLATES.keys()].join(' | ')}）`)
      }
      const text = fs.readFileSync(schemaFile, 'utf8')
      const problems = checkSchema(text)
      if (problems.length) {
        throw new DtpError('SCHEMA_INVALID', `schema 未通过自检（${problems.length} 处），拒绝建包。首条：${problems[0]}（先运行 dtp template check ${schemaFile}）`)
      }
      schema = parseSchema(text)
      if (builtinRel) {
        // 释放拷贝：同名同内容跳过；异内容拒绝（不覆盖用户改过的模版）
        const releasedPath = path.join(path.dirname(path.resolve(file)), 'templates', path.basename(builtinRel))
        if (fs.existsSync(releasedPath)) {
          if (!fs.readFileSync(releasedPath).equals(fs.readFileSync(schemaFile))) {
            throw new DtpError('USAGE', `已存在不同的模版文件：${releasedPath}（不覆盖用户修改；删除该文件、改名，或改用 --template <路径> 指定其他 schema）`)
          }
          released = false
        } else {
          fs.mkdirSync(path.dirname(releasedPath), { recursive: true })
          fs.copyFileSync(schemaFile, releasedPath)
          released = true
        }
        schemaFile = releasedPath
      }
      const sha256 = createHash('sha256').update(fs.readFileSync(schemaFile)).digest('hex')
      // 与 bind 同一形状；file 相对包文件目录（包尚不存在，relativeSchemaFile 自动回退真实化父目录）
      templateMeta = {
        name: schema.name,
        version: schema.version,
        schema_sha256: sha256,
        file: relativeSchemaFile(file, schemaFile),
      }
      if (released !== null) templateMeta.released = released
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
    // 首建设 config.default（二建不改；config 损坏时不覆盖，仅提示）
    let configInfo = null
    if (!explicit) {
      const cfg = ensureDefault(process.cwd(), path.basename(file))
      configInfo = { file: configPathOf(process.cwd()), default: cfg.default, written: cfg.written }
    }
    ctx.out.ok(
      {
        packet_id: meta.packet_id,
        name: meta.name,
        version: meta.version,
        root_node_id: root.id,
        file,
        nodes: schema ? 1 + schema.skeleton.length : 1,
        ...(templateMeta ? { template: templateMeta } : {}),
        ...(configInfo ? { config: configInfo } : {}),
      },
      () => {
        console.log(`已创建数据包「${meta.name}」(${color.dim(meta.version)}) → ${file}`)
        if (configInfo) {
          console.log(
            configInfo.written
              ? `已设为项目默认包：${configInfo.default}（后续命令可省略 --packet；编辑 ${configInfo.file} 可更改）`
              : `项目默认包仍为 ${configInfo.default}（${'未变更'}）`
          )
        }
        if (schema) {
          console.log(`模版派生：${templateMeta.name} v${templateMeta.version} · ${schema.skeleton.length} 个容器（无示例业务节点）`)
        }
        console.log(`根节点: ${shortId(root.id)}「${root.title}」`)
      }
    )
  },
}
