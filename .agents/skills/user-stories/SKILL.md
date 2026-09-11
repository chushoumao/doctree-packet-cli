---
name: user-stories
description: 用 dtp 用户故事包驱动「讨论用户故事 → 拆分需求 → 转化为任务」的工作流：故事(US-NNN)记录讨论与需求拆分，任务(TASK-NNN)挂载为故事子节点并通过扩展字段 acceptance（JSON 数组）结构化存储验收标准，执行时逐条复核回填 done_evidence 形成验收闭环。当用户提到用户故事/需求拆分/任务分解/验收标准/acceptance/US-NNN/TASK-NNN/故事池时使用。
---

# 用户故事包使用技能

本项目用 dtp 管理需求工作流：**讨论 → 用户故事(US) → 拆分需求 → 任务(TASK) → 实现 → 验收闭环**。核心约束：**任务层必须通过扩展字段 `acceptance`（JSON 数组）明确验收标准**，验收时逐条复核并回填证据。

## 何时触发

- 用户要求登记/讨论用户故事、拆分需求、分解任务。
- 实现任务前需要拿验收标准；实现后需要逐条复核验收。
- 提到 `user-stories.dtp`、`US-###`、`TASK-###`、`acceptance`、`故事池`。

## 任务包与骨架

- 真实包：`docs/user-stories.dtp`（**默认继续在此包登记**，已绑定模版 `docs/templates/user-stories.schema.json`）。
- 模版单一事实源：`docs/templates/user-stories.schema.json`（声明式 schema，story/task 规则与验收口径机器化）；新建故事包：`dtp init <包名> --template docs/templates/user-stories.schema.json`。
- 旧骨架 `user-stories.template.dtp` **已退役**（历史样例，勿再拷贝使用）；格式说明：`docs/templates/README.md`。
- 固定结构：故事池 `f_stories`（folder）；**任务挂载为所属故事的直接子节点**。

```
用户故事包 (us_root)
└── 故事池 (f_stories · folder)
    └── US-NNN 用户故事 (requirement)
        └── TASK-NNN 任务 (requirement)   ← ext.acceptance 验收标准
```

## 命令约定

```bash
PKT=docs/user-stories.dtp
U() { node bin/dtp.js "$@" --packet "$PKT" --user <agent> --json; }   # 全程 --json
```

- 号段全局递增补零：`US-###` / `TASK-###`；节点 `id` 为 `us###` / `task###`（task 编号跨故事全局唯一，便于引用）。
- 先看当前编号：`U ls f_stories` / `U query --tag task`。
- **一律通过 CLI 登记，禁止手改 JSONL。**未验收通过不要把 task 报告为 done。

## 统一格式模版

### 1) 用户故事 US（讨论与拆分的载体）

```bash
U add f_stories --id usNNN --title "US-NNN 作为<角色>，我希望<能力>，以便<价值>" --type requirement \
  --tags "story,<module>" --ext priority=P2 \
  --description "<一句话价值概述>" \
  --content $'【背景与讨论】<为什么做；讨论要点、备选方案，随讨论追加>\n【用户故事】作为…我希望…以便…\n【需求拆分】<拆出的需求点，逐条列；每条应可落为一个或多个任务>\n【验收口径】<故事级验收口径；task 的 acceptance 由它派生，不得矛盾>'
```

- content 四段必须齐全（【背景与讨论】【用户故事】【需求拆分】【验收口径】）。
- 讨论有新结论时用 `U update usNNN --content` 追加（append-only 留版本历史）。
- 需求拆分点应编号（①②③…），便于与 task 对应检查覆盖。

### 2) 任务 TASK（实现与验收的最小单元）★acceptance 必填

```bash
U add usNNN --id taskNNN --title "TASK-NNN <做什么>" --type requirement \
  --tags "task,<module>" --ext story=US-NNN --ext priority=P2 \
  --ext acceptance='["GIVEN <前置> WHEN <操作> THEN <可观察结果>","<下一条验收标准>"]' \
  --description "<一句话说明>" \
  --content $'【实现说明】<怎么做：涉及文件/接口/命令>\n【验收标准】<与 acceptance 数组逐条一致>\n【验收记录】（验收通过后回填一行结论；明细统一记 ext.done_evidence 单一事实源，此处勿复制防漂移）'
```

- **`ext.acceptance` 必填且必须是 JSON 数组**（shell 单引号包裹防展开）；没有验收标准的任务不许进入实现。
- 验收标准写「可观察、可复核」的结果（GIVEN/WHEN/THEN 或等价明确断言），不写「正常工作」这类不可复核描述。
- `ext.story` 冗余故事编号便于 `query --ext story=US-001`。
- 实现完成后回填验收证据：`U update taskNNN --ext done_evidence='<逐条复核结果，含命令/测试名>'`。

### 3) 讨论结论不改变故事范围时（补充记录）

```bash
U update usNNN --content "$(U get usNNN | 追加后全文)"   # 或直接重写 content，append-only 留痕
```

## 状态流转与验收闭环

状态枚举固定 `draft | review | approved | archived`，两层语义映射：

| 节点 | draft | review | approved | archived |
|------|-------|--------|----------|----------|
| US | 讨论中 | 已定稿待拆分 | 已排期实现中 | 搁置/放弃 |
| TASK | 待实现 | **已实现待验收** | **验收通过** | 取消 |

```bash
# 故事定稿
U update usNNN --status review
# 任务实现完成 → 待验收
U update taskNNN --status review
# 验收：逐条复核 acceptance → 回填证据 → 通过
U update taskNNN --ext done_evidence='①通过：npm test 82/82；②通过：cat -et 复核输出'
U update taskNNN --status approved
# 故事下全部 task approved → 故事交付
U update usNNN --status approved
```

**验收纪律**：验收 = 逐条对照 `acceptance` 复核，缺一条不通过；`done_evidence` 为空不给 approved。

## 常用查询

```bash
U query --parent f_stories --status draft              # 讨论中的故事
U query --tag task --status review                     # 待验收任务（全包）
U query --ext story=US-001                             # 某故事下全部任务
U query --tag task --status draft --ext priority=P1    # 待实现的高优任务
U get taskNNN                                          # 查看验收标准与记录
```

## 标签与扩展字段约定

| 字段 | 取值 | 说明 |
|------|------|------|
| `extensions.acceptance` | JSON 数组（**task 必填**） | 验收标准，逐条可复核 |
| `extensions.story` | `US-NNN`（task 必填） | 所属故事冗余引用 |
| `extensions.priority` | `P0`–`P3` | 优先级，冗余到 tags 便于过滤 |
| `extensions.done_evidence` | 字符串 | 验收证据（approved 前回填） |
| `extensions.assignee` / `estimate` | 可选 | 执行人 / 预估（如 `2h`、`1d`） |

标签：`story` / `task` 类型冗余、模块/能力（`cli`/`export`/`write-path`…）、`P0`–`P3`。

## 需求工作流清单（每轮照做）

1. **讨论** — 登记 US（draft），讨论记录进 content。
2. **定稿** — 故事四段齐全 → `review`。
3. **拆分** — 需求拆分点逐条转 TASK，acceptance 由「验收口径」派生（story 回 `approved` 表示排期）。
4. **实现** — task `draft`，按【实现说明】做。
5. **验收** — 逐条复核 acceptance → 回填 `done_evidence` → `approved`；全部 task 通过后 story `approved`。
6. **收尾** — 涉及 dtp 代码改动的任务走 `dtp-regression` 技能的登记闭环。

## 参数边界检查清单

- 沿用通用清单（数值严格解析、空值拒绝 fail-open、用法错误 exit 2 / 业务错误 exit 1、错误消息带行动指引）。
- `acceptance` 必须 JSON 数组：登记后 `U get taskNNN` 确认类型是数组而非字符串（shell 引号易踩坑）；`--ext` 等号后空值报 `USAGE`（置空用 `k=null`，ISSUE-022）。
- story 与 task 的 `--parent` 关系必须正确：task 挂 story 下，不许挂 `f_stories` 根下。

## 自检

```bash
U verify                                             # 9 项完整性校验，必须 ok:true
U lint                                               # 模版符合性：error 级违规为 0（story/task 约定机器化校验）
node bin/dtp.js tree --packet "$PKT"                 # 人工复核骨架与故事分布
U query --tag task --status review --packet "$PKT"   # 待验收任务面
```
