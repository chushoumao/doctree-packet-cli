// TASK-007 回归：两个真实工作流 schema（入库产物自检 + 违规检出力）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir, runDtp } from './helpers.js'
import { checkSchema, parseSchema } from '../src/template.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const j = (args, opts) => JSON.parse(runDtp([...args, '--json'], opts).stdout || 'null')

// ---------- acceptance ①：两个入库 schema 自检零错误 ----------

test('user-stories / dtp-regression schema：checkSchema 零错误，comment 顶层说明齐备', () => {
  for (const name of ['user-stories.schema.json', 'dtp-regression.schema.json']) {
    const file = path.join(ROOT, 'docs', 'templates', name)
    const schema = parseSchema(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(checkSchema(schema), [], `${name} 应零错误`)
    assert.ok(schema.comment.length > 20, `${name} 顶层 comment 应说明用途`)
    assert.ok(schema.skeleton.length >= 1)
  }
})

// ---------- acceptance ③：回归 schema 对构造违规包的检出力 ----------

test('dtp-regression schema：title 模式 / 挂载位置 / 必填 ext 违规逐条检出', () => {
  const dir = tmpdir('reg-schema-')
  const pkt = path.join(dir, 'reg.dtp')
  const schemaAbs = path.join(ROOT, 'docs', 'templates', 'dtp-regression.schema.json')

  // 用 init --template 派生骨架（同时验证真实 schema 可派生）
  j(['init', '回归验证包', '--packet', pkt, '--template', schemaAbs], { cwd: dir })
  // 合规 ISSUE 不应被报
  j(['add', 'f_issues', '--id', 'issue001', '--title', 'ISSUE-001 合规条目', '--type', 'requirement', '--ext', 'severity=P2', '--ext', 'area=src/a.js', '--packet', pkt], { cwd: dir })
  // 三类违规：title 不符模式 / OPTIM 挂错容器 / FIX 缺必填 ext
  j(['add', 'f_issues', '--id', 'issue002', '--title', '坏标题没有编号前缀', '--type', 'requirement', '--ext', 'severity=P2', '--ext', 'area=src/b.js', '--packet', pkt], { cwd: dir })
  j(['add', 'f_issues', '--id', 'optim001', '--title', 'OPTIM-001 挂错位置的建议', '--type', 'knowledge', '--ext', 'severity=P3', '--ext', 'area=src/c.js', '--packet', pkt], { cwd: dir })
  j(['add', 'f_fixlog', '--id', 'fix001', '--title', 'FIX-001 缺字段的修复', '--type', 'document', '--packet', pkt], { cwd: dir })

  const raw = runDtp(['lint', '--schema', schemaAbs, '--packet', pkt, '--json'], { cwd: dir })
  const r = JSON.parse(raw.stdout)
  assert.equal(raw.status, 1)
  const rules = r.violations.map((v) => `${v.rule}@${v.node_id ?? '-'}`)
  assert.ok(rules.includes('title.pattern@issue002'), `应报 title.pattern，实际 ${rules}`)
  assert.ok(rules.includes('parent.container@optim001'), `应报 parent.container，实际 ${rules}`)
  assert.ok(rules.includes('ext.required@fix001'), `应报 ext.required，实际 ${rules}`)
  // fix001 缺 fixed_in/issues 两个字段且无 fix 标签 → 三条（ext.required×2 + tags.require）
  assert.equal(r.violations.filter((v) => v.node_id === 'fix001').length, 3)
  assert.ok(rules.includes('tags.require@fix001'))
  // 合规 issue001 不在违规列表
  assert.ok(!r.violations.some((v) => v.node_id === 'issue001'))
})
