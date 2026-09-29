// skill 子命令（US-006 / TASK-023）：面向 agent 的使用态规约速查。
// 静态层五节（contract/refs/usage/rules/pitfalls）+ 动态层（包绑定 schema 经 describeSchema 生成）。
// 裸 dtp skill 零参数走默认包链；无包优雅降级（静态层 + init 引导，exit 0，--json packet:null）；
// 显式 --packet 缺失 USAGE exit 2——宽容缺省、严格显式。--section 五节白名单，
// --json 全量 {ok,packet,sections} 与过滤 {ok,packet,section,content} 两形状不混用。
// 节名是 CLI 契约（agent 可编程硬编码）；规则 id 属 schema 数据层不升格为节名，
// 单规则寻址留 rules.<id> 点寻址作自然扩展（v1 不做）。
import fs from 'node:fs'
import { DtpError } from '../errors.js'
import { describeSchema, parseSchema, resolveSchemaFile } from '../template.js'

export const SECTIONS = ['contract', 'refs', 'usage', 'rules', 'pitfalls']

// 静态层内容与仓库既定契约同步（AGENTS.md / README / cli.js 根帮助）；改动这些事实时同步本节
const STATIC = {
  contract: [
    '--json：任何命令 stdout 输出单行 JSON——成功 {ok:true,...}，失败 {ok:false,error:{code,message}}；失败细节的人类可读文本在 stderr',
    '退出码：成功 0；用法/参数错误（USAGE/EXISTS/INVALID_TYPE/INVALID_STATUS）2；其他业务错误 1',
    '错误统一为 DtpError(code,message)；SCHEMA_VIOLATION 附 violations[]（逐条含 severity/hint）',
    'append-only：JSONL 历史行不可改写；一切修改=内存修改+备份+单次追加落盘，失败不留半行',
    '内容哈希只覆盖语义字段（parent_id/node_type/title/description/content/tags/status/extensions），同内容同哈希；篡改巡检不阻断写入、以 warnings 报告',
  ].join('\n'),
  refs: [
    '节点引用三写法（所有接受 <节点> 参数的命令通用）：',
    '1. 完整节点 id（uuid，或唯一前缀——git 风格缩写，歧义时报错并列出候选）',
    '2. 唯一前缀：id 开头片段，命中多个时报 USAGE 并列出候选',
    '3. / 开头语义路径：按 title 逐级匹配，如 /条目池/ITEM-001 对应节点的路径',
    '编号引用（如 US-001）：在 ref_exists 校验与 query 场景按「标题编号段」解析',
  ].join('\n'),
  usage: [
    '建包：dtp init <名> [--template <schema>]；默认位置 .dtp/<名>..dtp，或 --packet 指定',
    '加节点：dtp add <父节点> --title <标题> [--type folder|document|requirement|knowledge|index] [--id <id>] [--ext 键=值] [--tags]',
    '改节点：dtp update <节点> --title/--description/--content/--status/--ext/--tags（各字段可组合）',
    '查询：dtp ls / tree / query（--type --status --tag） / get <节点> --json',
    '版本：dtp history <节点> / dtp checkout <节点> --version N',
    '质量：dtp lint [--schema <文件>] / dtp verify（结构+哈希巡检）',
    '配置态：dtp settings template new/check/bind + dtp settings show（绑定与规则聚合）；dtp template 为弃用别名',
    '规约速查：dtp skill [--section contract|refs|usage|rules|pitfalls]',
  ].join('\n'),
  // rules 节为动态层占位，运行时按包绑定 schema 生成
  pitfalls: [
    '--tag 查询为精确匹配、大小写敏感（同维度多个为「或」；OPTIM-005 裁决：不做归一化）',
    'enforce 包的正文段落校验按精确字面匹配——段落标题不要加括号变体或前后缀',
    '写路径被强制校验拒绝（SCHEMA_VIOLATION）时，读 --json 的 error.violations[].hint 获取逐条修复指引',
    '--ext 的值是单字面量：JSON 数组须整体作为字符串传入，如 --ext acceptance=\'["GIVEN…WHEN…THEN…"]\'',
    '包文件是 JSONL append-only：不要手工编辑历史行；修复用 dtp recover，巡检用 dtp verify',
    'dtp web 端口被占用 = 已有实例在跑（浏览器连的是旧工作区），按报错指引换端口或关旧实例',
  ].join('\n'),
}

// 动态层：包绑定 schema 的逐规则规约。任何配置态问题（无绑/文件丢失/坏 schema）都转为
// rules 节内的警示 + 修复指引——skill 是速查工具，不该因配置态缺陷崩掉整个输出
function renderBoundRules(packetPath, template) {
  if (!template) {
    return '包未绑定模版 schema。绑定后此处显示逐规则规约：dtp settings template bind <schema> --packet <包>'
  }
  const abs = resolveSchemaFile(packetPath, template.file)
  if (!fs.existsSync(abs)) {
    return `⚠ 绑定的 schema 文件丢失：${template.file}（绑定 sha 仍在案）。查看绑定详情：dtp settings show --packet ${packetPath}；恢复文件或重新绑定后重试`
  }
  let schema
  try {
    schema = parseSchema(fs.readFileSync(abs, 'utf8'))
  } catch (e) {
    return `⚠ 绑定的 schema 不是合法 JSON：${template.file}（${e.message}）。修复后重试：dtp template check ${template.file}`
  }
  let d
  try {
    d = describeSchema(schema)
  } catch (e) {
    return `⚠ 绑定的 schema 未通过自检：${e.message}`
  }
  const head = `${d.name} v${d.version} 逐规则规约（${d.rules.length} 条，按依赖拓扑序；「为什么」为 schema 作者注释）：`
  const containers = d.containers.map((c) => `  容器 ${c.id}「${c.title}」[${c.type}]`).join('\n')
  const blocks = d.rules
    .map((r) => {
      const why = r.comment ? `\n  为什么：${r.comment}` : ''
      return `\n【${r.id}】${why}\n${r.lines.map((l) => `  · ${l}`).join('\n')}`
    })
    .join('\n')
  return [head, containers, blocks].join('\n')
}

export const command = {
  name: 'skill',
  summary: 'agent 使用态规约速查：契约/引用/用法速查/逐规则规约（绑定 schema 动态生成）/通用坑',
  args: [],
  options: {
    section: { arg: 'name', desc: `只取一节（${SECTIONS.join(' | ')}）；缺省输出全部五节` },
  },
  example: [
    'dtp skill                          # 全部五节（含当前包绑定 schema 的逐规则规约）',
    'dtp skill --section rules --packet ./周报包.dtp',
    'dtp skill --json --section contract',
  ],
  run(ctx) {
    const section = ctx.opts.section
    if (section !== undefined && !SECTIONS.includes(section)) {
      throw new DtpError('USAGE', `未知 section "${section}"（可用：${SECTIONS.join(' | ')}）`)
    }
    // 降级三态：显式 --packet 缺失严格报错（调用方明确点名了一个包）；缺省解析缺包优雅降级
    const exists = fs.existsSync(ctx.packetPath)
    if (ctx.explicitPacket && !exists) {
      throw new DtpError('USAGE', `数据包不存在：${ctx.packetPath}（显式 --packet 指向的路径须存在；省略 --packet 走默认解析链）`)
    }
    let packetPath = null
    let rulesText
    if (exists) {
      packetPath = ctx.packetPath
      const packet = ctx.load()
      rulesText = renderBoundRules(ctx.packetPath, packet.meta.metadata?.template ?? null)
    } else {
      rulesText =
        '未指定数据包（当前目录无默认包）。建包后此处显示逐规则规约：dtp init <名> 建包 → dtp settings template bind <schema> --packet <包> 绑定'
    }
    const sections = {
      contract: STATIC.contract,
      refs: STATIC.refs,
      usage: STATIC.usage,
      rules: rulesText,
      pitfalls: STATIC.pitfalls,
    }
    if (section !== undefined) {
      // 过滤形状：{ok,packet,section,content}——与全量形状不混用（不同时给 sections 键）
      ctx.out.ok({ packet: packetPath, section, content: sections[section] }, () => {
        console.log(sections[section])
      })
      return
    }
    ctx.out.ok({ packet: packetPath, sections }, () => {
      for (const name of SECTIONS) {
        console.log(`━━━ ${name} ━━━`)
        console.log(sections[name])
        console.log()
      }
    })
  },
}
