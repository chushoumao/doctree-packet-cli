import fs from 'node:fs'
import { DtpError } from '../errors.js'
import { listBackups, backupPacketFile, parsePacketText, readRawPacket, withLock } from '../storage.js'

export const command = {
  name: 'recover',
  summary: '从备份恢复数据包（每次写入前自动备份，保留最近 3 份）',
  args: [],
  options: {
    from: { arg: 'n', desc: '从第 n 份备份恢复（1 = 最近一次写入前的状态）' },
  },
  example: ['dtp recover', 'dtp recover --from 2'],
  run(ctx) {
    const file = ctx.packetPath
    const backups = listBackups(file)

    if (ctx.opts.from === undefined) {
      ctx.out.ok({ backups }, () => {
        if (!backups.length) {
          console.log(`没有可用备份（${file}.bak.1 … .bak.3）`)
          return
        }
        console.log(`可用备份（${file}）：`)
        for (const b of backups) {
          console.log(`  #${b.index}  ${b.mtime}  ${(b.size / 1024).toFixed(1)} KB`)
        }
        console.log('运行 dtp recover --from <n> 恢复（恢复前会先备份当前文件）')
      })
      return
    }

    const n = Number.parseInt(ctx.opts.from, 10)
    const chosen = backups.find((b) => b.index === n)
    if (!chosen) throw new DtpError('NOT_FOUND', `备份 #${ctx.opts.from} 不存在（可用：${backups.map((b) => b.index).join(', ') || '无'}）`)

    withLock(file, () => {
      const text = readRawPacket(chosen.file)
      parsePacketText(text, { source: chosen.file }) // 校验备份可用
      if (fs.existsSync(file)) backupPacketFile(file) // 当前状态先保底
      fs.writeFileSync(file, text, 'utf8')
    })
    ctx.out.ok(
      { restored_from: chosen.file, output: file },
      () => console.log(`已从备份 #${n} 恢复 → ${file}`)
    )
  },
}
