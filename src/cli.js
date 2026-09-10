import { DtpError } from './errors.js'

// 零依赖命令行解析：首个非选项 token 为子命令；选项可出现在任意位置。
// 支持 --name value / --name=value / 短选项 -y；multi 选项可重复传入。

export const GLOBAL_OPTIONS = {
  packet: { arg: 'path', desc: '数据包文件路径（默认 ./packet.dtp）' },
  json: { desc: '以结构化 JSON 输出（供脚本/Agent 消费）' },
  pretty: { desc: '格式化 JSON 输出' },
  quiet: { desc: '静默模式：成功时不产生输出' },
  user: { arg: 'name', desc: '操作人，记录到 changelog（默认取环境变量 DTP_USER）' },
  help: { desc: '显示帮助' },
  version: { desc: '显示版本号' },
}

function defaults() {
  return {
    packet: './packet.dtp',
    json: false,
    pretty: false,
    quiet: false,
    user: process.env.DTP_USER ?? null,
  }
}

// 命令专属选项查找（不回退全局）：返回规范长名。命令选项须优先于全局
// help/version 拦截，否则 init --version <ver> 这类同名命令选项永远无法到达命令。
function findCommandOption(command, name, isLong) {
  if (!command) return null
  if (command.options?.[name]) return name
  if (!isLong) {
    for (const [key, def] of Object.entries(command.options ?? {})) {
      if (def.short === name) return key
    }
  }
  return null
}

export function parseArgv(argv, registry) {
  const globals = defaults()
  let command = null
  const positionals = []
  const opts = {}
  // 解析期错误不立即抛出：暂存后继续扫描，让位于错误之后的 --json 等全局选项
  // 仍能收集进 globals，保证错误也能以 JSON 形式输出（Agent 契约）。首个错误优先。
  let parseError = null
  const defer = (e) => {
    if (!parseError) parseError = e
  }
  let versionFlag = false

  const applyOpt = (name, def, value) => {
    if (def.multi) (opts[name] ??= []).push(value)
    else opts[name] = value
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    try {
    if (tok.startsWith('-') && tok.length > 1 && !/^-\d/.test(tok)) {
      const isLong = tok.startsWith('--')
      let name = isLong ? tok.slice(2) : tok.slice(1)
      let inline
      const eq = name.indexOf('=')
      if (eq >= 0) {
        inline = name.slice(eq + 1)
        name = name.slice(0, eq)
      }
      // 命令专属选项优先（含与全局同名的选项，如 init --version <ver>）
      const cmdOptName = findCommandOption(command, name, isLong)
      if (cmdOptName !== null) {
        const def = command.options[cmdOptName]
        if (!def.arg) {
          if (inline !== undefined) throw new DtpError('USAGE', `布尔选项 --${cmdOptName} 不接受 = 赋值`)
          applyOpt(cmdOptName, def, true)
          continue
        }
        let value = inline
        if (value === undefined) {
          value = argv[++i]
          if (value === undefined) throw new DtpError('USAGE', `选项 ${tok} 需要一个值（${def.arg}）`)
        }
        applyOpt(cmdOptName, def, value)
        continue
      }
      if (name === 'help' || name === 'h') return { helpFor: command ? command.name : null, globals }
      if (name === 'version' || name === 'V') {
        versionFlag = true
        continue
      }

      const def = isLong ? GLOBAL_OPTIONS[name] : null
      if (!def) {
        throw new DtpError(
          'USAGE',
          `未知选项 ${tok}${command ? `（查看 dtp ${command.name} --help）` : '（查看 dtp --help）'}`
        )
      }
      // 到这里的只剩全局长选项（packet/json/pretty/quiet/user）
      if (!def.arg) {
        if (inline !== undefined) throw new DtpError('USAGE', `布尔选项 --${name} 不接受 = 赋值`)
        applyOpt(name, def, true)
        continue
      }
      let value = inline
      if (value === undefined) {
        value = argv[++i]
        if (value === undefined) throw new DtpError('USAGE', `选项 ${tok} 需要一个值（${def.arg}）`)
      }
      applyOpt(name, def, value)
      continue
    }
    // 非选项 token：第一个是命令名，其余是位置参数
    if (!command) {
      if (tok === 'help') {
        const target = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : null
        return { helpFor: target, globals }
      }
      command = registry[tok]
      if (!command) throw new DtpError('USAGE', `未知命令 "${tok}"（运行 dtp --help 查看全部命令）`)
    } else {
      positionals.push(tok)
    }
    } catch (e) {
      defer(e)
    }
  }

  // 全局选项落到 globals（错误场景也先收集，供 main 以正确的输出通道报告）
  for (const key of ['packet', 'user']) if (opts[key] !== undefined) globals[key] = opts[key]
  for (const key of ['json', 'pretty', 'quiet']) if (opts[key] !== undefined) globals[key] = Boolean(opts[key])

  // 解析错误随返回值交给 main（而非此处抛出）：main 需先按 globals 建好输出通道再抛
  if (parseError) return { parseError, globals }
  if (versionFlag) return { version: true, globals }
  if (!command) return { helpFor: null, globals }

  // 位置参数映射（最后一个参数可声明 variadic 吸收剩余）+ 默认值
  const args = {}
  const argSpecs = command.args ?? []
  let pi = 0
  for (const spec of argSpecs) {
    if (spec.variadic) {
      args[spec.name] = positionals.slice(pi)
      pi = positionals.length
    } else if (pi < positionals.length) {
      args[spec.name] = positionals[pi++]
    }
  }
  if (pi < positionals.length) {
    // 零位置参数命令（verify/pack/query…）最常见的误用是把包路径当位置参数：直接给出行动指引
    const hint =
      argSpecs.length === 0
        ? `dtp ${command.name} 不接受位置参数；指定数据包请用 --packet <路径>`
        : `查看 dtp ${command.name} --help`
    return { parseError: new DtpError('USAGE', `多余的参数 "${positionals[pi]}"（${hint}）`), globals }
  }
  for (const spec of argSpecs) {
    if (spec.required && (args[spec.name] === undefined || args[spec.name].length === 0)) {
      return { parseError: new DtpError('USAGE', `缺少参数 <${spec.name}>（查看 dtp ${command.name} --help）`), globals }
    }
  }
  for (const [name, def] of Object.entries(command.options ?? {})) {
    if (opts[name] === undefined && def.default !== undefined) opts[name] = def.default
  }

  return { command, args, opts, globals, parseError: null }
}

// ---------- 帮助渲染 ----------

function optionFlags(name, def) {
  const short = def.short ? `-${def.short}, ` : '    '
  const val = def.arg ? ` <${def.arg}>` : ''
  return `${short}--${name}${val}`
}

export function renderCommandHelp(cmd) {
  const parts = []
  const usageArgs = (cmd.args ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ')
  parts.push(`${colorless('用法:')}${' '}dtp${usageArgs ? ' ' + usageArgs : ''} [选项]`)
  parts.push('')
  if (cmd.summary) parts.push(cmd.summary)
  parts.push('')
  if (cmd.args?.length) {
    parts.push('参数:')
    for (const a of cmd.args) {
      const req = a.required ? '' : '（可选）'
      parts.push(`  <${a.name}>${req}  ${a.desc ?? ''}`)
    }
    parts.push('')
  }
  parts.push('选项:')
  const rows = Object.entries(cmd.options ?? {}).map(([name, def]) => [optionFlags(name, def), def.desc ?? ''])
  for (const [k, v] of Object.entries(GLOBAL_OPTIONS)) {
    if (k === 'help' || k === 'version') continue
    rows.push([`    --${k}${v.arg ? ` <${v.arg}>` : ''}`, v.desc])
  }
  rows.push(['    --help', '显示本帮助'])
  const w = Math.max(...rows.map((r) => r[0].length))
  for (const [k, v] of rows) parts.push(`  ${k.padEnd(w + 2)}${v}`)
  if (cmd.example) {
    parts.push('')
    parts.push('示例:')
    for (const e of [].concat(cmd.example)) parts.push(`  ${e}`)
  }
  return parts.join('\n')
}

function colorless(s) {
  return s
}

export function renderRootHelp(registry, version) {
  const parts = []
  parts.push(`dtp v${version} — DocTree Packet CLI`)
  parts.push('树形结构化 · Append-Only 版本化 · JSONL 存储的文档数据包管理工具')
  parts.push('')
  parts.push('用法: dtp [全局选项] <命令> [参数] [选项]')
  parts.push('')
  parts.push('命令:')
  const cmds = Object.values(registry)
  const w = Math.max(...cmds.map((c) => c.name.length))
  for (const c of cmds) parts.push(`  ${c.name.padEnd(w + 2)}${c.summary ?? ''}`)
  parts.push('')
  parts.push('全局选项:')
  const rows = Object.entries(GLOBAL_OPTIONS).map(([k, v]) => [
    `    --${k}${v.arg ? ` <${v.arg}>` : ''}`,
    v.desc,
  ])
  const w2 = Math.max(...rows.map((r) => r[0].length))
  for (const [k, v] of rows) parts.push(`  ${k.padEnd(w2 + 2)}${v}`)
  parts.push('')
  parts.push('节点引用支持：完整 ID / 唯一前缀（git 风格）/ 以 / 开头的语义路径')
  parts.push('运行 dtp <命令> --help 查看详细用法')
  return parts.join('\n')
}
