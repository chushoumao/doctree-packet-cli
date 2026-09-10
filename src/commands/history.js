import { DtpError } from '../errors.js'
import { color, shortId } from '../output.js'

function shortHash(h) {
  return h ? String(h).slice(0, 8) + '…' : '∅'
}

function displayValue(v) {
  if (v === null || v === undefined) return '∅'
  let s = typeof v === 'string' ? v : JSON.stringify(v)
  s = s.replace(/\r?\n/g, '\\n')
  if (s.length > 60) s = s.slice(0, 57) + '…'
  return s
}

// 从版本快照解析普通字段/扩展字段的旧值与新值。
// changelog 行本身只存哈希；版本快照（内存中全量在场）持有真实值，
// 按 entry.version 定位变更后快照、再取紧邻的前一版为变更前快照。
// 快照缺失（如 pack 后只剩最新版）时返回 null，调用方回退哈希显示。
function makeValueResolver(versions) {
  const byVersion = new Map(versions.map((v) => [v.version, v]))
  const byTimestamp = new Map(versions.map((v) => [v.updated_at, v]))
  const sorted = [...versions].sort((a, b) => a.version - b.version)
  return (e) => {
    const newSnap = (e.version != null ? byVersion.get(e.version) : null) ?? byTimestamp.get(e.timestamp)
    if (!newSnap) return null
    let oldSnap = null
    for (const v of sorted) {
      if (v.version < newSnap.version) oldSnap = v
      else break
    }
    // 前一版快照缺失且当前版本 >1：历史快照已被 pack 压缩，旧值不可考。
    // 返回 null 让调用方回退哈希显示，而非把「不可考」伪装成 ∅（空值）。
    if (!oldSnap && newSnap.version > 1) return null
    const read = (snap) => {
      if (!snap) return null
      if (e.field.startsWith('extensions.')) {
        return snap.extensions?.[e.field.slice('extensions.'.length)] ?? null
      }
      return snap[e.field] ?? null
    }
    return { old: read(oldSnap), new: read(newSnap) }
  }
}

function formatEntry(e, resolveValues) {
  switch (e.field) {
    case '*created':
      return `*created ${shortHash(e.new_hash)}`
    case '*deleted':
      return `*deleted（原哈希 ${shortHash(e.old_hash)}）`
    case '*moved':
      return `*moved ${e.old_path} → ${e.new_path}`
    case '*checkout':
      return `*checkout ← v${e.target_version}`
    default: {
      const vals = resolveValues ? resolveValues(e) : null
      if (vals) return `${e.field}: ${displayValue(vals.old)} → ${displayValue(vals.new)}`
      return `${e.field}: ${shortHash(e.old_hash)} → ${shortHash(e.new_hash)}`
    }
  }
}

export const command = {
  name: 'history',
  summary: '显示节点的变更历史（版本演进）',
  args: [{ name: 'node', required: true, desc: '节点 ID（唯一前缀）；已删除节点亦可查看' }],
  options: {
    limit: { arg: 'n', desc: '最多显示最近 n 个版本' },
  },
  example: 'dtp history fr001',
  run(ctx) {
    const packet = ctx.load()
    const id = packet.resolveIdAny(ctx.args.node)
    const versions = packet.versions.get(id) ?? []
    const entries = packet.changelog.filter((e) => e.node_id === id)

    // changelog 与版本的关联：优先 version 字段（精确），旧格式按同时间戳兜底
    const related = (v) =>
      entries.filter((e) => e.version === v.version || (e.version == null && e.timestamp === v.updated_at))
    const resolveValues = makeValueResolver(versions)
    const timeline = versions.map((v) => ({
      version: v.version,
      updated_at: v.updated_at,
      hash: v.hash,
      title: v.title,
      fields: related(v).map((e) => formatEntry(e, resolveValues)),
      users: [...new Set(related(v).map((e) => e.user).filter(Boolean))],
    }))
    timeline.reverse() // 最新在前
    let shown = timeline
    if (ctx.opts.limit !== undefined) {
      // 严格正整数：parseInt 会把 1.5/2abc/1e2 静默截断为 1/2/1
      const raw = String(ctx.opts.limit).trim()
      if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        throw new DtpError('USAGE', `--limit 需要是正整数，收到 "${ctx.opts.limit}"`)
      }
      shown = timeline.slice(0, Number(raw))
    }
    const deleted = packet.tombstones.has(id)
    // 最早版本号 >1 说明更早的版本快照已被 pack 压缩（append-only 文件仍保留其 changelog）
    const earliest = versions.length ? Math.min(...versions.map((v) => v.version)) : 1
    const compacted = earliest > 1

    ctx.out.ok(
      {
        node_id: id,
        versions: shown,
        total_versions: versions.length,
        total_entries: entries.length,
        deleted,
        compacted,
      },
      () => {
        const current = packet.nodes.get(id)
        const head = current
          ? `${shortId(id)}「${current.title}」当前 v${current.version}`
          : `${shortId(id)}（已删除）`
        console.log(`节点 ${head} · 共 ${versions.length} 个版本 · ${entries.length} 条变更记录`)
        if (compacted) {
          console.log(color.dim('  历史版本快照已压缩（仅保留最新），更早版本的字段值不可考，以哈希显示'))
        }
        for (const t of shown) {
          const who = t.users?.length ? ` ${color.cyan(t.users.join(','))}` : ''
          console.log(`  v${t.version}  ${color.dim(t.updated_at)}${who}  ${color.dim(shortHash(t.hash))}`)
          for (const f of t.fields) console.log(`        ${f}`)
        }
        if (deleted) {
          const del = entries.find((e) => e.field === '*deleted')
          if (del) console.log(color.red(`  已删除于 ${del.timestamp}`))
        }
      }
    )
  },
}
