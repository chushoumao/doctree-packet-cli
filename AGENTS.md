# AGENTS.md — dtp 项目协作规则

dtp（DocTree Packet CLI）是一个**零依赖** Node.js 命令行工具，用 JSONL + append-only + 内容哈希管理树形文档数据包。本文件是项目内 AI / 协作者的统一约定；dogfooding 迭代的具体命令与模版见技能 **`dtp-regression`**（`.agents/skills/dtp-regression/SKILL.md`）。

## 技术栈与运行

- Node.js ≥ 18.17，ESM，**零运行时依赖**（只用 `node:*` 内建模块）。
- 入口 `bin/dtp.js` → `src/main.js`；子命令在 `src/commands/`，注册表 `src/commands/index.js`。
- 本地运行：`node bin/dtp.js <命令> ...`（或 `npm run dtp -- <命令>`）。
- 测试：`npm test`（`node --test`）。**提交前必须全绿。**
- 每轮 dogfooding 迭代收尾后 bump `package.json` 版本。

## 核心不变量（改动必须保持）

1. **零依赖**：不引入任何运行时 npm 依赖。
2. **append-only**：变更为「内存修改 + 备份 + 单次 append 落盘」，绝不改写历史行，失败不留半行。
3. **内容哈希**：`computeNodeHash` 只覆盖语义字段（parent_id/node_type/title/description/content/tags/status/extensions），不含 version/时间戳，同内容同哈希。
4. **Agent 契约（`--json`）**：任何命令、含报错，都在 stdout 输出**单行 JSON**（`{ok:true,...}` / `{ok:false,error:{code,message}}`）；人类可读信息走 stderr。
5. **退出码**：用法错误（`USAGE`/`EXISTS`/`INVALID_TYPE`/`INVALID_STATUS`）= 2；其他业务错误 = 1。
6. **错误类型**：统一用 `DtpError(code, message)`（`src/errors.js`），不要抛裸 `Error`。

## dogfooding 迭代循环（本项目主工作方式）

每轮聚焦**一个命令或一个能力面**，五步循环，全程用 dtp 自身登记追踪：

1. **基准** — `npm test` 确认全绿，记录基线用例数。
2. **验证参数** — 构造覆盖该命令**所有参数与边界条件**的 scratch 数据包（放系统临时目录，勿入库），逐个执行并记录原始输出（退出码 / stdout / stderr）。
3. **登记** — 可复现缺陷登记为 **ISSUE**，非缺陷改进点登记为 **OPTIM**，写入回归任务包。
4. **修复** — 改代码并补 `test/<面>-edges.test.js` 回归用例；`npm test` 全绿。
5. **收尾** — 登记 **FIX**（根因/改动/验证），把对应 ISSUE/OPTIM 置 `approved` 并写 `fixed_in`；`dtp verify` 通过后 bump 版本，并核对/更新 `dtp-regression` 技能与 `docs/templates/`（见「技能新鲜度」）。

> 只修可复现、证据在手的问题；改语义类取舍先登记 OPTIM 说明「取舍」，不要默默改行为。

## 技能新鲜度（每轮必查）

`dtp-regression` 技能（`.agents/skills/dtp-regression/SKILL.md`）与 `docs/templates/` 是迭代循环的「说明书」；**功能演进后必须同步更新，禁止让其与代码脱节**：

- 新增 / 改名 / 删除命令、参数、选项或写路径行为时，更新技能中的命令示例与「参数边界检查清单」。
- 变更 `--json` 契约、错误码、退出码、`extensions`/tags 约定时，更新技能与 `docs/templates/README.md` 的对应约定。
- 调整登记格式模板（ISSUE/OPTIM/FIX 体例）后，同步 `docs/templates/`。
- 收尾 checklist 未完成「核对技能新鲜度」视为本轮未收尾。

## 回归任务包

- 真实包 `docs/dtp-regression.dtp`；可复用骨架 `docs/templates/dtp-regression.template.dtp`（说明见 `docs/templates/README.md`）。
- 骨架：`问题登记 f_issues` / `优化建议 f_optim` / `修复登记 f_fixlog`。
- 默认在当前包继续登记，号段全局递增补零：`ISSUE-###`/`OPTIM-###`/`FIX-###`，`id` 为 `issue###`/`optim###`/`fix###`。
- **登记与修复一律通过 CLI 自举完成，不要手改 JSONL。**

## 代码约定

- ESM import；2 空格缩进；沿用邻接文件风格。
- 注释用中文，只在「为什么」非显然时写，不复述代码。
- 外科手术式改动：只碰与任务相关的行，不顺带重构无关代码。
- 新增命令：`src/commands/<name>.js` 导出 `command = { name, summary, args, options, example, run(ctx) }`，并在 `src/commands/index.js` 注册。
- 读取用 `ctx.load()`；写入用 `ctx.withLock(() => { ...; packet.save() })`。

## Git 与仓库

- 远程 `https://github.com/chushoumao/doctree-packet-cli`（公开），分支 `main`。
- 提交信息用约定式前缀（`fix:`/`feat:`/`test:`/`docs:`/`chore:`），正文可中文。
- 不提交 `node_modules/`、`tmp/`、`*.bak.*`、`.DS_Store`（见 `.gitignore`）。
- 未经明确要求，不 `git push`、不改 git config。

## 边界

- 不动 `docs/dtp-regression.dtp.bak.*`（工具生成的备份）。
- 不破坏 `--json` 契约的字段名/形状，除非作为登记在案的 OPTIM 明确推进。
