// settings 子命令（US-006）：配置态命名空间真身。template new/check/bind 自旧位置平移收归，
// 另增 settings show 只读聚合（绑定 schema 名/version/sha、enforce 态、容器清单、逐规则摘要）。
// 旧 dtp template 降级为转发壳（commands/template.js）指向本 dispatch——单一实现路径保证
// 两入口 stdout 逐字节等价，弃用提示只进 stderr。topic=template 的报错文案与旧实现逐字一致。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DtpError } from '../errors.js'
import { parseSchema, checkSchema, describeSchema, relativeSchemaFile, resolveSchemaFile } from '../template.js'
import { assertWritableOutput } from './_shared.js'
import { command as lintCommand } from './lint.js'
import { color } from '../output.js'

export const TEMPLATE_ACTIONS = ['new', 'check', 'bind', 'unbind']
export const SETTINGS_TOPICS = ['template', 'show']

// template new 的骨架（OPTIM-033）：示范完整键集而非最小集——写真实场景不必回头读 DSL 文档。
// comment 键即注释（DSL 求值忽略），产物必须通过自身 check（自举保证）。
// 第二容器/第二规则专示范 ref_exists 引用核查，不需要可整块删除。
function buildSchemaSkeleton(name) {
  return {
    name,
    version: '1.0.0',
    comment: `${name} 数据包模版（DSL v1）。comment 键为人类注释，校验与求值均忽略；可配置键以 dtp settings template check 的报错为准`,
    skeleton: [
      {
        id: 'f_items',
        title: '条目池',
        type: 'folder',
        description: '登记条目的容器。dtp init --template 按 skeleton 建包（挂根节点下）；lint 校验容器存在且 id/type/title 与声明一致',
        comment: '容器骨架，可声明多个；可选键：tags',
      },
      {
        id: 'f_notes',
        title: '备注池',
        type: 'folder',
        description: '存放引用条目的备注（示范 ref_exists 引用核查）',
        comment: '第二个容器只为示范「引用其他节点」的规则写法；用不到可删（同时删 note 规则）',
      },
    ],
    rules: [
      {
        id: 'item',
        comment: [
          '主规则示范各键用途（不需要的键整行删除即可）：',
          '· scope.parent：规则生效的父容器 id（也可填另一条规则的 id，表示挂在该规则认领的节点下）',
          '· match：认领谓词——id 或 title 任一命中即受本规则治理（两者都给更稳；都不给规则永不生效）',
          '· id_pattern / title_pattern：节点 id 与标题必须匹配的正则',
          '· content_sections：正文必须包含的段落标题（精确字面匹配，变体标题不算命中）',
          '· ext_required：必填扩展字段（dtp update <节点> --ext 键=值 补齐）',
          '· ext_arrays：值必须是 JSON 数组的扩展字段',
          '· tags_require：必填标签（精确匹配、大小写敏感）',
          '· status_evidence：置某状态前必须回填的扩展字段（如 approved 前要有 done_evidence）',
          '· numbering：编号约定（id 与 title 编号不一致、编号空洞为 warn 级告警，不阻断）',
          '· scope.exclusive（本骨架未启用）：true = 该容器下不允许出现未被任何规则认领的节点（warn 级）',
        ].join('\n'),
        scope: { parent: 'f_items' },
        match: { id: '^item\\d{3}$', title: '^ITEM-\\d{3}' },
        id_pattern: '^item\\d{3}$',
        title_pattern: '^ITEM-\\d{3} ',
        content_sections: ['【说明】', '【验收口径】'],
        ext_required: ['owner'],
        ext_arrays: ['acceptance'],
        tags_require: ['item'],
        status_evidence: { approved: ['done_evidence'] },
        numbering: { title_prefix: 'ITEM', id_prefix: 'item', digits: 3 },
      },
      {
        id: 'note',
        comment: '引用示范：ref_exists 要求 ext 的 item_ref 指向存活节点（标题编号如 ITEM-001，或节点 id）',
        scope: { parent: 'f_notes' },
        match: { id: '^note\\d{3}$', title: '^NOTE-\\d{3}' },
        id_pattern: '^note\\d{3}$',
        title_pattern: '^NOTE-\\d{3} ',
        ext_required: ['item_ref'],
        ref_exists: ['item_ref'],
        numbering: { title_prefix: 'NOTE', id_prefix: 'note', digits: 3 },
      },
    ],
  }
}

// 模版名同时用作默认文件名：拒绝空白与路径分隔符，避免写到预期之外的位置
function assertTemplateName(name) {
  if (typeof name !== 'string' || !name.trim() || /\s|\//.test(name)) {
    throw new DtpError('USAGE', `非法模版名 "${name}"（非空且不含空白与 '/'）`)
  }
  return name.trim()
}

// OPTIM-034：两处解析——先按 cwd（常规 CLI 语义），未命中再按包目录回退。
// 回退的意义：settings show 的 file 字段是「相对包文件目录」的契约路径（如 ../../x.schema.json），
// 照抄到 bind/check 时若 cwd ≠ 包目录就会指到包外（USAGE）。abs 则是绝对路径（照抄即可）。
// 两字段语义：file = 包相对、落盘契约；abs = 绝对路径、照抄可用（不落盘）。
function readSchemaFile(file, ctx) {
  const load = (absPath) => {
    const buf = fs.readFileSync(absPath)
    return { buf, text: buf.toString('utf8'), sha256: createHash('sha256').update(buf).digest('hex'), file, path: absPath }
  }
  const cwdPath = path.resolve(file)
  if (fs.existsSync(cwdPath)) return load(cwdPath)
  if (ctx?.packetPath && fs.existsSync(ctx.packetPath)) {
    const pktPath = resolveSchemaFile(ctx.packetPath, file)
    if (fs.existsSync(pktPath)) return load(pktPath)
  }
  const pktHint = ctx?.packetPath && fs.existsSync(ctx.packetPath) ? `；包目录解析：${resolveSchemaFile(ctx.packetPath, file)}` : ''
  throw new DtpError(
    'USAGE',
    `schema 文件不存在：${file}（cwd 解析：${cwdPath}${pktHint}；先用 dtp settings template new <name> 生成）`
  )
}

function runNew(ctx) {
  const name = assertTemplateName(ctx.args.target)
  const outFile = ctx.opts.out ?? `./${name}.schema.json`
  if (fs.existsSync(outFile)) {
    throw new DtpError('EXISTS', `文件已存在：${outFile}（换个名字、指定 --out，或删除后重试）`)
  }
  assertWritableOutput(outFile)
  const schema = buildSchemaSkeleton(name)
  // 骨架产物必须通过自身 check（自举保证）；失败即实现缺陷
  const problems = checkSchema(schema)
  if (problems.length) {
    throw new DtpError('INTERNAL', `template new 生成的骨架未通过自检（不应发生）：${problems.join('；')}`)
  }
  fs.writeFileSync(outFile, JSON.stringify(schema, null, 2) + '\n', 'utf8')
  ctx.out.ok({ schema_file: outFile, name: schema.name, version: schema.version }, () => {
    console.log(`已生成模版 schema → ${outFile}`)
    console.log(color.dim(`下一步：编辑规则 → dtp settings template check ${outFile} 自检 → dtp init <包名> --template ${outFile} 建包`))
  })
}

function runCheck(ctx) {
  if (!ctx.args.target) throw new DtpError('USAGE', 'template check 需要 <schema 文件路径>')
  const { text, file } = readSchemaFile(ctx.args.target, ctx)
  const problems = checkSchema(text)
  const ok = problems.length === 0
  let summary = ''
  if (ok) {
    const schema = parseSchema(text)
    summary = `${schema.skeleton.length} 个容器 · ${schema.rules?.length ?? 0} 条规则`
  }
  ctx.out.ok({ ok, file, problems }, () => {
    if (ok) console.log(`${color.green('✓')} schema 自检通过（${summary}）`)
    else {
      console.log(`${color.red('✗')} schema 自检发现 ${problems.length} 处问题：`)
      problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`))
    }
  })
  if (!ok) process.exitCode = 1
}

// lint 前置门（US-005 裁决①）：开启强制前先按待绑 schema 全包评估一遍，
// error 级违规存在则拒绝（warn 不挡——连续性告警不该阻止开强制）。
// 复用 lint 命令：以 --schema 指向待绑文件评估现有数据（首绑无既有绑定也能跑）
function assertEnforceable(packet, packetPath, schemaFile) {
  let captured = null
  const prevExit = process.exitCode
  try {
    lintCommand.run({
      packetPath,
      opts: { schema: schemaFile },
      load: () => packet,
      out: {
        ok(obj) {
          captured = obj
        },
      },
    })
  } finally {
    process.exitCode = prevExit ?? 0 // lint 有 error 会置 exitCode，用后复位
  }
  const errors = (captured?.violations ?? []).filter((v) => v.severity === 'error')
  if (captured?.ok === false && errors.length) {
    // 提示增强（不改拦截语义）：附受影响节点清单（id/标题），省去「再跑一次 lint 才知道是谁」
    throw new DtpError(
      'SCHEMA_VIOLATION',
      `拒绝开启强制校验：当前包对该 schema 存在 ${errors.length} 项 error 级违规（先修数据：dtp lint --packet ${packetPath} --schema ${schemaFile}）${affectedNodesText(packet, errors)}`,
      { violations: errors }
    )
  }
  return captured
}

// 受影响节点清单：按违规明细去重取 id/标题（上限 10 条，超出以「等 N 个」收尾）。
// 只列带 node_id 的违规——容器级缺失（skeleton.missing）无节点 id 不进清单但计入违规条数
// （026 复验确认的合理语义，已在 README/SKILL 点明，避免误报为矛盾）
function affectedNodesText(packet, errors) {
  const ids = [...new Set(errors.map((v) => v.node_id).filter(Boolean))]
  if (!ids.length) return ''
  const shown = ids.slice(0, 10)
  const parts = shown.map((id) => {
    const n = packet.nodes.get(id)
    return n ? `${id}「${n.title}」` : id
  })
  const more = ids.length > shown.length ? ` 等 ${ids.length} 个` : ''
  return `\n受影响节点（${ids.length}）：${parts.join('、')}${more}`
}

function runBind(ctx) {
  if (!ctx.args.target) throw new DtpError('USAGE', 'template bind 需要 <schema 文件路径>')
  // enforce 三态（US-005 裁决②）：--enforce=true / --no-enforce=false / 都不给=保持现值
  const on = ctx.opts.enforce === true
  const off = ctx.opts['no-enforce'] === true
  if (on && off) throw new DtpError('USAGE', '--enforce 与 --no-enforce 互斥')
  const enforceFlag = on ? true : off ? false : null
  const { text, sha256, path: schemaAbs } = readSchemaFile(ctx.args.target, ctx)
  // 无效 schema 拒绝写入（先自检后进锁，坏 schema 不触碰包文件）
  const problems = checkSchema(text)
  if (problems.length) {
    throw new DtpError('SCHEMA_INVALID', `schema 未通过自检（${problems.length} 处），拒绝绑定。首条：${problems[0]}`)
  }
  const schema = parseSchema(text)
  const template = { name: schema.name, version: schema.version, schema_sha256: sha256, file: '' }
  const rebound = ctx.withLock(() => {
    const packet = ctx.load()
    const prev = packet.meta.metadata?.template ?? null
    // 前置门：开启强制前拒绝脏数据（在锁内、写入前——被拒则包零写入）
    if (enforceFlag === true) assertEnforceable(packet, ctx.packetPath, schemaAbs)
    // file 记相对包文件目录的路径（允许 ../，lint 按包目录解析）；
    // 以回退解析出的绝对路径换算，跨 cwd 绑定同样得到正确的包相对值（OPTIM-034）
    template.file = relativeSchemaFile(ctx.packetPath, schemaAbs)
    // 元数据最小化：首绑且未给 flag 不写 enforce 字段；给了 flag 写显式值；未给且已绑则保持
    if (enforceFlag !== null) template.enforce = enforceFlag
    else if (prev?.enforce !== undefined) template.enforce = prev.enforce
    packet.meta.metadata ??= {}
    packet.meta.metadata.template = { ...template }
    packet.touchMeta() // 追加 packet_meta 行，不改写历史（append-only）
    packet.save()
    return Boolean(prev)
  })
  ctx.out.ok({ packet: ctx.packetPath, template, rebound }, () => {
    console.log(
      `${rebound ? '已更新绑定' : '已绑定'}：${template.name} v${template.version} → ${ctx.packetPath}`
    )
    console.log(
      template.enforce === true
        ? color.green('强制校验：已开启（add/update 写路径拦截违规，见 US-005）')
        : color.dim(template.enforce === false ? '强制校验：显式关闭（--no-enforce）' : '强制校验：未开启')
    )
    console.log(color.dim(`sha256 ${template.schema_sha256.slice(0, 12)}… · file ${template.file}`))
    console.log(color.dim('校验：dtp lint --packet ' + ctx.packetPath))
  })
}

// settings show：配置态只读聚合。四态——无绑定 / enforce 三态 / schema 文件丢失（降级，
// sha 仍在案）/ sha 漂移（警告）。漂移与丢失都属「配置现状」报告而非失败，恒 exit 0；
// 包缺失走 ctx.load() 惯例（NO_PACKET）。
function runShow(ctx) {
  if (ctx.args.action !== undefined || ctx.args.target !== undefined) {
    throw new DtpError('USAGE', 'settings show 不接受位置参数（配置态只读聚合；数据包用 --packet 指定）')
  }
  const packet = ctx.load()
  const t = packet.meta.metadata?.template ?? null

  // 绑定 schema 的当前文件态：丢失 → found:false；在案 → sha 比对 + 自检（漂移时摘要按当前文件给）
  let schema = null
  if (t?.file) {
    const abs = resolveSchemaFile(ctx.packetPath, t.file)
    if (!fs.existsSync(abs)) {
      // OPTIM-031：abs 为相对包文件目录解析出的绝对路径——照抄即可 bind/check，不受 cwd 影响
      schema = { found: false, file: t.file, abs }
    } else {
      const buf = fs.readFileSync(abs)
      const sha256 = createHash('sha256').update(buf).digest('hex')
      const drift = t.schema_sha256 ? sha256 !== t.schema_sha256 : true
      const problems = checkSchema(buf.toString('utf8'))
      schema = { found: true, file: t.file, abs, sha256, drift, problems }
    }
  }
  // 容器清单与逐规则摘要仅当 schema 在案且自检通过。人类渲染收编 describeSchema 共享实现
  // （TASK-023 acc6 裁决）：与 skill 动态层同一规约文本；--json payload 形状不变
  // （rules 仍为去注释结构化投影，不采用 describeSchema 的文本行）
  const usable = schema?.found && schema.problems.length === 0
  const parsed = usable ? parseSchema(fs.readFileSync(resolveSchemaFile(ctx.packetPath, t.file), 'utf8')) : null
  const described = parsed ? describeSchema(parsed) : null

  const payload = {
    packet: ctx.packetPath,
    template: t
      ? { name: t.name, version: t.version, schema_sha256: t.schema_sha256, file: t.file, enforce: t.enforce ?? null }
      : null,
    schema,
    // --json 形状契约：skeleton 显式三字段、rules 剔除 comment 肥字段、约束键原样保留
    skeleton: parsed ? parsed.skeleton.map((c) => ({ id: c.id, title: c.title, type: c.type ?? 'folder' })) : null,
    rules: parsed ? (parsed.rules ?? []).map(withoutComment) : null,
  }
  ctx.out.ok(payload, () => {
    console.log(`包：${ctx.packetPath} — 配置态聚合`)
    if (!t) {
      console.log('绑定模版：无（dtp settings template bind <schema> --packet <包> 绑定后此处显示聚合）')
      return
    }
    const enforceText =
      t.enforce === true
        ? color.green('强制校验：开启（add/update 写路径拦截违规）')
        : color.dim(t.enforce === false ? '强制校验：显式关闭（--no-enforce）' : '强制校验：未设置（默认关）')
    console.log(`绑定模版：${t.name} v${t.version}`)
    console.log(enforceText)
    if (!schema.found) {
      console.log(`${color.yellow('⚠')} schema 文件丢失：${t.file}（期望位置：${schema.abs}；绑定 sha 仍在案：${t.schema_sha256?.slice(0, 12)}…）`)
      return
    }
    if (schema.drift) {
      console.log(
        `${color.yellow('⚠')} schema 与绑定 sha 不一致（漂移）：绑定 ${t.schema_sha256?.slice(0, 12)}… / 当前 ${schema.sha256.slice(0, 12)}…（重新 dtp settings template bind 可更新绑定）`
      )
    } else {
      console.log(`schema：${t.file}（${color.green('✓')} 与绑定一致 · sha256 ${schema.sha256.slice(0, 12)}… · 绝对路径 ${schema.abs}）`)
    }
    console.log(`容器：${payload.skeleton.length} 个`)
    for (const c of payload.skeleton) console.log(`  ${c.id}  ${c.type ?? 'folder'}  ${c.title}`)
    console.log(`规则：${described.rules.length} 条（依赖拓扑序；「为什么」为 schema 作者注释）`)
    for (const r of described.rules) {
      console.log(`  【${r.id}】${r.comment ? `  为什么：${r.comment}` : ''}`)
      for (const l of r.lines) console.log(`    · ${l}`)
    }
  })
}

// 结构化规则投影剔除 comment（人类注释不进 --json；规约文本走 describeSchema 人类渲染）
function withoutComment(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (k !== 'comment') out[k] = v
  return out
}

// settings template unbind：配置态退出路径（OPTIM-035）。语义取舍（append-only 铁律）：
// ①「解绑」以**新增 packet_meta 行**表达（当前 metadata.template 置 null），绝不改写历史绑定行——
//    历史行仍完整记录「曾绑定过什么」；
// ②强制态随绑定一起消失（没有 schema 就没有强制的依据），故 enforce=true 时要求显式 --force 确认，
//    避免静默关掉保护；只想关强制不解绑则走 bind --no-enforce。
// 换绑不新增命令：再次 bind 即换绑（rebound=true，同一 append-only 路径）。
function runUnbind(ctx) {
  if (ctx.args.target !== undefined) {
    throw new DtpError('USAGE', 'settings template unbind 不接受位置参数（解绑按包执行：用 --packet 指定）')
  }
  const removed = ctx.withLock(() => {
    const packet = ctx.load()
    const prev = packet.meta.metadata?.template ?? null
    if (!prev) {
      throw new DtpError('USAGE', `包未绑定模版，无可解绑：${ctx.packetPath}（绑定：dtp settings template bind <schema> --packet <包>）`)
    }
    if (prev.enforce === true && ctx.opts.force !== true) {
      throw new DtpError(
        'USAGE',
        '该包开启了强制校验（enforce=true），解绑会一并解除强制；确认请加 --force，或先 dtp settings template bind --no-enforce 只关强制'
      )
    }
    packet.meta.metadata ??= {}
    packet.meta.metadata.template = null
    packet.touchMeta() // 追加 packet_meta 行，不改写历史（append-only）
    packet.save()
    return prev
  })
  ctx.out.ok(
    { packet: ctx.packetPath, unbound: { name: removed.name, version: removed.version }, enforce_cleared: removed.enforce === true },
    () => {
      console.log(`已解绑：${removed.name} v${removed.version} → ${ctx.packetPath}（append-only：新增 packet_meta 行，历史绑定行未改写）`)
      if (removed.enforce === true) console.log(color.yellow('⚠') + ' 强制校验已随绑定一并解除（无 schema 即无强制依据）')
      console.log(color.dim('重新绑定：dtp settings template bind <schema> --packet <包>（绑定不同 schema 即换绑）'))
    }
  )
}

export const command = {
  name: 'settings',
  summary: '配置态：settings template new/check/bind/unbind（模版收归）+ settings show（绑定与规则只读聚合）',
  args: [
    { name: 'topic', required: true, desc: 'template | show' },
    { name: 'action', required: false, desc: 'topic=template 时：new | check | bind | unbind；topic=show 时不接受' },
    { name: 'target', required: false, desc: 'new：模版名；check/bind：schema 文件路径' },
  ],
  options: {
    out: { arg: 'path', desc: '（仅 settings template new）schema 输出路径，默认 ./<模版名>.schema.json' },
    enforce: { desc: '（仅 settings template bind）开启写路径强制校验（需包当前无 error 级违规）' },
    'no-enforce': { desc: '（仅 settings template bind）显式关闭强制校验；两者都不给则保持现值' },
    force: { short: 'f', desc: '（仅 settings template unbind）确认：enforce 态解绑会一并解除强制校验' },
  },
  example: [
    'dtp settings template new weekly && dtp settings template check weekly.schema.json',
    'dtp settings template bind ./weekly.schema.json --packet ./周报包.dtp',
    'dtp settings template unbind --packet ./周报包.dtp   # 解绑（enforce 态需 --force）',
    'dtp settings show --packet ./周报包.dtp',
  ],
  run(ctx) {
    const topic = ctx.args.topic
    if (topic === 'show') return runShow(ctx)
    if (topic !== 'template') {
      throw new DtpError('USAGE', `未知 topic "${topic}"（settings 可用：${SETTINGS_TOPICS.join(' | ')}）`)
    }
    const action = ctx.args.action
    if (!action) throw new DtpError('USAGE', 'settings template 需要 <action>（new | check | bind | unbind）')
    // 文案与旧 template.js 逐字一致：转发壳依赖同一报错保证 stdout 等价
    if (!TEMPLATE_ACTIONS.includes(action)) {
      throw new DtpError('USAGE', `未知子命令 "${action}"（template 可用：${TEMPLATE_ACTIONS.join(' | ')}）`)
    }
    if (action === 'new') return runNew(ctx)
    if (action === 'check') return runCheck(ctx)
    if (action === 'unbind') return runUnbind(ctx)
    return runBind(ctx)
  },
}
