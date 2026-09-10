import fs from 'node:fs'
import { parsePacket, listBackups } from '../storage.js'
import { Packet } from '../packet.js'
import { computeNodeHash } from '../model/node.js'
import { DtpError } from '../errors.js'

export const command = {
  name: 'verify',
  summary: '校验数据包完整性（哈希、父子引用、索引一致性）',
  args: [],
  options: {},
  example: 'dtp verify --packet ./客服系统.dtp',
  run(ctx) {
    const file = ctx.packetPath
    // 包缺失/路径是目录属于输入错误而非校验结果：走标准 NO_PACKET 错误契约，
    // 避免返回 warnings:[] 的 checks 形状误导按 warnings 判定的调用方
    if (!fs.existsSync(file)) {
      throw new DtpError('NO_PACKET', `数据包不存在：${file}（先用 dtp init 创建）`)
    }
    if (fs.statSync(file).isDirectory()) {
      throw new DtpError('NO_PACKET', `数据包路径是一个目录：${file}`)
    }
    const checks = []
    const add = (name, fn) => {
      try {
        const details = fn() ?? []
        checks.push({ name, ok: details.length === 0, details })
      } catch (e) {
        checks.push({ name, ok: false, details: [e.message] })
      }
    }

    let packet = null
    let rec = null
    add('JSONL 可解析', () => {
      rec = parsePacket(file)
      packet = new Packet(rec, file)
      return []
    })

    if (packet) {
      add('根节点存在', () =>
        packet.nodes.has(packet.meta.root_node_id)
          ? []
          : [`root_node_id ${packet.meta.root_node_id} 指向不存在的节点`]
      )
      add('父子引用完整', () => {
        const problems = []
        for (const n of packet.nodes.values()) {
          if (n.parent_id === null && n.id !== packet.meta.root_node_id) {
            problems.push(`多个根：节点 ${n.id} 的 parent_id 为空`)
          }
          if (n.parent_id === n.id) problems.push(`自引用：节点 ${n.id}`)
          if (n.parent_id != null && !packet.nodes.has(n.parent_id)) {
            problems.push(`悬空引用：节点 ${n.id} 的 parent_id ${n.parent_id} 不存在`)
          }
        }
        return problems
      })
      add('无环且从根全部可达', () => packet.structuralErrors.filter((e) => !e.includes('路径冲突')))
      add('语义路径唯一', () => packet.structuralErrors.filter((e) => e.includes('路径冲突')))
      add('节点哈希匹配', () => {
        const problems = []
        for (const n of packet.nodes.values()) {
          const actual = computeNodeHash(n)
          if (actual !== n.hash) {
            problems.push(
              `节点 ${n.id}（${n.title}）哈希不匹配（期望 ${String(n.hash).slice(0, 8)}…，实际 ${actual.slice(0, 8)}…）`
            )
          }
        }
        return problems
      })
      add('路径索引一致', () => {
        const problems = []
        for (const [p, id] of packet.pathIndex) {
          if (!packet.nodes.has(id)) problems.push(`路径 ${p} 指向不存在的节点 ${id}`)
          else if (packet.pathOf(id) !== p) problems.push(`路径 ${p} 与节点 ${id} 的实际路径不一致`)
        }
        return problems
      })
      add('版本号单调递增', () => {
        const problems = []
        for (const [id, list] of packet.versions) {
          for (let i = 1; i < list.length; i++) {
            if (list[i].version <= list[i - 1].version) {
              problems.push(`节点 ${id} 版本序列异常：v${list[i - 1].version} 之后出现 v${list[i].version}`)
            }
          }
        }
        return problems
      })
      add('变更日志引用有效', () => {
        const problems = []
        for (const e of packet.changelog) {
          if (!packet.versions.has(e.node_id)) {
            problems.push(`changelog 引用未知节点 ${e.node_id}（field=${e.field}）`)
          }
        }
        return problems
      })
    }

    const errors = checks.filter((c) => !c.ok)
    const ok = errors.length === 0
    const stat = fs.statSync(file)
    ctx.out.ok(
      {
        ok,
        file,
        size: stat?.size ?? 0,
        nodes: packet?.nodes.size ?? 0,
        versions: [...(rec?.versions.values() ?? [])].reduce((s, v) => s + v.length, 0),
        changelog_entries: rec?.changelog.length ?? 0,
        deleted_nodes: rec?.tombstones.size ?? 0,
        warnings: rec?.warnings ?? [],
        checks,
      },
      () => {
        for (const c of checks) {
          console.log(`${c.ok ? '✓' : '✗'} ${c.name}`)
          for (const d of c.details) console.log(`    ${d}`)
        }
        for (const w of rec?.warnings ?? []) console.log(`⚠ ${w}`)
        console.log(
          ok
            ? `\n数据包完整：${packet.nodes.size} 个节点 · ${packet.changelog.length} 条变更记录`
            : listBackups(file).length
              ? `\n发现 ${errors.length} 项问题（可尝试 dtp recover 从备份恢复）`
              : `\n发现 ${errors.length} 项问题（无可用备份；请从源文件或快照重新获取）`
        )
      }
    )
    if (!ok) process.exitCode = 1
  },
}
