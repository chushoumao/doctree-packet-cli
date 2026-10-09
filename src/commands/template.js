// template 子命令——弃用转发壳（US-006 / TASK-022）：实现已收归 settings.js（dtp settings template ...）。
// stderr 弃用提示后原样转发（补 topic=template），stdout 逐字节等价靠同一代码路径保证；
// 本文件不再持有任何实现。args/options/summary/example 仅服务 --help 渲染（保留旧用法）。
import { command as settingsCommand } from './settings.js'

export const command = {
  name: 'template',
  summary: '（弃用别名 → dtp settings template）模版管理：new 生成 schema 骨架 / check 自检 / bind 绑定到包',
  args: [
    { name: 'action', required: true, desc: 'new | check | bind | unbind' },
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
    // 弃用提示恒走 stderr（人类与 --json 同文案），不污染 stdout/--json 单行契约
    console.error('dtp: 提示：dtp template 已更名 dtp settings template，本版本行为完全等价（弃用别名，后续版本可能移除）')
    return settingsCommand.run({ ...ctx, args: { topic: 'template', ...ctx.args } })
  },
}
