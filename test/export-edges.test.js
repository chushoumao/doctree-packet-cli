// export 输出结果回归（ISSUE-019/020/021 + OPTIM-014）：内容保真、TOC 层级、anchor 唯一、title/h1
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { tmpdir } from './helpers.js'
import { Packet, initPacketLines } from '../src/packet.js'
import { writeJsonlFresh } from '../src/storage.js'
import { toMarkdown, toHtml } from '../src/export.js'

let dir, packet
beforeEach(() => {
  dir = tmpdir()
  const file = path.join(dir, 'p.dtp')
  writeJsonlFresh(file, initPacketLines({ name: '导出包', packetId: 'pkt-ee' }).lines)
  packet = Packet.load(file)
  const root = packet.root()
  // ISSUE-019：正文含多连续空行（含围栏代码块内空行）
  packet.addNode({
    parentRef: root.id, id: 'ws', title: '空行节点',
    content: '段一\n\n\n\n段三\n\n```\ncode\n\n\ncode尾\n```',
  })
  // ISSUE-020：两层树（TOC 层级）
  packet.addNode({ parentRef: root.id, id: 'p1', title: '父节点', content: '父正文' })
  packet.addNode({ parentRef: 'p1', id: 'c1', title: '子节点', content: '子正文' })
  // ISSUE-021：自定义长 id 前 8 位碰撞
  packet.addNode({ parentRef: root.id, id: 'abcdefgh', title: '长ID甲' })
  packet.addNode({ parentRef: root.id, id: 'abcdefghx', title: '长ID乙' })
  // OPTIM-015：md 语法字符标题（强调/链接/代码/层级/删除线/HTML）
  packet.addNode({
    parentRef: root.id, id: 'md', title: '*粗* [链](x) #tag `code` _斜_ <div> ~删~ \\反斜',
  })
  packet.addNode({ parentRef: root.id, id: 'plain', title: '常规中文标题：用户认证模块 v1.0' })
})

test('ISSUE-019: md 导出保留正文连续空行（含代码块内）', () => {
  const md = toMarkdown(packet, packet.root().id)
  assert.ok(md.includes('段一\n\n\n\n段三'), '4 连续换行应原样保留')
  assert.ok(md.includes('code\n\n\ncode尾'), '代码块内空行应原样保留')
})

test('ISSUE-019: 节点间结构空行仍规范（块间恰好一个空行）', () => {
  const md = toMarkdown(packet, packet.root().id)
  assert.ok(md.includes('\n\n## 空行节点'), '节点块间以空行分隔')
  assert.ok(!/\n{3,}## /.test(md), '结构层级不应出现 3+ 连续换行')
})

test('ISSUE-020: html TOC 为单一根 ul 的嵌套结构', () => {
  const html = toHtml(packet, packet.root().id)
  const nav = html.slice(html.indexOf('<nav>'), html.indexOf('</nav>'))
  assert.ok(!/<\/ul>\s*<ul>/.test(nav), '不应存在平级相邻 ul（原按深度平铺互不嵌套）')
  // 子节点 li 内嵌套 ul：父 li 以 <a>…</a> 延续（后接换行与嵌套 ul，语义等价）
  assert.ok(/<a href="#node-p1">父节点<\/a>\s*<ul>/.test(nav), '子层应嵌套在父 li 内')
  assert.ok(nav.includes('<a href="#node-c1">子节点</a></li>'), '叶子 li 正常闭合')
})

test('ISSUE-021: anchor 用完整 id，无碰撞', () => {
  const html = toHtml(packet, packet.root().id)
  assert.ok(html.includes('id="node-abcdefgh"'), '节点甲 section 存在')
  assert.ok(html.includes('id="node-abcdefghx"'), '节点乙 section 独立存在（原被截断碰撞）')
  const ids = [...html.matchAll(/ id="(node-[^"]+)"/g)].map((m) => m[1])
  assert.equal(new Set(ids).size, ids.length, 'section id 应全部唯一')
  assert.ok(html.includes('href="#node-abcdefghx"'), 'TOC 链接指向乙自身')
})

test('OPTIM-014: title 为导出根标题；整页单一 h1', () => {
  // 整包导出：title = 包名
  const all = toHtml(packet, packet.root().id)
  assert.ok(all.includes('<title>导出包</title>'), '整包导出 title=包名（向后兼容）')
  assert.equal((all.match(/<h1>/g) || []).length, 1, '整页应只有根节点一个 h1（原页首包名 h1 与根 h1 重复）')
  assert.ok(all.includes('packet pkt-ee'), '包 meta 行保留')

  // 子树导出：title = 子树根标题
  const sub = toHtml(packet, 'p1')
  assert.ok(sub.includes('<title>父节点</title>'), '子树导出 title=导出根标题（原为包名）')
  assert.equal((sub.match(/<h1>/g) || []).length, 1)
})

test('md/html 基本形状不回退：层级递进、meta 行、转义', () => {
  const md = toMarkdown(packet, packet.root().id)
  assert.ok(md.includes('# 导出包'))
  assert.ok(md.includes('## 空行节点'))
  assert.ok(md.includes('> status: draft · version: v1'))

  const html = toHtml(packet, packet.root().id)
  assert.ok(html.includes('<!doctype html>'))
  assert.ok(html.includes('<h2>父节点</h2>'), 'depth1 仍为 h2')
  assert.ok(html.includes('<h1>导出包</h1>'), '根节点 h1')
})

// ---------- OPTIM-015：md 标题行内转义 ----------

test('OPTIM-015: md 标题语法字符被转义——层级保持、无注入、原文可还原', () => {
  const md = toMarkdown(packet, packet.root().id)
  const headLine = md.split('\n').find((l) => l.startsWith('## ') && l.includes('粗'))
  assert.ok(headLine, '找到该节点的二级标题行')
  // 层级由 # 前缀决定，不受标题内 # 影响
  assert.ok(headLine.startsWith('## '))
  // 行内语法字符全部带反斜杠（转义集：\ ` * _ [ ] # < ~）
  for (const esc of ['\\*粗\\*', '\\[链\\](x)', '\\#tag', '\\`code\\`', '\\_斜\\_', '\\<div\\>', '\\~删\\~']) {
    assert.ok(headLine.includes(esc), `应含转义序列 ${esc}；实际行：${headLine}`)
  }
  // 原文可还原：去掉转义反斜杠后等于原标题
  const rendered = headLine.replace(/^## /, '').replaceAll('\\#', '#').replaceAll('\\*', '*')
    .replaceAll('\\`', '`').replaceAll('\\_', '_').replaceAll('\\[', '[').replaceAll('\\]', ']')
    .replaceAll('\\<', '<').replaceAll('\\>', '>').replaceAll('\\~', '~').replaceAll('\\\\', '\\')
  assert.equal(rendered, '*粗* [链](x) #tag `code` _斜_ <div> ~删~ \\反斜')
  // 无裸注入：标题行内不存在未转义的强调/链接起点
  assert.ok(!/\*粗\*/.test(headLine))
  assert.ok(!/\[链\]\(x\)/.test(headLine))
})

test('OPTIM-015: 常规中英文标题零转义噪音', () => {
  const md = toMarkdown(packet, packet.root().id)
  const line = md.split('\n').find((l) => l.startsWith('## 常规中文标题'))
  assert.ok(line)
  assert.equal(line, '## 常规中文标题：用户认证模块 v1.0', '常规标题零反斜杠')
})

test('OPTIM-015: HTML 导出不回归（标题/TOC 仍 escapeHtml 转义）', () => {
  const html = toHtml(packet, packet.root().id)
  assert.ok(html.includes('&lt;div&gt;'), '标题经 escapeHtml')
  assert.ok(html.includes('<h2>*粗* [链](x) #tag `code` _斜_ &lt;div&gt; ~删~ \\反斜</h2>') || !html.includes('<h2><div>'), '无原始 HTML 注入')
})
