# 回归任务包模版

从真实 dogfooding 回归包 `docs/dtp-regression.dtp` 抽象出的可复用骨架。新建回归/缺陷跟踪任务时，复制 `dtp-regression.template.dtp` 即可开始，无需从零 `init`。

## 使用方式

```bash
# 1) 拷贝一份作为本次任务的实际数据包
cp docs/templates/dtp-regression.template.dtp  ./my-regression.dtp

# 2) 改包名（元数据 + 根节点标题），自举或直接编辑均可
#    推荐用 CLI：
node ./bin/dtp.js update tpl_root --title "我的回归任务" --packet ./my-regression.dtp

# 3) 逐条登记问题 / 建议 / 修复
node bin/dtp.js add f_issues  --title "ISSUE-001 标题" --type requirement --packet ./my-regression.dtp --ext severity=P2 --ext area=src/main.js --tags P2 --status draft
```

> 提示：模版中 `packet_id` 与各节点 `id` 已唯一，多个回归包可共存（id 仅在单包内约束）。

## 目录骨架

节点引用方式见包内 README：完整 ID / 唯一前缀 / 语义路径。

```
回归任务包 (root · folder)
├── 问题登记   (f_issues · folder)   缺陷，按发现顺序编号 ISSUE-NNN
├── 优化建议   (f_optim · folder)   非缺陷但值得改进的点 OPTIM-NNN
└── 修复登记   (f_fixlog · index)   每修复：根因/改动/验证  FIX-NNN
```

## 命名约定

| 目录 | 节点 type | 编号前缀 | 语义 |
|------|-----------|----------|------|
| 问题登记 | `requirement` | `ISSUE-###`，id `issue###` | 可复现的缺陷 |
| 优化建议 | `knowledge` | `OPTIM-###`，id `optim###` | 非缺陷的改进点（含"已确认非问题"的登记） |
| 修复登记 | `document` | `FIX-###`，id `fix###` | 每个修复的根因 / 改动 / 验证 |

- ID 用 `issue001`/`optim001`/`fix001` 风格，按序递增、补零，便于前缀寻址。
- 标题 = `编号 + 空格 + 一句摘要`，正文放 `description` / `content`。
- `status` 演进：`draft → review → approved`；暂缓/搁置用 `draft` + 标题注「（暂缓）」。

## 扩展字段（extensions）

| 键 | 建议值 | 说明 |
|----|--------|------|
| `severity` | `P0`–`P4` | 问题/建议优先级 |
| `area` | `src/…` 或模块名 | 问题所属模块 |
| `fixed_in` | `v1.2.0` | 计划/已修复版本 |
| `files` | `src/a.js,src/b.js` | 修复涉及文件 |
| `issues` | `ISSUE-001,ISSUE-002` | 该修复覆盖的问题编号 |

> `update --ext` 默认只允许新增键，修改已有键需显式 `--force`；删除键不支持（append-only）。

## 标签（tags）约定

- 冗余携带 `severity`（如 `P2`），便于 `query --tag P2` 组合过滤。
- 模块/能力标签（`cli`、`json`、`export`、`query`、`errmsg`、`io`、`integrity`、`write-path`、`ux`…）。
- 生命周期/结论标签（`fix`、`confirmed`）。自由扩展。

## content 体例

每个 ISSUE / OPTIM 的 `content` 建议用固定小节块（`【…】` 段），机器可扫、人类可读：

```text
问题登记（ISSUE）：
【复现】触发步骤 / 命令
【期望】正确行为
【实际】当前行为
【影响】损害面（阻断/契约破裂/排查成本）
【修复方向】一句话指引

优化建议（OPTIM）：
【现状】当前行为
【建议】改进点
【取舍】权衡 / 是否采纳
【验证】如何确认（对照组 / 用例）

修复登记（FIX）：
【根因】定位到的根因
【改动】具体改动点（文件 / 逻辑）
【验证】验证方式与结果（如 "49/49 测试全绿"）
```

## 自检

登记 / 修复完成后运行：

```bash
node bin/dtp.js verify --packet ./my-regression.dtp    # 9 项完整性校验
node bin/dtp.js tree  --packet ./my-regression.dtp     # 人工复核骨架
```
