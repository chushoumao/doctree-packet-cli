import { randomUUID } from 'node:crypto'
import { DtpError } from './errors.js'
import { parsePacket, appendJsonl, backupPacketFile } from './storage.js'
import {
  computeNodeHash,
  normalizeNodeType,
  normalizeStatus,
  normalizeTags,
  validateNodeId,
  validateTitle,
} from './model/node.js'
import { encodeSegment, normalizePathString } from './path.js'
import { canonicalJson, hashValue } from './hash.js'

const nowIso = () => new Date().toISOString()
const byCreated = (a, b) =>
  String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id))

function addTo(map, key, id) {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  set.add(id)
}

// 前缀歧义候选展示：完整短 ID 原样，过长截断；最多 5 个
function formatCandidates(ids, limit = 5) {
  const shown = ids.slice(0, limit).map((id) => (id.length > 8 ? `${id.slice(0, 8)}…` : id)).join(', ')
  return `${shown}${ids.length > limit ? ' …' : ''}`
}

export class Packet {
  constructor(rec, filePath) {
    this.filePath = filePath
    this.meta = rec.meta
    this.nodes = rec.nodes // id -> 最新节点（仅存活节点）
    this.versions = rec.versions // id -> [各版本快照]（含已删除）
    this.changelog = rec.changelog
    this.tombstones = rec.tombstones
    this.warnings = rec.warnings
    this.pending = [] // 待追加的 JSONL 行
    this.structuralErrors = []
    this.enforcer = null // 写路径校验钩子（US-005）：由 src/enforce.js 注入，Packet 不感知 schema
    this.__schemaWarnings = [] // 校验 warn 级违规（不拦截，供命令层透传）
    this.rebuildIndexes()
  }

  static load(filePath) {
    return new Packet(parsePacket(filePath), filePath)
  }

  // 从 children 表出发自根做迭代 DFS：建路径索引、维度索引，同时检测环/不可达/重复路径
  rebuildIndexes() {
    this.children = new Map()
    this.pathIndex = new Map()
    this.pathById = new Map()
    this.tagIndex = new Map()
    this.typeIndex = new Map()
    this.statusIndex = new Map()
    this.structuralErrors = []

    for (const n of this.nodes.values()) {
      if (n.parent_id != null) {
        let list = this.children.get(n.parent_id)
        if (!list) {
          list = []
          this.children.set(n.parent_id, list)
        }
        list.push(n)
      }
    }
    for (const list of this.children.values()) list.sort(byCreated)

    const root = this.nodes.get(this.meta.root_node_id)
    if (!root) {
      this.structuralErrors.push(`根节点 ${this.meta.root_node_id} 不存在`)
      return
    }

    const pathCount = new Map()
    // 索引键与 pathById 统一为归一化形式（NFC + 段 trim），与查询侧对称（ISSUE-017/018）；
    // 根键归一化一次即可，子键在循环内增量拼接（父键已归一化 + 单段 encodeSegment NFC）
    const rootPath = normalizePathString('/' + encodeSegment(root.title))
    this.pathIndex.set(rootPath, root.id)
    this.pathById.set(root.id, rootPath)
    pathCount.set(rootPath, 1)
    const visited = new Set([root.id])
    const stack = [{ id: root.id, path: rootPath }]
    while (stack.length) {
      const { id, path } = stack.pop()
      for (const child of this.children.get(id) ?? []) {
        if (visited.has(child.id)) {
          this.structuralErrors.push(`检测到环：节点 ${child.id}「${child.title}」`)
          continue
        }
        visited.add(child.id)
        // 父键已归一化，新段经 encodeSegment（NFC + 转义）后拼接即归一化形式，
        // 避免热循环内全路径重归一化的开销（perf 基线 10k 节点）
        const cp = path + '/' + encodeSegment(child.title)
        this.pathIndex.set(cp, child.id)
        this.pathById.set(child.id, cp)
        pathCount.set(cp, (pathCount.get(cp) ?? 0) + 1)
        stack.push({ id: child.id, path: cp })
      }
    }
    for (const n of this.nodes.values()) {
      if (!visited.has(n.id)) {
        this.structuralErrors.push(`节点 ${n.id}「${n.title}」从根不可达（父引用悬空或成环）`)
      }
    }
    for (const [p, c] of pathCount) {
      if (c > 1) this.structuralErrors.push(`路径冲突：${c} 个节点共享路径 ${p}`)
    }

    for (const n of this.nodes.values()) {
      for (const t of n.tags ?? []) addTo(this.tagIndex, t, n.id)
      addTo(this.typeIndex, n.node_type, n.id)
      addTo(this.statusIndex, n.status, n.id)
    }
  }

  root() {
    return this.nodes.get(this.meta.root_node_id) ?? null
  }

  childrenOf(id) {
    return this.children.get(id) ?? []
  }

  descendantsOf(id) {
    const out = []
    const queue = [id]
    while (queue.length) {
      const cur = queue.shift()
      for (const c of this.children.get(cur) ?? []) {
        out.push(c.id)
        queue.push(c.id)
      }
    }
    return out
  }

  pathOf(id) {
    const cached = this.pathById?.get(id)
    if (cached !== undefined) return cached
    // 索引缺失（孤儿节点）时回退为沿父链上溯
    const segs = []
    const seen = new Set()
    let cur = this.nodes.get(id)
    while (cur) {
      if (seen.has(cur.id)) break // 环保护
      seen.add(cur.id)
      segs.push(encodeSegment(cur.title))
      cur = cur.parent_id == null ? null : this.nodes.get(cur.parent_id)
    }
    return '/' + segs.reverse().join('/')
  }

  findByPath(pathText) {
    const key = normalizePathString(pathText)
    // OPTIM-013：/ 直达根（不注册进索引，保持索引与节点一一对应的 verify 不变量）
    if (key === '/') return this.root()?.id ?? null
    return this.pathIndex.get(key) ?? null
  }

  // 节点引用解析：精确 id → 唯一前缀（git 风格）；以 '/' 开头则按语义路径
  resolveRef(ref) {
    const r = String(ref ?? '').trim()
    if (!r) throw new DtpError('USAGE', '节点引用为空')
    if (r.startsWith('/')) {
      const id = this.findByPath(r)
      if (!id) throw new DtpError('NOT_FOUND', `路径不存在：${r}`)
      return this.nodes.get(id)
    }
    if (this.nodes.has(r)) return this.nodes.get(r)
    const live = [...this.nodes.keys()].filter((id) => id.startsWith(r))
    if (live.length === 1) return this.nodes.get(live[0])
    if (live.length > 1) {
      throw new DtpError('AMBIGUOUS_ID', `前缀 "${r}" 匹配 ${live.length} 个节点：${formatCandidates(live)}`)
    }
    const dead = [...this.versions.keys()].filter((id) => id.startsWith(r))
    if (dead.length >= 1) {
      throw new DtpError('NODE_DELETED', `节点 ${dead[0]} 已删除（dtp history ${dead[0].slice(0, 8)} 可查看历史）`)
    }
    throw new DtpError('NOT_FOUND', `节点不存在：${r}`)
  }

  // 供 history 使用：即使节点已删除也能解析出 id
  resolveIdAny(ref) {
    const r = String(ref ?? '').trim()
    if (!r) throw new DtpError('USAGE', '节点引用为空')
    if (r.startsWith('/')) {
      const id = this.findByPath(r)
      if (id) return id
      throw new DtpError('NOT_FOUND', `路径不存在：${r}`)
    }
    if (this.versions.has(r)) return r
    const known = [...this.versions.keys()].filter((id) => id.startsWith(r))
    if (known.length === 1) return known[0]
    if (known.length > 1) {
      throw new DtpError('AMBIGUOUS_ID', `前缀 "${r}" 匹配 ${known.length} 个节点：${formatCandidates(known)}`)
    }
    throw new DtpError('NOT_FOUND', `节点不存在：${r}`)
  }

  // 内容篡改巡检（与 verify 的"节点哈希匹配"同源）：写命令加载后调用，
  // 不阻断写入（仅结构性错误阻断），但以 warnings 暴露给调用方提示篡改风险
  hashMismatches() {
    const problems = []
    for (const n of this.nodes.values()) {
      const actual = computeNodeHash(n)
      if (actual !== n.hash) {
        problems.push(
          `节点 ${n.id}（${n.title}）哈希不匹配（期望 ${String(n.hash).slice(0, 8)}…，实际 ${actual.slice(0, 8)}…）——内容疑似被外部篡改，写入后将按当前内容重算哈希`
        )
      }
    }
    return problems
  }

  assertWritable() {
    if (this.structuralErrors.length) {
      throw new DtpError('STRUCTURE', `数据包结构异常，拒绝写入（dtp verify 查看详情）`)
    }
  }

  // 语义路径要求同级标题唯一：写入前显式预检，给出可定位冲突节点的错误
  // （而非事后由路径索引以笼统的 STRUCTURE 拒绝）
  assertTitleAvailable(parentId, title, excludeId = null) {
    for (const sibling of this.childrenOf(parentId)) {
      // NFC 比较：形式差异（NFC/NFD，macOS/部分输入法）不应绕过同级唯一性（ISSUE-017）
      if (
        sibling.id !== excludeId &&
        String(sibling.title).normalize('NFC') === String(title).normalize('NFC')
      ) {
        throw new DtpError(
          'EXISTS',
          `同父节点下已存在同名标题「${title}」（冲突节点 ${sibling.id}；同级标题须唯一，请更换标题）`
        )
      }
    }
  }

  pushVersion(node) {
    const list = this.versions.get(node.id) ?? []
    list.push(node)
    this.versions.set(node.id, list)
  }

  // 写路径校验（US-005）：候选节点（已构建未提交）过 enforcer。
  // error 级 → 抛 SCHEMA_VIOLATION（携带 violations，TASK-018 契约），调用方不 save 则包零写入；
  // warn 级 → 累积到 __schemaWarnings 随成功写入透传（同 rule+message 去重，幂等多次写）
  runEnforcer(candidate) {
    if (!this.enforcer) return
    const violations = this.enforcer.check(candidate)
    const errors = violations.filter((v) => v.severity === 'error')
    if (errors.length) {
      throw new DtpError(
        'SCHEMA_VIOLATION',
        `写路径校验未通过（${errors.length} 项 error 级违规）：${errors[0].message}`,
        { violations: errors }
      )
    }
    for (const w of violations) {
      if (w.severity !== 'warn') continue
      if (!this.__schemaWarnings.some((x) => x.rule === w.rule && x.message === w.message)) {
        this.__schemaWarnings.push(w)
      }
    }
  }

  recordChange(nodeId, field, oldHash, newHash, user, ts, extra = {}) {
    // version：本次变更产生的节点版本号（删除时为被删节点的最后版本），供 history 精确关联；
    // 旧格式文件缺少该字段时按 timestamp 兜底匹配
    const entry = {
      type: 'changelog',
      node_id: nodeId,
      field,
      old_hash: oldHash,
      new_hash: newHash,
      timestamp: ts,
      user: user ?? null,
      version: null,
      ...extra,
    }
    this.changelog.push(entry)
    this.pending.push(entry)
  }

  touchMeta(now = nowIso()) {
    this.meta.updated_at = now
    this.pending.push({ ...this.meta, type: 'packet_meta' })
  }

  // ---------- 变更操作（内存修改 + 收集待追加行；save() 落盘） ----------

  addNode({ parentRef, id, nodeType = 'document', title, description = '', content = '', tags = [], status = 'draft', extensions = {}, user = null }) {
    this.assertWritable()
    const parent = this.resolveRef(parentRef)
    title = validateTitle(title)
    this.assertTitleAvailable(parent.id, title)
    const nodeId = validateNodeId(id ?? randomUUID())
    if (this.versions.has(nodeId)) throw new DtpError('ID_EXISTS', `节点 ID 已存在（含已删除历史）：${nodeId}`)

    const now = nowIso()
    const node = {
      type: 'node',
      id: nodeId,
      parent_id: parent.id,
      node_type: normalizeNodeType(nodeType),
      title,
      description: String(description ?? ''),
      content: String(content ?? ''),
      extensions: extensions ?? {},
      created_at: now,
      updated_at: now,
      version: 1,
      hash: '',
      tags: normalizeTags(tags),
      status: normalizeStatus(status),
    }
    node.hash = computeNodeHash(node)
    this.runEnforcer(node) // 提交前校验：违规抛出，pending/nodes 均未动
    this.nodes.set(nodeId, node)
    this.pushVersion(node)
    this.pending.push({ ...node })
    this.recordChange(nodeId, '*created', null, node.hash, user, now, { version: 1 })
    this.touchMeta(now)
    this.rebuildIndexes()
    return node
  }

  updateNode(ref, patch, { user = null, forceExt = false } = {}) {
    this.assertWritable()
    const node = this.resolveRef(ref)
    const next = { ...node }
    const changes = [] // { field, oldValue, newValue }
    const diff = (field, oldValue, newValue) => {
      if (canonicalJson(oldValue ?? null) !== canonicalJson(newValue ?? null)) {
        changes.push({ field, oldValue: oldValue ?? null, newValue: newValue ?? null })
      }
    }

    if (patch.title !== undefined) {
      patch.title = validateTitle(patch.title)
      if (patch.title !== node.title) this.assertTitleAvailable(node.parent_id, patch.title, node.id)
      diff('title', node.title, patch.title)
      next.title = patch.title
    }
    if (patch.description !== undefined) {
      diff('description', node.description, patch.description)
      next.description = String(patch.description)
    }
    if (patch.content !== undefined) {
      diff('content', node.content, patch.content)
      next.content = String(patch.content)
    }
    if (patch.status !== undefined) {
      const s = normalizeStatus(patch.status)
      diff('status', node.status, s)
      next.status = s
    }
    if (patch.tags !== undefined) {
      const tags = normalizeTags(patch.tags)
      diff('tags', node.tags ?? [], tags)
      next.tags = tags
    }
    if (patch.extensions !== undefined && Object.keys(patch.extensions).length) {
      const incoming = patch.extensions
      const merged = { ...(node.extensions ?? {}) }
      for (const [k, v] of Object.entries(incoming)) {
        const exists = Object.prototype.hasOwnProperty.call(node.extensions ?? {}, k)
        if (exists) {
          if (canonicalJson(node.extensions[k]) === canonicalJson(v)) continue
          if (!forceExt) {
            throw new DtpError(
              'EXT_IMMUTABLE',
              `扩展字段 "${k}" 已存在，append-only 语义禁止修改已有键（确需覆盖请加 --force）`
            )
          }
          diff('extensions.' + k, node.extensions[k], v)
        } else {
          changes.push({ field: 'extensions.' + k, oldValue: null, newValue: v })
        }
        merged[k] = v
      }
      next.extensions = merged
    }

    if (!changes.length) return { node, changes, changed: false }

    next.version = (node.version ?? 0) + 1
    next.updated_at = nowIso()
    next.hash = computeNodeHash(next)
    this.runEnforcer(next) // 提交前校验（候选节点终态，非变更字段子集——US-005 定稿）
    this.nodes.set(node.id, next)
    this.pushVersion(next)
    this.pending.push({ ...next })
    for (const ch of changes) {
      this.recordChange(
        node.id,
        ch.field,
        ch.oldValue === null ? null : hashValue(ch.oldValue),
        ch.newValue === null ? null : hashValue(ch.newValue),
        user,
        next.updated_at,
        { version: next.version }
      )
    }
    this.touchMeta(next.updated_at)
    this.rebuildIndexes()
    return { node: next, changes, changed: true }
  }

  removeNode(ref, { user = null } = {}) {
    this.assertWritable()
    const node = this.resolveRef(ref)
    if (node.id === this.meta.root_node_id) throw new DtpError('USAGE', '不能删除根节点')

    const now = nowIso()
    const targets = [node.id, ...this.descendantsOf(node.id)]
    for (const tid of targets) {
      const n = this.nodes.get(tid)
      if (!n) continue
      this.nodes.delete(tid)
      this.tombstones.add(tid)
      this.pending.push({ type: 'node_delete', id: tid, timestamp: now })
      this.recordChange(tid, '*deleted', n.hash, null, user, now, { version: n.version })
    }
    this.touchMeta(now)
    this.rebuildIndexes()
    return { removed: targets, rootRemoved: node.id }
  }

  moveNode(ref, newParentRef, { user = null } = {}) {
    this.assertWritable()
    const node = this.resolveRef(ref)
    const parent = this.resolveRef(newParentRef)
    if (node.id === this.meta.root_node_id) throw new DtpError('USAGE', '不能移动根节点')
    if (parent.id === node.id) throw new DtpError('MOVE_CYCLE', '不能把节点移动到自身之下')
    if (parent.id === node.parent_id) {
      return { node, moved: false, oldPath: this.pathOf(node.id), newPath: this.pathOf(node.id) }
    }
    const subtree = new Set([node.id, ...this.descendantsOf(node.id)])
    if (subtree.has(parent.id)) {
      throw new DtpError('MOVE_CYCLE', '目标父节点位于被移动节点的子树内，将形成环')
    }
    if (parent.id !== node.parent_id) this.assertTitleAvailable(parent.id, node.title, node.id)

    const now = nowIso()
    const oldPath = this.pathOf(node.id)
    const next = { ...node, parent_id: parent.id, version: (node.version ?? 0) + 1, updated_at: now }
    next.hash = computeNodeHash(next)
    this.runEnforcer(next) // 提交前校验（候选节点终态，非变更字段子集——US-005 定稿）
    this.nodes.set(node.id, next)
    this.pushVersion(next)
    this.pending.push({ ...next })
    this.recordChange(node.id, 'parent_id', hashValue(node.parent_id ?? null), hashValue(parent.id), user, now, {
      version: next.version,
    })
    // 先重建索引，再取新路径（pathOf 走的是缓存）
    this.touchMeta(now)
    this.rebuildIndexes()
    const newPath = this.pathOf(node.id)
    this.recordChange(node.id, '*moved', null, null, user, now, {
      version: next.version,
      old_path: oldPath,
      new_path: newPath,
    })
    return { node: next, moved: true, oldPath, newPath }
  }

  checkoutNode(ref, targetVersion, { user = null } = {}) {
    this.assertWritable()
    const id = this.resolveIdAny(ref)
    if (!this.nodes.has(id)) throw new DtpError('NODE_DELETED', `节点 ${id} 已删除，无法 checkout`)
    const hist = this.versions.get(id) ?? []
    const target = hist.find((v) => v.version === targetVersion)
    if (!target) {
      const avail = hist.map((v) => v.version).join(', ')
      throw new DtpError('VERSION_NOT_FOUND', `节点 ${id} 不存在版本 ${targetVersion}（现有版本：${avail}）`)
    }
    const cur = this.nodes.get(id)
    if (targetVersion === cur.version) return { node: cur, changed: false, from: cur.version, to: targetVersion }
    if (target.title !== cur.title) this.assertTitleAvailable(cur.parent_id, target.title, id)

    const now = nowIso()
    // 回滚内容字段；父节点、created_at 保持当前值（回滚不改变树结构）
    const restored = {
      ...target,
      type: 'node',
      id,
      parent_id: cur.parent_id,
      created_at: cur.created_at,
      updated_at: now,
      version: (cur.version ?? 0) + 1,
    }
    restored.hash = computeNodeHash(restored)

    const changes = []
    const diffField = (field, oldValue, newValue) => {
      if (canonicalJson(oldValue ?? null) !== canonicalJson(newValue ?? null)) {
        changes.push({ field, oldValue: oldValue ?? null, newValue: newValue ?? null })
      }
    }
    for (const f of ['node_type', 'title', 'description', 'content', 'status', 'tags']) {
      diffField(f, cur[f], restored[f])
    }
    const keys = new Set([...Object.keys(cur.extensions ?? {}), ...Object.keys(restored.extensions ?? {})])
    for (const k of keys) diffField('extensions.' + k, cur.extensions?.[k] ?? null, restored.extensions?.[k] ?? null)

    this.nodes.set(id, restored)
    this.pushVersion(restored)
    this.pending.push({ ...restored })
    for (const ch of changes) {
      this.recordChange(
        id,
        ch.field,
        ch.oldValue === null ? null : hashValue(ch.oldValue),
        ch.newValue === null ? null : hashValue(ch.newValue),
        user,
        now,
        { version: restored.version }
      )
    }
    this.recordChange(id, '*checkout', cur.hash, restored.hash, user, now, {
      version: restored.version,
      target_version: targetVersion,
    })
    this.touchMeta(now)
    this.rebuildIndexes()
    return { node: restored, changes, changed: true, from: cur.version, to: targetVersion }
  }

  // ---------- 落盘 ----------

  save({ backup = true } = {}) {
    if (!this.pending.length) return 0
    this.assertWritable()
    if (backup) backupPacketFile(this.filePath)
    appendJsonl(this.filePath, this.pending)
    const n = this.pending.length
    this.pending = []
    return n
  }

  // 供 pack 使用：仅保留每个节点的最新版本 + 存活节点 changelog 的快照行集。
  // 已删节点的 changelog 一并丢弃：快照不含其版本快照，保留只会让
  // unpack 后 verify 的「变更日志引用有效」必然失败（引用悬空）。
  compact() {
    const lines = [{ ...this.meta, type: 'packet_meta' }]
    for (const n of [...this.nodes.values()].sort(byCreated)) {
      lines.push({ ...n, type: 'node' })
    }
    let droppedChangelog = 0
    for (const e of this.changelog) {
      if (this.nodes.has(e.node_id)) lines.push({ ...e, type: 'changelog' })
      else droppedChangelog++
    }
    return { lines, droppedChangelog }
  }

  compactLines() {
    return this.compact().lines
  }
}

// init 命令专用：从零构建一个新数据包的首批行（meta + 根节点 + *created）
export function initPacketLines({ name, packetId, version = 'v1.0.0', rootId = randomUUID(), metadata = {}, user = null }) {
  const now = nowIso()
  const root = {
    type: 'node',
    id: rootId,
    parent_id: null,
    node_type: 'folder',
    title: name,
    description: '',
    content: '',
    extensions: {},
    created_at: now,
    updated_at: now,
    version: 1,
    hash: '',
    tags: [],
    status: 'draft',
  }
  root.hash = computeNodeHash(root)
  const meta = {
    type: 'packet_meta',
    packet_id: packetId,
    name,
    version,
    created_at: now,
    updated_at: now,
    root_node_id: root.id,
    metadata: metadata ?? {},
  }
  const created = {
    type: 'changelog',
    node_id: root.id,
    field: '*created',
    old_hash: null,
    new_hash: root.hash,
    timestamp: now,
    user: user ?? null,
  }
  return { lines: [meta, root, created], meta, root }
}
