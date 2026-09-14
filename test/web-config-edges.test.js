// v1.7.0 分发面边界回归：web 参数严格校验 / 工作区类型 / config 与 init 的 fs 错误包装
// 覆盖 ISSUE-026（--port 过宽）、ISSUE-027（--dir 指向文件）、ISSUE-028（--host 空→全网卡）、
// ISSUE-029（config fs 错误 → INTERNAL 裸栈）、ISSUE-030（init fs 错误 → INTERNAL 裸错）、
// OPTIM-021（--dir 显式空串静默回落）。纯参数校验用例在服务监听前即拒绝，不会挂起。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir, runDtp } from './helpers.js'
import { readConfig, resolveWebWorkspace } from '../src/config.js'

const raw = (args, opts) => runDtp([...args, '--json'], opts)
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

// ---------- ISSUE-026：--port 严格十进制整数 ----------

test('ISSUE-026：--port 仅接受纯十进制 1..65535，进制/科学计数/空白一律 USAGE exit 2', () => {
  const ws = tmpdir('web-port-')
  const bad = ['0x10', '1e2', ' 4761 ', '4761 ', '+4761', '1.5', '0b101', 'abc', '0', '65536', '-1', '']
  for (const v of bad) {
    const r = raw(['web', '--port', v, '--dir', ws])
    const out = JSON.parse(r.stdout)
    assert.equal(r.status, 2, `--port "${v}" 应 exit 2，实际 ${r.status}：${r.stdout}`)
    assert.equal(out.error.code, 'USAGE', `--port "${v}" 应 USAGE`)
    assert.match(out.error.message, /--port/)
  }
})

// ---------- ISSUE-028：--host 空值拒绝（不得静默绑全网卡） ----------

test('ISSUE-028：--host 空串/纯空白 → USAGE exit 2（默认 127.0.0.1 不得被静默放大）', () => {
  const ws = tmpdir('web-host-')
  for (const v of ['', '   ']) {
    const r = raw(['web', '--host', v, '--port', '4761', '--dir', ws])
    const out = JSON.parse(r.stdout)
    assert.equal(r.status, 2)
    assert.equal(out.error.code, 'USAGE')
    assert.match(out.error.message, /--host/)
  }
})

// ---------- ISSUE-027 / OPTIM-021：--dir 类型与非空校验 ----------

test('ISSUE-027：--dir 指向已存在的普通文件 → USAGE exit 2（不得起服务后 500）', () => {
  const dir = tmpdir('web-dirfile-')
  const file = path.join(dir, 'afile.txt')
  fs.writeFileSync(file, 'x')
  const r = raw(['web', '--dir', file, '--port', '4761'])
  const out = JSON.parse(r.stdout)
  assert.equal(r.status, 2)
  assert.equal(out.error.code, 'USAGE')
  assert.match(out.error.message, /--dir/)
})

test('OPTIM-021：--dir 显式空串/纯空白 → USAGE（不再静默回落解析链）', () => {
  for (const v of ['', '  ']) {
    const r = raw(['web', '--dir', v, '--port', '4761'])
    const out = JSON.parse(r.stdout)
    assert.equal(r.status, 2, `--dir "${v}" 应 exit 2`)
    assert.equal(out.error.code, 'USAGE')
    assert.match(out.error.message, /--dir/)
  }
})

test('resolveWebWorkspace：三态与类型校验（显式优先 / 空值拒绝 / 文件拒绝 / 不存在放行）', () => {
  const dir = tmpdir('web-ws-unit-')
  fs.mkdirSync(path.join(dir, 'real'))
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x')

  assert.deepEqual(resolveWebWorkspace(dir, './real'), { path: path.resolve(dir, 'real'), source: 'dir' })
  assert.throws(() => resolveWebWorkspace(dir, ''), (e) => e.code === 'USAGE')
  assert.throws(() => resolveWebWorkspace(dir, '  '), (e) => e.code === 'USAGE')
  assert.throws(() => resolveWebWorkspace(dir, './file.txt'), (e) => e.code === 'USAGE')
  // 不存在的目录保持「按需创建」语义（不因本次加固被误拒）
  assert.deepEqual(resolveWebWorkspace(dir, './no/such'), { path: path.resolve(dir, 'no/such'), source: 'dir' })
})

// ---------- ISSUE-029：config 读取的 fs 级失败 → CONFIG_INVALID ----------

test('ISSUE-029：.dtp 是文件 / config.json 是目录 → CONFIG_INVALID（不冒泡 INTERNAL）', () => {
  const d1 = tmpdir('cfg-file-')
  fs.writeFileSync(path.join(d1, '.dtp'), 'not a dir')
  assert.throws(() => readConfig(d1), (e) => e.code === 'CONFIG_INVALID' && /不是目录/.test(e.message))
  const r1 = JSON.parse(raw(['ls'], { cwd: d1 }).stdout)
  assert.equal(r1.error.code, 'CONFIG_INVALID')

  const d2 = tmpdir('cfg-dir-')
  fs.mkdirSync(path.join(d2, '.dtp', 'config.json'), { recursive: true })
  assert.throws(() => readConfig(d2), (e) => e.code === 'CONFIG_INVALID' && /是目录/.test(e.message))
  const r2 = JSON.parse(raw(['ls'], { cwd: d2 }).stdout)
  assert.equal(r2.error.code, 'CONFIG_INVALID')
})

test('ISSUE-029：config.json 无读权限 → CONFIG_INVALID（root 下 chmod 不生效，跳过）', { skip: isRoot }, () => {
  const dir = tmpdir('cfg-perm-')
  fs.mkdirSync(path.join(dir, '.dtp'), { recursive: true })
  const cfg = path.join(dir, '.dtp', 'config.json')
  fs.writeFileSync(cfg, JSON.stringify({ version: 1, default: 'x.dtp' }))
  fs.chmodSync(cfg, 0o000)
  try {
    assert.throws(() => readConfig(dir), (e) => e.code === 'CONFIG_INVALID' && /权限/.test(e.message))
    const r = JSON.parse(raw(['ls'], { cwd: dir }).stdout)
    assert.equal(r.error.code, 'CONFIG_INVALID')
  } finally {
    fs.chmodSync(cfg, 0o644)
  }
})

test('ISSUE-029 回归：config 缺失仍为 null（ENOENT 语义未被加固破坏）', () => {
  const dir = tmpdir('cfg-absent-')
  assert.equal(readConfig(dir), null)
  // 缺省链无 config 无 legacy → NO_PACKET（非 CONFIG_INVALID）
  const r = JSON.parse(raw(['ls'], { cwd: dir }).stdout)
  assert.equal(r.error.code, 'NO_PACKET')
})

// ---------- ISSUE-030：init fs 级失败 → 可行动错误 ----------

test('ISSUE-030：超长包名 → USAGE exit 2 且不落任何 .dtp/ 目录；边界 200/201 字节', () => {
  const dir = tmpdir('init-long-')
  const r = raw(['init', 'a'.repeat(300)], { cwd: dir })
  const out = JSON.parse(r.stdout)
  assert.equal(r.status, 2)
  assert.equal(out.error.code, 'USAGE')
  assert.match(out.error.message, /过长|--packet/)
  assert.ok(!fs.existsSync(path.join(dir, '.dtp')), '拒绝时不得创建 .dtp/')

  // 边界：200 字节放行，201 拒绝（`.dtp`+`.lock` 后缀后仍低于 NAME_MAX）
  assert.equal(JSON.parse(raw(['init', 'b'.repeat(200)], { cwd: dir }).stdout).ok, true)
  assert.equal(JSON.parse(raw(['init', 'c'.repeat(201)], { cwd: dir }).stdout).error.code, 'USAGE')
})

test('ISSUE-030：.dtp/templates 是文件 → USAGE exit 2（含指引），不冒泡 INTERNAL', () => {
  const dir = tmpdir('init-tplfile-')
  fs.mkdirSync(path.join(dir, '.dtp'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.dtp', 'templates'), 'x')
  const r = raw(['init', '包', '--template', 'user-stories'], { cwd: dir })
  const out = JSON.parse(r.stdout)
  assert.equal(r.status, 2)
  assert.equal(out.error.code, 'USAGE')
  assert.match(out.error.message, /释放内置模版|--template/)
})

test('ISSUE-030：.dtp/templates 只读 → USAGE（root 下 chmod 不生效，跳过）', { skip: isRoot }, () => {
  const dir = tmpdir('init-tplro-')
  const tpl = path.join(dir, '.dtp', 'templates')
  fs.mkdirSync(tpl, { recursive: true })
  fs.chmodSync(tpl, 0o555)
  try {
    const r = raw(['init', '包', '--template', 'user-stories'], { cwd: dir })
    const out = JSON.parse(r.stdout)
    assert.equal(r.status, 2)
    assert.equal(out.error.code, 'USAGE')
    assert.match(out.error.message, /释放内置模版/)
  } finally {
    fs.chmodSync(tpl, 0o755)
  }
})

test('ISSUE-030 回归：正常 init（空壳与内置模版）不受加固影响', () => {
  const dir = tmpdir('init-ok-')
  const plain = JSON.parse(raw(['init', '普通包'], { cwd: dir }).stdout)
  assert.equal(plain.ok, true)
  assert.equal(plain.file, '.dtp/普通包.dtp')

  const dir2 = tmpdir('init-ok2-')
  const tpl = JSON.parse(raw(['init', '故事包', '--template', 'user-stories'], { cwd: dir2 }).stdout)
  assert.equal(tpl.ok, true)
  assert.equal(tpl.template.released, true)
  assert.ok(fs.existsSync(path.join(dir2, '.dtp', 'templates', 'user-stories.schema.json')))
})
