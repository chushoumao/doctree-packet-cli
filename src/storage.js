import fs from 'node:fs'
import zlib from 'node:zlib'
import { DtpError } from './errors.js'

// ---------- 读取 ----------

function readPacketText(filePath) {
  let buf
  try {
    buf = fs.readFileSync(filePath)
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new DtpError('NO_PACKET', `数据包不存在：${filePath}（先用 dtp init 创建）`)
    }
    if (e.code === 'EISDIR') {
      throw new DtpError('NO_PACKET', `数据包路径是一个目录：${filePath}`)
    }
    throw e
  }
  // 透明支持 gzip（.gz 后缀或魔数）
  if (filePath.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    buf = zlib.gunzipSync(buf)
  }
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // 去 BOM
  return text
}

// 解析 JSONL 文本。规则：
// - 每行一个对象，按 type 分发：packet_meta（最后一个生效）/ node（同 id 后行覆盖前行）/ node_delete / changelog
// - 非末行的损坏数据视为致命错误；末行损坏（写入中途崩溃的残行）告警跳过
export function parsePacketText(text, { source = 'packet' } = {}) {
  const lines = text.split('\n')
  const nonEmpty = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') nonEmpty.push(i)
  }
  const rec = {
    meta: null,
    nodes: new Map(),
    versions: new Map(), // id -> [各版本快照]（含已删除节点，供 history/checkout）
    changelog: [],
    tombstones: new Set(),
    warnings: [],
  }
  const lastIdx = nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : -1
  for (const i of nonEmpty) {
    const no = i + 1
    let obj
    try {
      obj = JSON.parse(lines[i])
    } catch {
      if (i === lastIdx) {
        rec.warnings.push(`${source} 第 ${no} 行损坏（可能是写入中断的残行），已跳过`)
        continue
      }
      throw new DtpError('CORRUPT_LINE', `${source} 第 ${no} 行不是合法 JSON，数据包损坏`)
    }
    switch (obj?.type) {
      case 'packet_meta':
        rec.meta = obj
        break
      case 'node': {
        if (!obj.id) throw new DtpError('CORRUPT_LINE', `${source} 第 ${no} 行 node 缺少 id`)
        rec.nodes.set(obj.id, obj)
        const list = rec.versions.get(obj.id) ?? []
        list.push(obj)
        rec.versions.set(obj.id, list)
        break
      }
      case 'node_delete': {
        if (!obj.id) throw new DtpError('CORRUPT_LINE', `${source} 第 ${no} 行 node_delete 缺少 id`)
        rec.nodes.delete(obj.id)
        rec.tombstones.add(obj.id)
        break
      }
      case 'changelog':
        rec.changelog.push(obj)
        break
      default:
        rec.warnings.push(`${source} 第 ${no} 行未知类型 "${obj?.type}"，已跳过`)
    }
  }
  if (!rec.meta) throw new DtpError('NO_META', `${source} 缺少 packet_meta 行，不是有效的数据包`)
  return rec
}

export function parsePacket(filePath) {
  return parsePacketText(readPacketText(filePath), { source: filePath })
}

export function readRawPacket(filePath) {
  return readPacketText(filePath)
}

// ---------- 追加写入 ----------

// 单次 write 调用写入全部行：小数据量下近似原子，崩溃时最多损失末尾残行
export function appendJsonl(filePath, objs) {
  const text = objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
  const fd = fs.openSync(filePath, 'a')
  try {
    fs.writeFileSync(fd, text, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

export function writeJsonlFresh(filePath, objs) {
  const text = objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
  fs.writeFileSync(filePath, text, 'utf8')
}

// ---------- 备份（写入前轮换，保留最近 keep 份） ----------

export function backupPacketFile(filePath, keep = 3) {
  if (!fs.existsSync(filePath)) return null
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${filePath}.bak.${i}`
    const to = `${filePath}.bak.${i + 1}`
    if (fs.existsSync(from)) fs.renameSync(from, to)
  }
  const target = `${filePath}.bak.1`
  fs.copyFileSync(filePath, target)
  return target
}

export function listBackups(filePath, keep = 3) {
  const out = []
  for (let i = 1; i <= keep; i++) {
    const f = `${filePath}.bak.${i}`
    if (fs.existsSync(f)) {
      const st = fs.statSync(f)
      out.push({ index: i, file: f, mtime: st.mtime.toISOString(), size: st.size })
    }
  }
  return out
}

// ---------- 文件锁（单写多读：仅变更命令加锁） ----------

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // 有权限限制但进程存在
  }
}

export function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`
  const info = { pid: process.pid, time: new Date().toISOString() }
  try {
    fs.writeFileSync(lockPath, JSON.stringify(info) + '\n', { flag: 'wx' })
    return lockPath
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    let prev = null
    try {
      prev = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    } catch {
      /* 锁文件损坏视为陈旧锁 */
    }
    if (prev && isPidAlive(prev.pid)) {
      throw new DtpError('LOCKED', `数据包正被进程 ${prev.pid} 使用：${lockPath}`)
    }
    // 陈旧锁：抢占覆盖（CLI 场景可容忍极小竞态窗口）
    fs.writeFileSync(lockPath, JSON.stringify(info) + '\n')
    return lockPath
  }
}

export function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath)
  } catch {
    /* 已不存在则忽略 */
  }
}

// Windows 下并发创建锁文件可能撞上他人持有的句柄（共享冲突，libuv 表现为
// EPERM/EBUSY），属瞬时竞争而非权限问题，与 LOCKED 一并退避重试
function isTransientLockError(e) {
  return e.code === 'EPERM' || e.code === 'EBUSY'
}

export function withLock(filePath, fn, { retries = 9, baseMs = 20, capMs = 400 } = {}) {
  // 持锁者为存活进程时按指数退避 + 抖动重试，吸收并发写竞争（含惊群下
  // 个别等待者被反复抢先的饥饿情形）；陈旧锁在 acquireLock 内直接抢占，不走重试。
  let lockPath = null
  for (let attempt = 0; lockPath === null; attempt++) {
    try {
      lockPath = acquireLock(filePath)
    } catch (e) {
      if ((e.code !== 'LOCKED' && !isTransientLockError(e)) || attempt >= retries) throw e
      const delay = Math.min(capMs, baseMs * 2 ** attempt)
      const wait = delay + Math.floor(Math.random() * delay)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
    }
  }
  try {
    return fn()
  } finally {
    releaseLock(lockPath)
  }
}
