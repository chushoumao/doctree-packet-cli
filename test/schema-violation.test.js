// TASK-018 回归：SCHEMA_VIOLATION 错误契约（DtpError.details + Output 序列化 + 人类输出函数）
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { DtpError, asDtpError } from '../src/errors.js'
import { Output, printViolations } from '../src/output.js'

const VIOLATIONS = [
  { node_id: 'us002', rule: 'title.pattern', severity: 'error', message: '标题不符', hint: '标题 = 编号 + 空格 + 摘要' },
  { rule: 'ext.required', severity: 'error', message: '缺 priority', hint: '用 dtp update 补齐' },
]

// ---------- DtpError details（additive） ----------

test('DtpError：details 附加字段可携带，缺省为 undefined（既有错误零影响）', () => {
  const plain = new DtpError('NO_PACKET', '包不存在')
  assert.equal(plain.code, 'NO_PACKET')
  assert.equal(plain.message, '包不存在')
  assert.equal(plain.details, undefined)

  const rich = new DtpError('SCHEMA_VIOLATION', '2 项违规', { violations: VIOLATIONS })
  assert.equal(rich.code, 'SCHEMA_VIOLATION')
  assert.deepEqual(rich.details.violations, VIOLATIONS)

  // asDtpError 透传已有实例（含 details）
  assert.deepEqual(asDtpError(rich).details.violations, VIOLATIONS)
  // 包装外部错误：无 details
  assert.equal(asDtpError(new Error('boom')).details, undefined)
})

// ---------- Output.error 序列化（--json 单行契约） ----------

test('Output.error：details.violations 序列化为 error.violations；缺省不出现', () => {
  let captured = ''
  const orig = console.log
  console.log = (s) => (captured = s)
  try {
    const rich = new DtpError('SCHEMA_VIOLATION', '2 项违规', { violations: VIOLATIONS })
    new Output({ json: true }).error(rich)
    const out = JSON.parse(captured)
    assert.equal(out.ok, false)
    assert.equal(out.error.code, 'SCHEMA_VIOLATION')
    assert.deepEqual(out.error.violations, VIOLATIONS, 'violations 复用 lint 形状')
    assert.equal(captured.split('\n').length, 1, '单行契约')

    const plain = new DtpError('NO_PACKET', '包不存在')
    captured = ''
    new Output({ json: true }).error(plain)
    const out2 = JSON.parse(captured)
    assert.equal('violations' in out2.error, false, 'details 缺省不出现')
    assert.equal(out2.error.code, 'NO_PACKET')
  } finally {
    console.log = orig
  }
})

// ---------- 人类输出：逐条违规含 hint（stderr，--json 模式不重复） ----------

let errLines = []
beforeEach(() => {
  errLines = []
})
afterEach(() => {
  console.error = () => {}
})

test('printViolations：逐条输出 rule/message/hint 到 stderr（人类模式）', () => {
  const orig = console.error
  console.error = (s) => errLines.push(String(s))
  try {
    printViolations(VIOLATIONS)
  } finally {
    console.error = orig
  }
  const all = errLines.join('\n')
  assert.match(all, /title\.pattern/)
  assert.match(all, /标题不符/)
  assert.match(all, /标题 = 编号 \+ 空格 \+ 摘要/, 'hint 在场')
  assert.match(all, /ext\.required/)
})

test('Output.error 人类模式触发 violations 打印；--json 模式不重复打印', () => {
  const origErr = console.error
  const origLog = console.log
  let errLines2 = []
  let jsonLine = ''
  console.error = (s) => errLines2.push(String(s))
  console.log = (s) => (jsonLine = String(s))
  try {
    const rich = new DtpError('SCHEMA_VIOLATION', '2 项违规', { violations: VIOLATIONS })
    new Output({ json: true }).error(rich)
    assert.equal(errLines2.filter((l) => l.includes('title.pattern')).length, 0, '--json 模式不打印人类明细')

    new Output({ json: false }).error(rich)
    assert.ok(errLines2.some((l) => l.includes('title.pattern')), '人类模式逐条打印')
  } finally {
    console.error = origErr
    console.log = origLog
  }
})
