// .dtp/ 项目级配置（US-003 3.3）：极简契约 {"version":1,"default":"<文件名>.dtp"}。
// 只存「目录扫描表达不了的默认包选择」；schema 绑定在包内 metadata.template（v1.6.0 契约），
// 不在此重复以免双源漂移。config.json 是普通文件直接覆写（原子：tmp + rename），
// 不受 append-only 纪律约束（那只针对 .dtp 数据包本身）。
import fs from 'node:fs'
import path from 'node:path'
import { DtpError } from './errors.js'

export const CONFIG_DIR = '.dtp'
export const CONFIG_VERSION = 1

// default 只允许 .dtp/ 内的单层安全文件名：天然排除路径分隔符/穿越/盘符
const SAFE_DEFAULT_RE = /^[\w\u4e00-\u9fff][\w\u4e00-\u9fff.\- ]*\.dtp$/i

export const configDirOf = (cwd = process.cwd()) => path.join(cwd, CONFIG_DIR)
export const configPathOf = (cwd = process.cwd()) => path.join(configDirOf(cwd), 'config.json')

// 读取并校验 config；损坏/形状非法抛 CONFIG_INVALID（fail loud，绝不静默忽略）
export function readConfig(cwd = process.cwd()) {
  const file = configPathOf(cwd)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return null
    // .dtp 是文件 / config.json 是目录 / 无读权限：归为 CONFIG_INVALID 并给行动指引，
    // 不冒泡成 INTERNAL 裸栈（ISSUE-029）
    const why =
      e.code === 'ENOTDIR' ? '.dtp 不是目录'
      : e.code === 'EISDIR' ? '.dtp/config.json 是目录'
      : e.code === 'EACCES' ? '无读取权限'
      : (e.code ?? e.message)
    throw new DtpError(
      'CONFIG_INVALID',
      `无法读取 .dtp/config.json（${why}）：${file}（修复或删除该文件/目录后重试，或用 --packet 显式指定数据包）`
    )
  }
  let obj
  try {
    obj = JSON.parse(raw)
  } catch (e) {
    throw new DtpError('CONFIG_INVALID', `.dtp/config.json 不是合法 JSON：${e.message}（修复或删除该文件后重试）`)
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new DtpError('CONFIG_INVALID', `.dtp/config.json 顶层必须是对象 {"version":1,"default":"<文件名>.dtp"}（收到 ${JSON.stringify(obj) ?? String(obj)}）`)
  }
  if (obj.version !== CONFIG_VERSION) {
    throw new DtpError('CONFIG_INVALID', `.dtp/config.json version 应为 ${CONFIG_VERSION}（收到 ${JSON.stringify(obj.version)}）；更高版本请升级 dtp 后重试`)
  }
  if (typeof obj.default !== 'string' || !SAFE_DEFAULT_RE.test(obj.default)) {
    throw new DtpError(
      'CONFIG_INVALID',
      `.dtp/config.json 的 default 须为 .dtp/ 内的安全文件名（如 "my.dtp"，不含路径分隔符），收到 ${JSON.stringify(obj.default)}`
    )
  }
  return { version: obj.version, default: obj.default }
}

// 原子写：tmp + rename，失败不留半文件
export function writeConfig(cwd, config) {
  if (config.version !== CONFIG_VERSION || !SAFE_DEFAULT_RE.test(config.default ?? '')) {
    throw new DtpError('USAGE', `非法 config 形状：${JSON.stringify(config)}（version=${CONFIG_VERSION}，default 须为安全文件名）`)
  }
  const dir = configDirOf(cwd)
  fs.mkdirSync(dir, { recursive: true })
  const file = configPathOf(cwd)
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

// init 建包后设置默认：仅在 config 不存在或尚无 default 时写入（首建设默认，二建不改）。
// config 损坏到不了这里：makeContext 对缺省命令已先抛 CONFIG_INVALID（显式 --packet 完全绕开 config）
export function ensureDefault(cwd, filename) {
  if (!SAFE_DEFAULT_RE.test(filename)) {
    throw new DtpError('USAGE', `非法数据包文件名 "${filename}"（安全字符集：字母数字/中文/._- 与空格，无路径分隔符）`)
  }
  const existing = readConfig(cwd)
  if (existing?.default) return { written: false, default: existing.default }
  writeConfig(cwd, { version: CONFIG_VERSION, default: filename })
  return { written: true, default: filename }
}

// 缺省解析（不含显式 --packet，那由调用方先行短路）：
// .dtp/config.json default > ./packet.dtp（legacy）> 无。
// 静态错误（CONFIG_INVALID / default 形状）即时抛；default 指向的文件是否存在属
// 运行期事实，交由 ctx.load() 按需 fail loud（不阻断 init 等不需既有包的命令）。
export function resolveDefaultPacket(cwd = process.cwd()) {
  let config = null
  try {
    config = readConfig(cwd)
  } catch (e) {
    if (e.code !== 'CONFIG_INVALID') throw e
    return { source: 'config-error', path: path.join(CONFIG_DIR, 'config.json'), error: e }
  }
  if (config) {
    return { source: 'config', path: path.join(CONFIG_DIR, config.default), config }
  }
  const legacy = path.join('.', 'packet.dtp')
  return { source: fs.existsSync(path.resolve(cwd, legacy)) ? 'legacy' : 'none', path: legacy, config: null }
}

// web 工作区解析（dtp web 与 server.js 直跑共用）：--dir > DTP_WORKSPACE > .dtp/config.json 存在→.dtp/ > 报错指引 init
// （四态链与 TASK-009 的包解析链同源：config 只判存在性即定向 .dtp/，不读 default 内容）
export function resolveWebWorkspace(cwd = process.cwd(), explicitDir) {
  // 显式 --dir 与「未提供」严格区分（OPTIM-021）：空串不得静默回落解析链
  if (explicitDir !== undefined) {
    const dir = String(explicitDir).trim()
    if (!dir) throw new DtpError('USAGE', '--dir 需要是非空目录路径（省略则按 DTP_WORKSPACE > .dtp/ 解析）')
    const abs = path.resolve(cwd, dir)
    // 已存在但不是目录：启动即拒，否则 server 报 ok:true、随后每个 API 都在 mkdir 上抛原始 EEXIST（ISSUE-027）
    if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
      throw new DtpError('USAGE', `--dir 需要是目录：${abs}（当前是文件）`)
    }
    return { path: abs, source: 'dir' }
  }
  const env = process.env.DTP_WORKSPACE?.trim()
  if (env) return { path: path.resolve(env), source: 'env' }
  // config 存在（合法）→ 工作区即 .dtp/；损坏则 fail loud（与包解析链一致）
  const cfg = readConfig(cwd) // null = 不存在；损坏抛 CONFIG_INVALID 向上传播
  if (cfg) return { path: configDirOf(cwd), source: 'config' }
  throw new DtpError(
    'NO_PACKET',
    `未找到 web 工作区：无 --dir、未设 DTP_WORKSPACE，且 ${CONFIG_DIR}/config.json 不存在（先 dtp init <名> 建包，或 dtp web --dir <目录> 指定）`
  )
}

// ctx.load 的 NO_PACKET 文案：按解析来源给针对性行动指引（fail loud 不静默回退）
export function packetMissingError(result, resolvedPath) {
  if (result.source === 'config') {
    return new DtpError(
      'NO_PACKET',
      `配置默认数据包不存在：${resolvedPath}（.dtp/config.json 指向的文件已移动或删除；编辑 .dtp/config.json、重新 dtp init，或用 --packet 显式指定）`
    )
  }
  if (result.source === 'none') {
    return new DtpError(
      'NO_PACKET',
      `未指定数据包，且未找到 .dtp/config.json 默认或 ./packet.dtp（先 dtp init <名> 建包到 .dtp/，或用 --packet <路径> 指定）`
    )
  }
  return new DtpError('NO_PACKET', `数据包不存在：${resolvedPath}（先用 dtp init 创建）`)
}
