// 语义路径：以节点标题为段、'/' 分隔；标题中的 '/' 以 '\/' 转义。
// 例：/智能客服系统/FR-001 用户认证/登录验证

export function encodeSegment(title) {
  return String(title).replaceAll('/', '\\/')
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
  return out.filter((x) => x !== '').map(decodeSegment)
}

// 逐段编码后拼接为索引键
export function pathKey(segs) {
  return '/' + segs.map(encodeSegment).join('/')
}

// 规范化任意路径输入为索引键形式
export function normalizePathString(pathText) {
  return pathKey(splitSegments(pathText))
}
