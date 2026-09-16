// 写路径强制校验接线（US-005）：读包内 metadata.template，构造 Packet 的 enforcer 钩子。
// Packet 不感知 schema（避免 template.js ↔ packet.js 循环依赖），本模块是唯一接线点：
// CLI（main.js ctx.load）与 webui（api.js mutate）各接一行，webui 自动获益。
//
// schema 三态与 lint 同源：文件丢失 → TEMPLATE_MISSING；非法 → SCHEMA_INVALID；
// 同版本 sha 不符 → SCHEMA_DRIFT（拒绝在校验不可信内容）；版本不同 → 放行并附 schema.drift warn。
//
// 惰性设计：attach 只读 metadata 标志（cheap），check() 首次调用才读文件+解析（memo）。
// 读路径命令（ls/query/get）attach 后零额外 IO、零失败面——强制校验是写路径关切，
// 不该让「schema 文件被删」把只读命令也一并打挂（lint 才是显式的全局校验入口）。
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { DtpError } from './errors.js'
import { parseSchema, checkSchema, evaluateNode, resolveSchemaFile } from './template.js'

export function attachEnforcer(packet) {
  const bound = packet.meta.metadata?.template
  if (!bound || bound.enforce !== true) return packet // 未绑 / 未开启：零行为、零成本

  let compiled = null
  const loadSchema = () => {
    if (compiled) return compiled
    const schemaPath = resolveSchemaFile(packet.filePath, bound.file)
    if (!fs.existsSync(schemaPath)) {
      throw new DtpError(
        'TEMPLATE_MISSING',
        `强制校验：绑定的 schema 文件不存在：${schemaPath}（metadata.template.file=${bound.file}；恢复文件、re-bind，或 dtp template bind --no-enforce 关闭强制）`
      )
    }
    const buf = fs.readFileSync(schemaPath)
    const text = buf.toString('utf8')
    const problems = checkSchema(text)
    if (problems.length) {
      throw new DtpError('SCHEMA_INVALID', `强制校验：schema 非法（${problems.length} 处）：${problems[0]}（修复后 dtp template check）`)
    }
    const schema = parseSchema(text)
    const sha = createHash('sha256').update(buf).digest('hex')
    if (bound.version === schema.version && bound.schema_sha256 !== sha) {
      throw new DtpError(
        'SCHEMA_DRIFT',
        `强制校验：schema 版本同为 v${bound.version} 但内容与绑定记录不一致（记录 ${String(bound.schema_sha256).slice(0, 12)}…，实际 ${sha.slice(0, 12)}…）；确认升级请 bump version 后 re-bind`
      )
    }
    const driftWarn =
      bound.version !== schema.version
        ? [
            {
              rule: 'schema.drift',
              severity: 'warn',
              message: `强制校验用 schema 版本 v${schema.version} 与绑定记录 v${bound.version} 不同（re-bind 可刷新记录）`,
              hint: 're-bind 后此告警消失；版本演进不阻断写入',
            },
          ]
        : []
    compiled = { schema, driftWarn }
    return compiled
  }

  packet.enforcer = {
    check(candidate) {
      const { schema, driftWarn } = loadSchema()
      return [...driftWarn, ...evaluateNode(schema, candidate, packet)]
    },
  }
  return packet
}
