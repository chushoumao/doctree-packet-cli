import fs from 'node:fs'
import path from 'node:path'
import { DtpError } from '../errors.js'
import { readRawPacket, parsePacketText, withLock } from '../storage.js'

export const command = {
  name: 'unpack',
  summary: '将打包文件解包为可用数据包',
  args: [{ name: 'file', required: true, desc: '打包文件路径（支持 .gz）' }],
  options: {
    force: { short: 'f', desc: '覆盖已存在的目标文件（原文件先备份）' },
  },
  example: 'dtp unpack ./v1.0.0.dtp --packet ./restored.dtp',
  run(ctx) {
    const src = ctx.args.file
    if (!fs.existsSync(src)) throw new DtpError('NO_PACKET', `打包文件不存在：${src}`)
    const target = ctx.packetPath
    if (path.resolve(src) === path.resolve(target)) {
      throw new DtpError('USAGE', '目标文件不能与源文件相同')
    }
    if (fs.existsSync(target) && !ctx.opts.force) {
      throw new DtpError('EXISTS', `目标文件已存在：${target}（确需覆盖请加 --force）`)
    }
    const text = readRawPacket(src)
    const rec = parsePacketText(text, { source: src }) // 校验合法性
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true })
    withLock(target, () => {
      fs.writeFileSync(target, text, 'utf8')
    })
    ctx.out.ok(
      {
        source: src,
        output: target,
        nodes: rec.nodes.size,
        changelog_entries: rec.changelog.length,
      },
      () => console.log(`已解包 ${src} → ${target}（${rec.nodes.size} 个节点）`)
    )
  },
}
