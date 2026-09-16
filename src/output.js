import { DtpError } from './errors.js'

// ---------- 颜色（TTY 且未设 NO_COLOR 时启用） ----------

const colorEnabled = () => process.stdout.isTTY && !process.env.NO_COLOR
const wrap = (code) => (s) => (colorEnabled() ? `\x1b[${code}m${s}\x1b[0m` : String(s))

export const color = {
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  dim: wrap('2'),
  bold: wrap('1'),
}

export const TYPE_COLOR = {
  folder: color.cyan,
  document: (s) => String(s),
  requirement: color.magenta,
  knowledge: color.blue,
  index: color.yellow,
}
export const STATUS_COLOR = {
  draft: color.dim,
  review: color.yellow,
  approved: color.green,
  archived: (s) => color.dim(color.bold(s)),
}

export function shortId(id) {
  return String(id).slice(0, 8)
}

// ---------- 终端显示宽度（CJK/全角按 2 列计） ----------

export function visualWidth(s) {
  let w = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0)
    if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6))) w += 2
    else if (cp >= 0x1f300 && cp <= 0x1faff) w += 2
    else w += 1
  }
  return w
}

export function padEndVisual(s, width) {
  const s2 = String(s)
  return s2 + ' '.repeat(Math.max(0, width - visualWidth(s2)))
}

export function renderTable(headers, rows, { minGap = 2, maxCol = 60 } = {}) {
  const widths = headers.map((h, i) => {
    const colVals = [h, ...rows.map((r) => String(r[i] ?? ''))]
    return Math.min(maxCol, Math.max(...colVals.map(visualWidth)))
  })
  const head = headers.map((h, i) => padEndVisual(h, widths[i])).join(' '.repeat(minGap))
  const sep = widths.map((w) => '-'.repeat(w)).join(' '.repeat(minGap))
  const body = rows.map((r) =>
    r.map((c, i) => padEndVisual(String(c ?? ''), widths[i])).join(' '.repeat(minGap))
  )
  return [head, sep, ...body]
}

// ---------- 输出通道 ----------
// --json：所有结果（含错误）以 {"ok":true|false,...} 结构化输出，供 Agent/脚本消费
// --quiet：静默成功输出；--pretty：JSON 缩进

export class Output {
  constructor({ json = false, pretty = false, quiet = false } = {}) {
    this.json = json
    this.pretty = pretty
    this.quiet = quiet
  }

  ok(obj, human) {
    if (this.json) {
      console.log(JSON.stringify({ ok: true, ...obj }, null, this.pretty ? 2 : 0))
      return
    }
    if (this.quiet) return
    if (typeof human === 'function') human(obj)
  }

  error(e) {
    if (this.json) {
      // details.violations（SCHEMA_VIOLATION）：结构化违规随 error 附带（复用 lint 形状）
      const extra = e.details?.violations ? { violations: e.details.violations } : {}
      console.log(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, ...extra } }, null, this.pretty ? 2 : 0))
    } else if (e.details?.violations?.length) {
      // 人类模式逐条违规含 hint（--json 模式已在 stdout 单行内，不重复打印）
      printViolations(e.details.violations)
    }
    console.error(`${color.red('dtp:')} ${e.message}`)
  }
}

// 人类模式的违规明细（Output.error 人类分支调用；对齐 lint 的人类输出风格）
export function printViolations(violations) {
  for (const v of violations) {
    console.error(`  ${color.red('✗')} [${v.rule}]${v.node_id ? ` ${color.dim(v.node_id)}` : ''} ${v.message}`)
    if (v.hint) console.error(`    ${color.dim(v.hint)}`)
  }
}

// 节点公开形态（去掉 JSONL 行类型标记）
export function publicNode(node) {
  const { type, ...rest } = node
  return rest
}
