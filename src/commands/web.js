// web 命令（US-003）：启动可视化控制台（webui/，零依赖单进程 import 直启）。
// 工作区解析链与包解析链同源（src/config.js）：--dir > DTP_WORKSPACE > .dtp/config.json 存在→.dtp/ > 报错指引。
// --open 默认关（headless/CI 安全）；服务长驻：run 返回后 http server 句柄维持事件循环。
import { spawn } from 'node:child_process'
import { resolveWebWorkspace } from '../config.js'
import { DtpError } from '../errors.js'
import { color } from '../output.js'

// 跨平台开浏览器：失败仅警告（开浏览器是便利不是功能，不能因它判定启动失败）
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  const child = process.platform === 'win32' ? spawn('cmd', ['/c', cmd, url], { detached: true, stdio: 'ignore' }) : spawn(cmd, [url], { detached: true, stdio: 'ignore' })
  child.unref()
  child.on('error', () => console.error(`${color.yellow('dtp: ⚠')} 无法自动打开浏览器（${cmd}），请手动访问 ${url}`))
}

export const command = {
  name: 'web',
  summary: '启动可视化控制台（webui，Ctrl-C 退出）',
  args: [],
  options: {
    port: { arg: 'n', desc: '监听端口（默认 4761）' },
    host: { arg: 'host', desc: '监听地址（默认 127.0.0.1，仅本机访问）' },
    dir: { arg: 'path', desc: '工作区目录（默认按 DTP_WORKSPACE > .dtp/ 解析）' },
    open: { desc: '启动后自动打开浏览器（默认不打开）' },
  },
  example: ['dtp web --open', 'dtp web --port 4762 --dir ./docs'],
  async run(ctx) {
    const { path: workspace, source } = resolveWebWorkspace(process.cwd(), ctx.opts.dir)
    // 严格十进制整数（ISSUE-026）：Number() 会把 0x10 / 1e2 / " 1 " 静默解释成别的端口
    let port
    if (ctx.opts.port !== undefined) {
      const raw = String(ctx.opts.port)
      const n = /^\d+$/.test(raw) ? Number(raw) : NaN
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new DtpError('USAGE', `--port 需要是 1-65535 的整数（收到 "${ctx.opts.port}"）`)
      }
      port = n
    }
    // 空 host 会被 Node 解释为全网卡（TCP *:port），与「默认仅本机」相悖（ISSUE-028）
    const host = ctx.opts.host !== undefined ? String(ctx.opts.host).trim() : undefined
    if (ctx.opts.host !== undefined && !host) {
      throw new DtpError('USAGE', '--host 不能为空（默认 127.0.0.1 仅本机访问；对外监听请用 --host 0.0.0.0）')
    }
    // 动态 import：CLI 其它命令不为 webui 付加载成本
    const { start } = await import('../../webui/server.js')
    let info
    try {
      info = await start({ host, port, workspace })
    } catch (e) {
      throw new DtpError('USAGE', e.message)
    }
    ctx.out.ok(
      { url: info.url, host: info.host, port: info.port, workspace: info.workspace, workspace_source: source, open: Boolean(ctx.opts.open) },
      () => {
        console.log(`可视化控制台 → ${color.bold(info.url)}`)
        console.log(color.dim(`工作区：${info.workspace}（来源：${source}）`))
        console.log(color.dim('Ctrl-C 退出；界面树/查询/编辑与 CLI 共享同一引擎与文件锁'))
      }
    )
    if (ctx.opts.open) openBrowser(info.url)
  },
}
