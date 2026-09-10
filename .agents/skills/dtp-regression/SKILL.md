---
name: dtp-regression
description: 用 dtp 回归任务包驱动 dogfooding 式迭代：统一登记问题(ISSUE)、优化建议(OPTIM)、修复(FIX)，闭环「验证参数 → 登记 → 修复 → 验证」。当用户提到 dogfooding/dogfood、回归任务包、dtp-regression.dtp、ISSUE-/OPTIM-/FIX- 登记、问题登记/优化建议/修复登记、迭代某个 dtp 命令或参数、缺陷跟踪时使用。
---

# dtp 回归任务包使用技能

本项目用 **dogfooding** 方式迭代 dtp：外圈「验证 → 登记 → 修复 → 验证」，内圈用 dtp 自身登记追踪。本技能规定统一的登记模板与动作，保证循环可复现、可交接。

## 何时触发

- 用户要求迭代某个命令 / 能力面、测试某命令的参数与边界。
- 出现可复现缺陷，或发现非缺陷但值得改进的点（摩擦点）。
- 需要补登记、修复、状态流转、收尾（bump 版本）。
- 提到 `dtp-regression.dtp`、`ISSUE-###`/`OPTIM-###`/`FIX-###`。

## 任务包与骨架

- 真实包：`docs/dtp-regression.dtp`（**默认继续在此包登记**）。
- 可复用骨架：`docs/templates/dtp-regression.template.dtp`；格式说明：`docs/templates/README.md`。
- 固定三个收集夹：`f_issues`（问题登记 · folder）/ `f_optim`（优化建议 · folder）/ `f_fixlog`（修复登记 · index）。

## 命令约定

```bash
PKT=docs/dtp-regression.dtp
D() { node bin/dtp.js "$@" --packet "$PKT" --user <agent> --json; }   # 全程 --json，便于解析
```

- 号段全局递增补零：`ISSUE-###`/`OPTIM-###`/`FIX-###`；节点 `id` 为 `issue###`/`optim###`/`fix###`。
- 先看当前编号：`D ls f_issues` / `D ls f_optim` / `D ls f_fixlog`，或 `D query --path "/<包名>/问题登记"`。
- **一律通过 CLI 登记，禁止手改 JSONL。** 未收尾前不要把问题报告为「已修复」。

## 统一格式模版

### 1) 问题登记 ISSUE（可复现缺陷）

```bash
D add f_issues --id issueNNN --title "ISSUE-NNN <一句摘要>" --type requirement \
  --tags "P2,<module>" --ext severity=P2 --ext area=src/<file>.js \
  --description "<一句话说明问题本质>" \
  --content $'【复现】<最小命令/步骤，含真实退出码与输出>\n【期望】<正确行为>\n【实际】<当前行为>\n【影响】<损害面：阻断/契约破裂/静默错误/排查成本>\n【修复方向】<一句话指引>'
```

- `content` 必须＝**复现/期望/实际/影响/修复方向**五段，缺一不可；「复现」要能照抄执行。
- 只有**可复现、证据在手**才登记为 ISSUE；说不清的先按 OPTIM 登记。

### 2) 优化建议 OPTIM（非缺陷改进点 / 暂缓项）

```bash
D add f_optim --id optimNNN --title "OPTIM-NNN <一句摘要>" --type knowledge --status draft \
  --tags "P3,<module>" --ext severity=P3 --ext area=<模块或文件> \
  --description "<一句话说明>" \
  --content $'【现状】<当前行为/数据>\n【建议】<改进点>\n【取舍】<权衡：收益 vs 复杂度/风险；是否采纳>\n【验证】<对照组或用例，如何确认>'
```

- **暂缓/搁置**用 `status draft` 并在标题或正文注明「（暂缓）」+ 理由，不要直接 `approved`。
- 改语义类的取舍**必须先登记 OPTIM 并写明取舍**，禁止默默改行为。

### 3) 修复登记 FIX（每次修复一条，可覆盖多个问题）

```bash
D add f_fixlog --id fixNNN --title "FIX-NNN <摘要>（ISSUE-…/OPTIM-…）" --type document \
  --tags "fix,<module>" --ext fixed_in=vX.Y.Z --ext issues=ISSUE-…,OPTIM-… \
  --description "<一句话说明修复>" \
  --content $'【根因】<定位到的根因>\n【改动】<文件与逻辑，含新增测试文件>\n【验证】<验证方式与结果，如 "新增 N 组回归；M/M 测试全绿">'
```

- `extensions.issues` 填该修复覆盖的编号（逗号分隔）。
- FIX 必须对应已完成的代码改动 + 已跑的测试，不允许「计划性」FIX。

## 状态流转与收尾

```bash
# 问题：修复完成 → review → 写 fixed_in → approved
D update issueNNN --status review
D update issueNNN --ext fixed_in=vX.Y.Z
D update issueNNN --status approved
# 被 FIX 覆盖的 OPTIM 同样处置
# FIX 本身：review → approved
D update fixNNN --status review && D update fixNNN --status approved
```

收尾顺序（缺一不可）：
1. `npm test` 全绿（记录用例数）。
2. 登记 FIX，回填 `fixed_in`，把 ISSUE/OPTIM 置 `approved`。
3. `D verify`（应 `ok:true`，9 项检查通过）。
4. bump `package.json` 版本（每轮迭代一个版本）。

> `update --ext` 对**已有键**修改需加 `--force`；新增键直接用。键不可删除（append-only）。

## 标签与扩展字段约定

| 字段 | 取值 | 说明 |
|------|------|------|
| `extensions.severity` | `P0`–`P4` | 优先级，同时冗余到 `--tags` 便于 `query --tag P2` |
| `extensions.area` | `src/…` 或模块名 | 所属模块 |
| `extensions.fixed_in` | `vX.Y.Z` | 已修复版本（FIX 必有；被修复的 ISSUE/OPTIM 也回填） |
| `extensions.files` | `src/a.js,src/b.js` | 可选，修复涉及文件 |
| `extensions.issues` | `ISSUE-001,OPTIM-002` | FIX 覆盖的编号 |

标签：`P0..P4`、模块/能力（`cli`/`json`/`query`/`history`/`export`/`errmsg`/`io`/`integrity`/`write-path`/`ux`…）、结论（`fix`/`confirmed`）。

## 五步迭代清单（每轮照做）

1. **基准** — `npm test` 全绿，记基线用例数。
2. **验证参数** — 构造覆盖该命令**所有参数与边界**的 scratch 包（系统临时目录，**勿入库**），逐条执行，记录退出码 + stdout + stderr。
3. **登记** — 缺陷 → ISSUE，改进点 → OPTIM（含暂缓）。
4. **修复** — 改代码 + 补 `test/<面>-edges.test.js`；`npm test` 全绿。
5. **收尾** — 登记 FIX、回填 `fixed_in`、置 `approved`、`D verify`、bump 版本。

## 参数边界检查清单（回归易漏项）

- **数值解析**：不要用 `parseInt` 裸解析（`1.5`/`2abc`/`1e2`/`0x10` 会被静默截断）——须严格 `^\d+$` 且范围校验。
- **空值 fail-open**：显式空过滤值（`--tag ""`/`--keyword ""`/`--path ""`）应报错，绝不能退化为「返回全集」。
- **退出码**：用法错误（含 `INVALID_TYPE`/`INVALID_STATUS`）= 2，业务错误 = 1。
- **错误消息**：歧义/缺失要给出候选或行动指引，而非仅数量或裸栈。
- **压缩/边界数据**：pack 后历史快照丢失、删除节点、空包、坏行等，都要各测一遍。
- **契约形状**：`--json` 字段名/形状变化视为破坏性，需登记 OPTIM 后推进。

## 自检

```bash
D verify        # 9 项完整性校验，必须 ok:true
node bin/dtp.js tree --packet "$PKT"   # 人工复核骨架与登记分布
D query --tag P2 --status approved --packet "$PKT"   # 抽查状态
```
