// template 子命令（US-002）：模版 schema 的生成（new）/ 自检（check）/ 绑定（bind）。
// 单文件 dispatch：首个位置参数为子命令名；bind 走 touchMeta 追加 packet_meta 行（append-only）。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DtpError } from '../errors.js'
import { parseSchema, checkSchema, relativeSchemaFile } from '../template.js'
import { assertWritableOutput } from './_shared.js'
import { command as lintCommand } from './lint.js'
import { color } from '../output.js'

const SUBCOMMANDS = ['new', 'check', 'bind']

// template new 的最小可跑骨架：comment 键即注释（DSL 求值忽略），产物必须通过自身 check
function buildSchemaSkeleton(name) {
  return {
    name,
    version: '1.0.0',
    comment: `${name} 数据包模版（DSL v1）。comment 键为人类注释，校验与求值均忽略；可配置键以 dtp template check 的报错为准`,
    skeleton: [
      {
        id: 'f_items',
        title: '条目池',
        type: 'folder',
        description: '登记条目的容器。dtp init --template 按 skeleton 建包（挂根节点下）；lint 校验容器存在且 id/type/title 与声明一致',
        comment: '容器骨架，可声明多个；可选键：tags',
      },
    ],
    rules: [
      {
        id: 'item',
        comment: '最小可跑示例规则：match 认领 → 字段校验 → 编号连续性（warn）。可选键：ext_required / ext_arrays / ref_exists / status_evidence 等',
        scope: { parent: 'f_items' },
        match: { id: '^item\\d{3}$', title: '^ITEM-\\d{3}' },
        id_pattern: '^item\\d{3}$',
        title_pattern: '^ITEM-\\d{3} ',
        tags_require: ['item'],
        numbering: { title_prefix: 'ITEM', id_prefix: 'item', digits: 3 },
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

function readSchemaFile(file, { action }) {
  if (!fs.existsSync(file)) {
    throw new DtpError('USAGE', `schema 文件不存在：${file}（先用 dtp template new <name> 生成）`)
  }
  const buf = fs.readFileSync(file)
  return { buf, text: buf.toString('utf8'), sha256: createHash('sha256').update(buf).digest('hex'), file, action }
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
    console.log(color.dim(`下一步：编辑规则 → dtp template check ${outFile} 自检 → dtp init <包名> --template ${outFile} 建包`))
  })
}

function runCheck(ctx) {
  if (!ctx.args.target) throw new DtpError('USAGE', 'template check 需要 <schema 文件路径>')
  const { text, file } = readSchemaFile(ctx.args.target, { action: 'check' })
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
    throw new DtpError(
      'SCHEMA_VIOLATION',
      `拒绝开启强制校验：当前包对该 schema 存在 ${errors.length} 项 error 级违规（先修数据：dtp lint --packet ${packetPath} --schema ${schemaFile}）`,
      { violations: errors }
    )
  }
  return captured
}

function runBind(ctx) {
  if (!ctx.args.target) throw new DtpError('USAGE', 'template bind 需要 <schema 文件路径>')
  // enforce 三态（US-005 裁决②）：--enforce=true / --no-enforce=false / 都不给=保持现值
  const on = ctx.opts.enforce === true
  const off = ctx.opts['no-enforce'] === true
  if (on && off) throw new DtpError('USAGE', '--enforce 与 --no-enforce 互斥')
  const enforceFlag = on ? true : off ? false : null
  const { text, sha256, file } = readSchemaFile(ctx.args.target, { action: 'bind' })
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
    if (enforceFlag === true) assertEnforceable(packet, ctx.packetPath, file)
    // file 记相对包文件目录的路径（允许 ../，lint 按包目录解析）；
    // 包已加载成功，realpath 两侧归一不会 ENOENT
    template.file = relativeSchemaFile(ctx.packetPath, file)
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

export const command = {
  name: 'template',
  summary: '模版管理：new 生成 schema 骨架 / check 自检 / bind 绑定到包',
  args: [
    { name: 'action', required: true, desc: 'new | check | bind' },
    { name: 'target', required: false, desc: 'new：模版名；check/bind：schema 文件路径' },
  ],
  options: {
    out: { arg: 'path', desc: '（仅 new）schema 输出路径，默认 ./<模版名>.schema.json' },
    enforce: { desc: '（仅 bind）开启写路径强制校验（需包当前无 error 级违规）' },
    'no-enforce': { desc: '（仅 bind）显式关闭强制校验；两者都不给则保持现值' },
  },
  example: [
    'dtp template new weekly && dtp template check weekly.schema.json',
    'dtp template bind ./weekly.schema.json --packet ./周报包.dtp',
  ],
  run(ctx) {
    const action = ctx.args.action
    if (!SUBCOMMANDS.includes(action)) {
      throw new DtpError('USAGE', `未知子命令 "${action}"（template 可用：${SUBCOMMANDS.join(' | ')}）`)
    }
    if (action === 'new') return runNew(ctx)
    if (action === 'check') return runCheck(ctx)
    return runBind(ctx)
  },
}
