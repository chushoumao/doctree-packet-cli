# 数据包模版（声明式 schema）

数据包格式约定的**单一事实源**是声明式 schema（DSL v1）：

| 工作流 | 内置 schema（`--template` 保留字） |
|--------|----------------------------------|
| 用户故事 | `user-stories` |
| dogfooding 回归 | `dtp-regression` |

两份 schema 均随 npm 包分发：`dtp init <名> --template user-stories` 即释放派生（详见 `dtp init --help`）。

> ⚠️ **已退役**：`user-stories.template.dtp` 与 `dtp-regression.template.dtp` 保留为历史样例，**勿再拷贝使用**——骨架派生已由 `dtp init --template` 接管，且旧样例含示例业务节点，与现行「无示例节点」约定不一致。

## 标准工作流

```bash
# 1) 生成模版骨架（最小可跑示例 + comment 注释），编辑成自己的约定
dtp template new weekly
dtp template check weekly.schema.json        # 自检：正则可编译/引用存在/无环

# 2) 从模版建包（容器骨架自动建立，无示例业务节点，metadata.template 自动绑定）
dtp init "周报包" --packet weekly.dtp --template weekly.schema.json

# 3) 已有包绑定模版（先自检，无效 schema 拒写；升级 schema 后 re-bind 刷新记录）
dtp template bind weekly.schema.json --packet weekly.dtp

# 4) 符合性校验（只读；CI 或收尾自检）
dtp lint --packet weekly.dtp                 # 零参数按包内绑定发现
dtp lint --packet weekly.dtp --schema ./x.json   # 临时指定 schema
```

## DSL v1 速览

```jsonc
{
  "name": "weekly", "version": "1.0.0",
  "comment": "人类注释，校验与求值忽略",
  "skeleton": [ { "id": "f_items", "title": "条目池", "type": "folder", "description": "…", "tags": ["x"], "comment": "容器骨架" } ],
  "rules": [
    {
      "id": "item", "comment": "规则注释",
      "scope":  { "parent": "f_items" },          // 容器 id 或规则 id（后者=挂在该规则认领的节点下）
      "match":  { "id": "^item\\d{3}$", "title": "^ITEM-\\d{3}" },  // 认领谓词（id/title 任一命中，含挂错父检测）
      "id_pattern": "^item\\d{3}$", "title_pattern": "^ITEM-\\d{3} ",
      "ext_required": ["owner"], "ext_arrays": ["acceptance"],
      "tags_require": ["item"], "content_sections": ["【说明】"],
      "ref_exists": ["parent"], "status_evidence": { "approved": ["done_evidence"] },
      "numbering": { "title_prefix": "ITEM", "id_prefix": "item", "digits": 3 }
    }
  ]
}
```

- `comment` 键：顶层 / skeleton 条目 / 规则处合法，人类可读，求值忽略。
- 未被任何规则认领的节点 v1 放行（不做 closed 容器）；ext 类型只判 string 存在性与 array 数组性。
- `ref_exists`：ext 值与存活节点 id 或标题编号段（首个分隔符前 token）**全等**，不做模糊匹配。
- `content_sections`：段落标题**精确匹配**（`content.includes('【需求拆分】')`）——括注/修饰须写进段内正文；变体标题（`【需求拆分（草案）】`）不命中，这是刻意设计（段标题即契约本体，前缀匹配会放过「【需求拆分说明】」这类近似标题）。
- 编号连续性（warn 级）基于历史出现过的编号（含已删除节点，rm 不制造跳号噪音）。

## lint 规则命名空间（rule id）

`skeleton.missing` / `parent.container` / `id.pattern` / `title.pattern` / `ext.required` / `ext.arrays` / `tags.require` / `content.sections` / `ref_exists` / `status.evidence` / `id.continuity`(warn) / `packet.structure`；lint 层另有 `schema.drift`（版本演进 warn）与 `regex.runtime`（防御性兜底）。

## lint 三态与漂移语义

- 未绑定模版 → `TEMPLATE_MISSING` exit 1（可 `--schema` 临时指定）；
- 绑定文件丢失 / JSON 坏 → 快速失败（`TEMPLATE_MISSING` / `SCHEMA_INVALID`），不产生 violations；
- **版本不同 → `schema.drift` warn**（正常演进，message 带两版本，re-bind 后消失）；
- **同版本不同 sha256 → `SCHEMA_DRIFT` error**（同版本内容变更视为可疑）。

## 写路径强制校验（enforce）

绑定后可开启编辑时校验（`metadata.template.enforce`）：

| 命令 | 语义 |
|------|------|
| `dtp template bind <schema> --enforce` | 开启；**前置门**：包当前对该 schema 存在 error 级违规则拒绝（先 `dtp lint` 修数据） |
| `dtp template bind <schema> --no-enforce` | 显式关闭 |
| `dtp template bind <schema>`（不给 flag） | **保持现值**（首绑则不写该字段，元数据最小） |

行为：

- `add`/`update` 在**写入前**对候选节点终态跑其适用规则（`evaluateNode`，非全包 lint）；error 级违规 → `SCHEMA_VIOLATION`（exit 1，`error.violations` 逐条 rule/message/hint），**包文件字节零变化**。
- warn 级（`id.continuity`、`schema.drift`）不拦截；随成功写入以 `schema_warnings` 透传（人类模式打印 ⚠）。
- schema 三态与 lint 同源：文件丢失 `TEMPLATE_MISSING` / 非法 `SCHEMA_INVALID` / 同版本 sha 不符 `SCHEMA_DRIFT`（拒绝在校验不可信内容）；版本演进放行并附 `schema.drift` warn。
- CLI 与 webui 编辑 API 共用同一 enforcer（webui 的 `add`/`update` 同样被拒）。

已知限制（当前版本）：

- **`rm` 不拦 `ref_exists` 悬挂**：删除被引用的节点会产生悬空引用（lint 事后可查，写路径不拦——破坏性操作自身已有 `--yes` 门槛）。
- **`mv` / `checkout` 未接入**：移动可能造成 `parent.container` 违规、回滚可能恢复历史违规态，均属后续版本。
- **enforce 态 `add` 需原子带全必填字段**：这是「输入即受约束」的产品承诺，不是缺陷——中途补字段的写法在 enforce 包内会被拦（未开启则不受影响）。

逃生路径：先修数据（`dtp lint --packet <p>` 看逐条明细）或 `--no-enforce` 关闭；不提供按次跳过参数。

## 与旧模版的对应关系

旧 `.template.dtp` 的目录骨架 = schema 的 `skeleton`；旧散文约定（ISSUE/OPTIM/FIX、US/TASK 的编号、必填 ext、状态策略）= schema 的 `rules`。升级 schema 后记得 `dtp template bind` re-bind 并提交 schema 文件（包内 metadata 记录相对路径 + sha256）。
