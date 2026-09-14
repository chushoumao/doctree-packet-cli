// TASK-009 回归：.dtp/config.json 契约与 --packet 解析链（六态矩阵 + 原子写 + init 行为）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir, runDtp } from './helpers.js'
import { readConfig, writeConfig, ensureDefault, resolveDefaultPacket } from '../src/config.js'
import { DtpError } from '../src/errors.js'

const j = (args, opts) => JSON.parse(runDtp([...args, '--json'], opts).stdout || 'null')
const raw = (args, opts) => runDtp([...args, '--json'], opts)

// ---------- 单元层：形状校验与原子写 ----------

test('readConfig：合法/缺失/损坏/形状非法/version 不符/default 穿越', () => {
  const dir = tmpdir('cfg-unit-')
  fs.mkdirSync(path.join(dir, '.dtp'))
  const cfg = path.join(dir, '.dtp', 'config.json')

  assert.equal(readConfig(dir), null, '不存在 → null')

  fs.writeFileSync(cfg, JSON.stringify({ version: 1, default: 'a.dtp' }))
  assert.deepEqual(readConfig(dir), { version: 1, default: 'a.dtp' })

  fs.writeFileSync(cfg, '{oops')
  assert.throws(() => readConfig(dir), (e) => e instanceof DtpError && e.code === 'CONFIG_INVALID' && /不是合法 JSON/.test(e.message))

  fs.writeFileSync(cfg, JSON.stringify({ version: 1, default: '../evil.dtp' }))
  assert.throws(() => readConfig(dir), (e) => e.code === 'CONFIG_INVALID' && /安全文件名/.test(e.message))

  fs.writeFileSync(cfg, JSON.stringify({ version: 1, default: 'sub/x.dtp' }))
  assert.throws(() => readConfig(dir), (e) => e.code === 'CONFIG_INVALID')

  fs.writeFileSync(cfg, JSON.stringify({ version: 2, default: 'a.dtp' }))
  assert.throws(() => readConfig(dir), (e) => e.code === 'CONFIG_INVALID' && /version/.test(e.message))
})

test('writeConfig：原子写（无 .tmp 残留）且覆盖生效；非法形状拒绝', () => {
  const dir = tmpdir('cfg-write-')
  writeConfig(dir, { version: 1, default: 'one.dtp' })
  writeConfig(dir, { version: 1, default: 'two.dtp' })
  assert.deepEqual(readConfig(dir), { version: 1, default: 'two.dtp' })
  assert.deepEqual(fs.readdirSync(path.join(dir, '.dtp')), ['config.json'], '不留 tmp 半文件')

  assert.throws(() => writeConfig(dir, { version: 1, default: '../x.dtp' }), (e) => e.code === 'USAGE')
})

test('ensureDefault：首建设默认、已有不动', () => {
  const dir = tmpdir('cfg-ensure-')
  const r1 = ensureDefault(dir, 'first.dtp')
  assert.deepEqual(r1, { written: true, default: 'first.dtp' })
  const r2 = ensureDefault(dir, 'second.dtp')
  assert.deepEqual(r2, { written: false, default: 'first.dtp' }, '二建不改默认')

  assert.throws(() => ensureDefault(dir, '../bad.dtp'), (e) => e.code === 'USAGE')
})

// ---------- 解析链六态矩阵（CLI 级） ----------

test('解析链①：显式 --packet 行为与现状一致，零副作用（不建 .dtp/ 不写 config）', () => {
  const dir = tmpdir('cfg-explicit-')
  j(['init', '显式包', '--packet', 'x.dtp'], { cwd: dir })
  const r = j(['ls', '--packet', 'x.dtp'], { cwd: dir })
  assert.equal(r.ok, true)
  assert.ok(!fs.existsSync(path.join(dir, '.dtp')), '不得创建 .dtp/')
})

test('解析链②：config default 生效（init 缺省落 .dtp/ 后省略 --packet 可用）', () => {
  const dir = tmpdir('cfg-default-')
  const init = j(['init', '项目包'], { cwd: dir })
  assert.equal(init.file, '.dtp/项目包.dtp')
  assert.equal(init.config.default, '项目包.dtp')
  assert.equal(init.config.written, true)
  assert.ok(init.config.file.endsWith(path.join('.dtp', 'config.json')), 'config 路径（realpath 前缀因平台而异，断言后缀）')

  const ls = j(['ls'], { cwd: dir })
  assert.equal(ls.ok, true)
  const add = j(['add', '/', '--title', '页面', '--type', 'document'], { cwd: dir })
  assert.equal(add.ok, true, '写路径同样按 default 解析')
})

test('解析链③：default 指向的文件丢失 → NO_PACKET fail loud 带指引', () => {
  const dir = tmpdir('cfg-missing-')
  j(['init', '会丢的包'], { cwd: dir })
  fs.rmSync(path.join(dir, '.dtp', '会丢的包.dtp'))
  const r = raw(['ls'], { cwd: dir })
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'NO_PACKET')
  assert.match(out.error.message, /config\.json/)
  assert.match(out.error.message, /--packet|init/)
  assert.equal(r.status, 1)
})

test('解析链④：config JSON 损坏 → CONFIG_INVALID exit 1', () => {
  const dir = tmpdir('cfg-corrupt-')
  j(['init', '坏配置'], { cwd: dir })
  fs.writeFileSync(path.join(dir, '.dtp', 'config.json'), '{oops')
  const r = raw(['ls'], { cwd: dir })
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'CONFIG_INVALID')
  assert.match(out.error.message, /不是合法 JSON/)
  assert.equal(r.status, 1)
})

test('解析链⑤：无 config 且无 legacy → NO_PACKET 指引 init/--packet', () => {
  const dir = tmpdir('cfg-none-')
  const r = raw(['ls'], { cwd: dir })
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'NO_PACKET')
  assert.match(out.error.message, /dtp init/)
  assert.match(out.error.message, /--packet/)
})

test('解析链⑥：仅 ./packet.dtp（legacy 第三级）继续可用', () => {
  const dir = tmpdir('cfg-legacy-')
  j(['init', '老包', '--packet', 'packet.dtp'], { cwd: dir })
  const ls = j(['ls'], { cwd: dir })
  assert.equal(ls.ok, true, '无 config 时回退 legacy')
})

// ---------- init 缺省落点行为 ----------

test('init：首建设 default、二建不改；显式 --packet 零 config 字段', () => {
  const dir = tmpdir('cfg-init-')
  const i1 = j(['init', '包一'], { cwd: dir })
  assert.equal(i1.config.written, true)
  const i2 = j(['init', '包二'], { cwd: dir })
  assert.equal(i2.file, '.dtp/包二.dtp')
  assert.equal(i2.config.written, false)
  assert.equal(i2.config.default, '包一.dtp', '默认仍是首建')

  // 两个包都在 .dtp/ 下，显式引用第二包不受影响
  const ls2 = j(['ls', '--packet', '.dtp/包二.dtp'], { cwd: dir })
  assert.equal(ls2.ok, true)

  // 显式 --packet init：不建 .dtp/（相对本测试已存在，验证不写 config 字段）
  const dir2 = tmpdir('cfg-init2-')
  const i3 = j(['init', '自管包', '--packet', 'free.dtp'], { cwd: dir2 })
  assert.equal(i3.config, undefined)
  assert.ok(!fs.existsSync(path.join(dir2, '.dtp')))
})

test('init：缺省名不适合作文件名 → USAGE 指引 --packet', () => {
  const dir = tmpdir('cfg-badname-')
  const r = raw(['init', 'a/b'], { cwd: dir })
  assert.equal(JSON.parse(r.stdout).error.code, 'USAGE')
  assert.equal(r.status, 2)
  assert.match(JSON.parse(r.stdout).error.message, /--packet/)
  assert.ok(!fs.existsSync(path.join(dir, '.dtp')), '拒绝时不得创建任何目录')
  const r2 = raw(['init', '  '], { cwd: dir })
  assert.equal(JSON.parse(r2.stdout).error.code, 'USAGE')
})

test('init：缺省落点遇损坏 config → CONFIG_INVALID fail loud；显式 --packet 是自救通道', () => {
  const dir = tmpdir('cfg-corrupt-init-')
  fs.mkdirSync(path.join(dir, '.dtp'))
  fs.writeFileSync(path.join(dir, '.dtp', 'config.json'), '{oops')
  const r = raw(['init', '新包'], { cwd: dir })
  assert.equal(JSON.parse(r.stdout).error.code, 'CONFIG_INVALID')
  assert.equal(r.status, 1)
  assert.equal(fs.readFileSync(path.join(dir, '.dtp', 'config.json'), 'utf8'), '{oops', '不覆盖用户文件')
  // 显式 --packet 完全绕开 config（零副作用约定），损坏状态下仍可建包
  const r2 = j(['init', '自救包', '--packet', 'rescue.dtp'], { cwd: dir })
  assert.equal(r2.ok, true)
})

test('resolveDefaultPacket：来源标记（config/legacy/none/config-error）', () => {
  const empty = tmpdir('cfg-res-')
  assert.equal(resolveDefaultPacket(empty).source, 'none')

  const legacyDir = tmpdir('cfg-res2-')
  j(['init', 'l', '--packet', 'packet.dtp'], { cwd: legacyDir })
  assert.equal(resolveDefaultPacket(legacyDir).source, 'legacy')

  const cfgDir = tmpdir('cfg-res3-')
  writeConfig(cfgDir, { version: 1, default: 'x.dtp' })
  assert.equal(resolveDefaultPacket(cfgDir).source, 'config')
  assert.equal(resolveDefaultPacket(cfgDir).path, path.join('.dtp', 'x.dtp'))

  fs.writeFileSync(path.join(cfgDir, '.dtp', 'config.json'), '{oops')
  const err = resolveDefaultPacket(cfgDir)
  assert.equal(err.source, 'config-error')
  assert.ok(err.error instanceof DtpError)
})
