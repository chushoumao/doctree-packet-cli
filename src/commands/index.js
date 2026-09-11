import { command as init } from './init.js'
import { command as add } from './add.js'
import { command as update } from './update.js'
import { command as rm } from './rm.js'
import { command as mv } from './mv.js'
import { command as ls } from './ls.js'
import { command as tree } from './tree.js'
import { command as query } from './query.js'
import { command as get } from './get.js'
import { command as getPath } from './get-path.js'
import { command as history } from './history.js'
import { command as checkout } from './checkout.js'
import { exportCmd } from './export.js'
import { command as pack } from './pack.js'
import { command as unpack } from './unpack.js'
import { command as verify } from './verify.js'
import { command as recover } from './recover.js'
import { command as template } from './template.js'
import { command as lint } from './lint.js'

// 命令注册表：键即子命令名
export const registry = {
  [init.name]: init,
  [add.name]: add,
  [update.name]: update,
  [rm.name]: rm,
  [mv.name]: mv,
  [ls.name]: ls,
  [tree.name]: tree,
  [query.name]: query,
  [get.name]: get,
  [getPath.name]: getPath,
  [history.name]: history,
  [checkout.name]: checkout,
  [exportCmd.name]: exportCmd,
  [pack.name]: pack,
  [unpack.name]: unpack,
  [verify.name]: verify,
  [recover.name]: recover,
  [template.name]: template,
  [lint.name]: lint,
}
