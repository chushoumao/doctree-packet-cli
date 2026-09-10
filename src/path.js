// 语义路径：以节点标题为段、'/' 分隔；标题中的 '/' 以 '\/' 转义。
// 例：/智能客服系统/FR-001 用户认证/登录验证

export function encodeSegment(title) {
  // NFC 归一化：索引与查询两侧的统一咽喉。NFD 输入（macOS 文件名/部分输入法）
  // 与 NFC 存储规范等价，字节级匹配会让视觉相同的路径互相 NOT_FOUND（ISSUE-017）
  return String(title).normalize('NFC').replaceAll('/', '\\/')
}

export function decodeSegment(seg) {
  return seg.replaceAll('\\/', '/')
}

// 解析用户输入的路径为解码后的标题段数组；容忍缺省前导 '/' 与多余首尾 '/'
export function splitSegments(pathText) {
  const s = String(pathText ?? '').trim()
  if (!s) return []
  let raw = s.startsWith('/') ? s.slice(1) : s
  if (raw.endsWith('/')) raw = raw.slice(0, -1)
  const out = []
  let cur = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\' && raw[i + 1] === '/') {
      cur += '/'
      i++
    } else if (ch === '/') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  // 段级 trim：存储侧标题已 trim（FIX-005），输入段残留空白（含全角空格）
  // 会让视觉相同的路径永远失配（ISSUE-018）；trim 不会误伤任何合法标题
  return out.filter((x) => x !== '').map((s) => decodeSegment(s).trim())
}

// 逐段编码后拼接为索引键
export function pathKey(segs) {
  return '/' + segs.map(encodeSegment).join('/')
}

// 规范化任意路径输入为索引键形式
export function normalizePathString(pathText) {
  return pathKey(splitSegments(pathText))
}
