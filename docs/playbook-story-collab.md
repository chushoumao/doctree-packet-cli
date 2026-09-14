# 故事驱动 × 多 Agent 协作手册

> 沉淀自 US-002「数据包模版配置功能」（v1.6.0）全流程实战复盘。
> 目标读者：要在本仓库（或任何用 dtp 管理需求的仓库）发起需求、实现功能的人类维护者与 Agent 团队。
> 一句话：**用 dtp 自己管理需求，把「需求侧」「实现侧」「回归侧」放进三个可通信的 Agent 会话（herdr 三 pane），按「登记 → 评审 → 拆任务 → 实现 → 独立验收 → 闭环登记」的节奏交付——全程留痕、可审计、可交接。**

## 1. 前置准备（一次性）

| 项 | 内容 |
|---|---|
| 需求包 | `docs/user-stories.dtp`（格式约定见 `docs/templates/user-stories.schema.json`，新包用 `dtp init --template` 派生） |
| 回归包 | `docs/dtp-regression.dtp`（缺陷 ISSUE / 优化 OPTIM / 修复 FIX 登记） |
| 会话拓扑 | 见下 §1.1：主 / dev / regression 三 pane，**label 即角色** |
| 规约 | 通读 `.agents/skills/user-stories` 与 `.agents/skills/dtp-regression` 两个技能 + 根目录 `AGENTS.md` |

### 1.1 Pane 组织与自举约定（agent 上来自组织）

当前布局（w4 workspace · dtp）：

```text
├── w4:p1 主 pane             左列整高   需求侧 / 验收方（故事包写入方）
├── w4:p2 dev        [右上]              实现侧（story TASK 实现，独占 src/）
└── w4:p3 regression [右下]              回归侧（dogfooding 回归迭代：ISSUE/OPTIM/FIX 闭环）
```

拆分顺序：root → right(0.5) → 右支 down(0.5)。主 pane 独占整列保证树形与长输出可见性；dev 与 regression 叠放次列，实现与回归两条工作流并行互不阻塞。

**自举规则**——agent 进入仓库后按序自检，缺什么补什么，不需要人指挥：

1. 首个进入仓库的会话即主 pane，无需创建；
2. `herdr pane list` 自检：同 workspace 无 label `dev` → `herdr pane split --current --direction right --cwd $PWD --no-focus` → `herdr pane rename <新 pane id> dev` → `herdr agent start dev --kind pi --pane <新 pane id>`；
3. 仍无 label `regression` → 以 dev pane 为基准 `herdr pane split <dev id> --direction down --cwd $PWD` → rename `regression` → 同法起 agent；
4. **label 即角色**：角色分配不靠口头约定，pane 标签就是合约，会话换人角色不变；
5. 互认：`intercom list` 核对三方可见；所有登记动作带 `--user agent`。

## 2. 角色与边界

| 角色 | 职责 | 不做 |
|------|------|------|
| 需求侧（主 pane） | 故事登记（使用者立场细化）、派工、**独立验收**、回填 `done_evidence`、结论落库、跨任务汇总 | 不碰 `src/`；不越权替实现侧写代码 |
| 实现侧（dev pane） | 读任务 `acceptance` → 实现 → 补测试 → 置 `review` → 交证据摘要；**独占 `src/` 写权限** | 不改包登记（汇总由需求侧统一落库，防双写）；不擅自 bump 版本、commit/push |
| 回归侧（regression pane） | dogfooding 回归迭代（验证参数 → 登记 → 修复 → 验证）、ISSUE/OPTIM/FIX 闭环、真实包维护操作 | 不做 story TASK 实现；跨线工作以派工消息为准 |
| 维护者（人类） | 拍板决策点（语义取舍、优先级、发布、push 授权） | —— |

**双写纪律**：讨论产生的新结论，由需求侧一次性落库；实现侧只改代码与自己的任务状态。同一时间同一包只允许一方写入。

## 3. 流程六步

```
① 登记 US（draft）          四段 content：背景与讨论 / 用户故事 / 需求拆分 / 验收口径
② 评审细化                  需求侧以「使用者立场」出细化稿 → 实现侧逐条回应（同意/反对+理由+发现的问题）
                           → 需求侧汇总回写故事 content（append-only 留痕）
③ 定稿拆分                  决策点由维护者拍板 → US 置 review → 拆 TASK（acceptance 必填，
                           GIVEN/WHEN/THEN 可复核断言）→ US approved（= 排期）
④ 实现                      逐任务派发：消息自包含（读哪个任务 + 实现要点 + 完成定义）
                           → 实现侧置 review + 证据摘要（文件清单 / API / 测试数 / 边界说明）
⑤ 独立验收                  需求侧不采信报告：独立复跑测试 + 源码抽查 + 自写冒烟
                           → 逐条对照 acceptance → 通过则回填 done_evidence + approved
⑥ 收尾                      技能/文档同步（技能新鲜度）→ 版本 bump → 回归包闭环登记 → 约定式提交推送
```

## 4. 关键纪律（每条都踩过坑）

1. **报告不采信，验收必独立**。实现侧的证据摘要只当索引，结论必须自己跑出来。本轮独立复核抓到：并行负载下 perf 假失败（ISSUE-023）、两次冒烟脚本自身 bug 误判产品（隔离复现后再下结论）。
2. **发现即登记，闭环消化**。lint 上线当天抓出回归包 14 处违反自身约定的历史欠账 → ISSUE-024 → FIX-014（逐条附推导证据）→ lint 清零。工具发现问题，就用项目的登记闭环修问题，不走口头通道。
3. **单一事实源，指针防漂移**。格式约定在 schema；验收明细在 `ext.done_evidence`；content `【验收记录】` 只放一行结论 + 指针。任何一份数据只允许一个权威位置，其余地方引用。
4. **语义取舍先登记再执行**。`fix.issues` 允许 `none`（无对应登记的历史维护性修复）这类裁决 → 先 OPTIM-020 记录语义，再改数据。
5. **拒绝静默**。实现侧发现需求方的计划盲区（如某组违规未被分派）→ 报备 + 按同一精神处理，不静默跳过、不擅自放宽规则。
6. **计划盲区双向兜底**。需求侧拆任务可能漏项，实现侧对「发现但未派发」的问题有报备义务，而不是等指令。
7. **边界问题抽象成契约**。踩到 macOS `/var` symlink 坑 → 不在两处各自修，抽共享 helper（`resolveSchemaFile`）并在后续任务指令中强制复用。
8. **派工消息自包含**。实现侧会话没有需求侧的上下文：每条派工带「读哪个任务（CLI 命令）+ 关键约束 + 完成定义 + 边界（什么不许做）」。
9. **回归独立成席，不阻塞 dev**。需要回归参加的工作（缺陷修复迭代、真实包维护、参数边界巡检）一律走 regression pane；dev 专注当前 story 任务。regression 忙线时登记可由需求侧代办、修复排队，不往 dev 里插队。
10. **外部/存量代码入仓：按项目合约迁移改造，不做机械合并**。合并式接入只会把外部布局假设（如兄弟目录 import、自带子包声明、风格偏差）带进仓库；迁移时逐项对照 AGENTS.md 合约（零依赖/ESM/错误契约/注释与风格），有偏差先改造再入包，文档同步改写为新入口。

## 5. 本轮战绩（为什么值得抄）

- 1 个故事 → 6 个任务全 approved，**零返工**（唯一计划盲区以报备补录方式消化）
- 测试基线 87 → 136；perf 假失败根因定位到「套件 CPU 总负载越过预算的确定性临界」（受控实验：stash 基线对照 4/4 复现）
- 新工具上线当天抓出 **14 处真实历史欠账**，并用项目自身的回归闭环消化——工具比散文可靠的最直接证明
- 版本 v1.5.5 → v1.6.0，5 个约定式提交，工作区 clean，远程同步

## 6. 快速上手清单（新团队照抄）

```text
[ ] 三会话就绪且互通（主 / dev / regression；intercom list 彼此可见，缺员按 §1.1 自举规则补建）
[ ] U 登记 US-0NN：四段 content 齐全（draft）
[ ] 出「使用者立场」细化稿 → 实现侧逐条评审 → 汇总回写 → 定稿 review
[ ] 维护者拍板决策点 → 拆 TASK-0NN（acceptance 数组、可复核断言）→ story approved
[ ] 逐任务循环：派发（自包含消息）→ 证据摘要 → 独立验收 → done_evidence → approved
    └─ content 验收记录只放一行结论 + 指针（明细在 ext.done_evidence）
[ ] 全部 task approved → 收尾：技能/文档同步、ISSUE/FIX 闭环、版本 bump
[ ] 提交：约定式前缀拆分（feat/test/docs/chore）→ 维护者授权后 push
```

## 7. 常见坑与处置

| 坑 | 处置 |
|---|---|
| content 占位符「（完成后回填）」忘同步 | 技能模版已改为「回填一行结论，明细指向 ext.done_evidence」 |
| 冒烟脚本自身 bug 误判产品缺陷 | 对照物必须与被测物同源（用自己的 schema 对自己的包）；初判失败先隔离复现再定性 |
| 并行测试下性能用例假失败 | `npm test` 已串行化（`--test-concurrency=1`，FIX-015）；性能预算属临界值时优先隔离而非放宽 |
| 同一文件拆多个提交 | 按 hunk 暂存（本轮 package.json 的 test-script 与 version 分属 test/chore 两提交） |
| 路径/symlink 类环境差异 | 第一次踩到就抽共享 helper，并在后续任务指令中显式要求复用 |
| Agent 会话丢上下文 | 派工消息永远自包含：任务号 + 读取命令 + 约束 + 完成定义 |
| 回归工作挤进 dev 会话 → 实现被阻塞、上下文串扰 | 回归迭代一律走 regression pane；跨线派工前先 `herdr agent list` 看忙闲 |

## 附：命令速查

```bash
# 故事包
U() { node bin/dtp.js "$@" --packet docs/user-stories.dtp --user <agent> --json; }
U query --tag task --ext story=US-0NN            # 某故事全部任务
U get taskNNN                                    # acceptance / done_evidence
U lint                                           # 模版符合性（零参数自动发现）

# 回归包
D() { node bin/dtp.js "$@" --packet docs/dtp-regression.dtp --user <agent> --json; }
D query --tag task --status review               # 待验收面

# 全局自检
node bin/dtp.js verify --packet docs/<包>.dtp    # 9 项结构校验
node bin/dtp.js tree --packet docs/<包>.dtp      # 骨架人工复核
```

---

*沉淀日期：2026-09-11 · 依据：US-002（task003–008，v1.6.0，commits 0c93d06..6e40564）*
