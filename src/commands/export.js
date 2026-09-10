import fs from 'node:fs'
import { DtpError } from '../errors.js'
import { toMarkdown, toHtml } from '../export.js'
import { assertWritableOutput } from './_shared.js'

// export 为保留字，命令对象以 exportCmd 导出
export const exportCmd = {
  name: 'export',
  summary: '导出节点（及其子树）为 Markdown 或 HTML',
  args: [{ name: 'node', desc: '节点 ID（唯一前缀）或 /语义路径，默认根节点' }],
  options: {
    format: { arg: 'fmt', default: 'md', desc: 'md | html' },
    output: { arg: 'file', desc: '写入文件（默认打印到标准输出）' },
  },
  example: ['dtp export n_root --format md > doc.md', 'dtp export fr001 --format html --output doc.html'],
  run(ctx) {
    const format = String(ctx.opts.format).toLowerCase()
    if (format !== 'md' && format !== 'html' && format !== 'markdown') {
      throw new DtpError('USAGE', `--format 仅支持 md | html，收到 "${ctx.opts.format}"`)
    }
    const packet = ctx.load()
    const node = ctx.args.node ? packet.resolveRef(ctx.args.node) : packet.root()
    const text = format === 'html' ? toHtml(packet, node.id) : toMarkdown(packet, node.id)

    if (ctx.opts.output) {
      assertWritableOutput(ctx.opts.output)
      fs.writeFileSync(ctx.opts.output, text, 'utf8')
      const count = 1 + packet.descendantsOf(node.id).length
      ctx.out.ok(
        { output: ctx.opts.output, format, bytes: Buffer.byteLength(text), root: node.id, nodes: count },
        () => console.log(`已导出 ${count} 个节点 → ${ctx.opts.output} (${format})`)
      )
      return
    }
    const count = 1 + packet.descendantsOf(node.id).length
    ctx.out.ok(
      { format, bytes: Buffer.byteLength(text), root: node.id, nodes: count, content: text },
      () => process.stdout.write(text)
    )
  },
}
