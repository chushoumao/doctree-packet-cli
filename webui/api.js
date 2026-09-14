// dtp Web UI — API 层
// 直接复用仓库 src/ 引擎（Packet / withLock / filterNodes / export / verify / history），
// 响应形状遵循 CLI 的 --json 契约：{ok:true,...} / {ok:false,error:{code,message}}。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'

import { Packet, initPacketLines } from '../src/packet.js'
import { withLock, writeJsonlFresh } from '../src/storage.js'
import { filterNodes } from '../src/query.js'
import { toMarkdown, toHtml } from '../src/export.js'
import { publicNode } from '../src/output.js'
import {
  normalizeNodeType,
  normalizeStatus,
  normalizeTags,
} from '../src/model/node.js'
import { DtpError, asDtpError } from '../src/errors.js'
import { parseSchema, checkSchema, skeletonLines, relativeSchemaFile } from '../src/template.js'
import { command as verifyCommand } from '../src/commands/verify.js'
import { command as historyCommand } from '../src/commands/history.js'
import { command as templateCommand } from '../src/commands/template.js'
import { command as lintCommand } from '../src/commands/lint.js'

// 工作区注入式（US-003 接线）：模块级 const 会在 import 时固化，无法支撑 dtp web
// 每次启动指向不同工作区；由 server 启动时 configureWorkspace 注入
let WORKSPACE = null

export function configureWorkspace(dir) {
  WORKSPACE = path.resolve(String(dir))
  return WORKSPACE
}

// 未注入就用到包操作 = 调用方漏了启动流程，fail loud 优于静默工作在错误目录
function ws() {
  if (!WORKSPACE) throw new DtpError('USAGE', '工作区未配置（应由 server 启动时注入）')
  return WORKSPACE
}

// 文件名限定在 ASCII 词符 + CJK + .-_ 空间内（天然排除路径分隔符与盘符），杜绝目录穿越
const PACKET_RE = /^[\w\u4e00-\u9fff][\w\u4e00-\u9fff.\- ]*\.dtp$/i

// schema 文件以工作区相对路径标识（根目录或 templates/ 子目录），同样限定字符集排除穿越
const SCHEMA_RE = /^[\w\u4e00-\u9fff][\w\u4e00-\u9fff.\- ]*(?:\/[\w\u4e00-\u9fff][\w\u4e00-\u9fff.\- ]*)*\.schema\.json$/i
const SCHEMA_DIR = 'templates'

// ---------- 工具 ----------

function requireString(v, name) {
  if (typeof v !== 'string' || !v.trim()) throw new DtpError('USAGE', `参数 ${name} 不能为空`)
  return v
}

// 扩展字段校验：与 parseExtAssignments 同规则（键不含 "."），API 侧直接收对象
function extObject(ext) {
  if (ext == null) return {}
  if (typeof ext !== 'object' || Array.isArray(ext)) {
    throw new DtpError('USAGE', 'ext 需要是对象 {key: value}')
  }
  const out = {}
  for (const [k, v] of Object.entries(ext)) {
    const key = String(k).trim()
    if (!key) throw new DtpError('USAGE', '扩展字段名不能为空')
    if (key.includes('.')) {
      throw new DtpError('USAGE', `扩展字段名不能包含 "."（"${key}"，与 changelog 字段名冲突）`)
    }
    out[key] = v
  }
  return out
}

// 数据包文件名 → 工作区内绝对路径（拒绝越界）
function resolvePacketFile(p) {
  const name = requireString(p, 'packet')
  if (!PACKET_RE.test(name)) {
    throw new DtpError('USAGE', `数据包文件名不合法（应为 *.dtp）：${name}`)
  }
  const full = path.join(ws(), name)
  if (!full.startsWith(ws() + path.sep)) throw new DtpError('USAGE', '非法路径')
  return full
}

// schema 相对路径（工作区内）→ 绝对路径（拒绝越界）
function resolveSchemaRef(p) {
  const rel = String(requireString(p, 'template')).replaceAll('\\', '/')
  if (!SCHEMA_RE.test(rel)) {
    throw new DtpError('USAGE', `schema 文件名不合法（应为工作区内 *.schema.json 相对路径）：${rel}`)
  }
  const full = path.join(ws(), rel)
  if (!full.startsWith(ws() + path.sep)) throw new DtpError('USAGE', '非法路径')
  return full
}

const toWorkspaceRel = (full) => path.relative(ws(), full).replaceAll('\\', '/')

// 读路径缓存：同一 (mtimeMs, size) 的文件直接复用已解析的 Packet，
// 树/详情/历史/统计/列表等高频读不再整文件重解析。append-only 模型下任何写入
// （CLI 或本 UI）必然追加行、改变 size，缓存不会返回陈旧快照；写路径（mutate）在
// 锁内直读文件、不经此缓存。
const packetCache = new Map() // 绝对路径 -> { mtimeMs, size, packet }
const PACKET_CACHE_MAX = 24

function loadPacketCached(file) {
  const stat = fs.statSync(file)
  const hit = packetCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.packet
  const packet = Packet.load(file)
  if (packetCache.size >= PACKET_CACHE_MAX) packetCache.delete(packetCache.keys().next().value)
  packetCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, packet })
  return packet
}

function loadPacket(p) {
  const file = resolvePacketFile(p)
  if (!fs.existsSync(file)) throw new DtpError('NO_PACKET', `数据包不存在：${file}`)
  return loadPacketCached(file)
}

function publicNodeWith(packet, n, extra = {}) {
  return { ...publicNode(n), path: packet.pathOf(n.id), ...extra }
}

// CLI verify 命令以桩 ctx 复用（9 项检查逻辑不再复制）；run 可能置 exitCode，用后复位
function runVerify(file) {
  let captured = null
  const prev = process.exitCode
  verifyCommand.run({ packetPath: file, out: { ok(obj) { captured = obj } } })
  process.exitCode = prev ?? 0
  return captured
}

// CLI history 命令同样以桩复用（版本快照 ↔ changelog 关联逻辑复杂，保持单一事实源）
function runHistory(file, ref) {
  const packet = loadPacketCached(file)
  packet.resolveIdAny(requireString(ref, 'ref'))
  let captured = null
  historyCommand.run({
    load: () => packet,
    args: { node: ref },
    opts: {},
    out: { ok(obj) { captured = obj } },
  })
  return captured
}

// CLI lint 命令以桩复用（schema 发现/漂移二分/evaluate 全在命令内，含 TEMPLATE_MISSING
// /SCHEMA_INVALID/SCHEMA_DRIFT 快速失败）；有 error 级违规时命令会置 exitCode，用后复位
function runLint(file, schemaAbs) {
  let captured = null
  const prev = process.exitCode
  lintCommand.run({
    packetPath: file,
    opts: schemaAbs ? { schema: schemaAbs } : {},
    load: () => Packet.load(file),
    out: { ok(obj) { captured = obj } },
  })
  process.exitCode = prev ?? 0
  return captured
}

// 写操作统一走「锁内加载 → 内存变更 → save 落盘」，与 CLI 单写多读模型一致
function mutate(p, fn) {
  const file = resolvePacketFile(p)
  return withLock(file, () => {
    const packet = Packet.load(file)
    const warnings = packet.hashMismatches()
    const result = fn(packet)
    const appended = packet.save()
    return { appended, warnings, ...result }
  })
}

// ---------- 读接口 ----------

function listPackets() {
  fs.mkdirSync(ws(), { recursive: true })
  const files = fs
    .readdirSync(ws(), { withFileTypes: true })
    .filter((d) => d.isFile() && PACKET_RE.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b))
  const packets = files.map((name) => {
    const full = path.join(ws(), name)
    const stat = fs.statSync(full)
    try {
      const packet = loadPacketCached(full)
      const boundTpl = packet.meta.metadata?.template ?? null
      return {
        file: name,
        name: packet.meta.name,
        version: packet.meta.version,
        packet_id: packet.meta.packet_id,
        nodes: packet.nodes.size,
        deleted: packet.tombstones.size,
        versions: [...packet.versions.values()].reduce((s, v) => s + v.length, 0),
        changelog: packet.changelog.length,
        structural_errors: packet.structuralErrors.length,
        warnings: packet.warnings.length,
        size: stat.size,
        updated_at: packet.meta.updated_at,
        mtime: stat.mtime.toISOString(),
        template: boundTpl ? { name: boundTpl.name, version: boundTpl.version } : null,
      }
    } catch (e) {
      const err = asDtpError(e)
      return { file: name, error: err.message, code: err.code, size: stat.size, mtime: stat.mtime.toISOString() }
    }
  })
  return { packets, workspace: ws() }
}

function tree(p) {
  const packet = loadPacket(p)
  const nodes = []
  for (const n of packet.nodes.values()) {
    nodes.push(publicNodeWith(packet, n, { child_count: packet.childrenOf(n.id).length }))
  }
  nodes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const children = {}
  for (const [id, list] of packet.children) children[id] = list.map((c) => c.id)
  return {
    meta: packet.meta,
    root_id: packet.meta.root_node_id,
    nodes,
    children,
    warnings: packet.warnings,
    structural_errors: packet.structuralErrors,
    tags: [...packet.tagIndex.keys()].sort(),
    tombstones: [...packet.tombstones],
  }
}

function nodeDetail(p, ref) {
  const packet = loadPacket(p)
  const node = packet.resolveRef(requireString(ref, 'ref'))
  const parent = node.parent_id != null ? packet.nodes.get(node.parent_id) : null
  const breadcrumb = []
  let cur = node
  while (cur) {
    breadcrumb.unshift({ id: cur.id, title: cur.title })
    cur = cur.parent_id != null ? packet.nodes.get(cur.parent_id) : null
  }
  return {
    node: publicNodeWith(packet, node),
    parent: parent ? publicNodeWith(packet, parent) : null,
    breadcrumb,
    children: packet.childrenOf(node.id).map((c) => publicNodeWith(packet, c, { child_count: packet.childrenOf(c.id).length })),
    descendants: packet.descendantsOf(node.id).length,
  }
}

function history(p, ref) {
  const file = resolvePacketFile(p)
  if (!fs.existsSync(file)) throw new DtpError('NO_PACKET', `数据包不存在：${file}`)
  return runHistory(file, requireString(ref, 'ref'))
}

function query(p, q) {
  const packet = loadPacket(p)
  // 单值逗号串（URLSearchParams 拼接形态）与多值等价：都拆开按「或」处理
  const list = (v) =>
    []
      .concat(v ?? [])
      .flatMap((item) => String(item).split(','))
      .map((s) => s.trim())
      .filter(Boolean)
  const ext = list(q.ext).map((pair) => {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new DtpError('USAGE', `ext 过滤需要 key=value 格式，收到 "${pair}"`)
    const key = pair.slice(0, eq)
    const raw = pair.slice(eq + 1)
    let value = raw
    try {
      value = JSON.parse(raw)
    } catch { /* 原字符串比较 */ }
    return { key, value }
  })
  const nodes = filterNodes(packet, {
    tags: list(q.tag),
    types: list(q.type),
    statuses: list(q.status),
    ext,
    keyword: q.keyword ? String(q.keyword) : undefined,
    pathPrefix: q.pathPrefix ? String(q.pathPrefix) : undefined,
  })
  const limit = q.limit ? Number(q.limit) : undefined
  const shown = limit && limit > 0 ? nodes.slice(0, limit) : nodes
  return { nodes: shown.map((n) => publicNodeWith(packet, n)), count: shown.length, total: nodes.length }
}

function stats(p) {
  const packet = loadPacket(p)
  const nodes = [...packet.nodes.values()]
  const by = (key) => {
    const m = {}
    for (const n of nodes) m[n[key]] = (m[n[key]] ?? 0) + 1
    return m
  }
  const tagCounts = new Map()
  for (const n of nodes) for (const t of n.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  const byDay = {}
  for (const e of packet.changelog) {
    const day = String(e.timestamp ?? '').slice(0, 10)
    if (day) byDay[day] = (byDay[day] ?? 0) + 1
  }
  const titleOf = (id) => {
    const list = packet.versions.get(id)
    return list?.length ? list[list.length - 1].title : null
  }
  const recent = [...packet.changelog]
    .slice(-12)
    .reverse()
    .map((e) => ({
      timestamp: e.timestamp,
      user: e.user,
      field: e.field,
      node_id: e.node_id,
      node_title: titleOf(e.node_id),
      deleted: packet.tombstones.has(e.node_id),
    }))
  const users = {}
  for (const e of packet.changelog) if (e.user) users[e.user] = (users[e.user] ?? 0) + 1
  return {
    meta: packet.meta,
    nodes: nodes.length,
    deleted: packet.tombstones.size,
    versions: [...packet.versions.values()].reduce((s, v) => s + v.length, 0),
    changelog: packet.changelog.length,
    max_depth: (() => {
      let depth = 0
      const walk = (id, d) => {
        depth = Math.max(depth, d)
        for (const c of packet.childrenOf(id)) walk(c.id, d + 1)
      }
      if (packet.root()) walk(packet.root().id, 1)
      return depth
    })(),
    by_type: by('node_type'),
    by_status: by('status'),
    by_tag: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })),
    by_day: byDay,
    users,
    recent,
    warnings: packet.warnings,
    structural_errors: packet.structuralErrors,
  }
}

function verify(p) {
  const file = resolvePacketFile(p)
  if (!fs.existsSync(file)) throw new DtpError('NO_PACKET', `数据包不存在：${file}`)
  return runVerify(file)
}

function exportDocs(p, q) {
  const packet = loadPacket(p)
  const format = q.format === 'html' ? 'html' : 'md'
  const node = q.ref ? packet.resolveRef(String(q.ref)) : packet.root()
  if (!node) throw new DtpError('NOT_FOUND', '未找到导出目标')
  const content = format === 'html' ? toHtml(packet, node.id) : toMarkdown(packet, node.id)
  return { format, title: node.title, content }
}

// append-only 台账：原始 JSONL 尾部视图像（每行摘要 + 行号）
function ledger(p, q) {
  const file = resolvePacketFile(p)
  if (!fs.existsSync(file)) throw new DtpError('NO_PACKET', `数据包不存在：${file}`)
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  const total = lines.filter((l) => l.trim()).length
  const limit = Math.min(Math.max(Number(q.limit) || 150, 1), 500)
  const tail = []
  const nonEmpty = []
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) nonEmpty.push(i)
  for (const i of nonEmpty.slice(-limit).reverse()) {
    let obj = null
    try {
      obj = JSON.parse(lines[i])
    } catch { /* 残行 */ }
    const no = i + 1
    if (!obj) {
      tail.push({ no, type: 'corrupt', summary: '残缺行（写入中断）' })
      continue
    }
    switch (obj.type) {
      case 'packet_meta':
        tail.push({ no, type: 'meta', summary: `${obj.name} · ${obj.version}`, timestamp: obj.updated_at })
        break
      case 'node':
        tail.push({ no, type: 'node', id: obj.id, title: obj.title, version: obj.version, node_type: obj.node_type, timestamp: obj.updated_at })
        break
      case 'changelog':
        tail.push({ no, type: 'changelog', node_id: obj.node_id, field: obj.field, user: obj.user, timestamp: obj.timestamp, version: obj.version })
        break
      case 'node_delete':
        tail.push({ no, type: 'delete', id: obj.id, timestamp: obj.timestamp })
        break
      default:
        tail.push({ no, type: 'unknown', summary: String(obj.type ?? '?') })
    }
  }
  const stat = fs.statSync(file)
  return { total, shown: tail.length, size: stat.size, lines: tail, mtime: stat.mtime.toISOString() }
}

// ---------- 模版接口 ----------
// schema 文件存放约定：工作区根或 templates/ 子目录（与 CLI bind 记录的相对路径一致，
// 工作区可继续与 CLI 混用）。列表/读取/自检/保存在 api 层实现（checkSchema 单一事实源），
// new 与 bind 桩跑 CLI template 命令（骨架生成与锁内绑定逻辑不复制）。

function summarizeSchema(text) {
  const problems = checkSchema(text)
  let summary = null
  if (!problems.length) {
    const schema = parseSchema(text)
    summary = {
      name: schema.name,
      version: schema.version,
      skeleton: schema.skeleton.length,
      rules: schema.rules?.length ?? 0,
    }
  }
  return { problems, summary, schema_ok: problems.length === 0 }
}

function listTemplates() {
  fs.mkdirSync(ws(), { recursive: true })
  const files = []
  for (const dir of ['', SCHEMA_DIR]) {
    const abs = path.join(ws(), dir)
    if (!fs.existsSync(abs)) continue
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.isFile() && /\.schema\.json$/i.test(d.name)) files.push(dir ? `${dir}/${d.name}` : d.name)
    }
  }
  files.sort((a, b) => a.localeCompare(b))

  // 绑定索引：包 → metadata.template（file 归一为工作区相对路径；跨出工作区的引用不参与匹配）
  const packetTemplate = {}
  const boundTo = new Map()
  for (const d of fs.readdirSync(ws(), { withFileTypes: true })) {
    if (!d.isFile() || !PACKET_RE.test(d.name)) continue
    try {
      const packet = loadPacketCached(path.join(ws(), d.name))
      const t = packet.meta.metadata?.template
      if (!t) continue
      const rel = String(t.file ?? '').replaceAll('\\', '/')
      packetTemplate[d.name] = SCHEMA_RE.test(rel) ? { name: t.name, version: t.version, file: rel } : { name: t.name, version: t.version }
      if (SCHEMA_RE.test(rel)) {
        if (!boundTo.has(rel)) boundTo.set(rel, [])
        boundTo.get(rel).push(d.name)
      }
    } catch { /* 解析失败的包跳过（列表接口另行呈现错误） */ }
  }

  const templates = files.map((rel) => {
    const full = path.join(ws(), rel)
    const stat = fs.statSync(full)
    const { problems, summary, schema_ok } = summarizeSchema(fs.readFileSync(full, 'utf8'))
    return {
      file: rel,
      ...(summary ?? { name: null, version: null, skeleton: 0, rules: 0 }),
      ok: schema_ok,
      problem_count: problems.length,
      problems: problems.slice(0, 5),
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      bound_packets: boundTo.get(rel) ?? [],
    }
  })
  return { templates, packet_template: packetTemplate, workspace: ws() }
}

function readTemplate(file) {
  const full = resolveSchemaRef(file)
  if (!fs.existsSync(full)) throw new DtpError('NOT_FOUND', `schema 文件不存在：${file}`)
  const content = fs.readFileSync(full, 'utf8')
  const { problems, summary, schema_ok } = summarizeSchema(content)
  return { file: String(file), content, problems, schema_ok, ...(summary ?? {}) }
}

// 自检：优先校验请求体里的文本（保存前预检），否则读文件
function checkTemplate(body) {
  const { problems, summary, schema_ok } = summarizeSchema(
    typeof body.content === 'string' ? body.content : readTemplate(body.file).content
  )
  return { schema_ok, problems, ...(summary ?? {}) }
}

function newTemplate(body) {
  const name = requireString(body.name, 'name')
  // 生成逻辑桩跑 CLI template new（buildSchemaSkeleton + 自举校验不复制）；落点限定 templates/
  const out = path.join(WORKSPACE, SCHEMA_DIR, `${name.trim()}.schema.json`)
  fs.mkdirSync(path.join(WORKSPACE, SCHEMA_DIR), { recursive: true })
  let captured = null
  templateCommand.run({
    args: { action: 'new', target: name },
    opts: { out },
    out: { ok(obj) { captured = obj } },
  })
  return { ...(captured ?? {}), file: toWorkspaceRel(out) }
}

function saveTemplate(body) {
  const full = resolveSchemaRef(body.file)
  if (typeof body.content !== 'string') throw new DtpError('USAGE', 'content 需要是字符串')
  if (!fs.existsSync(full)) throw new DtpError('NOT_FOUND', `schema 文件不存在：${body.file}`)
  // 允许保存带问题的 schema（编辑中间态），问题随响应返回由前端呈现；bind 侧自会拒绝坏 schema
  fs.writeFileSync(full, body.content, 'utf8')
  const { problems, summary, schema_ok } = summarizeSchema(body.content)
  return { file: String(body.file), size: Buffer.byteLength(body.content), problems, schema_ok, ...(summary ?? {}) }
}

// 绑定走 CLI runBind（锁内 touchMeta append-only，sha256/相对路径换算全复用）
function bindTemplate(body) {
  const file = resolvePacketFile(requireString(body.packet, 'packet'))
  if (!fs.existsSync(file)) throw new DtpError('NO_PACKET', `数据包不存在：${file}`)
  const schemaAbs = resolveSchemaRef(requireString(body.template, 'template'))
  let captured = null
  templateCommand.run({
    args: { action: 'bind', target: schemaAbs },
    opts: {},
    packetPath: file,
    withLock: (fn) => withLock(file, fn),
    load: () => Packet.load(file),
    out: { ok(obj) { captured = obj } },
  })
  return captured ?? {}
}

function lint(p, q) {
  const file = resolvePacketFile(p)
  if (!fs.existsSync(file)) throw new DtpError('NO_PACKET', `数据包不存在：${file}`)
  return runLint(file, q.schema !== undefined ? resolveSchemaRef(q.schema) : null)
}

// ---------- 写接口 ----------

function initPacket(body) {
  const name = requireString(body.name, 'name')
  const file = body.file ?? `${name.trim()}.dtp`
  if (!PACKET_RE.test(file)) throw new DtpError('USAGE', `数据包文件名不合法（应为 *.dtp）：${file}`)
  const full = path.join(WORKSPACE, file)
  fs.mkdirSync(ws(), { recursive: true })
  if (fs.existsSync(full)) {
    if (!body.force) throw new DtpError('EXISTS', `数据包已存在：${file}（force 可覆盖）`)
    fs.rmSync(full, { force: true })
  }

  // 模版派生（对齐 dtp init --template）：坏 schema 拒绝建包；骨架容器随包建立并自动绑定
  let schema = null
  let templateMeta = null
  if (body.template !== undefined && body.template !== null && body.template !== '') {
    const schemaAbs = resolveSchemaRef(body.template)
    if (!fs.existsSync(schemaAbs)) {
      throw new DtpError('USAGE', `schema 文件不存在：${body.template}（先在模版页生成）`)
    }
    const buf = fs.readFileSync(schemaAbs)
    const problems = checkSchema(buf.toString('utf8'))
    if (problems.length) {
      throw new DtpError('SCHEMA_INVALID', `schema 未通过自检（${problems.length} 处），拒绝建包。首条：${problems[0]}`)
    }
    schema = parseSchema(buf.toString('utf8'))
    templateMeta = {
      name: schema.name,
      version: schema.version,
      schema_sha256: createHash('sha256').update(buf).digest('hex'),
      file: relativeSchemaFile(full, schemaAbs),
    }
    if (body.id && schema.skeleton.some((c) => c.id === body.id)) {
      throw new DtpError('USAGE', `自定义根 id "${body.id}" 与模版容器 id 冲突（容器：${schema.skeleton.map((c) => c.id).join(', ')}）`)
    }
  }

  const metadata = { ...(body.metadata ?? {}) }
  if (templateMeta) metadata.template = { ...templateMeta }
  const opts = {
    name: name.trim(),
    packetId: `pkt-${randomUUID()}`,
    version: body.version || 'v1.0.0',
    rootId: body.id || undefined,
    metadata,
    user: body.user ?? null,
  }
  const { lines, meta, root } = schema ? skeletonLines(schema, opts) : initPacketLines(opts)
  // 新建文件不存在锁竞争面，首写三行（meta + 根节点 + *created）直接落盘
  writeJsonlFresh(full, lines)
  return {
    file,
    meta,
    root_id: root.id,
    nodes: schema ? 1 + schema.skeleton.length : 1,
    ...(templateMeta ? { template: templateMeta } : {}),
  }
}

function addNode(body) {
  const title = requireString(body.title, 'title')
  const ext = extObject(body.ext)
  const result = mutate(body.packet, (packet) => {
    const node = packet.addNode({
      parentRef: requireString(body.parentRef, 'parentRef'),
      id: body.id || undefined,
      nodeType: body.nodeType || 'document',
      title,
      description: body.description ?? '',
      content: body.content ?? '',
      tags: normalizeTags([].concat(body.tags ?? [])),
      status: body.status || 'draft',
      extensions: ext,
      user: body.user ?? null,
    })
    return { node: publicNodeWith(packet, node) }
  })
  return { node: result.node, appended: result.appended, warnings: result.warnings }
}

function updateNode(body) {
  const ref = requireString(body.ref, 'ref')
  const patch = {}
  if (body.title !== undefined) patch.title = body.title
  if (body.description !== undefined) patch.description = body.description
  if (body.content !== undefined) patch.content = body.content
  if (body.status !== undefined) patch.status = normalizeStatus(body.status)
  if (body.tags !== undefined) patch.tags = normalizeTags([].concat(body.tags ?? []))
  if (body.ext !== undefined) {
    const ext = extObject(body.ext)
    if (Object.keys(ext).length) patch.extensions = ext
  }
  const result = mutate(body.packet, (packet) => {
    const r = packet.updateNode(ref, patch, { user: body.user ?? null, forceExt: Boolean(body.forceExt) })
    return { node: publicNodeWith(packet, r.node), changes: r.changes, changed: r.changed }
  })
  if (!result.changed) {
    return { node: result.node, changed: false, appended: 0, message: '内容无变化，未产生新版本' }
  }
  return {
    node: result.node,
    changed: true,
    changes: result.changes,
    appended: result.appended,
    warnings: result.warnings,
  }
}

function rmNode(body) {
  const result = mutate(body.packet, (packet) => {
    const r = packet.removeNode(requireString(body.ref, 'ref'), { user: body.user ?? null })
    return { removed: r.removed }
  })
  return { removed: result.removed, appended: result.appended, warnings: result.warnings }
}

function mvNode(body) {
  const result = mutate(body.packet, (packet) => {
    const r = packet.moveNode(
      requireString(body.ref, 'ref'),
      requireString(body.newParentRef, 'newParentRef'),
      { user: body.user ?? null }
    )
    return { node: publicNodeWith(packet, r.node), moved: r.moved, old_path: r.oldPath, new_path: r.newPath }
  })
  return { ...result, appended: result.appended, warnings: result.warnings }
}

function checkoutNode(body) {
  if (body.version === undefined || !Number.isInteger(Number(body.version))) {
    throw new DtpError('USAGE', 'version 需要是整数')
  }
  const result = mutate(body.packet, (packet) => {
    const r = packet.checkoutNode(requireString(body.ref, 'ref'), Number(body.version), { user: body.user ?? null })
    return { node: publicNodeWith(packet, r.node), changed: r.changed, from: r.from, to: r.to }
  })
  return { ...result, appended: result.appended, warnings: result.warnings }
}

// ---------- 分发 ----------

const routes = {
  'GET /api/packets': () => listPackets(),
  'GET /api/tree': (q) => tree(q.p),
  'GET /api/node': (q) => nodeDetail(q.p, q.ref),
  'GET /api/history': (q) => history(q.p, q.ref),
  'GET /api/query': (q) => query(q.p, q),
  'GET /api/stats': (q) => stats(q.p),
  'GET /api/verify': (q) => verify(q.p),
  'GET /api/export': (q) => exportDocs(q.p, q),
  'GET /api/ledger': (q) => ledger(q.p, q),
  'GET /api/templates': () => listTemplates(),
  'GET /api/template': (q) => readTemplate(q.file),
  'GET /api/lint': (q) => lint(q.p, q),
  'POST /api/init': (_q, body) => initPacket(body),
  'POST /api/template/new': (_q, body) => newTemplate(body),
  'POST /api/template/check': (_q, body) => checkTemplate(body),
  'POST /api/template/save': (_q, body) => saveTemplate(body),
  'POST /api/template/bind': (_q, body) => bindTemplate(body),
  'POST /api/add': (_q, body) => addNode(body),
  'POST /api/update': (_q, body) => updateNode(body),
  'POST /api/rm': (_q, body) => rmNode(body),
  'POST /api/mv': (_q, body) => mvNode(body),
  'POST /api/checkout': (_q, body) => checkoutNode(body),
}

const STATUS_BY_CODE = {
  NO_PACKET: 404,
  NOT_FOUND: 404,
  NODE_DELETED: 404,
  INTERNAL: 500,
}

export function handleApi(method, pathname, query, body) {
  const handler = routes[`${method} ${pathname}`]
  if (!handler) {
    return { status: 404, body: { ok: false, error: { code: 'NOT_FOUND', message: `未知接口：${method} ${pathname}` } } }
  }
  try {
    const data = handler(query, body ?? {})
    // 包装层 ok 恒 true（HTTP 200 = 传输成功）；命令 payload 自带的 ok（如 lint/verify 的
    // 校验结论）不得覆盖它，否则前端会把成功响应当错误抛出
    return { status: 200, body: { ...data, ok: true } }
  } catch (e) {
    const err = asDtpError(e)
    const status = STATUS_BY_CODE[err.code] ?? 400
    if (status === 500) console.error('[dtp-web]', e.stack ?? e)
    return { status, body: { ok: false, error: { code: err.code, message: err.message } } }
  }
}
