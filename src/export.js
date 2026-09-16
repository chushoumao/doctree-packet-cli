// 子树导出：Markdown / HTML

function metaLine(n) {
  const parts = [`status: ${n.status}`]
  if (n.tags?.length) parts.push(`tags: ${n.tags.join(', ')}`)
  parts.push(`version: v${n.version}`)
  parts.push(`id: ${n.id.slice(0, 8)}`)
  return parts.join(' · ')
}

// md 行内转义（US-004 OPTIM-015）：标题文本中的语法字符防下游渲染成强调/链接/代码/层级。
// 转义集 = 标题行内具有行内语法含义的最小集：\ ` * _ [ ] # < ~。
// 反斜杠转义仅对 ASCII 标点生效——常规中英文标题零反斜杠噪音，渲染输出与原文一致（可还原）
const escapeMdInline = (s) => String(s ?? '').replace(/[\\`*_[\]#<>~]/g, (c) => '\\' + c)

export function toMarkdown(packet, rootId) {
  // ISSUE-019：按节点分块拼接，content 原样嵌入（仅 trim 拼接边界），
  // 不做全文空行压缩——原 replace(/\n{3,}/g) 会无差别作用于正文/代码块内部，静默改写原文
  const blocks = []
  const walk = (id, depth) => {
    const n = packet.nodes.get(id)
    if (!n) return
    const level = Math.min(depth + 1, 6)
    const head = ['#'.repeat(level) + ' ' + escapeMdInline(n.title), '', '> ' + metaLine(n)]
    if (n.description) {
      head.push('', '> ' + n.description.split('\n').map((l) => l.trim()).join('\n> '))
    }
    const content = n.content ? String(n.content).trim() : ''
    blocks.push(content ? [...head, '', content].join('\n') : head.join('\n'))
    for (const c of packet.childrenOf(id)) walk(c.id, depth + 1)
  }
  walk(rootId, 0)
  return blocks.join('\n\n') + '\n'
}

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function contentToHtml(content) {
  // 零依赖：不渲染 Markdown 语法，按空行分段、保留换行
  return String(content ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replaceAll('\n', '<br>')}</p>`)
    .join('\n      ')
}

export function toHtml(packet, rootId) {
  // OPTIM-014：title 取导出根标题（整包导出时等于包名，向后兼容）
  const rootTitle = packet.nodes.get(rootId)?.title ?? packet.meta.name
  // ISSUE-020：TOC 改为 li 内嵌套 ul 的树结构（原平级 ul 直嵌不合法且空格缩进被浏览器折叠）
  const tocRoot = { children: [] }
  const body = []
  const walk = (id, depth, tocParent) => {
    const n = packet.nodes.get(id)
    if (!n) return
    // ISSUE-021：anchor 用完整 id（唯一）；slice(0,8) 截断在自定义长 id 下可碰撞
    const anchor = `node-${n.id}`
    let tocEntry = tocParent
    if (depth > 0) {
      tocEntry = { anchor, title: n.title, children: [] }
      tocParent.children.push(tocEntry)
    }
    const level = Math.min(depth + 1, 6)
    const ext = Object.entries(n.extensions ?? {})
      .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(JSON.stringify(v))}`)
      .join(' · ')
    body.push(`    <section id="${escapeHtml(anchor)}" class="depth-${depth}">`)
    body.push(`      <h${level}>${escapeHtml(n.title)}</h${level}>`)
    body.push(`      <div class="meta">${escapeHtml(metaLine(n))}${ext ? ' · ' + ext : ''}</div>`)
    if (n.description) body.push(`      <blockquote>${escapeHtml(n.description).replaceAll('\n', '<br>')}</blockquote>`)
    if (n.content) body.push(`      <div class="content">\n      ${contentToHtml(n.content)}\n      </div>`)
    for (const c of packet.childrenOf(id)) walk(c.id, depth + 1, tocEntry)
    body.push('    </section>')
  }
  walk(rootId, 0, tocRoot)

  const renderToc = (entries) =>
    entries.length
      ? '\n<ul>\n' +
        entries
          .map(
            (e) =>
              `    <li><a href="#${escapeHtml(e.anchor)}">${escapeHtml(e.title)}</a>${renderToc(e.children)}</li>`
          )
          .join('\n') +
        '\n  </ul>'
      : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(rootTitle)}</title>
<style>
  body { font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #24292f; line-height: 1.7; }
  h1 { border-bottom: 2px solid #d0d7de; padding-bottom: .4rem; }
  nav { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 8px; padding: 1rem 1.5rem; margin: 1.5rem 0; }
  nav ul { margin: 0.2rem 0; padding-left: 1.2rem; }
  section { margin: 1.2rem 0; padding-left: 1rem; border-left: 3px solid #eaeef2; }
  .meta { color: #57606a; font-size: .85rem; }
  blockquote { color: #57606a; border-left: 3px solid #d0d7de; margin: .6rem 0; padding: .1rem .9rem; }
  .content p { margin: .6rem 0; }
</style>
</head>
<body>
  <p class="meta">packet ${escapeHtml(packet.meta.packet_id)} · ${escapeHtml(packet.meta.version)} · ${packet.nodes.size} nodes</p>
  <nav>
    <strong>目录</strong>${renderToc(tocRoot.children)}
  </nav>
  <main>
${body.join('\n')}
  </main>
</body>
</html>
`
}
