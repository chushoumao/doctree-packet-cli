// 统一错误类型：code 供 --json 输出与脚本判断使用
// details（可选）：结构化附加信息（如 SCHEMA_VIOLATION 的 violations 数组），
// 序列化与人类呈现由 output/main 消费；缺省 undefined，既有错误零影响
export class DtpError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'DtpError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function asDtpError(e) {
  if (e instanceof DtpError) return e
  const err = new DtpError('INTERNAL', e?.message ?? String(e))
  err.cause = e
  return err
}
