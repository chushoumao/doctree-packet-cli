/* dtp Web UI — 前端逻辑（零依赖 vanilla JS）
   数据模型完全对齐 dtp 引擎（src/）：node/changelog/tombstone，
   写操作经 /api 走引擎的「锁内 append-only」路径。 */
'use strict'

/* ---------- 常量与工具 ---------- */

const NODE_TYPES = ['folder', 'document', 'requirement', 'knowledge', 'index']
const STATUSES = ['draft', 'review', 'approved', 'archived']
const TYPE_LABEL = { folder: '文件夹', document: '文档', requirement: '需求', knowledge: '知识', index: '索引' }
const TYPE_COLOR = { folder: '--c-folder', document: '--c-document', requirement: '--c-requirement', knowledge: '--c-knowledge', index: '--c-index' }
const STATUS_LABEL = { draft: '草稿', review: '评审中', approved: '已批准', archived: '已归档' }
const STATUS_COLOR = { draft: '--c-draft', review: '--c-review', approved: '--c-approved', archived: '--c-archived' }
const LIFE_FIELDS = new Set(['*created', '*deleted', '*moved', '*checkout'])

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const shortId = (id) => String(id ?? '').slice(0, 8)

function timeAgo(iso) {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return String(iso)
  const diff = Date.now() - t
  if (diff < 60e3) return '刚刚'
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`
  if (diff < 30 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`
  return new Date(t).toLocaleDateString('zh-CN')
}

const fmtBytes = (n) =>
  n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—')

const splitTags = (s) => [...new Set(String(s ?? '').split(',').map((t) => t.trim()).filter(Boolean))]

/* ---------- 图标（内联 SVG，笔画风格统一） ---------- */

const icon = (paths, vb = '0 0 16 16') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`

const ICONS = {
  folder: icon('<path d="M1.8 4.5c0-.6.4-1 1-1h3.2l1.4 1.7h5.8c.6 0 1 .4 1 1v6.3c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z"/>'),
  document: icon('<path d="M4 1.8h5.2L12.5 5v9.2H4Z"/><path d="M9 2v3.2h3.4"/><path d="M6 8.5h4M6 10.8h4"/>'),
  requirement: icon('<circle cx="8" cy="8" r="5.8"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r=".4" fill="currentColor"/>'),
  knowledge: icon('<path d="M8 3.2C6.8 2.2 4.9 2 2.8 2.2v10C4.9 12 6.8 12.2 8 13.2c1.2-1 3.1-1.2 5.2-1v-10C11.1 2 9.2 2.2 8 3.2Z"/><path d="M8 3.2v10"/>'),
  index: icon('<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/>'),
  caret: icon('<path d="m5.5 2.5 5 5.5-5 5.5"/>', '0 0 12 14'),
}

/* ---------- 状态 ---------- */

const state = {
  packets: [],
  workspace: null,
  packet: null, // 当前数据包文件名
  tree: null, // /api/tree 结果
  byId: new Map(),
  expanded: new Set(),
  selected: null, // 节点 id
  view: 'browse',
  filter: '',
  detail: null,
  history: null,
  statsCache: null, // {packet, data}
  query: { keyword: '', types: [], statuses: [], tags: [], extRows: [{ key: '', value: '' }], results: null, loading: false },
  editing: null, // {mode:'edit'|'add'} | null
  tpl: {
    list: null, // /api/templates 结果（templates 与 packet 均为包无关/随包缓存）
    packet: null, // list 对应的数据包（packet_template 视图）
    current: null, // 当前编辑的 schema 文件（工作区相对路径）
    content: '',
    savedContent: '',
    problems: [],
    ok: true,
    dirty: false,
    lint: null, // lint 报告（null = 未跑）
    lintErr: null, // lint 快速失败（TEMPLATE_MISSING / SCHEMA_INVALID / SCHEMA_DRIFT…）
    lintLoading: false,
    _seq: 0,
    _loadSeq: 0,
  },
  user: localStorage.getItem('dtp.user') || '',
  sideCollapsed: localStorage.getItem('dtp.sidebar') === 'collapsed',
}

/* ---------- API ---------- */

async function api(path, { method = 'GET', params, body } = {}) {
  let url = path
  if (params) {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue
      for (const item of [].concat(v)) q.append(k, item)
    }
    const s = q.toString()
    if (s) url += (url.includes('?') ? '&' : '?') + s
  }
  let res
  try {
    res = await fetch(url, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    })
  } catch {
    throw { code: 'NETWORK', message: '无法连接服务——server 进程是否还在运行？' }
  }
  let json
  try {
    json = await res.json()
  } catch {
    throw { code: 'NETWORK', message: `响应不是 JSON（HTTP ${res.status}）` }
  }
  if (!json.ok) throw json.error || { code: 'UNKNOWN', message: '未知错误' }
  return json
}

/* ---------- Toast ---------- */

function toast(message, type = 'ok') {
  const host = $('#toasts')
  while (host.children.length >= 4) host.firstChild.remove()
  const el = document.createElement('div')
  el.className = `toast toast--${type}`
  el.innerHTML =
    type === 'err'
      ? icon('<path d="M8 2 15 14H1Z"/><path d="M8 6.5v3.2M8 11.8v.2"/>')
      : icon('<path d="m2.8 8.4 3.4 3.4 7-7.6"/>')
  el.appendChild(document.createTextNode(message))
  host.appendChild(el)
  setTimeout(() => {
    el.classList.add('is-leaving')
    setTimeout(() => el.remove(), 380)
  }, type === 'err' ? 4200 : 2600)
}

/* ---------- 启动与数据装载 ---------- */

async function boot() {
  bindEvents()
  try {
    await loadPackets()
    const last = localStorage.getItem('dtp.packet')
    const pick = state.packets.find((p) => p.file === last) || state.packets.find((p) => !p.error)
    if (pick) {
      await switchPacket(pick.file, { silent: true })
    } else {
      renderPacketMenu()
      renderMain()
      renderRail()
    }
  } catch (e) {
    toast(`加载失败：${e.message}`, 'err')
    renderPacketMenu()
    renderMain()
    renderRail()
  }
}

async function loadPackets() {
  const data = await api('/api/packets')
  state.packets = data.packets
  state.workspace = data.workspace
  renderPacketMenu()
}

async function switchPacket(file, { silent } = {}) {
  // 先加载成功、再提交状态：失败的包不污染当前界面
  const data = await api('/api/tree', { params: { p: file } })
  state.packet = file
  localStorage.setItem('dtp.packet', file)
  state.selected = null
  state.detail = null
  state.history = null
  state.expanded = new Set()
  state.statsCache = null
  state.editing = null
  state.query.results = null
  state.tpl.lint = null
  state.tpl.lintErr = null
  state.tpl.lintLoading = false
  state.tpl._seq++ // 失效在途 lint 响应
  state.tree = data
  state.byId = new Map(data.nodes.map((n) => [n.id, n]))
  renderPacketMenu()
  const root = data.root_id
  if (root) {
    state.expanded.add(root)
    await selectNode(root, { silent })
  } else {
    renderMain()
    renderRail()
  }
  renderTree()
  renderSidebarFoot()
  if (!silent) toast(`已切换到「${data.meta?.name ?? file}」`)
}

async function refreshTree({ keepSelection = true, reloadPackets = true } = {}) {
  if (!state.packet) return
  const [data] = await Promise.all([
    api('/api/tree', { params: { p: state.packet } }),
    reloadPackets ? loadPackets().catch(() => {}) : Promise.resolve(),
  ])
  state.tree = data
  state.byId = new Map(data.nodes.map((n) => [n.id, n]))
  state.statsCache = null
  // 树数据变了（本 UI 写入或外部写入），模版符合性可能随之变化：作废 lint 缓存
  state.tpl.lint = null
  state.tpl.lintErr = null
  renderTree()
  renderSidebarFoot()
  if (keepSelection && state.selected) {
    if (state.byId.has(state.selected)) await selectNode(state.selected, { silent: true })
    else if (state.byId.has(data.root_id)) await selectNode(data.root_id, { silent: true })
    else {
      state.selected = null
      state.detail = null
      state.history = null
      renderMain()
      renderRail()
    }
  }
}

async function selectNode(id, { silent } = {}) {
  state.selected = id
  state.editing = null
  // 选中即展开祖先，保证可见
  let cur = state.byId.get(id)
  while (cur && cur.parent_id) {
    state.expanded.add(cur.parent_id)
    cur = state.byId.get(cur.parent_id)
  }
  const [detail, history] = await Promise.all([
    api('/api/node', { params: { p: state.packet, ref: id } }),
    api('/api/history', { params: { p: state.packet, ref: id } }).catch((e) => ({ error: e })),
  ])
  state.detail = detail.ok === false ? null : detail
  state.history = history.error ? null : history
  renderTree()
  renderMain({ fade: !silent })
  renderRail()
  // 树里滚动到选中行可见（查询跳转/面包屑跳转时尤其需要）
  $(`.tree__row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  if (state.view !== 'browse') setView('browse')
}

/* ---------- 顶栏渲染 ---------- */

function packetSignature(p) {
  return p ? `${p.mtime}:${p.size}` : ''
}

function renderPacketMenu() {
  const cur = state.packets.find((p) => p.file === state.packet)
  const name = $('#pkName')
  const meta = $('#pkMeta')
  if (cur?.error) {
    name.textContent = cur.file
    meta.textContent = '解析失败'
  } else if (cur) {
    name.textContent = cur.name ?? cur.file
    meta.textContent = `${cur.nodes} 节点 · ${cur.version ?? ''} · ${timeAgo(cur.mtime)}`
  } else {
    name.textContent = state.packets.length ? '选择数据包' : '尚无数据包'
    meta.textContent = ''
  }
  $('#pkBtn').disabled = false
  $('#pkCount').textContent = `${state.packets.length} 个`
  const list = $('#pkList')
  list.innerHTML =
    state.packets
      .map((p) => {
        const active = p.file === state.packet
        const badge = p.error
          ? `<span class="pkbadge pkbadge--err" title="${esc(p.error)}">解析失败</span>`
          : [
              p.template ? `<span class="pkbadge pkbadge--tpl" title="已绑定模版：${esc(p.template.name)} v${esc(p.template.version)}">◈ ${esc(p.template.name)}</span>` : '',
              p.warnings ? `<span class="pkbadge pkbadge--warn" title="${p.warnings} 条加载告警">⚠ ${p.warnings}</span>` : '',
              p.structural_errors ? `<span class="pkbadge pkbadge--err" title="${p.structural_errors} 项结构错误">✕ ${p.structural_errors}</span>` : '',
            ].join('')
        const info = p.error
          ? `<span class="pkrow__sub">${esc(p.error)}</span>`
          : `<span class="pkrow__sub">${p.nodes ?? '?'} 节点 · ${fmtBytes(p.size)} · ${timeAgo(p.mtime)}</span>`
        return `<button class="pkrow ${active ? 'is-active' : ''}" data-action="pick-packet" data-file="${esc(p.file)}" title="${esc(p.file)}">
          <span class="pkrow__name serif">${esc(p.name ?? p.file)}</span>
          ${badge}
          <span class="pkrow__ver mono">${esc(p.version ?? '')}</span>
          ${info}
        </button>`
      })
      .join('') || `<div class="pkrow__empty">工作区还没有数据包<br><small>点右上 ✦ 新建，或把 .dtp 文件放进工作区</small></div>`
  $('#pkWs').textContent = state.workspace ?? ''
}

function openPacketMenu() {
  renderPacketMenu()
  $('#pkPop').hidden = false
  $('#pkBtn').setAttribute('aria-expanded', 'true')
}

function closePacketMenu() {
  $('#pkPop').hidden = true
  $('#pkBtn').setAttribute('aria-expanded', 'false')
}

/* 手动刷新：树 + 详情 + 数据包列表，按钮转圈反馈 */
async function doRefresh(btns = []) {
  btns.forEach((b) => b.classList.add('is-busy'))
  try {
    await refreshTree()
  } catch (e) {
    toast(`刷新失败：${e.message}`, 'err')
  } finally {
    setTimeout(() => btns.forEach((b) => b.classList.remove('is-busy')), 350)
  }
}

/* 窗口聚焦 / 标签页切回时轻量探测：数据包是否被外部（CLI）修改过 */
let probeAt = 0
async function probeExternalChanges() {
  if (!state.packet) return
  const now = Date.now()
  if (now - probeAt < 3000) return
  probeAt = now
  let data
  try {
    data = await api('/api/packets')
  } catch {
    return // 静默：焦点探测不打扰
  }
  const prevSig = packetSignature(state.packets.find((p) => p.file === state.packet))
  state.packets = data.packets
  state.workspace = data.workspace
  renderPacketMenu()
  const curSig = packetSignature(data.packets.find((p) => p.file === state.packet))
  if (prevSig && curSig && prevSig !== curSig) {
    toast('检测到外部写入（CLI？），已自动刷新')
    await refreshTree({ reloadPackets: false }).catch(() => {})
  }
}

/* ---------- 树 ---------- */

function treeMatches(node, kw) {
  return (
    node.title.toLowerCase().includes(kw) ||
    (node.path ?? '').toLowerCase().includes(kw) ||
    (node.tags ?? []).some((t) => t.toLowerCase().includes(kw)) ||
    shortId(node.id).includes(kw)
  )
}

/* 标题内命中片段高亮（大小写不敏感；仅当命中发生在标题里时才有标记） */
function markMatch(title, kw) {
  if (!kw) return esc(title)
  const lower = title.toLowerCase()
  let out = ''
  let i = 0
  for (;;) {
    const j = lower.indexOf(kw, i)
    if (j < 0) return out + esc(title.slice(i))
    out += esc(title.slice(i, j)) + `<mark class="tree__mark">${esc(title.slice(j, j + kw.length))}</mark>`
    i = j + kw.length
  }
}

function buildTree() {
  const host = $('#tree')
  if (!state.tree) {
    host.innerHTML = `<div class="tree__empty">未加载数据包</div>`
    return
  }
  const kw = state.filter.trim().toLowerCase()
  const childrenOf = (id) => (state.tree.children[id] ?? []).map((cid) => state.byId.get(cid)).filter(Boolean)

  let keep = null
  if (kw) {
    keep = new Set()
    const mark = (n) => {
      if (keep.has(n.id)) return true
      const kidHit = childrenOf(n.id).some(mark)
      if (treeMatches(n, kw) || kidHit) {
        keep.add(n.id)
        return true
      }
      return false
    }
    for (const n of state.tree.nodes) mark(n)
  }

  // 单次字符串拼接 + innerHTML：比逐节点 appendChild 少量级 reflow，过滤打字时整树重建也顺滑
  const rowHtml = (n, depth) => {
    const kids = childrenOf(n.id)
    const hasKids = kids.length > 0
    const open = state.expanded.has(n.id) || Boolean(kw)
    const tc = `var(${TYPE_COLOR[n.node_type] ?? '--c-document'})`
    const sc = `var(${STATUS_COLOR[n.status] ?? '--c-draft'})`
    let html = `<div class="tree__row${n.id === state.selected ? ' is-active' : ''}" data-id="${esc(n.id)}" data-action="select" title="${esc(n.path)}" style="padding-left:${6 + depth * 15}px">
      <span class="tree__caret ${hasKids ? (open ? 'is-open' : '') : 'is-leaf'}" ${hasKids ? 'data-action="toggle"' : ''}>${ICONS.caret}</span>
      <span class="tree__icon" style="--tc:${tc};stroke:${tc}">${ICONS[n.node_type] ?? ICONS.document}</span>
      <span class="tree__title">${kw ? markMatch(n.title, kw) : esc(n.title)}</span>
      ${n.version > 1 ? `<span class="tree__ver">v${n.version}</span>` : ''}
      <span class="tree__dot" style="--sc:${sc}" title="${esc(STATUS_LABEL[n.status] ?? n.status)}"></span>
    </div>`
    if (hasKids) {
      const inner = kids.filter((k) => !keep || keep.has(k.id)).map((k) => rowHtml(k, depth + 1)).join('')
      html += `<div class="tree__kids${open ? ' is-open' : ''}"><div>${inner}</div></div>`
    }
    return html
  }

  const root = state.byId.get(state.tree.root_id)
  if (!root) {
    host.innerHTML = `<div class="tree__empty">根节点缺失（结构异常，可运行校验查看）</div>`
    return
  }
  const scrollTop = host.scrollTop
  host.innerHTML = rowHtml(root, 0)
  host.scrollTop = scrollTop
  if (kw && !host.querySelector('.tree__row')) {
    host.innerHTML = `<div class="tree__empty">没有匹配「${esc(state.filter)}」的节点<br><small>试试在「查询」里用正文关键词检索</small></div>`
  }
}

function toggleTreeRow(id) {
  if (state.expanded.has(id)) state.expanded.delete(id)
  else state.expanded.add(id)
  // 只切换 class，让 grid-rows 过渡动画生效
  const row = $(`.tree__row[data-id="${CSS.escape(id)}"]`)
  const wrap = row?.nextElementSibling
  if (wrap?.classList.contains('tree__kids')) {
    wrap.classList.toggle('is-open', state.expanded.has(id))
    row.querySelector('.tree__caret')?.classList.toggle('is-open', state.expanded.has(id))
  } else {
    buildTree()
  }
}

function renderTree() {
  buildTree()
}

function renderSidebarFoot() {
  const t = state.tree
  $('#sidebarFoot').innerHTML = t
    ? `<span>${t.nodes.length} 个节点 · ${t.tags.length} 个标签</span><span class="mono">${esc(t.meta?.version ?? '')}</span>`
    : ''
}

/* ---------- 侧栏折叠 ---------- */

function applySidebarCollapsed() {
  const c = state.sideCollapsed
  $('#sidebar')?.classList.toggle('is-collapsed', c)
  $('.stage')?.classList.toggle('is-side-collapsed', c)
  const btn = $('#sideFold')
  if (!btn) return
  btn.setAttribute('aria-expanded', String(!c))
  const tip = c ? '展开侧栏' : '折叠侧栏'
  btn.title = tip
  btn.setAttribute('aria-label', tip)
}

/* ---------- 主区路由 ---------- */

function renderMain({ fade } = {}) {
  const main = $('#main')
  const scroll = document.createElement('div')
  scroll.className = 'main__scroll'
  if (state.view === 'browse') {
    scroll.appendChild(renderDetail())
  } else if (state.view === 'query') {
    scroll.appendChild(renderQueryView())
  } else if (state.view === 'stats') {
    const host = document.createElement('div')
    scroll.appendChild(host)
    fillStats(host)
  } else if (state.view === 'template') {
    const host = document.createElement('div')
    scroll.appendChild(host)
    fillTemplateView(host)
  } else if (state.view === 'ledger') {
    const host = document.createElement('div')
    scroll.appendChild(host)
    fillLedger(host)
  }
  main.innerHTML = ''
  main.appendChild(scroll)
  // #qResults 必须已挂进文档 renderQueryResults 才能找到它（缓存结果回显走这里，setView 的 runQuery 只兜底 null）
  if (state.view === 'query') renderQueryResults()
  if (fade) scroll.classList.add('fade-swap')
}

/* ---------- 节点详情 ---------- */

function chipHtml(kind, value, extra = '') {
  if (kind === 'type') {
    const c = `var(${TYPE_COLOR[value] ?? '--c-document'})`
    return `<span class="chip" style="--c:${c}">${esc(TYPE_LABEL[value] ?? value)}</span>`
  }
  if (kind === 'status') {
    const c = `var(${STATUS_COLOR[value] ?? '--c-draft'})`
    return `<span class="chip" style="--c:${c}">${esc(STATUS_LABEL[value] ?? value)}</span>${extra}`
  }
  return `<span class="chip chip--plain">${esc(value)}</span>`
}

function extValueHtml(v) {
  if (Array.isArray(v)) {
    return `<ul style="margin:0;padding-left:18px">${v.map((x) => `<li>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('')}</ul>`
  }
  if (v !== null && typeof v === 'object') return `<code class="mono">${esc(JSON.stringify(v))}</code>`
  return esc(typeof v === 'string' ? v : JSON.stringify(v))
}

function renderDetail() {
  const frag = document.createElement('div')
  if (!state.packet || !state.tree) {
    frag.innerHTML = `<div class="empty">
      <div class="empty__glyph">${ICONS.knowledge}</div>
      <div class="empty__title">光池静默</div>
      <p>左侧还没有数据包——</p>
      <p><button class="btn btn--primary" data-action="new-packet">✦ 新建数据包</button></p>
    </div>`
    return frag
  }
  if (!state.detail) {
    frag.innerHTML = `<div class="empty">
      <div class="empty__glyph">${ICONS.folder}</div>
      <div class="empty__title">选择一个节点</div>
      <p>点击左侧树中的标题，这里会展开它的全部内容与版本水流。</p>
    </div>`
    return frag
  }
  if (state.editing) {
    frag.appendChild(state.editing.mode === 'add' ? renderAddForm() : renderEditForm())
    return frag
  }

  const { node, breadcrumb, children, descendants } = state.detail
  const isRoot = node.parent_id == null
  const tc = `var(${TYPE_COLOR[node.node_type] ?? '--c-document'})`

  const crumbs = breadcrumb
    .map((b, i) =>
      i === breadcrumb.length - 1
        ? `<span class="crumbs__seg is-current">${esc(b.title)}</span>`
        : `<span class="crumbs__seg" data-action="select" data-id="${esc(b.id)}">${esc(b.title)}</span><span class="crumbs__sep">/</span>`
    )
    .join('')

  const metas = [
    chipHtml('type', node.node_type),
    chipHtml('status', node.status),
    `<span class="chip chip--plain mono" data-action="copy-id" data-id="${esc(node.id)}" title="点击复制完整 ID">${esc(shortId(node.id))}…</span>`,
    `<span class="chip chip--plain">v${node.version}</span>`,
    `<span class="chip chip--plain" title="创建 ${esc(fmtDate(node.created_at))}">✧ ${esc(timeAgo(node.created_at))} 创建</span>`,
    `<span class="chip chip--plain" title="${esc(fmtDate(node.updated_at))}">↻ ${esc(timeAgo(node.updated_at))} 更新</span>`,
  ].join('')

  const sections = []

  if (node.tags?.length) {
    sections.push(`<div class="detail__section"><div class="detail__label">标签</div>
      <div class="taglist">${node.tags.map((t) => `<span class="chip" style="--c:var(--accent)">${esc(t)}</span>`).join('')}</div></div>`)
  }

  const ext = Object.entries(node.extensions ?? {})
  if (ext.length) {
    sections.push(`<div class="detail__section"><div class="detail__label">扩展字段<span class="ext-lock">append-only · 只增不改</span></div>
      <table class="ext-table">${ext.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${extValueHtml(v)}</td></tr>`).join('')}</table></div>`)
  }

  if (node.description) {
    sections.push(`<div class="detail__section"><div class="detail__label">描述</div><blockquote class="detail__desc">${esc(node.description)}</blockquote></div>`)
  }

  if (node.content) {
    sections.push(`<div class="detail__section"><div class="detail__label">正文</div><div class="detail__content">${esc(node.content)}</div></div>`)
  }

  if (children.length) {
    sections.push(`<div class="detail__section"><div class="detail__label">子节点 · ${children.length}</div><div class="childlist">
      ${children
        .map((c) => {
          const cc = `var(${TYPE_COLOR[c.node_type] ?? '--c-document'})`
          const sc = `var(${STATUS_COLOR[c.status] ?? '--c-draft'})`
          return `<div class="childrow" data-action="select" data-id="${esc(c.id)}">
            <span class="tree__icon" style="--tc:${cc};stroke:${cc}">${ICONS[c.node_type] ?? ICONS.document}</span>
            <span class="childrow__title" title="${esc(c.path)}">${esc(c.title)}</span>
            <span class="chip" style="--c:${sc};font-size:10.5px">${esc(STATUS_LABEL[c.status] ?? c.status)}</span>
            ${c.child_count ? `<span class="childrow__count">+${c.child_count}</span>` : ''}
          </div>`
        })
        .join('')}</div></div>`)
  }

  frag.innerHTML = `
    <div class="crumbs">${crumbs}</div>
    <div class="detail__head">
      <span class="detail__type-icon" style="--tc:${tc};stroke:${tc}">${ICONS[node.node_type] ?? ICONS.document}</span>
      <h1 class="detail__title">${esc(node.title)}</h1>
    </div>
    <div class="detail__metas">${metas}</div>
    <div class="detail__actions">
      <button class="btn" data-action="edit">${icon('<path d="M9.7 2.6a1.8 1.8 0 0 1 2.6 2.6L4.6 12.9l-3 .7.7-3Z"/>')}编辑</button>
      <button class="btn" data-action="add-child">${icon('<path d="M8 3v10M3 8h10"/>')}添加子节点</button>
      <button class="btn" data-action="move" ${isRoot ? 'disabled title="根节点不可移动"' : ''}>${icon('<path d="M3 5h8m0 0-2.4-2.4M11 5 8.6 7.4"/><path d="M13 11H5m0 0 2.4-2.4M5 11l2.4 2.4"/>')}移动</button>
      ${!isRoot ? `<button class="btn btn--danger" data-action="rm" data-arm="删除">${icon('<path d="M2.8 4.5h10.4M6.3 2.5h3.4M4.2 4.5l.7 8.6c0 .5.4.9 1 .9h4.2c.6 0 1-.4 1-.9l.7-8.6M6.6 7v4M9.4 7v4"/>')}删除</button>` : ''}
      ${descendants ? `<span class="chip chip--plain" title="级联删除将移除全部子孙">子树 ${descendants} 节点</span>` : ''}
    </div>
    ${sections.join('')}`

  return frag
}

/* ---------- 表单：编辑 / 新增 ---------- */

function extRowsHtml(rows, existingKeys) {
  return `<div class="ext-editor" id="extEditor">
    ${rows
      .map(
        (r, i) => `<div class="ext-editor__row">
        <input class="field__input field__input--mono" data-ext-key="${i}" placeholder="键（如 owner）" value="${esc(r.key)}" ${r.locked ? 'disabled' : ''}>
        <input class="field__input field__input--mono" data-ext-val="${i}" placeholder='值（尝试 JSON，失败按字符串）' value="${esc(r.raw ?? '')}">
        <button type="button" class="btn btn--icon btn--ghost" data-action="ext-remove" data-i="${i}" title="移除此行">${icon('<path d="M4 4l8 8M12 4l-8 8"/>')}</button>
      </div>`
      )
      .join('')}
    <button type="button" class="btn btn--ghost" data-action="ext-add" style="align-self:flex-start">${icon('<path d="M8 3v10M3 8h10"/>')}添加扩展字段</button>
    ${existingKeys?.length ? `<label class="form__check"><input type="checkbox" id="forceExt">覆盖已存在的扩展键（append-only 需显式 --force）</label>` : ''}
  </div>`
}

function readExtEditor() {
  const out = {}
  // 按行配对读取（而非全局索引）：删除中间行后索引会重复，全局查询会配错对
  for (const row of $$('#extEditor .ext-editor__row')) {
    const kEl = row.querySelector('[data-ext-key]')
    const vEl = row.querySelector('[data-ext-val]')
    if (!kEl || !vEl) continue
    const key = kEl.value.trim()
    if (!key) continue
    if (key.includes('.')) throw { message: `扩展字段名不能包含 "."：${key}` }
    if (key in out) throw { message: `重复的扩展字段名：${key}` }
    let val = vEl.value
    try {
      val = JSON.parse(val)
    } catch { /* 按字符串 */ }
    out[key] = val
  }
  return out
}

function renderEditForm() {
  const { node } = state.detail
  const frag = document.createElement('form')
  frag.className = 'form'
  frag.id = 'editForm'
  const extKeys = Object.keys(node.extensions ?? {})
  frag.innerHTML = `
    <div style="margin:2px 0 -4px"><span class="crumbs__seg is-current" style="padding-left:0">编辑</span>
      <span class="chip chip--plain" style="margin-left:8px">改动将生成 v${node.version + 1} 并写入 changelog</span></div>
    <div class="form__row">
      <div class="form__field" style="grid-column:1/-1">
        <label class="form__label">标题 <small>（同级唯一）</small></label>
        <input class="field__input" name="title" value="${esc(node.title)}" required>
      </div>
    </div>
    <div class="form__row">
      <div class="form__field">
        <label class="form__label">类型 <small>（append-only 模型不支持改类型）</small></label>
        <div>${chipHtml('type', node.node_type)}</div>
      </div>
      <div class="form__field">
        <label class="form__label">状态</label>
        <select class="select" name="status">
          ${STATUSES.map((s) => `<option value="${s}" ${s === node.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
        </select>
      </div>
      <div class="form__field">
        <label class="form__label">标签 <small>（逗号分隔，整体替换）</small></label>
        <input class="field__input" name="tags" value="${esc((node.tags ?? []).join(', '))}" placeholder="P0, auth">
      </div>
    </div>
    <div class="form__field">
      <label class="form__label">描述</label>
      <textarea class="field__input" name="description" rows="2">${esc(node.description ?? '')}</textarea>
    </div>
    <div class="form__field">
      <label class="form__label">正文</label>
      <textarea class="field__input" name="content" rows="8">${esc(node.content ?? '')}</textarea>
    </div>
    <div class="form__field">
      <label class="form__label">新增扩展字段 <small>（已有 ${extKeys.length} 个键被锁定）</small></label>
      ${extRowsHtml([{ key: '', value: '' }], extKeys)}
    </div>
    <div class="form__actions">
      <button type="button" class="btn" data-action="cancel-edit">取消</button>
      <button type="submit" class="btn btn--primary">${icon('<path d="m2.8 8.4 3.4 3.4 7-7.6"/>')}保存 · 生成新版本</button>
    </div>`
  return frag
}

function renderAddForm() {
  const parent = state.detail.node
  const frag = document.createElement('form')
  frag.className = 'form'
  frag.id = 'addForm'
  frag.innerHTML = `
    <div style="margin:2px 0 -4px;font-size:12.5px;color:var(--ink-faint)">
      在 <b class="serif">${esc(parent.title)}</b> 下新增子节点
    </div>
    <div class="form__row">
      <div class="form__field" style="grid-column:1/-1">
        <label class="form__label">标题 <small>（同级唯一，必填）</small></label>
        <input class="field__input" name="title" required placeholder="如 FR-023 短信验证码登录">
      </div>
    </div>
    <div class="form__row">
      <div class="form__field">
        <label class="form__label">类型</label>
        <select class="select" name="nodeType">
          ${NODE_TYPES.map((t) => `<option value="${t}" ${t === 'document' ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`).join('')}
        </select>
      </div>
      <div class="form__field">
        <label class="form__label">状态</label>
        <select class="select" name="status">
          ${STATUSES.map((s) => `<option value="${s}" ${s === 'draft' ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
        </select>
      </div>
      <div class="form__field">
        <label class="form__label">标签</label>
        <input class="field__input" name="tags" placeholder="P0, auth">
      </div>
    </div>
    <div class="form__field">
      <label class="form__label">描述</label>
      <textarea class="field__input" name="description" rows="2"></textarea>
    </div>
    <div class="form__field">
      <label class="form__label">正文</label>
      <textarea class="field__input" name="content" rows="6"></textarea>
    </div>
    <div class="form__field">
      <label class="form__label">扩展字段</label>
      ${extRowsHtml([{ key: '', value: '' }])}
    </div>
    <div class="form__actions">
      <button type="button" class="btn" data-action="cancel-edit">取消</button>
      <button type="submit" class="btn btn--primary">${icon('<path d="M8 3v10M3 8h10"/>')}创建节点</button>
    </div>`
  return frag
}

/* ---------- 右栏：版本水流 ---------- */

function renderRail() {
  const host = $('#railBody')
  const h = state.history
  // 没有选中节点，或只有 v1 创建版（无变更可看、无可回滚目标）时整栏隐藏，主区吃满宽度
  const hasSheets = Boolean(state.detail && h && (h.versions ?? []).length > 1)
  $('#rail').hidden = !hasSheets
  $('.stage')?.classList.toggle('is-rail-hidden', !hasSheets)
  if (!hasSheets) return
  const cur = state.detail.node
  const sheets = (h.versions ?? [])
    .map((v, i) => {
      const depth = Math.min(i, 4)
      const isCur = i === 0
      const fields = (v.fields ?? [])
        .map((f) => `<li class="${f.startsWith('*') ? 'is-life' : ''}">${esc(f)}</li>`)
        .join('')
      return `<div class="sheet ${isCur ? 'is-current' : ''} ${h.deleted ? 'is-deleted' : ''}" style="--depth:${depth}">
        <div class="sheet__head">
          <span class="sheet__ver">${isCur ? '✦ ' : ''}v${v.version}</span>
          <span class="sheet__when" title="${esc(v.updated_at)}">${esc(timeAgo(v.updated_at))}</span>
          ${v.users?.length ? `<span class="sheet__who">${esc(v.users.join('、'))}</span>` : ''}
        </div>
        ${fields ? `<ul class="sheet__fields">${fields}</ul>` : ''}
        ${!isCur && !h.deleted ? `<div class="sheet__act"><button class="btn btn--ghost" data-action="checkout" data-version="${v.version}" data-arm="回滚" style="font-size:11.5px">↩ 回滚到 v${v.version}</button></div>` : ''}
      </div>`
    })
    .join('')
  host.innerHTML = `
    <div class="sheets">${sheets}</div>
    <div class="rail__note">${h.total_versions} 个版本 · ${h.total_entries} 条变更${h.compacted ? ' · 更早版本已被 pack 压缩' : ''}${h.deleted ? ' · <span style="color:var(--danger)">节点已删除</span>' : ''}</div>`
}

/* ---------- 查询视图 ---------- */

function renderQueryView() {
  const frag = document.createElement('div')
  const q = state.query
  const tagChips = (state.tree?.tags ?? []).slice(0, 14)
  frag.innerHTML = `
    <h2 class="serif" style="font-size:20px;margin:2px 0 14px;font-weight:700">组合查询</h2>
    <div class="qbar">
      <div class="qbar__line">
        <div class="field field--search">
          ${icon('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>')}
          <input class="field__input" id="qKeyword" placeholder="关键词（标题 + 描述 + 正文）" value="${esc(q.keyword)}" spellcheck="false">
        </div>
        <div class="field">
          <input class="field__input field__input--mono" id="qExt" placeholder="扩展过滤 key=value（可多个，逗号分隔）" value="${esc(q.extText ?? '')}" spellcheck="false" style="min-width:230px">
        </div>
        <button class="btn" data-action="query-reset">重置</button>
      </div>
      <div class="qchips"><span class="qchips__label">类型</span>
        ${NODE_TYPES.map((t) => `<button class="qchip ${q.types.includes(t) ? 'is-on' : ''}" style="--c:var(${TYPE_COLOR[t]})" data-action="q-toggle" data-dim="types" data-val="${t}">${TYPE_LABEL[t]}</button>`).join('')}
      </div>
      <div class="qchips"><span class="qchips__label">状态</span>
        ${STATUSES.map((s) => `<button class="qchip ${q.statuses.includes(s) ? 'is-on' : ''}" style="--c:var(${STATUS_COLOR[s]})" data-action="q-toggle" data-dim="statuses" data-val="${s}">${STATUS_LABEL[s]}</button>`).join('')}
      </div>
      ${tagChips.length ? `<div class="qchips"><span class="qchips__label">标签</span>
        ${tagChips.map((t) => `<button class="qchip ${q.tags.includes(t) ? 'is-on' : ''}" style="--c:var(--accent)" data-action="q-toggle" data-dim="tags" data-val="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>` : ''}
    </div>
    <div class="qresults" id="qResults"></div>`
  // 稍后绑定关键词防抖
  requestAnimationFrame(() => {
    const kw = $('#qKeyword', frag)
    kw?.addEventListener('input', () => {
      clearTimeout(q._t)
      q._t = setTimeout(() => {
        q.keyword = kw.value
        runQuery()
      }, 320)
    })
    const ex = $('#qExt', frag)
    ex?.addEventListener('input', () => {
      clearTimeout(q._t2)
      q._t2 = setTimeout(() => {
        q.extText = ex.value
        runQuery()
      }, 320)
    })
  })
  return frag
}

/* 无数据包时的统一空态（空工作区如实展现，附带唯一合法入口：手动新建） */
function noPacketHtml(text) {
  return `<div class="empty">
    <div class="empty__glyph">${ICONS.folder}</div>
    <div class="empty__title">${esc(text ?? '尚无数据包')}</div>
    <p>工作区还没有数据包——点下方创建，或把 .dtp 文件放进工作区。</p>
    <p><button class="btn btn--primary" data-action="new-packet">✦ 新建数据包</button></p>
  </div>`
}

function renderQueryResults() {
  const host = $('#qResults')
  if (!host) return
  const r = state.query.results
  if (state.query.loading) {
    host.innerHTML = `<div class="qresults__count qresults__count--loading">查询中…</div>`
    return
  }
  if (!state.packet) {
    host.innerHTML = noPacketHtml('没有可查询的数据包')
    return
  }
  if (!r) {
    host.innerHTML = `<div class="qresults__count">同一维度多个取值为「或」，跨维度为「与」。</div>`
    return
  }
  if (!r.count) {
    host.innerHTML = `<div class="empty" style="padding:32px"><div class="empty__title">没有命中</div><p>放宽一两个维度，或清空关键词再试。</p></div>`
    return
  }
  host.innerHTML = `
    <div class="qresults__count">命中 ${r.count}${r.total > r.count ? ` / ${r.total}` : ''} 个节点 · 点击跳转</div>
    ${r.nodes
      .map((n, i) => {
        const tc = `var(${TYPE_COLOR[n.node_type] ?? '--c-document'})`
        const sc = `var(${STATUS_COLOR[n.status] ?? '--c-draft'})`
        return `<div class="qrow" data-action="select" data-id="${esc(n.id)}" style="--i:${Math.min(i, 14)}">
          <span class="tree__icon" style="--tc:${tc};stroke:${tc}">${ICONS[n.node_type] ?? ICONS.document}</span>
          <span class="qrow__title">${esc(n.title)}</span>
          <span class="qrow__path">${esc(n.path)}</span>
          <span class="qrow__meta">
            <span class="chip chip--plain">v${n.version}</span>
            <span class="tree__dot" style="--sc:${sc}" title="${esc(STATUS_LABEL[n.status])}"></span>
          </span>
        </div>`
      })
      .join('')}`
}

async function runQuery() {
  const q = state.query
  if (!state.packet) {
    q.results = null
    q.loading = false
    renderQueryResults()
    return
  }
  const params = { p: state.packet }
  if (q.keyword.trim()) params.keyword = q.keyword.trim()
  for (const t of q.types) (params.type ??= []).push(t)
  for (const s of q.statuses) (params.status ??= []).push(s)
  for (const t of q.tags) (params.tag ??= []).push(t)
  if (q.extText?.trim()) params.ext = splitTags(q.extText)
  const seq = (q._seq = (q._seq ?? 0) + 1)
  state.query.results = null
  state.query.loading = true
  renderQueryResults()
  try {
    const data = await api('/api/query', { params })
    if (seq !== q._seq) return // 已有更新的查询发出，丢弃过期响应
    state.query.results = data
  } catch (e) {
    if (seq === q._seq) toast(e.message, 'err')
  } finally {
    if (seq === q._seq) {
      state.query.loading = false
      renderQueryResults()
    }
  }
}

/* ---------- 统计视图 ---------- */

async function fillStats(host) {
  if (!state.packet) {
    host.innerHTML = noPacketHtml('没有可统计的数据包')
    return
  }
  host.innerHTML = `<div class="empty"><div class="empty__glyph">${ICONS.index}</div><div class="empty__title">汇集中…</div></div>`
  if (!state.statsCache || state.statsCache.packet !== state.packet) {
    try {
      const data = await api('/api/stats', { params: { p: state.packet } })
      state.statsCache = { packet: state.packet, data }
    } catch (e) {
      host.innerHTML = `<div class="empty fade-swap"><div class="empty__title">统计失败</div><p>${esc(e.message)}</p></div>`
      return
    }
  }
  const s = state.statsCache.data
  const maxDay = Math.max(1, ...Object.values(s.by_day ?? {}))
  const days = []
  const today = new Date()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400e3).toISOString().slice(0, 10)
    days.push({ d, n: s.by_day[d] ?? 0 })
  }
  const distRows = (obj, colorMap, labelMap) =>
    Object.entries(obj ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(
        ([k, v]) => `<div class="distrow">
          <span class="distrow__name"><span class="tree__dot" style="--sc:var(${colorMap[k] ?? '--c-draft'})"></span>${esc(labelMap?.[k] ?? k)}</span>
          <span class="distrow__track"><span class="distrow__fill" style="--c:var(${colorMap[k] ?? '--c-draft'});width:${Math.round((v / Math.max(1, s.nodes)) * 100)}%"></span></span>
          <span class="distrow__val">${v}</span>
        </div>`
      )
      .join('') || '<div class="distrow__name">（空）</div>'

  const users = Object.entries(s.users ?? {}).sort((a, b) => b[1] - a[1])

  host.innerHTML = `
    <h2 class="serif" style="font-size:20px;margin:2px 0 14px;font-weight:700">${esc(s.meta.name)} · 全景</h2>
    <div class="statsgrid">
      <div class="statcard statcard--span4">
        <div class="statcard__title">规模</div>
        <div class="statrow">
          <div><div class="bignum">${s.nodes}<small>存活节点</small></div></div>
          <div><div class="bignum">${s.versions}<small>版本快照</small></div></div>
          <div><div class="bignum">${s.changelog}<small>变更记录</small></div></div>
        </div>
        <dl class="kv" style="margin-top:14px">
          <dt>已删除节点</dt><dd>${s.deleted}</dd>
          <dt>树深度</dt><dd>${s.max_depth} 层</dd>
          <dt>数据包版本</dt><dd class="mono">${esc(s.meta.version)}</dd>
        </dl>
      </div>
      <div class="statcard statcard--span8">
        <div class="statcard__title">最近 14 天变更流量</div>
        <div class="spark">
          ${days.map((x, i) => `<div class="spark__col" title="${x.d} · ${x.n} 次变更">
            <div class="spark__bar" style="height:${Math.max(3, Math.round((x.n / maxDay) * 76))}px;--i:${i}"></div>
            <div class="spark__date">${x.d.slice(5)}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="statcard statcard--span4"><div class="statcard__title">状态分布</div><div class="distbar">${distRows(s.by_status, STATUS_COLOR, STATUS_LABEL)}</div></div>
      <div class="statcard statcard--span4"><div class="statcard__title">类型分布</div><div class="distbar">${distRows(s.by_type, TYPE_COLOR, TYPE_LABEL)}</div></div>
      <div class="statcard statcard--span4">
        <div class="statcard__title">高频标签</div>
        <div class="tagcloud">
          ${(s.by_tag ?? []).slice(0, 14).map((t) => `<span class="chip" style="--c:var(--accent)">${esc(t.tag)}<b>${t.count}</b></span>`).join('') || '<span class="chip chip--plain">无标签</span>'}
        </div>
        ${users.length ? `<div class="statcard__title" style="margin-top:18px">贡献者</div>
        <div class="distbar">${users.map(([u, c]) => `<div class="distrow"><span class="distrow__name">${esc(u)}</span><span class="distrow__track"><span class="distrow__fill" style="--c:var(--c-knowledge);width:${Math.round((c / users[0][1]) * 100)}%"></span></span><span class="distrow__val">${c}</span></div>`).join('')}</div>` : ''}
      </div>
      <div class="statcard statcard--span8">
        <div class="statcard__title">最近变更</div>
        <div class="feed">
          ${s.recent.map((r) => `<div class="feed__row">
            <span class="feed__when">${esc(timeAgo(r.timestamp))}</span>
            <span class="feed__what"><b>${esc(r.node_title ?? shortId(r.node_id))}</b>${r.deleted ? ' <span style="color:var(--ink-ghost)">（已删）</span>' : ''}</span>
            <span class="feed__field">${esc(r.field)}</span>
            <span class="feed__who">${esc(r.user ?? '—')}</span>
          </div>`).join('')}
        </div>
      </div>
      <div class="statcard statcard--span4">
        <div class="statcard__title">数据包档案</div>
        <dl class="kv">
          <dt>packet_id</dt><dd class="mono" style="font-size:11px">${esc(s.meta.packet_id)}</dd>
          <dt>根节点</dt><dd class="mono">${esc(s.meta.root_node_id)}</dd>
          <dt>创建</dt><dd>${esc(fmtDate(s.meta.created_at))}</dd>
          <dt>最近写入</dt><dd>${esc(fmtDate(s.meta.updated_at))}</dd>
          ${(s.meta.metadata && Object.keys(s.meta.metadata).length)
            ? Object.entries(s.meta.metadata).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</dd>`).join('')
            : ''}
        </dl>
      </div>
    </div>`
}

/* ---------- 模版视图 ---------- */

// 渲染分两层：fillTemplateView 整视图 + 局部填充器（#tplList/#tplBindCard/#tplProblems/
// #tplLint/#tplDirty）。异步回调只重写自己的容器，不重建编辑器，避免打断输入焦点。
async function fillTemplateView(host) {
  const t = state.tpl
  host.innerHTML = `<div class="empty"><div class="empty__glyph">${ICONS.knowledge}</div><div class="empty__title">汇集中…</div></div>`
  if (t.list == null || t.packet !== state.packet) {
    try {
      t.list = await api('/api/templates')
      t.packet = state.packet
    } catch (e) {
      host.innerHTML = `<div class="empty fade-swap"><div class="empty__title">模版列表加载失败</div><p>${esc(e.message)}</p></div>`
      return
    }
  }
  if (!t.current) t.current = t.list.templates[0]?.file ?? null
  if (t.current && t.loadedFile !== t.current) await loadTemplateContent()

  host.innerHTML = `
    <h2 class="serif" style="font-size:20px;margin:2px 0 6px;font-weight:700">模版 · 数据包格式约定</h2>
    <p class="tpl-lead">schema 声明骨架容器与字段规则（DSL v1）；数据包绑定模版后可随时 lint 校验符合性。schema 文件保存在工作区 <code class="mono">templates/</code> 目录，与 CLI 完全互通。</p>
    <div class="tplview">
      <div class="tplside">
        <div class="statcard">
          <div class="statcard__title tplside__title">模版 · ${t.list.templates.length}
            <button class="btn btn--ghost" style="font-size:11.5px;padding:3px 10px" data-action="tpl-new">${icon('<path d="M8 3v10M3 8h10"/>')}新建</button>
          </div>
          <div class="tpllist" id="tplList">${tplListHtml()}</div>
        </div>
        <div class="statcard" id="tplBindCard">${tplBindHtml()}</div>
      </div>
      <div class="tplmain">
        <div class="statcard">${tplEditorHtml()}</div>
        <div class="statcard" style="margin-top:14px">
          <div class="statcard__title tplside__title">模版符合性 · lint
            <button class="btn btn--ghost" style="font-size:11.5px;padding:3px 10px" data-action="tpl-lint" ${state.packet ? '' : 'disabled'}>${icon('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.8 1.8v3h-3"/>')}运行</button>
          </div>
          <div id="tplLint">${tplLintHtml()}</div>
        </div>
      </div>
    </div>`

  const area = host.querySelector('#tplArea')
  if (area) {
    // 内容用 JS 赋值而非 innerHTML：textarea 开标签后的首个换行会被 HTML 解析器吞掉
    area.value = t.content
    area.addEventListener('input', () => {
      t.content = area.value
      t.dirty = area.value !== t.savedContent
      renderTplDirty()
      updateTplHl(area)
    })
    area.addEventListener('scroll', () => syncTplScroll(area), { passive: true })
    // 中文输入法合成期间文字须可见：临时露出 textarea 文本、隐藏高亮层
    const code = area.closest('.tplcode')
    area.addEventListener('compositionstart', () => code?.classList.add('is-composing'))
    area.addEventListener('compositionend', () => {
      code?.classList.remove('is-composing')
      t.content = area.value
      t.dirty = area.value !== t.savedContent
      renderTplDirty()
      updateTplHl(area)
    })
    updateTplHl(area)
  }

  // 已绑定且尚未跑过 → 进视图自动 lint 一次（switchPacket/refreshTree 会重置）
  const bound = t.list.packet_template?.[state.packet]
  if (state.packet && bound && t.lint == null && t.lintErr == null && !t.lintLoading) runLint()
}

function tplListHtml() {
  const t = state.tpl
  return (
    t.list.templates
      .map((x) => {
        const active = x.file === t.current
        const badge = x.ok
          ? `<span class="pkbadge pkbadge--tpl" title="自检通过">${x.skeleton} 容器 · ${x.rules} 规则</span>`
          : `<span class="pkbadge pkbadge--err" title="${esc(x.problems.join('\n'))}">✕ ${x.problem_count} 问题</span>`
        const bound = x.bound_packets.length
          ? `<span class="tplrow__bound" title="已绑定：${esc(x.bound_packets.join('、'))}">◈ ${x.bound_packets.length} 包</span>`
          : ''
        return `<button class="tplrow ${active ? 'is-active' : ''}" data-action="tpl-pick" data-file="${esc(x.file)}" title="${esc(x.file)}">
          <span class="tplrow__name serif">${esc(x.name ?? x.file)}</span>
          <span class="tplrow__ver mono">${x.version ? `v${esc(x.version)}` : ''}</span>
          ${badge}${bound}
          <span class="tplrow__sub">${esc(x.file)} · ${timeAgo(x.mtime)}</span>
        </button>`
      })
      .join('') || `<div class="pkrow__empty">还没有模版<br><small>点「新建」生成一个 schema 骨架</small></div>`
  )
}

function tplBindHtml() {
  const t = state.tpl
  if (!state.packet) return `<div class="statcard__title">当前包绑定</div><p class="tpl-hint">尚未选择数据包。</p>`
  const cur = state.packets.find((p) => p.file === state.packet)
  const bind = t.list?.packet_template?.[state.packet]
  if (!bind) {
    return `<div class="statcard__title">当前包绑定</div>
      <p class="tpl-hint"><b class="serif">${esc(cur?.name ?? state.packet)}</b> 未绑定模版。<br>在右侧选中一个模版后点「绑定到此包」，或编辑时直接选「从此模版新建包」。</p>`
  }
  return `<div class="statcard__title">当前包绑定</div>
    <dl class="kv">
      <dt>数据包</dt><dd>${esc(cur?.name ?? state.packet)}</dd>
      <dt>模版</dt><dd><b class="serif">${esc(bind.name)}</b> <span class="mono">v${esc(bind.version)}</span></dd>
      ${bind.file ? `<dt>schema</dt><dd class="mono" style="font-size:11px">${esc(bind.file)}</dd>` : ''}
    </dl>`
}

/* ---------- schema 编辑器：JSON 语法高亮（透明 textarea 叠在高亮层上） ---------- */

// 词法级 tokenizer：不要求整体合法 JSON，编辑途中也能可靠着色
const JSON_TOKEN_RE = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g

function highlightJson(src) {
  let out = ''
  let last = 0
  JSON_TOKEN_RE.lastIndex = 0
  for (let m; (m = JSON_TOKEN_RE.exec(src)); ) {
    out += `<span class="tok-pun">${esc(src.slice(last, m.index))}</span>`
    if (m[1] !== undefined) {
      // 字符串后跟冒号 = 对象键
      if (m[2] !== undefined) out += `<span class="tok-key">${esc(m[1])}</span><span class="tok-pun">${esc(m[2])}</span>`
      else out += `<span class="tok-str">${esc(m[1])}</span>`
    } else if (m[3] !== undefined) out += `<span class="tok-num">${esc(m[3])}</span>`
    else out += `<span class="tok-lit">${esc(m[4])}</span>`
    last = JSON_TOKEN_RE.lastIndex
  }
  out += `<span class="tok-pun">${esc(src.slice(last))}</span>`
  return out
}

/* 重画高亮层与行号；行号槽/高亮层随 textarea 滚动平移（内容同源，几何天然对齐）。
   兄弟节点一律经 ta.closest('.tplcode') 解析：renderMain 的同步重建路径（tpl-pick 切模版 /
   离开模板视图再回来）在片段挂进文档前就会调用本函数，document.getElementById 那时查不到
   （query 视图 renderQueryResults 同款坑），高亮层会整块空白 */
function updateTplHl(ta) {
  if (!ta) return
  const wrap = ta.closest('.tplcode')
  const hl = wrap?.querySelector('.tplcode__hl code')
  if (!hl) return
  const gt = wrap?.querySelector('.tplcode__gutter-in')
  hl.innerHTML = highlightJson(ta.value) + '\n'
  if (gt) {
    const lines = ta.value.split('\n').length
    gt.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n') + '\n\n\n'
  }
  syncTplScroll(ta)
}

function syncTplScroll(ta) {
  if (!ta) return
  const wrap = ta.closest('.tplcode')
  const hl = wrap?.querySelector('.tplcode__hl code')
  if (!hl) return
  const gt = wrap?.querySelector('.tplcode__gutter-in')
  hl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
  if (gt) gt.style.transform = `translateY(${-ta.scrollTop}px)`
}

function tplEditorHtml() {
  const t = state.tpl
  if (!t.current) {
    return `<div class="empty" style="padding:26px"><div class="empty__title">未选择模版</div><p>左侧选择或新建一个 schema 开始编辑。</p></div>`
  }
  return `
    <div class="tplbar">
      <span class="tplbar__file mono">${esc(t.current)}</span>
      <span class="tpldirty ${t.dirty ? 'is-dirty' : ''}" id="tplDirty">${t.dirty ? '● 未保存' : '○ 已同步'}</span>
      <span class="tplbar__spacer"></span>
      <button class="btn btn--ghost" data-action="tpl-check" style="font-size:11.5px">自检</button>
      <button class="btn" data-action="tpl-save" style="font-size:11.5px">${icon('<path d="m2.8 8.4 3.4 3.4 7-7.6"/>')}保存</button>
      <button class="btn" data-action="tpl-bind" style="font-size:11.5px" ${state.packet ? '' : 'disabled'}>绑定到此包</button>
      <button class="btn btn--ghost" data-action="tpl-new-packet" style="font-size:11.5px">从此模版新建包</button>
    </div>
    <div class="tplcode" id="tplCode">
      <div class="tplcode__gutter" aria-hidden="true"><div class="tplcode__gutter-in" id="tplGutter"></div></div>
      <div class="tplcode__body">
        <pre class="tplcode__hl" aria-hidden="true"><code id="tplHl"></code></pre>
        <textarea class="tplcode__ta" id="tplArea" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="schema JSON 编辑器"></textarea>
      </div>
    </div>
    <div id="tplProblems" style="margin-top:10px">${tplProblemsHtml()}</div>`
}

function tplProblemsHtml() {
  const t = state.tpl
  if (!t.problems.length) {
    return `<div class="tpl-ok">${icon('<path d="m2.8 8.4 3.4 3.4 7-7.6"/>')} 自检通过 —— ${esc(t.name ?? t.current ?? '')}${t.version ? ` v${esc(t.version)}` : ''} · ${t.skeleton ?? 0} 容器 · ${t.rules ?? 0} 规则</div>`
  }
  return `<div class="tpl-problems">
    <div class="tpl-problems__head">自检发现 ${t.problems.length} 处问题${t.problemTotal > t.problems.length ? `（仅显示前 ${t.problems.length} 条，完整列表见「自检」）` : ''}：</div>
    <ol>${t.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>
  </div>`
}

function tplLintHtml() {
  const t = state.tpl
  if (t.lintLoading) return `<div class="qresults__count qresults__count--loading">校验中…</div>`
  if (t.lintErr) {
    const e = t.lintErr
    const actionable = ['TEMPLATE_MISSING', 'SCHEMA_DRIFT', 'SCHEMA_INVALID'].includes(e.code)
    return `<div class="linterr">
      <div class="linterr__code mono">${esc(e.code ?? '')}</div>
      <div class="linterr__msg">${esc(e.message)}</div>
      ${actionable ? `<button class="btn" style="font-size:11.5px;margin-top:10px" data-action="tpl-bind" ${state.packet && t.current ? '' : 'disabled'}>${icon('<path d="M8 1.8 13 3.6v4.2c0 3.1-2.1 5.3-5 6.4-2.9-1.1-5-3.3-5-6.4V3.6Z"/>')}绑定当前模版并重试</button>` : ''}
    </div>`
  }
  if (!t.lint) return `<p class="tpl-hint">运行 lint 检查当前数据包对模版的符合性（骨架 / 字段 / 引用 / 编号连续性）。</p>`
  const r = t.lint
  const errs = r.violations.filter((v) => v.severity === 'error')
  const warns = r.violations.filter((v) => v.severity !== 'error')
  const head = `<div class="linthead">
    <span class="serif" style="font-weight:700">${esc(r.template?.name ?? '')} <span class="mono" style="font-size:11px;color:var(--ink-faint)">v${esc(r.template?.version ?? '')}</span></span>
    <span class="linthead__badges">
      ${r.error_count === 0 ? `<span class="pkbadge pkbadge--tplok">✓ 符合模版</span>` : `<span class="pkbadge pkbadge--err">✕ ${r.error_count} 违规</span>`}
      ${r.warn_count ? `<span class="pkbadge pkbadge--warn">⚠ ${r.warn_count} 告警</span>` : ''}
    </span>
  </div>`
  if (!r.violations.length) return head
  const row = (v, i) => {
    const isErr = v.severity === 'error'
    const nodeChip = v.node_id
      ? state.byId.has(v.node_id)
        ? `<button class="lintnode" data-action="select" data-id="${esc(v.node_id)}" title="跳转节点">${esc(state.byId.get(v.node_id).title)}</button>`
        : `<span class="lintnode lintnode--dead" title="节点不存在（已删除或墓碑）">${esc(shortId(v.node_id))}</span>`
      : ''
    const driftBtn =
      v.rule === 'schema.drift'
        ? ` <button class="btn btn--ghost" style="font-size:11px;padding:2px 9px" data-action="tpl-bind">重新绑定</button>`
        : ''
    return `<div class="lintrow ${isErr ? 'lintrow--err' : 'lintrow--warn'}" style="--i:${Math.min(i, 12)}">
      <span class="lintrow__mark">${isErr ? icon('<path d="M4 4l8 8M12 4l-8 8"/>') : icon('<path d="M8 2 15 14H1Z"/><path d="M8 6.5v3.2M8 11.8v.2"/>')}</span>
      <span class="lintrow__rule mono">${esc(v.rule)}</span>
      ${nodeChip}
      <span class="lintrow__msg">${esc(v.message)}${driftBtn}</span>
      ${v.hint ? `<div class="lintrow__hint">${esc(v.hint)}</div>` : ''}
    </div>`
  }
  return `${head}<div class="lintlist">${errs.map((v, i) => row(v, i)).join('')}${warns.map((v, i) => row(v, i + errs.length)).join('')}</div>`
}

/* 局部填充器：元素不在文档（已切视图）时静默跳过 */
function renderTplPart(id, html) {
  const el = document.getElementById(id)
  if (el) el.innerHTML = html
}
function renderTplDirty() {
  const el = document.getElementById('tplDirty')
  if (el) {
    el.classList.toggle('is-dirty', state.tpl.dirty)
    el.textContent = state.tpl.dirty ? '● 未保存' : '○ 已同步'
  }
}

function applyTplResponse(r) {
  const t = state.tpl
  t.problems = r.problems ?? []
  t.ok = r.schema_ok !== false
  t.problemTotal = r.problems?.length ?? 0
  if (r.name !== undefined) {
    t.name = r.name ?? null
    t.version = r.version ?? null
    t.skeleton = r.skeleton ?? 0
    t.rules = r.rules ?? 0
  }
}

// 拉取当前选中模版的内容（列表默认选中 / 外部文件变化后 loadedFile 对不上时）
async function loadTemplateContent() {
  const t = state.tpl
  if (!t.current) return
  // 兜底初始化：++undefined = NaN 且 NaN !== NaN 恒真，seq 守卫会永远提前返回
  const seq = (t._loadSeq = (t._loadSeq ?? 0) + 1)
  try {
    const r = await api('/api/template', { params: { file: t.current } })
    if (seq !== t._loadSeq) return
    t.current = r.file
    t.content = r.content
    t.savedContent = r.content
    t.loadedFile = r.file
    t.dirty = false
    applyTplResponse(r)
  } catch (e) {
    toast(`读取模版失败：${e.message}`, 'err')
  }
}

// 显式切换模版（列表行点击）：整视图重绘
async function loadTemplate(file) {
  const t = state.tpl
  const seq = (t._loadSeq = (t._loadSeq ?? 0) + 1)
  try {
    const r = await api('/api/template', { params: { file } })
    if (seq !== t._loadSeq) return
    t.current = r.file
    t.content = r.content
    t.savedContent = r.content
    t.loadedFile = r.file
    t.dirty = false
    applyTplResponse(r)
    renderMain({ fade: true })
  } catch (e) {
    toast(`读取模版失败：${e.message}`, 'err')
  }
}

async function refreshTemplates() {
  const t = state.tpl
  try {
    t.list = await api('/api/templates')
    t.packet = state.packet
  } catch {
    return
  }
  renderTplPart('tplList', tplListHtml())
  renderTplPart('tplBindCard', tplBindHtml())
}

async function runLint() {
  const t = state.tpl
  if (!state.packet) return
  const seq = ++t._seq
  t.lintLoading = true
  t.lint = null
  t.lintErr = null
  renderTplPart('tplLint', tplLintHtml())
  try {
    const r = await api('/api/lint', { params: { p: state.packet } })
    if (seq !== t._seq) return
    t.lint = r
  } catch (e) {
    if (seq !== t._seq) return
    t.lintErr = e
  } finally {
    if (seq === t._seq) {
      t.lintLoading = false
      renderTplPart('tplLint', tplLintHtml())
    }
  }
}

async function doTplCheck() {
  const t = state.tpl
  try {
    const r = await api('/api/template/check', { method: 'POST', body: { content: t.content } })
    applyTplResponse(r)
    renderTplPart('tplProblems', tplProblemsHtml())
    toast(r.schema_ok ? `自检通过（${r.skeleton} 容器 · ${r.rules} 规则）` : `自检发现 ${r.problems.length} 处问题`, r.schema_ok ? 'ok' : 'err')
  } catch (e) {
    toast(`${e.code ?? ''} ${e.message}`, 'err')
  }
}

async function doTplSave() {
  const t = state.tpl
  try {
    const r = await api('/api/template/save', { method: 'POST', body: { file: t.current, content: t.content } })
    t.savedContent = t.content
    t.dirty = false
    applyTplResponse(r)
    renderTplDirty()
    renderTplPart('tplProblems', tplProblemsHtml())
    toast(r.schema_ok ? '已保存，自检通过' : `已保存，但仍有 ${r.problems.length} 处自检问题`, r.schema_ok ? 'ok' : 'err')
    refreshTemplates()
  } catch (e) {
    toast(`${e.code ?? ''} ${e.message}`, 'err')
  }
}

// targetFile 缺省为编辑器当前模版；lint 漂移恢复场景传入包内绑定记录的模版（重绑"它"而非"当前选中的"）
async function doTplBind(targetFile) {
  const t = state.tpl
  const file = targetFile || t.current
  try {
    const r = await api('/api/template/bind', { method: 'POST', body: { packet: state.packet, template: file } })
    toast(`${r.rebound ? '已更新绑定' : '已绑定'}：${r.template?.name ?? ''} v${r.template?.version ?? ''} → ${state.packet}`)
    await Promise.all([loadPackets(), refreshTemplates()])
    runLint()
  } catch (e) {
    toast(`${e.code ?? ''} ${e.message}`, 'err')
  }
}

// 漂移/丢失恢复的目标：优先包内绑定记录的 schema（重绑原模版），编辑器选中的兜底
const reboundTplFile = () =>
  state.tpl.list?.packet_template?.[state.packet]?.file || state.tpl.current || null

function openTplNewPanel() {
  openSlideover(
    '新建模版',
    `<form class="form" id="tplNewForm">
      <div class="form__field">
        <label class="form__label">模版名 <small>（非空，不含空格与 /）</small></label>
        <input class="field__input" name="name" required placeholder="如 weekly">
      </div>
      <p class="tpl-hint" style="margin:0 0 6px">将生成最小可跑的 schema 骨架（1 容器 + 1 示例规则），保存于 <code class="mono">templates/&lt;名&gt;.schema.json</code>，随后可在编辑器里调整规则。</p>
      <div class="form__actions">
        <button type="button" class="btn" data-action="close-slideover">取消</button>
        <button type="submit" class="btn btn--primary">✦ 生成</button>
      </div>
    </form>`
  )
}

/* ---------- 台账视图 ---------- */


const DROP_COLOR = { meta: '--c-index', node: '--c-folder', changelog: '--danger', delete: '--danger' }

async function fillLedger(host) {
  if (!state.packet) {
    host.innerHTML = noPacketHtml('没有可查台账的数据包')
    return
  }
  host.innerHTML = `<div class="empty"><div class="empty__glyph">${ICONS.index}</div><div class="empty__title">读取台账…</div></div>`
  let data
  try {
    data = await api('/api/ledger', { params: { p: state.packet, limit: 200 } })
  } catch (e) {
    host.innerHTML = `<div class="empty fade-swap"><div class="empty__title">台账读取失败</div><p>${esc(e.message)}</p></div>`
    return
  }
  const rowHtml = (l, i) => {
    const dc = `var(${DROP_COLOR[l.type] ?? '--c-draft'})`
    let main = ''
    if (l.type === 'node') main = `<b>${esc(l.title)}</b> <code>v${l.version} · ${esc(l.node_type)}</code>`
    else if (l.type === 'changelog') main = `<code>${esc(l.node_id ? shortId(l.node_id) : '?')}</code> ${esc(l.field)}`
    else if (l.type === 'meta') main = `<b>${esc(l.summary)}</b>`
    else if (l.type === 'delete') main = `<b style="color:var(--danger)">墓碑</b> <code>${esc(shortId(l.id))}</code>`
    else main = esc(l.summary ?? l.type)
    const clickable = l.type === 'node' && state.byId.has(l.id)
    return `<div class="stream__row is-${l.type} ${l.type === 'delete' ? 'is-deleted' : ''}" style="--dc:${dc};--i:${Math.min(i, 16)}${clickable ? ';cursor:pointer' : ''}" ${clickable ? `data-action="select" data-id="${esc(l.id)}"` : ''}>
      <span class="stream__no">${l.no}</span>
      <span class="stream__drop ${l.type === 'meta' ? 'stream__drop--meta' : ''}" style="--dc:${dc}"></span>
      <span class="stream__main">${main}</span>
      <span class="stream__user">${esc(l.user ?? (l.type === 'node' ? '' : ''))}</span>
      <span class="stream__when">${esc(l.timestamp ? timeAgo(l.timestamp) : '')}</span>
    </div>`
  }
  host.innerHTML = `
    <h2 class="serif" style="font-size:20px;margin:2px 0 6px;font-weight:700">台账 · append-only 水流</h2>
    <p style="margin:0 0 14px;color:var(--ink-faint);font-size:12.5px">
      数据包是单一 JSONL 文件，所有写操作只追加、从不改写历史。下方为文件尾部 200 行的实况（最新在上）：
      <span class="chip chip--plain" style="--c:var(--c-folder)">● node</span>
      <span class="chip chip--plain" style="--c:var(--accent)">● changelog</span>
      <span class="chip chip--plain" style="--c:var(--danger)">● node_delete</span>
      <span class="chip chip--plain" style="--c:var(--c-index)">● packet_meta</span>
    </p>
    <div class="ledgerhead">
      <span class="bignum">${data.total}<small>行</small></span>
      <span class="ledgerhead__item">体积 <b>${fmtBytes(data.size)}</b></span>
      <span class="ledgerhead__item">文件修改于 <b>${esc(fmtDate(data.mtime))}</b></span>
    </div>
    <div class="stream">${data.lines.map((l, i) => rowHtml(l, i)).join('')}</div>`
}

/* ---------- 滑出面板 ---------- */

function openSlideover(title, bodyHtml) {
  $('#scrim').hidden = false
  const so = $('#slideover')
  so.hidden = false
  so.innerHTML = `
    <div class="slideover__head">
      <span class="slideover__title">${title}</span>
      <button class="btn btn--icon btn--ghost" data-action="close-slideover">${icon('<path d="M4 4l8 8M12 4l-8 8"/>')}</button>
    </div>
    <div class="slideover__body">${bodyHtml}</div>`
}

function closeSlideover() {
  $('#scrim').hidden = true
  $('#slideover').hidden = true
  $('#slideover').innerHTML = ''
}

function openVerifyPanel(report) {
  const checks = report.checks
    .map(
      (c) => `<div class="check">
      <span class="check__mark check__mark--${c.ok ? 'ok' : 'bad'}">${c.ok ? icon('<path d="m3 8 3.2 3.2L13 4.4"/>') : icon('<path d="M8 3v6M8 12.4v.2"/>')}</span>
      <div style="min-width:0">
        <div class="check__name">${esc(c.name)}</div>
        ${c.details?.length ? `<ul class="check__details">${c.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>`
    )
    .join('')
  openSlideover(
    `校验报告 · ${report.ok ? '<span style="color:var(--ok)">完整</span>' : '<span style="color:var(--danger)">发现问题</span>'}`,
    `<div class="checklist">${checks}</div>
     ${report.warnings?.length ? `<div class="statcard" style="margin-top:14px"><div class="statcard__title">加载告警</div>${report.warnings.map((w) => `<p style="margin:4px 0;font-size:12px;color:var(--warn)">⚠ ${esc(w)}</p>`).join('')}</div>` : ''}
     <dl class="kv" style="margin-top:16px">
       <dt>节点</dt><dd>${report.nodes}</dd>
       <dt>版本快照</dt><dd>${report.versions}</dd>
       <dt>变更记录</dt><dd>${report.changelog_entries}</dd>
       <dt>墓碑</dt><dd>${report.deleted_nodes}</dd>
       <dt>体积</dt><dd>${fmtBytes(report.size)}</dd>
     </dl>`
  )
}

function openMovePanel() {
  const node = state.detail.node
  const forbidden = new Set([node.id, ...collectDescendants(node.id)])
  const candidates = state.tree.nodes
    .filter((n) => !forbidden.has(n.id) && n.id !== node.parent_id)
    .map((n) => {
      const depth = (n.path.match(/\//g) ?? []).length
      return { ...n, depth }
    })
  openSlideover(
    '移动子树',
    `<p style="margin:0 0 12px;color:var(--ink-faint);font-size:12.5px">为 <b class="serif">${esc(node.title)}</b> 选择新的父节点（整棵子树随行，路径索引自动更新）。</p>
     <div class="field field--search" style="margin-bottom:11px">${icon('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>')}<input class="field__input" id="moveFilter" placeholder="过滤目标路径" spellcheck="false"></div>
     <div class="movelist" id="moveList">
       ${candidates
         .map((c) => `<button class="movelist__row" data-action="mv-to" data-id="${esc(c.id)}" data-path="${esc(c.path)}" style="padding-left:${8 + Math.min(c.depth, 7) * 12}px">${esc(c.path)}</button>`)
         .join('')}
     </div>`
  )
  requestAnimationFrame(() => {
    $('#moveFilter')?.addEventListener('input', (e) => {
      const kw = e.target.value.trim().toLowerCase()
      $$('#moveList .movelist__row').forEach((b) => {
        b.style.display = !kw || b.dataset.path.toLowerCase().includes(kw) ? '' : 'none'
      })
    })
  })
}

function collectDescendants(id) {
  const out = []
  const walk = (pid) => {
    for (const cid of state.tree.children[pid] ?? []) {
      out.push(cid)
      walk(cid)
    }
  }
  walk(id)
  return out
}

async function openNewPacketPanel(tplFile) {
  // 模版下拉懒加载：未进过模版视图时现拉一次
  let templates = state.tpl.list?.templates ?? null
  if (!templates) {
    try {
      const data = await api('/api/templates')
      state.tpl.list = data
      state.tpl.packet = state.packet
      templates = data.templates
    } catch {
      templates = null // 拉不到就给空白包表单
    }
  }
  const tplSelect = templates?.length
    ? `<div class="form__field" style="grid-column:1/-1">
        <label class="form__label">模版 <small>（可选：按模版骨架建包并自动绑定）</small></label>
        <select class="select" name="template">
          <option value="">（空白包）</option>
          ${templates
            .map(
              (x) =>
                `<option value="${esc(x.file)}" ${x.file === tplFile ? 'selected' : ''} ${x.ok ? '' : 'disabled'}>${esc(x.name ?? x.file)}${x.ok ? `（${x.skeleton} 容器）` : '（自检未过）'}</option>`
            )
            .join('')}
        </select>
      </div>`
    : ''
  openSlideover(
    '新建数据包',
    `<form class="form" id="newPacketForm">
      <div class="form__field">
        <label class="form__label">包名 <small>（即根节点标题）</small></label>
        <input class="field__input" name="name" required placeholder="如 智能客服系统">
      </div>
      <div class="form__row">
        <div class="form__field">
          <label class="form__label">版本</label>
          <input class="field__input field__input--mono" name="version" value="v1.0.0">
        </div>
        <div class="form__field">
          <label class="form__label">文件名 <small>（可留空自动生成）</small></label>
          <input class="field__input field__input--mono" name="file" placeholder="客服系统.dtp">
        </div>
      </div>
      ${tplSelect}
      <div class="form__actions">
        <button type="button" class="btn" data-action="close-slideover">取消</button>
        <button type="submit" class="btn btn--primary">✦ 创建</button>
      </div>
    </form>`
  )
}

/* ---------- 写操作 ---------- */

const userName = () => (state.user || '').trim() || null

async function doUpdate(form) {
  const fd = new FormData(form)
  const body = {
    packet: state.packet,
    ref: state.detail.node.id,
    title: fd.get('title'),
    description: fd.get('description') ?? '',
    content: fd.get('content') ?? '',
    status: fd.get('status'),
    tags: splitTags(fd.get('tags')),
    user: userName(),
  }
  try {
    const ext = readExtEditor()
    if (Object.keys(ext).length) {
      body.ext = ext
      if ($('#forceExt')?.checked) body.forceExt = true
    }
  } catch (e) {
    toast(e.message || String(e), 'err')
    return
  }
  try {
    const r = await api('/api/update', { method: 'POST', body })
    if (!r.changed) {
      toast('内容无变化，未产生新版本')
    } else {
      toast(`已保存 → v${r.node.version}（${r.changes.map((c) => c.field).join('、')}）`)
    }
    await refreshTree()
  } catch (e) {
    toast(`${e.code ?? ''} ${e.message}`, 'err')
  }
}

async function doAdd(form) {
  const fd = new FormData(form)
  const body = {
    packet: state.packet,
    parentRef: state.detail.node.id,
    title: fd.get('title'),
    nodeType: fd.get('nodeType'),
    status: fd.get('status'),
    description: fd.get('description') ?? '',
    content: fd.get('content') ?? '',
    tags: splitTags(fd.get('tags')),
    user: userName(),
  }
  try {
    const ext = readExtEditor()
    if (Object.keys(ext).length) body.ext = ext
  } catch (e) {
    toast(e.message || String(e), 'err')
    return
  }
  try {
    const r = await api('/api/add', { method: 'POST', body })
    toast(`已创建「${r.node.title}」（${r.node.path}）`)
    state.expanded.add(state.detail.node.id)
    await refreshTree({ keepSelection: false })
    await selectNode(r.node.id, { silent: true })
  } catch (e) {
    toast(`${e.code ?? ''} ${e.message}`, 'err')
  }
}

async function doRm(id) {
  try {
    const r = await api('/api/rm', { method: 'POST', body: { packet: state.packet, ref: id, user: userName() } })
    toast(`已删除 ${r.removed.length} 个节点（含子孙）`)
    await refreshTree({ keepSelection: false })
    if (state.byId.has(state.tree.root_id)) await selectNode(state.tree.root_id, { silent: true })
  } catch (e) {
    toast(`${e.code ?? ''} ${e.message}`, 'err')
  }
}

async function doMv(targetId) {
  try {
    const r = await api('/api/mv', { method: 'POST', body: { packet: state.packet, ref: state.detail.node.id, newParentRef: targetId, user: userName() } })
    closeSlideover()
    toast(r.moved ? `已移动 → ${r.new_path}` : '已在目标位置，无变化')
    await refreshTree({ keepSelection: false })
    await selectNode(state.detail.node.id, { silent: true })
  } catch (e) {
    toast(`${e.code ?? ''} ${e.message}`, 'err')
  }
}

async function doCheckout(version) {
  try {
    const r = await api('/api/checkout', { method: 'POST', body: { packet: state.packet, ref: state.detail.node.id, version, user: userName() } })
    toast(r.changed ? `已回滚到 v${r.to}，生成新版本 v${r.node.version}（历史全部保留）` : '已在该版本')
    await refreshTree()
  } catch (e) {
    toast(`${e.code ?? ''} ${e.message}`, 'err')
  }
}

async function doVerify() {
  try {
    const r = await api('/api/verify', { params: { p: state.packet } })
    openVerifyPanel(r)
  } catch (e) {
    toast(`${e.code ?? ''} ${e.message}`, 'err')
  }
}

async function doExport(format, scope) {
  try {
    const params = { p: state.packet, format }
    if (scope !== 'packet' && state.detail?.node) params.ref = state.detail.node.id
    const r = await api('/api/export', { params })
    const name = (scope === 'packet' ? state.tree?.meta?.name : r.title) || 'export'
    const blob = new Blob([r.content], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    const url = URL.createObjectURL(blob)
    a.href = url
    a.download = `${name}.${format}`
    a.click()
    // 延迟释放：个别浏览器在 click 同步返回后才取 blob
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    toast(`已导出 ${a.download}（${fmtBytes(blob.size)}）`)
  } catch (e) {
    toast(`${e.code ?? ''} ${e.message}`, 'err')
  }
}

/* ---------- 视图切换 ---------- */

function setView(view) {
  if (view !== state.view && !confirmLeave()) return
  state.view = view
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === view))
  closeMenus()
  renderMain({ fade: true })
  if (view === 'query' && state.query.results === null) runQuery()
}

/* ---------- 未保存编辑保护 ---------- */

// 模版编辑器的脏检查（与节点编辑的 confirmLoseEdit 同款节奏）
function tplDirty() {
  return Boolean(state.tpl.dirty && state.tpl.current)
}

let loseTplArmedAt = 0
function confirmLoseTpl() {
  if (!tplDirty()) return true
  if (Date.now() - loseTplArmedAt < 2500) {
    loseTplArmedAt = 0
    return true
  }
  loseTplArmedAt = Date.now()
  toast('模版编辑器有未保存的修改——2.5 秒内再点一次将放弃并继续', 'err')
  return false
}

// 离开任何带未保存编辑的界面（节点表单 / 模版编辑器）前的统一守卫
function confirmLeave() {
  return confirmLoseTpl() && confirmLoseEdit()
}

// 编辑表单是否已被改动（与节点原值逐字段比对；新增表单只要有任何输入即算脏）
function editingDirty() {
  if (!state.editing) return false
  const f = state.editing.mode === 'edit' ? $('#editForm') : $('#addForm')
  if (!f) return false
  const extTyped = $$('#extEditor .ext-editor__row').some((row) => {
    const k = row.querySelector('[data-ext-key]')?.value.trim()
    const v = row.querySelector('[data-ext-val]')?.value.trim()
    return k || v
  })
  if (extTyped) return true
  const fd = new FormData(f)
  if (state.editing.mode === 'add') {
    return ['title', 'description', 'content', 'tags'].some((k) => String(fd.get(k) ?? '').trim())
  }
  const n = state.detail?.node
  if (!n) return false
  return (
    String(fd.get('title') ?? '') !== n.title ||
    String(fd.get('description') ?? '') !== (n.description ?? '') ||
    String(fd.get('content') ?? '') !== (n.content ?? '') ||
    String(fd.get('status') ?? '') !== n.status ||
    String(fd.get('tags') ?? '') !== (n.tags ?? []).join(', ')
  )
}

// 有未保存修改时要求 2.5s 内二次点击确认放弃（armThen 同款节奏，不打断无修改的路径）
let loseEditArmedAt = 0
function confirmLoseEdit() {
  if (!editingDirty()) return true
  if (Date.now() - loseEditArmedAt < 2500) {
    loseEditArmedAt = 0
    return true
  }
  loseEditArmedAt = Date.now()
  toast('有未保存的修改——2.5 秒内再点一次将放弃并继续', 'err')
  return false
}

/* ---------- 事件 ---------- */

function closeMenus() {
  $('#exportMenu').hidden = true
  closePacketMenu()
}

function bindEvents() {
  // 光随指动：指针位置的镜面高光（rAF 节流，避免 pointermove 每帧强制 layout）
  let litRaf = 0
  let litLastEv = null
  document.addEventListener('pointermove', (e) => {
    litLastEv = e
    if (litRaf) return
    litRaf = requestAnimationFrame(() => {
      litRaf = 0
      const ev = litLastEv
      litLastEv = null
      const el = ev?.target.closest?.('.glass--lit')
      if (!el) return
      const rect = el.getBoundingClientRect()
      el.style.setProperty('--mx', `${ev.clientX - rect.left}px`)
      el.style.setProperty('--my', `${ev.clientY - rect.top}px`)
      el.style.setProperty('--lit', '1')
    })
  })
  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest?.('.glass--lit')
    if (el) el.style.setProperty('--lit', '0')
  })

  // 树过滤
  $('#treeFilter').addEventListener('input', (e) => {
    clearTimeout(state._filterT)
    state._filterT = setTimeout(() => {
      state.filter = e.target.value
      $('#filterClear').hidden = !e.target.value
      e.target.closest('.field')?.classList.toggle('has-value', Boolean(e.target.value))
      buildTree()
    }, 140)
  })

  // 侧栏折叠初态（localStorage 记忆）
  applySidebarCollapsed()

  // 署名
  $('#userInput').value = state.user
  $('#userInput').addEventListener('input', (e) => {
    state.user = e.target.value
    localStorage.setItem('dtp.user', state.user)
  })

  // 窗口聚焦 / 标签页切回：探测外部（CLI）写入并自动刷新
  window.addEventListener('focus', probeExternalChanges)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) probeExternalChanges()
  })

  // 全局点击代理
  document.addEventListener('click', (e) => {
    // 菜单区域内的点击不触发自动关闭（开合由各 action 自管）
    if (!e.target.closest('.pkmenu, .menu')) closeMenus()
    const el = e.target.closest('[data-action]')
    if (!el) return
    const act = el.dataset.action
    const id = el.dataset.id
    switch (act) {
      case 'view': setView(el.dataset.view); break
      case 'toggle': e.stopPropagation(); toggleTreeRow(id); break
      case 'select':
        if (el.closest('.tree')) {
          // 树里点击已选中节点 = 折叠/展开
          if (id === state.selected) toggleTreeRow(id)
          else if (confirmLeave()) selectNode(id).catch((err) => toast(err.message, 'err'))
        } else {
          if (confirmLeave()) selectNode(id).catch((err) => toast(err.message, 'err'))
        }
        break
      case 'copy-id':
        navigator.clipboard?.writeText(id).then(() => toast('完整 ID 已复制'), () => toast('复制失败', 'err'))
        break
      case 'edit': state.editing = { mode: 'edit' }; renderMain({ fade: true }); break
      case 'add-child': state.editing = { mode: 'add' }; renderMain({ fade: true }); break
      case 'cancel-edit': state.editing = null; renderMain({ fade: true }); break
      case 'move': if (!el.disabled) openMovePanel(); break
      case 'mv-to': doMv(id); break
      case 'rm': armThen(el, '删除', () => doRm(state.detail.node.id)); break
      case 'checkout': armThen(el, '回滚', () => doCheckout(Number(el.dataset.version))); break
      case 'verify':
        el.classList.add('is-busy')
        doVerify().finally(() => el.classList.remove('is-busy'))
        break
      case 'new-packet': openNewPacketPanel(); break
      case 'close-slideover': closeSlideover(); break
      case 'packet-menu': {
        const wasOpen = !$('#pkPop').hidden
        closeMenus()
        if (!wasOpen) openPacketMenu()
        break
      }
      case 'pick-packet': {
        closeMenus()
        if (!el.dataset.file || el.dataset.file === state.packet) break
        switchPacket(el.dataset.file).catch((err) => toast(`${err.code ?? ''} ${err.message}`, 'err'))
        break
      }
      case 'toggle-theme': {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
        document.documentElement.dataset.theme = next
        localStorage.setItem('dtp.theme', next)
        break
      }
      case 'refresh': doRefresh([el]); break
      case 'toggle-sidebar': {
        state.sideCollapsed = !state.sideCollapsed
        localStorage.setItem('dtp.sidebar', state.sideCollapsed ? 'collapsed' : 'open')
        applySidebarCollapsed()
        break
      }
      case 'clear-filter': {
        const inp = $('#treeFilter')
        inp.value = ''
        state.filter = ''
        $('#filterClear').hidden = true
        inp.closest('.field')?.classList.remove('has-value')
        buildTree()
        inp.focus()
        break
      }
      case 'export-menu': {
        const m = $('#exportMenu')
        const wasOpen = !m.hidden
        closeMenus()
        m.hidden = wasOpen
        break
      }
      case 'export-doc': closeMenus(); doExport(el.dataset.format, el.dataset.scope); break
      case 'q-toggle': {
        const dim = el.dataset.dim
        const val = el.dataset.val
        const arr = state.query[dim]
        const i = arr.indexOf(val)
        if (i >= 0) arr.splice(i, 1)
        else arr.push(val)
        // 局部更新：只切 chip 状态并重跑结果，不重建视图（保焦点、保滚动）
        el.classList.toggle('is-on', arr.includes(val))
        runQuery()
        break
      }
      case 'query-reset': {
        Object.assign(state.query, { keyword: '', types: [], statuses: [], tags: [], extText: '', results: null })
        const kw = $('#qKeyword')
        const ex = $('#qExt')
        if (kw) kw.value = ''
        if (ex) ex.value = ''
        $$('.qchip').forEach((c) => c.classList.remove('is-on'))
        runQuery()
        break
      }
      case 'tpl-pick': {
        const f = el.dataset.file
        if (!f || f === state.tpl.current) break
        if (confirmLoseTpl()) loadTemplate(f)
        break
      }
      case 'tpl-new': openTplNewPanel(); break
      case 'tpl-check': doTplCheck(); break
      case 'tpl-save': doTplSave(); break
      case 'tpl-bind':
        if (!el.disabled) doTplBind(el.closest('#tplLint') ? reboundTplFile() : undefined)
        break
      case 'tpl-lint':
        if (!el.disabled) {
          el.classList.add('is-busy')
          runLint().finally(() => el.classList.remove('is-busy'))
        }
        break
      case 'tpl-new-packet': openNewPacketPanel(state.tpl.current); break
      case 'ext-add': {
        const editor = $('#extEditor')
        const row = document.createElement('div')
        row.className = 'ext-editor__row'
        row.innerHTML = `
          <input class="field__input field__input--mono" data-ext-key placeholder="键（如 owner）">
          <input class="field__input field__input--mono" data-ext-val placeholder='值（尝试 JSON，失败按字符串）'>
          <button type="button" class="btn btn--icon btn--ghost" data-action="ext-remove">${icon('<path d="M4 4l8 8M12 4l-8 8"/>')}</button>`
        editor.insertBefore(row, editor.querySelector('[data-action="ext-add"]'))
        row.querySelector('[data-ext-key]').focus()
        break
      }
      case 'ext-remove': {
        el.closest('.ext-editor__row')?.remove()
        break
      }
    }
  })

  // 表单提交
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'editForm') {
      e.preventDefault()
      doUpdate(e.target)
    } else if (e.target.id === 'addForm') {
      e.preventDefault()
      doAdd(e.target)
    } else if (e.target.id === 'newPacketForm') {
      e.preventDefault()
      const fd = new FormData(e.target)
      api('/api/init', {
        method: 'POST',
        body: {
          name: fd.get('name'),
          version: fd.get('version') || 'v1.0.0',
          file: fd.get('file') || undefined,
          template: fd.get('template') || undefined,
          user: userName(),
        },
      })
        .then(async (r) => {
          closeSlideover()
          toast(
            r.template
              ? `数据包「${r.meta.name}」已创建（按模版 ${r.template.name} · ${r.nodes} 节点，已自动绑定）`
              : `数据包「${r.meta.name}」已创建`
          )
          await Promise.all([loadPackets(), state.tpl.list ? refreshTemplates() : Promise.resolve()])
          await switchPacket(r.file, { silent: true })
        })
        .catch((err) => toast(`${err.code ?? ''} ${err.message}`, 'err'))
    } else if (e.target.id === 'tplNewForm') {
      e.preventDefault()
      const fd = new FormData(e.target)
      api('/api/template/new', { method: 'POST', body: { name: fd.get('name') } })
        .then(async (r) => {
          closeSlideover()
          toast(`模版「${r.name}」已生成 → ${r.file}`)
          await refreshTemplates()
          await loadTemplate(r.file)
        })
        .catch((err) => toast(`${err.code ?? ''} ${err.message}`, 'err'))
    }
  })

  // 遮罩 / Esc 关闭
  $('#scrim').addEventListener('click', closeSlideover)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#slideover').hidden) closeSlideover()
      else if (state.editing) {
        state.editing = null
        renderMain({ fade: true })
      }
      closeMenus()
      return
    }
    // 树键盘导航（浏览视图、非输入控件时）：↑↓ 移动选择、→ 展开、← 折叠/上跳、/ 聚焦过滤
    const tag = e.target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === '/') {
      e.preventDefault()
      if (state.sideCollapsed) {
        state.sideCollapsed = false
        localStorage.setItem('dtp.sidebar', 'open')
        applySidebarCollapsed()
      }
      $('#treeFilter')?.focus()
      return
    }
    if (state.view !== 'browse' || !state.tree) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const ids = visibleTreeIds()
      if (!ids.length) return
      const i = ids.indexOf(state.selected)
      const next = e.key === 'ArrowDown' ? ids[Math.min(i + 1, ids.length - 1)] : ids[Math.max(i - 1, 0)]
      if (next && next !== state.selected) selectNode(next).catch((err) => toast(err.message, 'err'))
    } else if (e.key === 'ArrowRight' && state.selected) {
      if (!state.expanded.has(state.selected) && state.tree.children[state.selected]?.length) toggleTreeRow(state.selected)
    } else if (e.key === 'ArrowLeft' && state.selected) {
      if (state.expanded.has(state.selected)) toggleTreeRow(state.selected)
      else {
        const pid = state.byId.get(state.selected)?.parent_id
        if (pid) selectNode(pid).catch((err) => toast(err.message, 'err'))
      }
    }
  })
}

// 当前树中可见（未折叠）的行 id 序列
function visibleTreeIds() {
  return $$('.tree__row')
    .filter((r) => {
      let el = r.parentElement
      while (el && el.id !== 'tree') {
        if (el.classList.contains('tree__kids') && !el.classList.contains('is-open')) return false
        el = el.parentElement
      }
      return true
    })
    .map((r) => r.dataset.id)
}

/* 二次确认：第一次点击武装（文案变化），3.5s 内再点执行 */
function armThen(el, verb, fn) {
  if (el.dataset.armed === '1') {
    delete el.dataset.armed
    fn()
    return
  }
  const original = el.innerHTML
  el.dataset.armed = '1'
  el.innerHTML = `再点一次确认${verb}`
  el.style.color = 'var(--danger)'
  setTimeout(() => {
    if (el.dataset.armed === '1') {
      delete el.dataset.armed
      el.innerHTML = original
      el.style.color = ''
    }
  }, 3500)
}

boot()
