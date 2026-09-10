import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { tmpdir } from './helpers.js'
import {
  parsePacketText,
  appendJsonl,
  writeJsonlFresh,
  backupPacketFile,
  listBackups,
  acquireLock,
  releaseLock,
  withLock,
} from '../src/storage.js'
import { DtpError } from '../src/errors.js'

let dir
beforeEach(() => {
  dir = tmpdir()
})

const META = { type: 'packet_meta', packet_id: 'pkt-1', name: 'n', version: 'v1.0.0', created_at: 't', updated_at: 't', root_node_id: 'r', metadata: {} }
const NODE = (id, parent_id = null) => ({ type: 'node', id, parent_id, node_type: 'folder', title: id, description: '', content: '', extensions: {}, created_at: 't', updated_at: 't', version: 1, hash: 'h' + id, tags: [], status: 'draft' })

test('roundtrip：写入再解析还原全部记录', () => {
  const file = path.join(dir, 'p.dtp')
  writeJsonlFresh(file, [META, NODE('r'), NODE('a', 'r')])
  const rec = parsePacketText(fs.readFileSync(file, 'utf8'))
  assert.equal(rec.meta.packet_id, 'pkt-1')
  assert.equal(rec.nodes.size, 2)
  assert.equal(rec.nodes.get('a').parent_id, 'r')
})

test('同 id 后行覆盖前行（append-only 版本链）', () => {
  const rec = parsePacketText(
    [META, NODE('r'), NODE('a', 'r'), { ...NODE('a', 'r'), version: 2, title: 'a2' }]
      .map((o) => JSON.stringify(o))
      .join('\n')
  )
  assert.equal(rec.nodes.get('a').version, 2)
  assert.equal(rec.versions.get('a').length, 2)
})

test('node_delete 逻辑删除并留 tombstone', () => {
  const rec = parsePacketText(
    [META, NODE('r'), NODE('a', 'r'), { type: 'node_delete', id: 'a', timestamp: 't2' }]
      .map((o) => JSON.stringify(o))
      .join('\n')
  )
  assert.equal(rec.nodes.size, 1)
  assert.ok(rec.tombstones.has('a'))
  assert.equal(rec.versions.get('a').length, 1) // 历史版本保留
})

test('末行损坏告警跳过，中部损坏抛错', () => {
  const good = [META, NODE('r')].map((o) => JSON.stringify(o)).join('\n')
  const rec = parsePacketText(good + '\n{"type":"node","id":"broken"') // 截断的最后一行
  assert.equal(rec.nodes.size, 1)
  assert.equal(rec.warnings.length, 1)

  assert.throws(
    () => parsePacketText(good + '\n{"broken"\n' + JSON.stringify(NODE('x', 'r'))),
    DtpError
  )
})

test('gzip 透明读取（.gz 后缀）', () => {
  const file = path.join(dir, 'p.dtp.gz')
  const text = [META, NODE('r')].map((o) => JSON.stringify(o)).join('\n') + '\n'
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(text)))
  const rec = parsePacketText(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'))
  assert.equal(rec.nodes.size, 1)
})

test('备份轮换保留最近 3 份', () => {
  const file = path.join(dir, 'p.dtp')
  writeJsonlFresh(file, [META])
  backupPacketFile(file)
  fs.appendFileSync(file, 'x\n')
  backupPacketFile(file)
  fs.appendFileSync(file, 'y\n')
  backupPacketFile(file)
  fs.appendFileSync(file, 'z\n')
  backupPacketFile(file)
  const backups = listBackups(file)
  assert.equal(backups.length, 3)
  // bak.1 应为最后一次写入前（含 x y z）的内容
  assert.ok(fs.readFileSync(backups[0].file, 'utf8').includes('z'))
  // 第 4 份（最老）被轮换掉
  assert.ok(!fs.existsSync(file + '.bak.4'))
})

test('文件锁：互斥与陈旧锁抢占', () => {
  const file = path.join(dir, 'p.dtp')
  writeJsonlFresh(file, [META])
  const lock = acquireLock(file)
  assert.ok(fs.existsSync(lock))
  assert.throws(() => acquireLock(file), (e) => e.code === 'LOCKED')
  releaseLock(lock)
  assert.ok(!fs.existsSync(lock))

  // 伪造陈旧锁（PID 不存在）
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: 999999999, time: 't' }))
  const lock2 = acquireLock(file)
  releaseLock(lock2)

  // withLock 异常时也释放
  assert.throws(() => withLock(file, () => { throw new Error('boom') }), /boom/)
  assert.ok(!fs.existsSync(file + '.lock'))
})

test('appendJsonl 追加而非覆盖', () => {
  const file = path.join(dir, 'p.dtp')
  writeJsonlFresh(file, [META])
  appendJsonl(file, [NODE('r')])
  appendJsonl(file, [NODE('a', 'r')])
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 3)
})
