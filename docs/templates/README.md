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
- 编号连续性（warn 级）基于历史出现过的编号（含已删除节点，rm 不制造跳号噪音）。

## lint 规则命名空间（rule id）

`skeleton.missing` / `parent.container` / `id.pattern` / `title.pattern` / `ext.required` / `ext.arrays` / `tags.require` / `content.sections` / `ref_exists` / `status.evidence` / `id.continuity`(warn) / `packet.structure`；lint 层另有 `schema.drift`（版本演进 warn）与 `regex.runtime`（防御性兜底）。

## lint 三态与漂移语义

- 未绑定模版 → `TEMPLATE_MISSING` exit 1（可 `--schema` 临时指定）；
- 绑定文件丢失 / JSON 坏 → 快速失败（`TEMPLATE_MISSING` / `SCHEMA_INVALID`），不产生 violations；
- **版本不同 → `schema.drift` warn**（正常演进，message 带两版本，re-bind 后消失）；
- **同版本不同 sha256 → `SCHEMA_DRIFT` error**（同版本内容变更视为可疑）。

## 与旧模版的对应关系

旧 `.template.dtp` 的目录骨架 = schema 的 `skeleton`；旧散文约定（ISSUE/OPTIM/FIX、US/TASK 的编号、必填 ext、状态策略）= schema 的 `rules`。升级 schema 后记得 `dtp template bind` re-bind 并提交 schema 文件（包内 metadata 记录相对路径 + sha256）。
