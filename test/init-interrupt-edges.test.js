// OPTIM-023 回归：init 中断安全（静态构造中间态，不追真实 SIGKILL 时序）
//
// 设计取舍（与 OPTIM-023 登记一致）：
// - 本文件**不复现**真实 SIGKILL / 时序注入 —— 在套件内不确定、易 flaky。改为直接构造
//   「中断后可能留下的中间态」文件，断言其被安全消化（与 storage.test.js 的残行用例同风格）。
// - **现状语义钉桩**：writeJsonlFresh 是 `fs.writeFileSync` 整文件覆盖，**非原子**（无 tmp+rename）。
//   用例以「inode 不变 + 无 .tmp 残留 + 覆盖不追加」固化该语义：若实现侧后续改为原子落盘
//   （tmp+rename），inode 断言会失败 → 必须同步更新本用例与 dtp-regression SKILL 的参数边界说明。
//   当前 init 首写的崩溃安全依赖「备份轮换 + 存储层末行残缺告警跳过」，而非原子 rename。
//
// 已覆盖面（不重复，避免与既有用例重叠）：
// - storage.test.js：acquireLock 互斥 / 死 PID 陈旧锁抢占 / withLock 异常释放 / 备份轮换保留 3 份
// - cli.test.js：持锁时变更命令报 LOCKED；init-template.test.js：--force 备份**存在性**
// 本文件补的是 **init 级端到端**：CLI init 遇陈旧·损坏锁、半写包 --force 的备份**内容**保真、
// 以及 writeJsonlFresh 的覆盖语义。存活 PID 的 LOCKED 由上述既有用例覆盖，此处不再重复慢路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir, runJson } from './helpers.js'
import { writeJsonlFresh } from '../src/storage.js'
import { initPacketLines, Packet } from '../src/packet.js'

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

// ---------- ① 陈旧锁 / 损坏锁：init 应安全抢占 ----------

test('OPTIM-023①：CLI init 遇陈旧锁（死 PID）不阻断建包，且抢占后不残留锁文件', () => {
  const dir = tmpdir('ii-stale-')
  fs.mkdirSync(path.join(dir, '.dtp'), { recursive: true })
  const lock = path.join(dir, '.dtp', '包.dtp.lock')
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999999, time: 't' })) // 不存在的 PID = 崩溃残留

  const r = runJson(['init', '包'], { cwd: dir })
  assert.equal(r.status, 0, r.err ?? '')
  assert.equal(r.data.ok, true)
  assert.equal(r.data.file, '.dtp/包.dtp')
  assert.ok(!fs.existsSync(lock), '抢占后应将锁释放（不残留死锁文件）')
  assert.equal(runJson(['verify'], { cwd: dir }).data.ok, true)
})

test('OPTIM-023①：CLI init 遇损坏锁内容（非 JSON）同样视为陈旧锁安全通过', () => {
  const dir = tmpdir('ii-corruptlock-')
  fs.mkdirSync(path.join(dir, '.dtp'), { recursive: true })
  const lock = path.join(dir, '.dtp', '坏包.dtp.lock')
  fs.writeFileSync(lock, 'not json{{{') // 写入中断留下的半截锁

  const r = runJson(['init', '坏包'], { cwd: dir })
  assert.equal(r.status, 0, r.err ?? '')
  assert.equal(r.data.ok, true)
  assert.ok(!fs.existsSync(lock), '损坏锁应被抢占并清理')
})

// ---------- ② 半写包 + init --force：备份保真、重建可用 ----------

test('OPTIM-023②：半写包（末行截断）可被加载（残行告警跳过），init --force 逐字节备份原文并重建', () => {
  const dir = tmpdir('ii-half-')
  assert.equal(runJson(['init', '半写包'], { cwd: dir }).data.ok, true)
  const file = path.join(dir, '.dtp', '半写包.dtp')

  // 模拟写入中断：把最后一非空行截断一半（留下残行）
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const i = lines.length - 2
  lines[i] = lines[i].slice(0, Math.floor(lines[i].length / 2))
  fs.writeFileSync(file, lines.join('\n'))
  const halfHash = sha(fs.readFileSync(file))

  // 中间态本身可被加载：残行告警跳过，根节点存活（中断残留不致命）
  const halfPacket = Packet.load(file)
  assert.equal(halfPacket.root().title, '半写包')
  assert.ok(
    halfPacket.warnings.some((w) => /第 \d+ 行损坏/.test(w)),
    `半写包加载应产出残行告警，实际：${JSON.stringify(halfPacket.warnings)}`
  )

  // --force 重建：旧的截断内容轮换进 .bak.1（保留中断现场）
  const r = runJson(['init', '半写包', '--force'], { cwd: dir })
  assert.equal(r.status, 0, r.err ?? '')
  assert.equal(r.data.ok, true)

  const bak = file + '.bak.1'
  assert.ok(fs.existsSync(bak), '.bak.1 应存在（备份轮换）')
  assert.equal(sha(fs.readFileSync(bak)), halfHash, '.bak.1 必须逐字节等于截断原文，不得丢中断现场')

  // 重建后可正常读写，且不再有残行告警
  assert.equal(runJson(['verify'], { cwd: dir }).data.ok, true)
  assert.equal(runJson(['ls'], { cwd: dir }).data.ok, true)
  assert.equal(Packet.load(file).warnings.length, 0, '重建后应无残行告警')
})

// ---------- ③ writeJsonlFresh 语义：整文件覆盖（非原子），无 tmp 残留 ----------

test('OPTIM-023③：writeJsonlFresh 为整文件原地覆盖（inode 不变 = 非原子 rename），无 .tmp 残留、覆盖不追加', () => {
  const dir = tmpdir('ii-fresh-')
  const file = path.join(dir, 'w.dtp')
  const objs1 = initPacketLines({ name: '一', packetId: 'pkt-1', rootId: 'n_root' }).lines
  writeJsonlFresh(file, objs1)

  // 契约：每行 JSON + 末尾换行
  assert.equal(fs.readFileSync(file, 'utf8'), objs1.map((o) => JSON.stringify(o)).join('\n') + '\n')
  const ino1 = fs.statSync(file).ino

  // 二次写入：整文件覆盖（非追加）
  const objs2 = initPacketLines({ name: '二', packetId: 'pkt-2', rootId: 'n_root' }).lines
  writeJsonlFresh(file, objs2)
  assert.equal(fs.statSync(file).ino, ino1, '现状：原地覆盖（非 tmp+rename 原子落盘），inode 不变')
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, objs2.length, '覆盖而非追加')

  // 覆盖为更短内容同样生效（truncate 语义），且不留半文件
  writeJsonlFresh(file, [objs2[0]])
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1)
  assert.ok(
    !fs.readdirSync(dir).some((n) => n.includes('.tmp')),
    `不得残留 .tmp 半文件，实际目录：${JSON.stringify(fs.readdirSync(dir))}`
  )
})
