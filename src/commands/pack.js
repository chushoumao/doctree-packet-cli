import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { DtpError } from '../errors.js'
import { color } from '../output.js'
import { assertWritableOutput } from './_shared.js'

function defaultPackOutput(packetPath, gzip) {
  let base = path.basename(packetPath).replace(/\.gz$/, '')
  base = base.replace(/\.(dtp|jsonl)$/, '')
  return path.join(path.dirname(packetPath), `${base}.packed.dtp${gzip ? '.gz' : ''}`)
}

export const command = {
  name: 'pack',
  summary: '打包为压缩快照（仅保留各节点最新版本 + 完整 changelog）',
  args: [],
  options: {
    output: { arg: 'file', desc: '输出文件（默认 <包名>.packed.dtp）' },
    gzip: { desc: 'gzip 压缩（输出 .gz 文件；读取时自动解压）' },
  },
  example: ['dtp pack --output ./v1.0.0.dtp', 'dtp pack --gzip'],
  run(ctx) {
    const packet = ctx.load()
    const gzip = Boolean(ctx.opts.gzip)
    const output = ctx.opts.output ?? defaultPackOutput(ctx.packetPath, gzip)
    if (path.resolve(output) === path.resolve(ctx.packetPath)) {
      throw new DtpError('USAGE', '输出文件不能与源数据包相同')
    }
    assertWritableOutput(output)
    const { lines, droppedChangelog } = packet.compact()
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    const buf = gzip ? zlib.gzipSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8')
    fs.writeFileSync(output, buf)

    const tombstoned = packet.tombstones.size
    const keptChangelog = packet.changelog.length - droppedChangelog
    ctx.out.ok(
      {
        output,
        bytes: buf.length,
        nodes: packet.nodes.size,
        changelog_entries: keptChangelog,
        dropped_versions: [...packet.versions.values()].reduce((s, v) => s + v.length, 0) - packet.nodes.size,
        dropped_deleted: tombstoned,
        dropped_changelog: droppedChangelog,
        gzip,
      },
      () => {
        console.log(`已打包 ${packet.nodes.size} 个节点 → ${output} (${(buf.length / 1024).toFixed(1)} KB)`)
        console.log(
          color.dim(
            `保留 ${keptChangelog} 条变更记录（快照丢弃 ${droppedChangelog} 条已删节点记录）；` +
              '快照不含历史版本与已删除节点，完整历史请保留原始文件'
          )
        )
      }
    )
  },
}
