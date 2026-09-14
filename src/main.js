import fs from 'node:fs'
import { readFileSync } from 'node:fs'
import { parseArgv, renderRootHelp, renderCommandHelp } from './cli.js'
import { Output, color } from './output.js'
import { asDtpError, DtpError } from './errors.js'
import { withLock } from './storage.js'
import { Packet } from './packet.js'
import { registry } from './commands/index.js'
import { resolveDefaultPacket, packetMissingError } from './config.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export async function main(argv) {
  let out = new Output({})
  try {
    const parsed = parseArgv(argv, registry)
    out = new Output(parsed.globals)
    if (parsed.parseError) throw parsed.parseError
    if (parsed.version) {
      if (out.json) out.ok({ version: `v${pkg.version}` })
      else console.log(`dtp v${pkg.version}`)
      return 0
    }
    if (parsed.helpFor !== undefined) {
      if (parsed.helpFor === null) {
        console.log(renderRootHelp(registry, pkg.version))
      } else {
        const cmd = registry[parsed.helpFor]
        if (cmd) console.log(renderCommandHelp(cmd))
        else {
          console.log(`未知命令 "${parsed.helpFor}"（dtp --help 查看全部命令）`)
          console.log(renderRootHelp(registry, pkg.version))
        }
      }
      return 0
    }
    const ctx = makeContext(parsed, out)
    await parsed.command.run(ctx)
    // 命令内部可设置 process.exitCode 表达非零退出（如 verify 发现问题）
    return process.exitCode ?? 0
  } catch (e) {
    const err = asDtpError(e)
    out.error(err)
    if (err.code === 'INTERNAL') {
      console.error(color.dim(e.stack ?? ''))
    }
    // 用法错误统一退出码 2：枚举拼写错误（INVALID_TYPE/INVALID_STATUS）同属调用方错误
    const usageCodes = ['USAGE', 'EXISTS', 'INVALID_TYPE', 'INVALID_STATUS']
    return usageCodes.includes(err.code) ? 2 : 1
  }
}

function makeContext(parsed, out) {
  // --packet 解析链（US-003）：显式 > .dtp/config.json default > ./packet.dtp。
  // 显式 = 零副作用（不建 .dtp/ 不写 config）；缺省解析的静态错误（CONFIG_INVALID）
  // 即时抛，default 指向的文件缺失留到 ctx.load() 按需 fail loud（不阻断 init）
  const explicit = parsed.globals.packet !== undefined
  const resolved = explicit ? null : resolveDefaultPacket()
  if (resolved?.error) throw resolved.error
  const packetPath = explicit ? parsed.globals.packet : resolved.path
  const ctx = {
    args: parsed.args,
    opts: parsed.opts,
    globals: parsed.globals,
    out,
    user: parsed.globals.user,
    packetPath,
    explicitPacket: explicit,
    packetSource: explicit ? 'explicit' : resolved.source,
    load() {
      if (!fs.existsSync(packetPath)) {
        throw packetMissingError(explicit ? { source: 'legacy' } : resolved, packetPath)
      }
      const packet = Packet.load(packetPath)
      // 篡改巡检结果缓存：写命令据此在 JSON 输出附 warnings（不阻断写入）
      packet.__hashWarnings = packet.hashMismatches()
      if (packet.__hashWarnings.length) {
        for (const w of packet.__hashWarnings) console.error(`${color.yellow('dtp: ⚠')} ${w}`)
      }
      return packet
    },
    withLock(fn) {
      return withLock(packetPath, fn)
    },
  }
  return ctx
}
