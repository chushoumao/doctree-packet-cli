// lint 命令（US-002）：包对模版 schema 的符合性校验（只读）。
// schema 发现三态：未绑/文件丢 → TEMPLATE_MISSING 快速失败；JSON 坏 → SCHEMA_INVALID 快速失败；
// 同 version 不同 sha256 → SCHEMA_DRIFT 快速失败（同版本内容变更视为可疑，非演进）；
// version 不同 → schema.drift warn（正常演进，校验照常进行，提示 re-bind）。
// --schema <path> 临时指定：跳过包内发现与漂移校验（不写包）。
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { DtpError } from '../errors.js'
import { parseSchema, checkSchema, evaluate, resolveSchemaFile } from '../template.js'
import { color } from '../output.js'

// 读取并自检 schema 文件；不可用即快速失败（不进 violations）
function loadSchemaFile(schemaPath) {
  if (!fs.existsSync(schemaPath)) {
    throw new DtpError('TEMPLATE_MISSING', `schema 文件不存在：${schemaPath}（先用 dtp template new <name> 生成）`)
  }
  const buf = fs.readFileSync(schemaPath)
  const text = buf.toString('utf8')
  const problems = checkSchema(text)
  if (problems.length) {
    throw new DtpError(
      'SCHEMA_INVALID',
      `schema 未通过自检（${problems.length} 处）：${problems[0]}${problems.length > 1 ? ' 等' : ''}（修复后 dtp template check ${schemaPath}）`
    )
  }
  return { schema: parseSchema(text), sha256: createHash('sha256').update(buf).digest('hex') }
}

export const command = {
  name: 'lint',
  summary: '按绑定的模版 schema 校验包符合性（骨架/字段/引用/编号，只读）',
  args: [],
  options: {
    schema: { arg: 'path', desc: '临时指定 schema 文件（跳过包内绑定发现与漂移校验）' },
  },
  example: ['dtp lint --packet ./周报包.dtp', 'dtp lint --packet ./周报包.dtp --schema ./weekly.schema.json'],
  run(ctx) {
    const file = ctx.packetPath
    if (!fs.existsSync(file)) {
      throw new DtpError('NO_PACKET', `数据包不存在：${file}（先用 dtp init 创建）`)
    }
    if (fs.statSync(file).isDirectory()) {
      throw new DtpError('NO_PACKET', `数据包路径是一个目录：${file}`)
    }
    const packet = ctx.load()
    const bound = packet.meta.metadata?.template ?? null
    const violations = []

    let schema
    if (ctx.opts.schema !== undefined) {
      // 临时指定：不读包内绑定，不做漂移校验
      ;({ schema } = loadSchemaFile(ctx.opts.schema))
    } else {
      if (!bound) {
        throw new DtpError('TEMPLATE_MISSING', `包未绑定模版：${file}（先用 dtp template bind <schema> 绑定，或本次用 --schema 临时指定）`)
      }
      // 必须走 resolveSchemaFile：按包目录解析 metadata.template.file（两侧 realpath 归一，symlink 安全）
      const schemaPath = resolveSchemaFile(file, bound.file)
      if (!fs.existsSync(schemaPath)) {
        throw new DtpError(
          'TEMPLATE_MISSING',
          `绑定的 schema 文件不存在：${schemaPath}（metadata.template.file 记录为 ${bound.file}；schema 迁移后请 dtp template bind 重新绑定）`
        )
      }
      const loaded = loadSchemaFile(schemaPath)
      schema = loaded.schema
      // 漂移二分：版本不同 = 正常演进（warn，校验继续）；同版本内容变更 = 可疑（快速失败）
      if (bound.version !== schema.version) {
        violations.push({
          rule: 'schema.drift',
          severity: 'warn',
          message: `schema 版本不一致：包绑定 v${bound.version}，当前文件 v${schema.version}（正常演进；确认后 dtp template bind 重新绑定刷新记录）`,
          hint: '升级 schema 属预期行为；re-bind 后此告警消失',
        })
      } else if (bound.schema_sha256 !== loaded.sha256) {
        throw new DtpError(
          'SCHEMA_DRIFT',
          `schema 版本同为 v${bound.version} 但内容与绑定记录不一致（记录 ${String(bound.schema_sha256).slice(0, 12)}…，实际 ${loaded.sha256.slice(0, 12)}…）。同版本内容应稳定；确认是升级请先 bump schema version 再 dtp template bind 重新绑定`
        )
      }
    }

    // 符合性评估（evaluate 内部处理 packet.structure 前置短路）
    violations.push(...evaluate(schema, packet))

    const errorCount = violations.filter((v) => v.severity === 'error').length
    const warnCount = violations.length - errorCount
    const ok = errorCount === 0
    ctx.out.ok(
      {
        ok,
        packet: file,
        template: { name: schema.name, version: schema.version },
        violations,
        error_count: errorCount,
        warn_count: warnCount,
      },
      () => {
        console.log(`模版 ${schema.name} v${schema.version} → ${file}`)
        for (const v of violations) {
          const tag = v.severity === 'error' ? color.red('✗') : color.yellow('⚠')
          const at = v.node_id ? ` ${color.dim(v.node_id)}` : ''
          console.log(`${tag} [${v.rule}]${at} ${v.message}`)
          if (v.hint) console.log(`   ${color.dim(v.hint)}`)
        }
        if (ok && warnCount === 0) console.log(color.green(`✓ 符合模版约定（0 违规）`))
        else if (ok) console.log(color.yellow(`⚠ ${warnCount} 条告警，无 error 级违规`))
        else console.log(color.red(`✗ ${errorCount} 项违规${warnCount ? `，${warnCount} 条告警` : ''}`))
      }
    )
    if (!ok) process.exitCode = 1
  },
}
