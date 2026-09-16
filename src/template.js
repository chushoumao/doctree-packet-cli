// 模版模块（US-002 DSL v1）：数据包格式约定的单一事实源。
// 四段 API：parseSchema（文本→对象）/ checkSchema（schema 自检→string[]）/
// evaluate（包对模版符合性→violations[]，纯函数只读）/ skeletonLines（schema→init 骨架 JSONL 行）。
//
// DSL 设计要点（定稿见 US-002【背景与讨论】）：
// - JSON 无注释 → comment 键为合法人类可读注释，求值忽略、checkSchema 白名单放行；
// - scope.parent 可引用容器 id（skeleton 节点）或规则 id（该规则认领的节点集为父集），
//   规则按引用关系拓扑求值，checkSchema 负责查环——表达「任务挂在故事节点下」的最小机制；
// - match 为「认领」谓词（id/title 任一命中即认领，含挂错父节点）：认领但不在 scope 内 →
//   parent.container；容器内未被任何规则认领的节点 v1 放行（不做 closed 容器）；
// - rule id 命名空间（violations.rule）二期写路径强制（SCHEMA_VIOLATION）直接复用，勿改；
// - ext 类型 v1 只判 string（存在性）与 array（数组性），不做通用类型系统；
// - 编号连续性基于 packet.versions 里出现过的编号（含 tombstone，rm 不制造跳号噪音）。
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DtpError } from './errors.js'
import { NODE_TYPES, computeNodeHash, normalizeTags } from './model/node.js'
import { initPacketLines } from './packet.js'

// ---------- DSL v1 键白名单 ----------

const TOP_KEYS = new Set(['name', 'version', 'comment', 'skeleton', 'rules'])
const SKELETON_KEYS = new Set(['id', 'title', 'type', 'description', 'tags', 'comment'])
const RULE_KEYS = new Set([
  'id',
  'comment',
  'scope',
  'match',
  'id_pattern',
  'title_pattern',
  'ext_required',
  'ext_arrays',
  'tags_require',
  'content_sections',
  'ref_exists',
  'status_evidence',
  'numbering',
])
const SCOPE_KEYS = new Set(['parent'])
const MATCH_KEYS = new Set(['id', 'title'])
const NUMBERING_KEYS = new Set(['title_prefix', 'id_prefix', 'digits'])

// violations 的 rule 取值域（命名空间定死，勿改）
export const RULE_IDS = [
  'skeleton.missing',
  'parent.container',
  'id.pattern',
  'title.pattern',
  'ext.required',
  'ext.arrays',
  'tags.require',
  'content.sections',
  'ref_exists',
  'status.evidence',
  'id.continuity',
  'packet.structure',
]

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0
const isStringArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString)

// 正则元字符转义：numbering 前缀按字面量拼进编号正则
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// 可读性问题累积：兼容「无值/类型不对/内容不符」三类，msg 拼进位置
const req = (problems, where, what, v, ok) => {
  if (!ok) problems.push(`${where}：${what}（收到 ${JSON.stringify(v) ?? String(v)}）`)
}

// ---------- 第一段：parseSchema ----------

// 坏 JSON 抛 SCHEMA_INVALID；合法则原样返回（comment 键保留，不做裁剪）
export function parseSchema(text) {
  let obj
  try {
    obj = JSON.parse(String(text))
  } catch (e) {
    throw new DtpError('SCHEMA_INVALID', `schema 不是合法 JSON：${e.message}`)
  }
  if (!isPlainObject(obj)) throw new DtpError('SCHEMA_INVALID', 'schema 顶层必须是 JSON 对象')
  return obj
}

// ---------- 第二段：checkSchema ----------

// schema 自检，返回可读问题列表（空数组 = 通过）。接受对象或文本；
// 文本解析失败不抛，降级为单条问题，供 CLI 逐条输出。
export function checkSchema(input) {
  let schema = input
  if (typeof input === 'string') {
    try {
      schema = parseSchema(input)
    } catch (e) {
      return [e.message]
    }
  }
  const problems = []
  if (!isPlainObject(schema)) return ['schema 顶层必须是 JSON 对象']

  for (const k of Object.keys(schema)) {
    if (!TOP_KEYS.has(k)) problems.push(`顶层出现未知键 "${k}"（合法键：${[...TOP_KEYS].join(' | ')}）`)
  }
  req(problems, '顶层', 'name 必须是非空字符串', schema.name, isNonEmptyString(schema.name))
  req(problems, '顶层', 'version 必须是非空字符串', schema.version, isNonEmptyString(schema.version))

  // ---- skeleton ----
  if (!Array.isArray(schema.skeleton)) {
    problems.push(`skeleton 必须是数组（收到 ${JSON.stringify(schema.skeleton) ?? String(schema.skeleton)}）`)
  } else if (schema.skeleton.length === 0) {
    problems.push('skeleton 至少需要 1 个容器')
  } else {
    const seenIds = new Set()
    schema.skeleton.forEach((c, i) => {
      const where = `skeleton[${i}]`
      if (!isPlainObject(c)) {
        problems.push(`${where} 必须是对象（收到 ${JSON.stringify(c) ?? String(c)}）`)
        return
      }
      for (const k of Object.keys(c)) {
        if (!SKELETON_KEYS.has(k)) problems.push(`${where} 出现未知键 "${k}"（合法键：${[...SKELETON_KEYS].join(' | ')}）`)
      }
      req(problems, where, 'id 必须是非空字符串', c.id, isNonEmptyString(c.id))
      req(problems, where, 'title 必须是非空字符串', c.title, isNonEmptyString(c.title))
      if (c.type !== undefined && !NODE_TYPES.includes(c.type)) {
        problems.push(`${where} type "${c.type}" 不是合法节点类型（可选：${NODE_TYPES.join(' | ')}）`)
      }
      if (c.tags !== undefined && !isStringArray(c.tags)) {
        problems.push(`${where} tags 必须是非空字符串数组`)
      }
      if (isNonEmptyString(c.id)) {
        if (seenIds.has(c.id)) problems.push(`${where} 容器 id 重复：${c.id}`)
        seenIds.add(c.id)
      }
    })
  }

  // ---- rules ----
  if (schema.rules !== undefined && !Array.isArray(schema.rules)) {
    problems.push(`rules 必须是数组（收到 ${JSON.stringify(schema.rules) ?? String(schema.rules)}）`)
  } else if (Array.isArray(schema.rules)) {
    const skeletonIds = new Set(
      (Array.isArray(schema.skeleton) ? schema.skeleton : []).filter(isPlainObject).map((c) => c.id)
    )
    const ruleIds = new Set()
    schema.rules.forEach((r, i) => {
      const where = `rules[${i}]`
      if (!isPlainObject(r)) {
        problems.push(`${where} 必须是对象（收到 ${JSON.stringify(r) ?? String(r)}）`)
        return
      }
      for (const k of Object.keys(r)) {
        if (!RULE_KEYS.has(k)) problems.push(`${where} 出现未知规则键 "${k}"（合法键：${[...RULE_KEYS].join(' | ')}）`)
      }
      if (!isNonEmptyString(r.id)) {
        req(problems, where, 'id 必须是非空字符串', r.id, false)
        return
      }
      if (ruleIds.has(r.id)) problems.push(`${where} 规则 id 重复：${r.id}`)
      ruleIds.add(r.id)
      if (skeletonIds.has(r.id)) problems.push(`${where} 规则 id "${r.id}" 与容器 id 冲突`)

      // scope：唯一键 parent，引用容器 id 或规则 id
      if (!isPlainObject(r.scope)) {
        problems.push(`${where}（${r.id}）scope 必须是对象且含 parent`)
      } else {
        for (const k of Object.keys(r.scope)) {
          if (!SCOPE_KEYS.has(k)) problems.push(`${where}（${r.id}）scope 出现未知键 "${k}"（仅允许 parent）`)
        }
        req(problems, `${where}（${r.id}）`, 'scope.parent 必须是非空字符串', r.scope.parent, isNonEmptyString(r.scope.parent))
        if (r.scope.parent === r.id) problems.push(`${where}（${r.id}）scope.parent 不能引用自身`)
      }

      // match：认领谓词，id/title 至少一个（缺失则规则永不生效）
      if (!isPlainObject(r.match)) {
        problems.push(`${where}（${r.id}）match 必须是对象且至少含 id 或 title 之一（认领谓词）`)
      } else {
        for (const k of Object.keys(r.match)) {
          if (!MATCH_KEYS.has(k)) problems.push(`${where}（${r.id}）match 出现未知键 "${k}"（仅允许 id | title）`)
        }
        if (r.match.id === undefined && r.match.title === undefined) {
          problems.push(`${where}（${r.id}）match 至少需要 id 或 title 中的一个模式`)
        }
        for (const k of ['id', 'title']) {
          if (r.match[k] !== undefined) checkRegex(problems, `${where}（${r.id}）match.${k}`, r.match[k])
        }
      }

      for (const k of ['id_pattern', 'title_pattern']) {
        if (r[k] !== undefined) checkRegex(problems, `${where}（${r.id}）${k}`, r[k])
      }
      for (const [k, what] of [
        ['ext_required', 'ext_required 必须是非空字符串数组'],
        ['ext_arrays', 'ext_arrays 必须是非空字符串数组'],
        ['tags_require', 'tags_require 必须是非空字符串数组'],
        ['content_sections', 'content_sections 必须是非空字符串数组'],
        ['ref_exists', 'ref_exists 必须是非空字符串数组'],
      ]) {
        if (r[k] !== undefined) req(problems, `${where}（${r.id}）`, what, r[k], isStringArray(r[k]))
      }

      if (r.status_evidence !== undefined) {
        if (!isPlainObject(r.status_evidence)) {
          problems.push(`${where}（${r.id}）status_evidence 必须是对象（状态 → 必填 ext 键数组）`)
        } else {
          for (const [status, keys] of Object.entries(r.status_evidence)) {
            if (!isNonEmptyString(status)) problems.push(`${where}（${r.id}）status_evidence 状态键必须非空`)
            req(problems, `${where}（${r.id}）status_evidence["${status}"]`, '值必须是非空字符串数组', keys, isStringArray(keys))
          }
        }
      }

      if (r.numbering !== undefined) {
        const n = r.numbering
        const where2 = `${where}（${r.id}）numbering`
        if (!isPlainObject(n)) {
          problems.push(`${where2} 必须是对象`)
        } else {
          for (const k of Object.keys(n)) {
            if (!NUMBERING_KEYS.has(k)) problems.push(`${where2} 出现未知键 "${k}"（合法键：${[...NUMBERING_KEYS].join(' | ')}）`)
          }
          req(problems, where2, 'title_prefix 必须是非空字符串', n.title_prefix, isNonEmptyString(n.title_prefix))
          req(problems, where2, 'id_prefix 必须是非空字符串', n.id_prefix, isNonEmptyString(n.id_prefix))
          req(problems, where2, 'digits 必须是正整数（补零位数，说明性字段）', n.digits, Number.isInteger(n.digits) && n.digits > 0)
        }
      }
    })

    // scope.parent 引用存在性 + 规则引用成环（DFS 记路径）
    const byId = new Map()
    for (const r of schema.rules) if (isPlainObject(r) && isNonEmptyString(r.id)) byId.set(r.id, r)
    for (const r of schema.rules) {
      if (!isPlainObject(r) || !isPlainObject(r.scope)) continue
      const p = r.scope.parent
      if (isNonEmptyString(p) && p !== r.id && !skeletonIds.has(p) && !byId.has(p)) {
        problems.push(`规则 ${r.id} 的 scope.parent "${p}" 不是已声明的容器 id 或规则 id`)
      }
    }
    const visiting = new Set()
    const done = new Set()
    const stack = []
    const dfs = (r) => {
      if (done.has(r.id)) return
      if (visiting.has(r.id)) {
        const from = stack.indexOf(r.id)
        problems.push(`规则引用成环：${[...stack.slice(from), r.id].join(' → ')}`)
        return
      }
      visiting.add(r.id)
      stack.push(r.id)
      const p = r.scope?.parent
      const next = byId.get(p)
      if (next) dfs(next)
      stack.pop()
      visiting.delete(r.id)
      done.add(r.id)
    }
    for (const r of schema.rules) if (isPlainObject(r) && isNonEmptyString(r.id)) dfs(r)
  }

  return problems
}

// 正则模式自检：非字符串 / 不可编译都报可读错误，绝不抛出
function checkRegex(problems, where, pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    problems.push(`${where} 必须是非空字符串（正则模式）`)
    return
  }
  try {
    new RegExp(pattern)
  } catch (e) {
    problems.push(`${where} 正则不可编译（${pattern}）：${e.message}`)
  }
}

// ---------- 第三段：评估（evaluate 全包 / evaluateNode 单节点，US-005 写路径） ----------

// 标题编号段 = 首个分隔符前的 token（如 "US-001 作为…" → "US-001"），
// ref_exists 语义：ext 值与某存活节点 id 全等 或 编号段全等，不做模糊匹配
const codeOfTitle = (title) => String(title ?? '').split(/[\s(（:：,，、]/)[0]

// 逐条内置提示（不进 DSL，二期写路径强制复用同一文案基调）
const HINTS = {
  'skeleton.missing': '对照 schema.skeleton 补建容器（dtp add）或修正其标题/类型',
  'packet.structure': '先运行 dtp verify 修复结构问题，再进行模版符合性校验',
  'parent.container': '用 dtp mv 把节点移到符合该规则 scope 的父节点下',
  'id.pattern': '节点 id 需符合规则的 id_pattern（建节点时用 --id 指定规范编号）',
  'title.pattern': '节点 title 需符合规则的 title_pattern（标题 = 编号 + 空格 + 摘要）',
  'ext.required': '用 dtp update <节点> --ext <键>=<值> 补齐必填扩展字段',
  'ext.arrays': '值必须是 JSON 数组，如 --ext acceptance=\'["GIVEN … WHEN … THEN …"]\'',
  'tags.require': '用 dtp update <节点> --tags 补上缺失标签',
  'content.sections': '用 dtp update <节点> --content 补齐缺失的段落标题',
  ref_exists: '引用值须为存活节点的编号（如 US-001）或节点 id（dtp query 可查）',
  'status.evidence': '置 approved 前需 --ext 回填佐证字段（如 done_evidence）',
  'id.continuity': '编号空洞若属历史遗留可确认放行；新登记请顺延当前最大编号',
}

// 包对模版符合性校验：纯函数、只读 packet，返回 violations[]
// （{node_id?, rule, severity, message, hint}；有 error 才该 exit 1，由调用方决定）
// 规则集编译缓存（WeakMap 按 schema 对象键控）：schema 对象视为不可变（parse 后勿改），
// 同对象重复评估零编译成本。透明缓存——不改变任何输出与报错
const compiledCache = new WeakMap()

// 编译规则集：checkSchema 门 + 拓扑排序 + 正则预编译（evaluate / evaluateNode 共享）
function compileRules(schema) {
  const cached = compiledCache.get(schema)
  if (cached) return cached
  const problems = checkSchema(schema)
  if (problems.length > 0) {
    throw new DtpError('SCHEMA_INVALID', `schema 未通过自检（${problems.length} 处问题），先运行 dtp template check 修复`)
  }
  const rules = schema.rules ?? [] // checkSchema 允许省略 rules（仅骨架 schema）
  const byId = new Map(rules.map((r) => [r.id, r]))
  const ordered = []
  const seenOrder = new Set()
  const visit = (r) => {
    if (seenOrder.has(r.id)) return
    seenOrder.add(r.id)
    const p = byId.get(r.scope.parent)
    if (p) visit(p)
    ordered.push(r)
  }
  for (const r of rules) visit(r)

  // 预编译正则（schema 已过自检，理论上不会失败；仍兜底为 SCHEMA_INVALID 快速失败）
  const compile = (p) => (p === undefined ? null : new RegExp(p))
  const rx = new Map()
  for (const r of rules) {
    try {
      rx.set(r.id, {
        matchId: compile(r.match?.id),
        matchTitle: compile(r.match?.title),
        idPattern: compile(r.id_pattern),
        titlePattern: compile(r.title_pattern),
        numId: r.numbering ? new RegExp(`^${escapeRegExp(r.numbering.id_prefix)}(\\d+)$`) : null,
        numTitle: r.numbering ? new RegExp(`^${escapeRegExp(r.numbering.title_prefix)}-(\\d+)`) : null,
      })
    } catch (e) {
      throw new DtpError('SCHEMA_INVALID', `规则 ${r.id} 正则编译失败：${e.message}`)
    }
  }
  const compiled = { rules, byId, ordered, rx }
  compiledCache.set(schema, compiled)
  return compiled
}

export function evaluate(schema, packet) {
  const problems = checkSchema(schema)
  if (problems.length > 0) {
    throw new DtpError('SCHEMA_INVALID', `schema 未通过自检（${problems.length} 处问题），先运行 dtp template check 修复`)
  }

  // 前置短路：结构破损的包谈业务符合性无意义（rule=packet.structure，hint 先跑 verify）
  if (packet.structuralErrors?.length) {
    return [
      {
        rule: 'packet.structure',
        severity: 'error',
        message: `包结构异常（${packet.structuralErrors.length} 处：${packet.structuralErrors[0]}${packet.structuralErrors.length > 1 ? ' 等' : ''}），跳过逐条符合性评估`,
        hint: HINTS['packet.structure'],
      },
    ]
  }

  const violations = []
  const { rules, byId, ordered, rx } = compileRules(schema)
  const push = (rule, severity, message, nodeId) => {
    const v = { rule, severity, message, hint: HINTS[rule] }
    if (nodeId !== undefined) v.node_id = nodeId
    violations.push(v)
  }

  // 正则执行统一兑底：checkSchema 只能拦截编译期错误，运行期异常（如深度回溯栈溢出）
  // 捕获为违规而非崩溃（rule=regex.runtime，防御性兑底，正常 schema 不会触发）。
  // numbering 的正则由转义字面量构造，不会失败，不在兑底范围
  const safeTest = (re, value, { rule, node, where, failRule, failMsg } = {}) => {
    let ok
    try {
      ok = re.test(value)
    } catch (e) {
      push(
        'regex.runtime',
        'error',
        `规则 ${rule} 的正则执行失败（${where}：${String(re.source).slice(0, 40)}…）：${e.message}`,
        node?.id
      )
      return false
    }
    if (!ok && failRule) push(failRule, 'error', failMsg, node?.id)
    return ok
  }

  // ---- 骨架：容器存在且 id/type/title 与 schema 一致（同一 rule，message 区分缺因）----
  for (const c of schema.skeleton) {
    const node = packet.nodes.get(c.id)
    if (!node) {
      push('skeleton.missing', 'error', `容器 ${c.id}「${c.title}」不存在`)
    } else if (node.node_type !== (c.type ?? 'folder')) {
      push('skeleton.missing', 'error', `容器 ${c.id} 类型不符：期望 ${c.type ?? 'folder'}，实际 ${node.node_type}`)
    } else if (node.title !== c.title) {
      push('skeleton.missing', 'error', `容器 ${c.id} 标题不符：期望「${c.title}」，实际「${node.title}」`)
    }
  }

  const isClaimed = (r, node) => {
    const c = rx.get(r.id)
    return (
      (c.matchId ? safeTest(c.matchId, node.id, { rule: r.id, node, where: 'match.id' }) : false) ||
      (c.matchTitle ? safeTest(c.matchTitle, node.title, { rule: r.id, node, where: 'match.title' }) : false)
    )
  }

  // 全局认领集：挂错父检测 + 规则引用的父集（认领即算，不论其当前挂在哪）
  const claimedBy = new Map()
  for (const r of rules) {
    const set = new Set()
    for (const node of packet.nodes.values()) if (isClaimed(r, node)) set.add(node.id)
    claimedBy.set(r.id, set)
  }

  // ref_exists 的可解析目标：存活节点 id + 标题编号段
  const liveRefs = new Set()
  for (const node of packet.nodes.values()) {
    liveRefs.add(node.id)
    liveRefs.add(codeOfTitle(node.title))
  }

  for (const r of ordered) {
    const c = rx.get(r.id)
    // 父集：容器 id → {容器}；规则 id → 该规则认领的节点集
    const parentSet = byId.has(r.scope.parent) ? claimedBy.get(r.scope.parent) : new Set([r.scope.parent])

    // 挂错父：被认领但父不在父集（含 parent_id 悬空/为根外的其他容器）
    for (const node of packet.nodes.values()) {
      if (!isClaimed(r, node)) continue
      if (node.parent_id == null || !parentSet.has(node.parent_id)) {
        const where = node.parent_id == null ? '根' : `「${packet.nodes.get(node.parent_id)?.title ?? node.parent_id}」`
        push('parent.container', 'error', `节点 ${node.id}「${node.title}」被规则 ${r.id} 认领，但挂在 ${where} 下而非该规则 scope 内`, node.id)
      }
    }

    // 字段校验：只对「认领且挂对位置」的节点做（挂错父时定位问题优先，不做叠加噪音）
    for (const pid of parentSet) {
      for (const node of packet.childrenOf(pid)) {
        if (!isClaimed(r, node)) continue // 未被本规则认领 → v1 放行
        const ext = node.extensions ?? {}
        const tags = new Set(node.tags ?? [])

        if (c.idPattern && !safeTest(c.idPattern, node.id, { rule: r.id, node, where: 'id_pattern', failRule: 'id.pattern', failMsg: `节点 ${node.id} 的 id 不符合规则 ${r.id} 的模式 ${r.id_pattern}` })) {
          // 失败推送已在 safeTest 内完成
        }
        if (c.titlePattern && !safeTest(c.titlePattern, node.title, { rule: r.id, node, where: 'title_pattern', failRule: 'title.pattern', failMsg: `节点 ${node.id}「${node.title}」的标题不符合规则 ${r.id} 的模式 ${r.title_pattern}` })) {
          // 同上
        }
        for (const key of r.ext_required ?? []) {
          if (ext[key] == null || ext[key] === '') {
            push('ext.required', 'error', `节点 ${node.id} 缺少必填扩展字段 "${key}"（规则 ${r.id}）`, node.id)
          }
        }
        for (const key of r.ext_arrays ?? []) {
          const v = ext[key]
          if (v !== undefined && v !== null && !Array.isArray(v)) {
            push('ext.arrays', 'error', `节点 ${node.id} 的扩展字段 "${key}" 必须是数组，实际为 ${typeof v}`, node.id)
          }
        }
        for (const t of r.tags_require ?? []) {
          if (!tags.has(t)) {
            push('tags.require', 'error', `节点 ${node.id}「${node.title}」缺少必填标签 "${t}"（规则 ${r.id}）`, node.id)
          }
        }
        for (const s of r.content_sections ?? []) {
          if (!String(node.content ?? '').includes(s)) {
            push('content.sections', 'error', `节点 ${node.id} 正文缺少段落「${s}」（规则 ${r.id}）`, node.id)
          }
        }
        for (const key of r.ref_exists ?? []) {
          const v = ext[key]
          const target = typeof v === 'string' ? v.trim() : null
          if (!target) {
            push('ref_exists', 'error', `节点 ${node.id} 的引用字段 "${key}" 缺失或非字符串（规则 ${r.id}）`, node.id)
          } else if (!liveRefs.has(target)) {
            push('ref_exists', 'error', `节点 ${node.id} 的 "${key}"=${JSON.stringify(v)} 不指向任何存活节点（编号或 id）`, node.id)
          }
        }
        const evidenceKeys = r.status_evidence?.[node.status]
        if (evidenceKeys) {
          for (const key of evidenceKeys) {
            if (ext[key] == null || ext[key] === '') {
              push('status.evidence', 'error', `节点 ${node.id} 状态为 ${node.status} 但缺少 "${key}"（规则 ${r.id}）`, node.id)
            }
          }
        }
      }
    }

    // 编号连续性（warn）：基于 versions 出现过的编号（含 tombstone），
    // 另校验存活节点 title 编号与 id 编号一致
    if (r.numbering) {
      const seen = new Set()
      for (const id of packet.versions.keys()) {
        const m = c.numId.exec(id)
        if (m) seen.add(parseInt(m[1], 10))
      }
      if (seen.size > 0) {
        const max = Math.max(...seen)
        const gaps = []
        for (let i = 1; i <= max; i++) if (!seen.has(i)) gaps.push(i)
        if (gaps.length > 0) {
          push('id.continuity', 'warn', `规则 ${r.id} 编号空洞：${gaps.join(', ')}（历史最大编号 ${max}，含已删除节点）`)
        }
      }
      for (const node of packet.nodes.values()) {
        if (!isClaimed(r, node)) continue
        const mId = c.numId.exec(node.id)
        const mTitle = c.numTitle.exec(node.title)
        // 按整数值比较（补零位数差异不算不一致；位数约定是说明性的）
        if (mId && mTitle && parseInt(mId[1], 10) !== parseInt(mTitle[1], 10)) {
          push(
            'id.continuity',
            'warn',
            `节点 ${node.id} 的 title 编号 ${r.numbering.title_prefix}-${parseInt(mTitle[1], 10)} 与 id 编号 ${parseInt(mId[1], 10)} 不一致`,
            node.id
          )
        }
      }
    }
  }

  return violations
}

// 单节点评估（US-005 写路径强制）：对候选节点跑其适用规则，返回 violations[]。
// 纯函数只读 packet。与 evaluate 的字段检查同构——修改规则集时两处同步（测试矩阵守护）。
// 与 evaluate 的差异：无骨架检查（候选不是容器）、structuralErrors 改报 packet.structure
// violation（写路径与 lint 的消费形状统一）、连续性只做「候选相关」warn（新增跳号与
// title/id 不一致），历史空洞不在单节点职责内
export function evaluateNode(schema, candidate, packet) {
  const { rules, byId, ordered, rx } = compileRules(schema)
  const violations = []
  const push = (rule, severity, message, nodeId) => {
    const v = { rule, severity, message, hint: HINTS[rule] }
    if (nodeId !== undefined) v.node_id = nodeId
    violations.push(v)
  }
  const safeTest = (re, value, { rule, node, where, failRule, failMsg } = {}) => {
    let ok
    try {
      ok = re.test(value)
    } catch (e) {
      push('regex.runtime', 'error', `规则 ${rule} 的正则执行失败（${where}：${String(re.source).slice(0, 40)}…）：${e.message}`, node?.id)
      return false
    }
    if (!ok && failRule) push(failRule, 'error', failMsg, node?.id)
    return ok
  }
  const isClaimed = (r, node) => {
    const c = rx.get(r.id)
    return (
      (c.matchId ? safeTest(c.matchId, node.id, { rule: r.id, node, where: 'match.id' }) : false) ||
      (c.matchTitle ? safeTest(c.matchTitle, node.title, { rule: r.id, node, where: 'match.title' }) : false)
    )
  }

  // 结构破损：单条违规（写路径与 lint 消费形状统一，调用方可照常按 severity 拦截）
  if (packet.structuralErrors?.length) {
    push('packet.structure', 'error', '包结构异常，跳过候选节点评估', undefined)
    return violations
  }

  // 认领集：规则引用 scope 的父集判定需要（候选自身不在 packet，天然不计入）
  const claimedBy = new Map()
  for (const r of rules) {
    const set = new Set()
    for (const node of packet.nodes.values()) if (isClaimed(r, node)) set.add(node.id)
    claimedBy.set(r.id, set)
  }
  // ref_exists 可解析目标：存活节点 id + 标题编号段（候选自身排除——自引用无意义）
  const liveRefs = new Set()
  for (const node of packet.nodes.values()) {
    liveRefs.add(node.id)
    liveRefs.add(codeOfTitle(node.title))
  }

  for (const r of ordered) {
    const c = rx.get(r.id)
    if (!isClaimed(r, candidate)) continue
    const parentSet = byId.has(r.scope.parent) ? claimedBy.get(r.scope.parent) : new Set([r.scope.parent])
    // 挂错父：定位问题优先，不做字段检查叠加（与 evaluate 同构）
    if (candidate.parent_id == null || !parentSet.has(candidate.parent_id)) {
      const where = candidate.parent_id == null ? '根' : `「${packet.nodes.get(candidate.parent_id)?.title ?? candidate.parent_id}」`
      push('parent.container', 'error', `节点 ${candidate.id}「${candidate.title}」被规则 ${r.id} 认领，但挂在 ${where} 下而非该规则 scope 内`, candidate.id)
      continue
    }
    const ext = candidate.extensions ?? {}
    const tags = new Set(candidate.tags ?? [])
    if (c.idPattern) {
      safeTest(c.idPattern, candidate.id, { rule: r.id, node: candidate, where: 'id_pattern', failRule: 'id.pattern', failMsg: `节点 ${candidate.id} 的 id 不符合规则 ${r.id} 的模式 ${r.id_pattern}` })
    }
    if (c.titlePattern) {
      safeTest(c.titlePattern, candidate.title, { rule: r.id, node: candidate, where: 'title_pattern', failRule: 'title.pattern', failMsg: `节点 ${candidate.id}「${candidate.title}」的标题不符合规则 ${r.id} 的模式 ${r.title_pattern}` })
    }
    for (const key of r.ext_required ?? []) {
      if (ext[key] == null || ext[key] === '') {
        push('ext.required', 'error', `节点 ${candidate.id} 缺少必填扩展字段 "${key}"（规则 ${r.id}）`, candidate.id)
      }
    }
    for (const key of r.ext_arrays ?? []) {
      const v = ext[key]
      if (v !== undefined && v !== null && !Array.isArray(v)) {
        push('ext.arrays', 'error', `节点 ${candidate.id} 的扩展字段 "${key}" 必须是数组，实际为 ${typeof v}`, candidate.id)
      }
    }
    for (const t of r.tags_require ?? []) {
      if (!tags.has(t)) {
        push('tags.require', 'error', `节点 ${candidate.id}「${candidate.title}」缺少必填标签 "${t}"（规则 ${r.id}）`, candidate.id)
      }
    }
    for (const sec of r.content_sections ?? []) {
      if (!String(candidate.content ?? '').includes(sec)) {
        push('content.sections', 'error', `节点 ${candidate.id} 正文缺少段落「${sec}」（规则 ${r.id}）`, candidate.id)
      }
    }
    for (const key of r.ref_exists ?? []) {
      const v = ext[key]
      const target = typeof v === 'string' ? v.trim() : null
      if (!target) {
        push('ref_exists', 'error', `节点 ${candidate.id} 的引用字段 "${key}" 缺失或非字符串（规则 ${r.id}）`, candidate.id)
      } else if (!liveRefs.has(target)) {
        push('ref_exists', 'error', `节点 ${candidate.id} 的 "${key}"=${JSON.stringify(v)} 不指向任何存活节点（编号或 id）`, candidate.id)
      }
    }
    const evidenceKeys = r.status_evidence?.[candidate.status]
    if (evidenceKeys) {
      for (const key of evidenceKeys) {
        if (ext[key] == null || ext[key] === '') {
          push('status.evidence', 'error', `节点 ${candidate.id} 状态为 ${candidate.status} 但缺少 "${key}"（规则 ${r.id}）`, candidate.id)
        }
      }
    }
    // 连续性（warn，不阻断）：新增编号跳号 + title/id 编号一致性
    if (r.numbering) {
      const mId = c.numId.exec(candidate.id)
      const mTitle = c.numTitle.exec(candidate.title)
      if (mId && candidate.version === 1) {
        const seen = new Set()
        for (const id of packet.versions.keys()) {
          const m = c.numId.exec(id)
          if (m) seen.add(parseInt(m[1], 10))
        }
        const max = seen.size ? Math.max(...seen) : 0
        if (parseInt(mId[1], 10) > max + 1) {
          push('id.continuity', 'warn', `新增编号 ${parseInt(mId[1], 10)} 跳过未用编号 ${max + 1}..${parseInt(mId[1], 10) - 1}（规则 ${r.id}）`)
        }
      }
      if (mId && mTitle && parseInt(mId[1], 10) !== parseInt(mTitle[1], 10)) {
        push('id.continuity', 'warn', `节点 ${candidate.id} 的 title 编号 ${r.numbering.title_prefix}-${parseInt(mTitle[1], 10)} 与 id 编号 ${parseInt(mId[1], 10)} 不一致`, candidate.id)
      }
    }
  }
  return violations
}

// realpath 归一：文件不存在时退回「真实化父目录 + 文件名」（init 建包前包文件尚不存在）
function realPathOfFile(p) {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.join(fs.realpathSync(path.dirname(path.resolve(p))), path.basename(p))
  }
}

// 包与 schema 的相对路径换算（bind 写入 / lint 解析 / init 建包共用，两侧统一 realpath 归一，
// 避免 macOS /var ↔ /private/var 这类 symlink 前缀不一致导致相对路径跨界）
export function relativeSchemaFile(packetPath, schemaPath) {
  const pktDir = path.dirname(realPathOfFile(path.resolve(packetPath)))
  const schemaAbs = realPathOfFile(path.resolve(schemaPath))
  return path.relative(pktDir, schemaAbs)
}

// 逆运算：按包目录解析 metadata.template.file（允许 ../）
export function resolveSchemaFile(packetPath, recordedFile) {
  const pktDir = path.dirname(realPathOfFile(path.resolve(packetPath)))
  return path.resolve(pktDir, recordedFile)
}

// ---------- 第四段：skeletonLines ----------

// 按 schema.skeleton 派生 init 骨架 JSONL 行：根 + 容器（父=根、声明顺序），无示例业务节点。
// 调用方契约：schema 已过 parseSchema + checkSchema（init --template 负责先检后建）。
export function skeletonLines(schema, { name, packetId, version = 'v1.0.0', rootId = randomUUID(), metadata = {}, user = null } = {}) {
  if (!isPlainObject(schema) || !Array.isArray(schema.skeleton)) {
    throw new DtpError('SCHEMA_INVALID', 'schema 缺少 skeleton 数组，无法派生骨架')
  }
  const base = initPacketLines({ name, packetId, version, rootId, metadata, user })
  const lines = [...base.lines]
  const now = base.meta.created_at // 单次写入，全部行同时间戳
  for (const c of schema.skeleton) {
    if (c.id === rootId) throw new DtpError('USAGE', `容器 id "${c.id}" 与根节点 id 冲突`)
    const node = {
      type: 'node',
      id: c.id,
      parent_id: rootId,
      node_type: c.type ?? 'folder',
      title: c.title,
      description: c.description ?? '',
      content: '',
      extensions: {},
      created_at: now,
      updated_at: now,
      version: 1,
      hash: '',
      tags: normalizeTags(c.tags ?? []),
      status: 'draft',
    }
    node.hash = computeNodeHash(node)
    lines.push(node, {
      type: 'changelog',
      node_id: c.id,
      field: '*created',
      old_hash: null,
      new_hash: node.hash,
      timestamp: now,
      user: user ?? null,
      version: 1,
    })
  }
  const meta = { ...base.meta, updated_at: now }
  lines.push(meta)
  return { lines, meta, root: base.root }
}
