// get-path 迭代回归（ISSUE-017/018 + OPTIM-013）：多语言、NFC/NFD、段级空白、根路径
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runJson, runDtp, makePacket, tmpdir, path } from './helpers.js'

const NFC = 'caf\u00e9' // 预组合 é
const NFD = 'caf\u0065\u0301' // 分解 e + 组合尖音（U+0301）

function seed() {
  const dir = tmpdir('dtp-gp-')
  const file = path.join(dir, 'p.dtp')
  makePacket(file, { name: '路径包' }) // 根 id=n_root
  const add = (parent, id, title, extra = []) => {
    const r = runJson(['add', parent, '--id', id, '--title', title, ...extra, '--packet', file])
    assert.equal(r.status, 0, `add ${id} 失败 ${JSON.stringify(r.data)}`)
  }
  add('n_root', 'c1', '子夹', ['--type', 'folder'])
  add('n_root', 't1', '任务A')
  add('n_root', 's1', '带/斜杠')
  add('n_root', 'nfc', NFC)
  add('n_root', 'ja', '日本語タイトル')
  add('n_root', 'ar', 'العربية')
  add('n_root', 'ej', '🚀火箭')
  add('n_root', 'zw', '👨‍👩‍👧家庭')
  add('c1', 'deep', '深层')
  return { file, add }
}

test('ISSUE-018: 段级空白 trim 后视觉相同路径可命中', () => {
  const { file } = seed()

  // 段首/段尾半角空格（存储侧标题已 trim，输入段残留空白不应失配）
  const lead = runJson(['get-path', '/路径包/ 子夹', '--packet', file])
  assert.equal(lead.status, 0)
  assert.equal(lead.data.node.id, 'c1')

  const trail = runJson(['get-path', '/路径包/子夹 ', '--packet', file])
  assert.equal(trail.status, 0)

  // 全角空格（U+3000）同样被 trim
  const fw = runJson(['get-path', '/路径包/\u3000子夹', '--packet', file])
  assert.equal(fw.status, 0)
})

test('ISSUE-018: 纯空白路径报 USAGE 而非误导性 NOT_FOUND', () => {
  const { file } = seed()
  for (const bad of ['   ', '\u3000', '\t']) {
    const r = runJson(['get-path', bad, '--packet', file])
    assert.equal(r.status, 2, `空白路径 ${JSON.stringify(bad)} 应报用法错误`)
    assert.equal(r.data.error.code, 'USAGE')
  }
})

test('ISSUE-017: NFC/NFD 规范等价路径互相命中', () => {
  const { file } = seed()

  // NFC 标题 + NFD 输入（macOS Finder 复制场景）
  const nfdInput = runJson(['get-path', `/路径包/${NFD}`, '--packet', file])
  assert.equal(nfdInput.status, 0)
  assert.equal(nfdInput.data.node.id, 'nfc')

  // NFC 标题 + NFC 输入照常
  const nfcInput = runJson(['get-path', `/路径包/${NFC}`, '--packet', file])
  assert.equal(nfcInput.status, 0)
  assert.equal(nfcInput.data.node.id, 'nfc')
})

test('ISSUE-017: 同级唯一性校验对 NFC/NFD 视觉重名生效', () => {
  const { file } = seed()
  // nfc 节点标题为 NFC café；再 add NFD 形式（视觉相同）应被 EXISTS 拒绝
  const r = runJson(['add', 'n_root', '--id', 'nfd2', '--title', NFD, '--packet', file])
  assert.equal(r.status, 2)
  assert.equal(r.data.error.code, 'EXISTS')
})

test('ISSUE-017: query --path 与 pathOf 对 NFC/NFD 对称', () => {
  const { file } = seed()
  // pathOf 已归一化：query --path 用 NFD 输入也应命中 NFC 标题节点
  const q = runJson(['query', '--path', `/路径包/${NFD}`, '--packet', file])
  assert.equal(q.status, 0)
  const ids = q.data.nodes.map((n) => n.id)
  assert.ok(ids.includes('nfc'), `NFD 前缀应命中 nfc 节点，实际 ${JSON.stringify(ids)}`)
})

test('OPTIM-013: get-path / 直达根节点', () => {
  const { file } = seed()
  const r = runJson(['get-path', '/', '--packet', file])
  assert.equal(r.status, 0)
  assert.equal(r.data.node.id, 'n_root')
  // 既有 "/根标题" 方式不受影响
  const byTitle = runJson(['get-path', '/路径包', '--packet', file])
  assert.equal(byTitle.status, 0)
  assert.equal(byTitle.data.node.id, 'n_root')
})

test('多语言路径：CJK/RTL/emoji/含斜杠标题', () => {
  const { file } = seed()

  const cases = [
    ['/路径包/日本語タイトル', 'ja'],
    ['/路径包/العربية', 'ar'],
    ['/路径包/🚀火箭', 'ej'],
    ['/路径包/👨‍👩‍👧家庭', 'zw'],
    ['/路径包/带\\/斜杠', 's1'], // 标题中的 '/' 需 \/ 转义
    ['/路径包/子夹/深层', 'deep'], // 嵌套
  ]
  for (const [p, id] of cases) {
    const r = runJson(['get-path', p, '--packet', file])
    assert.equal(r.status, 0, `get-path ${p} 应成功`)
    assert.equal(r.data.node.id, id)
  }

  // 大小写敏感维持（字节精确语义，不折叠）
  add2(file)
  const cs = runJson(['get-path', '/路径包/todo', '--packet', file])
  assert.equal(cs.status, 1)
  assert.equal(cs.data.error.code, 'NOT_FOUND')
})

function add2(file) {
  runDtp(['add', 'n_root', '--id', 'cs1', '--title', 'TODO', '--packet', file])
}

test('契约：多余参数/未知选项 USAGE exit2，无包 NO_PACKET exit1', () => {
  const { file } = seed()

  const extra = runJson(['get-path', '/路径包/子夹', 'extra', '--packet', file])
  assert.equal(extra.status, 2)
  assert.equal(extra.data.error.code, 'USAGE')

  const unknown = runJson(['get-path', '/路径包/子夹', '--bogus', '--packet', file])
  assert.equal(unknown.status, 2)
  assert.equal(unknown.data.error.code, 'USAGE')

  const noPacket = runJson(['get-path', '/x', '--packet', path.join(tmpdir('dtp-gp-'), 'nope.dtp')])
  assert.equal(noPacket.status, 1)
  assert.equal(noPacket.data.error.code, 'NO_PACKET')
})

test('mv/rm 后路径索引同步', () => {
  const { file, add } = seed()
  add('n_root', 'mv1', '要移动')
  add('n_root', 'rm1', '要删除')

  const mv = runJson(['mv', 'mv1', '/路径包/子夹', '--packet', file])
  assert.equal(mv.status, 0)
  const newPath = runJson(['get-path', '/路径包/子夹/要移动', '--packet', file])
  assert.equal(newPath.status, 0)
  const oldPath = runJson(['get-path', '/路径包/要移动', '--packet', file])
  assert.equal(oldPath.status, 1)

  runDtp(['rm', 'rm1', '--yes', '--packet', file])
  const gone = runJson(['get-path', '/路径包/要删除', '--packet', file])
  assert.equal(gone.status, 1)
  assert.equal(gone.data.error.code, 'NOT_FOUND')
})
