// 子树导出：Markdown / HTML

function metaLine(n) {
  const parts = [`status: ${n.status}`]
  if (n.tags?.length) parts.push(`tags: ${n.tags.join(', ')}`)
  parts.push(`version: v${n.version}`)
  parts.push(`id: ${n.id.slice(0, 8)}`)
  return parts.join(' · ')
}

export function toMarkdown(packet, rootId) {
  const lines = []
  const walk = (id, depth) => {
    const n = packet.nodes.get(id)
    if (!n) return
    const level = Math.min(depth + 1, 6)
    lines.push('#'.repeat(level) + ' ' + n.title)
    lines.push('')
    lines.push('> ' + metaLine(n))
    if (n.description) {
      lines.push('')
      lines.push(
        '> ' +
          n.description
            .split('\n')
            .map((l) => l.trim())
            .join('\n> ')
      )
    }
    if (n.content) {
      lines.push('')
      lines.push(n.content)
    }
    lines.push('')
    for (const c of packet.childrenOf(id)) walk(c.id, depth + 1)
  }
  walk(rootId, 0)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
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
  const name = packet.meta.name
  const toc = []
  const body = []
  const walk = (id, depth) => {
    const n = packet.nodes.get(id)
    if (!n) return
    const anchor = `node-${n.id.slice(0, 8)}`
    if (depth > 0) {
      while (toc.length <= depth) toc.push([])
      toc[depth].push({ anchor, title: n.title })
    }
    const level = Math.min(depth + 1, 6)
    const ext = Object.entries(n.extensions ?? {})
      .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(JSON.stringify(v))}`)
      .join(' · ')
    body.push(`    <section id="${anchor}" class="depth-${depth}">`)
    body.push(`      <h${level}>${escapeHtml(n.title)}</h${level}>`)
    body.push(`      <div class="meta">${escapeHtml(metaLine(n))}${ext ? ' · ' + ext : ''}</div>`)
    if (n.description) body.push(`      <blockquote>${escapeHtml(n.description).replaceAll('\n', '<br>')}</blockquote>`)
    if (n.content) body.push(`      <div class="content">\n      ${contentToHtml(n.content)}\n      </div>`)
    for (const c of packet.childrenOf(id)) walk(c.id, depth + 1)
    body.push('    </section>')
  }
  walk(rootId, 0)

  const tocHtml = toc
    .map(
      (lvl, i) =>
        `${'  '.repeat(i)}<ul>\n` +
        lvl.map((e) => `${'  '.repeat(i + 1)}<li><a href="#${e.anchor}">${escapeHtml(e.title)}</a></li>`).join('\n') +
        `\n${'  '.repeat(i)}</ul>`
    )
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(name)}</title>
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
  <h1>${escapeHtml(name)}</h1>
  <p class="meta">packet ${escapeHtml(packet.meta.packet_id)} · ${escapeHtml(packet.meta.version)} · ${packet.nodes.size} nodes</p>
  <nav>
    <strong>目录</strong>
${tocHtml}
  </nav>
  <main>
${body.join('\n')}
  </main>
</body>
</html>
`
}
