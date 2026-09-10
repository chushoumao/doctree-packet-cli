// 统一错误类型：code 供 --json 输出与脚本判断使用
export class DtpError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DtpError'
    this.code = code
  }
}

export function asDtpError(e) {
  if (e instanceof DtpError) return e
  const err = new DtpError('INTERNAL', e?.message ?? String(e))
  err.cause = e
  return err
}
