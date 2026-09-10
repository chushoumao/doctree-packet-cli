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
  writeJsonlFresh(file, initPacketLines({ name: '演示', packetId: 'pkt-e' }).lines)
  packet = Packet.load(file)
  const root = packet.root()
  packet.addNode({ parentRef: root.id, id: 'f1', title: '功能 <重点>', nodeType: 'requirement', tags: ['P0'], description: '描述行1\n描述行2', content: '正文段落一\n\n正文段落二 <b>' })
  packet.addNode({ parentRef: 'f1', id: 'leaf', title: '子项', content: '子项正文' })
})

test('Markdown：标题层级递进、元信息、正文', () => {
  const md = toMarkdown(packet, packet.root().id)
  assert.ok(md.includes('# 演示'))
  assert.ok(md.includes('## 功能 <重点>'))
  assert.ok(md.includes('### 子项'))
  assert.ok(md.includes('> status: draft · tags: P0 · version: v1'))
  assert.ok(md.includes('> 描述行1\n> 描述行2'))
  assert.ok(md.includes('正文段落一'))
})

test('HTML：转义危险字符、嵌套结构、目录锚点', () => {
  const html = toHtml(packet, packet.root().id)
  assert.ok(html.includes('<!doctype html>'))
  assert.ok(html.includes('功能 &lt;重点&gt;')) // 标题转义
  assert.ok(html.includes('&lt;b&gt;')) // 正文转义
  assert.ok(!html.includes('<b>'))
  assert.ok(html.includes('id="node-'))
  assert.ok(html.includes('<nav>'))
})
