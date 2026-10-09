// OPTIM-027 回归：--content/--description 的 @file 长文本注入（含 @@ 字面转义）
// 背景证据在池：OPTIM-005 关闭时 v2 坏写的根因即「多行内容无文件通道只能走命令行字面量」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir, runJson, runDtp, makePacket } from './helpers.js'

const j = (args, opts) => runJson(args, opts).data

function setup(prefix = 'txt-') {
  const dir = tmpdir(prefix)
  const pkt = path.join(dir, 'p.dtp')
  makePacket(pkt, { name: '文本包' })
  const root = j(['init', '文本包', '--packet', pkt, '--id', 'n_root'], { cwd: dir }).root_node_id ?? 'n_root'
  return { dir, pkt, root }
}

test('OPTIM-027：--content/--description 支持 @file 注入（内容原样，含尾随换行）', () => {
  const { dir, pkt, root } = setup()
  fs.writeFileSync(path.join(dir, 'spec.md'), '【说明】第一行\n第二行\n')
  fs.writeFileSync(path.join(dir, 'desc.md'), '描述文本\n')
  const r = j(['add', root, '--id', 'na', '--title', 'A', '--content', '@./spec.md', '--description', '@./desc.md', '--packet', pkt], { cwd: dir })
  assert.equal(r.ok, true, JSON.stringify(r))
  const n = j(['get', 'na', '--packet', pkt], { cwd: dir })
  assert.equal(n.node.content, '【说明】第一行\n第二行\n')
  assert.equal(n.node.description, '描述文本\n')
})

test('OPTIM-027：@@ 前缀为字面量转义（不读文件）；@ 开头内容按转义规则保留', () => {
  const { dir, pkt, root } = setup('txt-esc-')
  // '@@literal @here' → '@literal @here'（剥掉一个 @）
  j(['add', root, '--id', 'nb', '--title', 'B', '--content', '@@literal @here', '--packet', pkt], { cwd: dir })
  assert.equal(j(['get', 'nb', '--packet', pkt], { cwd: dir }).node.content, '@literal @here')
  // '@@@mention' → '@@mention'（想写两个字面 @ 就写三个）
  j(['add', root, '--id', 'nc', '--title', 'C', '--description', '@@@mention', '--packet', pkt], { cwd: dir })
  assert.equal(j(['get', 'nc', '--packet', pkt], { cwd: dir }).node.description, '@@mention')
  // 非 @ 开头的普通值不受影响
  j(['add', root, '--id', 'nd', '--title', 'D', '--content', '普通文本', '--packet', pkt], { cwd: dir })
  assert.equal(j(['get', 'nd', '--packet', pkt], { cwd: dir }).node.content, '普通文本')
})

test('OPTIM-027：文件缺失 → USAGE exit 2 且报错附 cwd 解析绝对路径', () => {
  const { dir, pkt, root } = setup('txt-miss-')
  const raw = j(['add', root, '--title', 'E', '--content', '@./nope.md', '--packet', pkt], { cwd: dir })
  assert.equal(raw.ok, false)
  assert.equal(raw.error.code, 'USAGE')
  assert.match(raw.error.message, /长文读取失败/)
  assert.ok(raw.error.message.includes(path.join(dir, 'nope.md')), '含绝对路径')
  // @ 后空路径同样给出可行动指引
  const empty = j(['add', root, '--title', 'F', '--content', '@', '--packet', pkt], { cwd: dir })
  assert.equal(empty.error.code, 'USAGE')
})

test('OPTIM-027：update 同语义（@file 注入生效并递增版本）；help 说明两形态', () => {
  const { dir, pkt, root } = setup('txt-upd-')
  fs.writeFileSync(path.join(dir, 'v1.md'), '第一版\n')
  fs.writeFileSync(path.join(dir, 'v2.md'), '第二版\n')
  j(['add', root, '--id', 'nu', '--title', 'U', '--content', '@./v1.md', '--packet', pkt], { cwd: dir })
  const upd = j(['update', 'nu', '--content', '@./v2.md', '--packet', pkt], { cwd: dir })
  assert.equal(upd.ok, true)
  const n = j(['get', 'nu', '--packet', pkt], { cwd: dir })
  assert.equal(n.node.version, 2)
  assert.equal(n.node.content, '第二版\n')

  // help 说明两形态（@file 读文件 / @@ 字面量）
  for (const cmd of ['add', 'update']) {
    const h = runDtp([cmd, '--help'], { cwd: dir }).stdout
    assert.match(h, /@文件路径 读文件注入/, `${cmd} help 说明 @file 形态`)
    assert.match(h, /@@ 开头表示字面量/, `${cmd} help 说明转义形态`)
  }
})
