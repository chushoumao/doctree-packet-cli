// dtp Web UI — HTTP 服务
// 零依赖（node:* only）：静态文件 + JSON API（见 api.js），引擎直接复用仓库 src/。
// 两种启动方式：`dtp web` 命令（推荐，工作区解析链见 src/commands/web.js）或
// `node webui/server.js` 直跑（开发用，环境变量 HOST/PORT/DTP_WORKSPACE 仍生效）。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { handleApi, configureWorkspace } from './api.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.join(HERE, 'public')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

const MAX_BODY = 5 * 1024 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({ __raw: Buffer.concat(chunks).toString('utf8') })
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath)
  rel = rel.replace(/\\/g, '/')
  const full = path.normalize(path.join(PUBLIC, rel))
  if (!full.startsWith(PUBLIC + path.sep) && full !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  // SPA 回退：无扩展名的路径交给 index.html
  const target = fs.existsSync(full) && fs.statSync(full).isFile()
    ? full
    : path.join(PUBLIC, 'index.html')
  try {
    const data = fs.readFileSync(target)
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
}

// 启动服务（dtp web 与直跑共用）：注入工作区并监听，resolve 于 listening、reject 于绑定失败
export function start({ host, port, workspace, onReady } = {}) {
  const HOST = host ?? process.env.HOST ?? '127.0.0.1'
  const PORT = Number(port ?? process.env.PORT ?? 4761)
  configureWorkspace(workspace)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    try {
      if (url.pathname.startsWith('/api/')) {
        const body = req.method === 'POST' ? await readBody(req) : {}
        // searchParams → 普通对象；同名参数（tag=a&tag=b）收为数组
        const query = {}
        for (const [k, v] of url.searchParams) {
          query[k] = k in query ? [].concat(query[k], v) : v
        }
        const { status, body: out } = handleApi(req.method, url.pathname, query, body)
        sendJson(res, status, out)
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: { code: 'USAGE', message: '只支持 GET / POST' } })
        return
      }
      serveStatic(res, url.pathname)
    } catch (e) {
      sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: String(e?.message ?? e) } })
    }
  })

  // 端口被占 = 大概率已有一个实例在跑（服务的是它自己的工作区）。必须把话挑明，
  // 否则用户会对着旧实例的界面，以为是自己指定的工作区"数据对不上"
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e?.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${PORT} 已被占用——大概率已有一个 dtp web 实例在运行（浏览器此时连的是那个实例）。处理：关掉旧实例，或换端口：dtp web --port ${PORT + 1}`))
        return
      }
      reject(e)
    })
    server.listen(PORT, HOST, () => {
      const info = {
        server,
        url: `http://${HOST}:${PORT}`,
        host: HOST,
        port: PORT,
        workspace: configureWorkspace(workspace),
      }
      onReady?.(info)
      resolve(info)
    })
  })
}

// 直跑守卫：仅在被 node 直接执行时启动（作为模块被 dtp web import 时不触发）
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const workspace = process.env.DTP_WORKSPACE?.trim()
    ? path.resolve(process.env.DTP_WORKSPACE.trim())
    : process.cwd() + path.sep + '.dtp' // 直跑缺省按项目约定，不再有内置 workspace 副本
  start({ workspace })
    .then((info) => {
      console.log(`dtp webui 已启动 → ${info.url}`)
      console.log(`工作区：${info.workspace}`)
      fs.mkdirSync(info.workspace, { recursive: true })
      const packets = fs.readdirSync(info.workspace).filter((f) => /\.dtp$/i.test(f)).length
      console.log(packets ? `现有数据包 ${packets} 个` : '工作区为空（dtp init 或界面「新建数据包」开始）')
    })
    .catch((e) => {
      console.error(`启动失败：${e.message}`)
      process.exit(1)
    })
}
