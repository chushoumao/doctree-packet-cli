# dtp — DocTree Packet CLI

[![CI](https://github.com/chushoumao/doctree-packet-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/chushoumao/doctree-packet-cli/actions/workflows/ci.yml)

树形结构化 · Append-Only 版本化 · JSONL 存储的文档数据包管理工具（Node.js 实现，**零运行时依赖**）。

面向三类使用者：

- **产品经理 / 需求分析师**：快速拆解需求树、更新内容、标记状态
- **Agent 系统**：作为底层存储引擎，`--json` 提供原子化读写与查询接口
- **DevOps**：纳入 CI/CD，用于自动化文档生成与合规检查（`verify` / `export` / `pack`）

```bash
# 无需安装依赖，克隆后直接使用
node bin/dtp.js init "智能客服系统" --packet ./客服系统.dtp

# 或链接为全局命令
npm link          # 之后可直接 dtp <命令>
```

要求 Node.js ≥ 18.17。

---

## 快速上手

### 安装

```bash
# 从本地 tarball 安装（当前推荐；发布后可直接 npm i -g doctree-packet-cli）
npm i -g doctree-packet-cli-<版本>.tgz

# 发布后的免安装用法（标注：npm 发布后生效，当前不可用）
# npx doctree-packet-cli init "智能客服系统"
```

安装后即得 `dtp` 命令；`--template user-stories|dtp-regression` 可释放内置模版，`dtp web` 打开可视化控制台。

### 上手

```bash
# 初始化项目（缺省落点 .dtp/，自动设为项目默认包）
dtp init "智能客服系统"

# 添加需求模块
dtp add n_root --id fr001 --title "FR-001 用户认证" --type requirement --tags auth,P0

# 细化子需求
dtp add fr001 --title "登录验证" --description "支持账号密码及验证码登录" --content "..."
dtp add fr001 --title "找回密码"

# 更新内容（自动版本递增 + changelog）
dtp update fr001 --content "新内容..." --ext priority=P0 --ext owner=张三 --user 张三

# 查询所有 P0 且状态为 approved 的需求
dtp query --tag P0 --status approved

# 语义路径定位
dtp get-path "/智能客服系统/FR-001 用户认证/登录验证"

# 变更历史 / 回滚
dtp history fr001
dtp checkout fr001 1

# 树形浏览
dtp tree

# 导出为 Markdown / HTML
dtp export n_root --format md > doc.md

# 打包为快照（支持 gzip）与解包
dtp pack --output ./v1.0.0.dtp.gz --gzip
dtp unpack ./v1.0.0.dtp.gz --packet ./restored.dtp

# 完整性校验 / 从备份恢复
dtp verify
dtp recover --from 1

# 可视化控制台（缺省工作区 .dtp/，自动开浏览器可加 --open）
dtp web
```

> 约定：省略 `--packet` 时按 `.dtp/config.json` 默认 → `./packet.dtp` 解析；`dtp init` 缺省落点 `.dtp/<名>.dtp`（首建自动设默认）。

---

## 命令一览

| 命令 | 说明 |
|------|------|
| `dtp init <name>` | 创建新数据包（生成根节点）。`--id` 自定义根 ID，`--version` 包版本，`--meta k=v` 包元数据，`--template <tpl>` 按模版派生骨架包：`user-stories`/`dtp-regression` 释放内置模版到包旁 `templates/`（保留字优先于本地同名文件），或 `<schema 路径>`，`--force` 覆盖 |
| `dtp add <parent>` | 添加子节点。`--title`（必填）`--type` `--description` `--content` `--tags` `--status` `--ext k=v` `--id` |
| `dtp update <node>` | 更新字段，自动递增版本并记录 changelog。`--title` `--description` `--content` `--status` `--tags`（整体替换）`--ext`；`--force` 允许覆盖已有扩展键 |
| `dtp rm <node>` | 删除节点及全部子孙（级联）。交互环境询问确认，脚本中需 `--yes` |
| `dtp mv <node> <newParent>` | 移动子树，路径索引自动更新（含成环检测） |
| `dtp ls [path]` | 列出直接子节点，`-r/--recursive` 递归列出子树 |
| `dtp tree [node]` | 树形打印，`--depth` 限深 |
| `dtp query` | 组合过滤：`--tag` `--type` `--status` `--ext k=v` `--keyword` `--path` `--limit` |
| `dtp get <node>` | 显示节点完整信息 |
| `dtp get-path <path>` | 通过语义路径获取节点 |
| `dtp history <node>` | 版本演进与变更历史（已删除节点亦可查看） |
| `dtp checkout <node> <version>` | 回滚到指定版本（以新增变更实现，不抹除历史） |
| `dtp export [node]` | 导出子树，`--format md\|html`，`--output` 写文件 |
| `dtp pack` | 打包快照（各节点最新版本 + 完整 changelog），`--gzip` 压缩 |
| `dtp unpack <file>` | 解包为可用数据包 |
| `dtp verify` | 校验哈希 / 父子引用 / 索引一致性 / 版本单调性等 9 项 |
| `dtp recover` | 列出或恢复备份（`--from n`） |
| `dtp web` | 启动可视化控制台（webui）：树浏览 / 查询 / 统计 / 校验 / 模版管理 / 编辑，与 CLI 共享引擎与文件锁。`--port` `--host` `--dir` `--open` |
| `dtp template new\|check\|bind` | 模版管理：`new` 生成 schema 骨架、`check` 自检（正则可编译 / 引用存在 / 无环）、`bind` 绑定到包（先自检，无效 schema 拒写） |
| `dtp lint` | 按绑定的模版 schema 校验包符合性（骨架 / 字段 / 引用 / 编号，只读）。零参数按包内绑定发现，`--schema <path>` 临时指定 |

**全局选项**（可放在任意位置）：`--packet <path>`（默认 `./packet.dtp`）、`--json`、`--pretty`、`--quiet`、`--user <name>`（默认取环境变量 `DTP_USER`）、`--help`、`--version`。

### 数据包模版（schema）

数据包格式约定的**单一事实源**是声明式 schema。工作流：`dtp template new` 生成骨架 → 编辑成自己的约定 → `dtp template check` 自检 → `dtp init --template` 派生建包（或 `dtp template bind` 绑定已有包）→ `dtp lint` 符合性校验。DSL 与 lint 规则完整说明见 **[docs/templates/README.md](docs/templates/README.md)**（权威文档，此处不展开）。

用 dtp 管理需求与回归登记的协作流程（需求侧 / 实现侧 / 回归侧三会话，故事与任务闭环）见 **[docs/playbook-story-collab.md](docs/playbook-story-collab.md)**。

### 节点引用规则

所有接受 `<node>` 的命令支持三种写法：

1. 完整 ID（`fr001` 或完整 UUID）
2. 唯一前缀（git 风格，如 `fr00`；歧义时报错并列出候选）
3. 语义路径（以 `/` 开头，如 `/智能客服系统/FR-001 用户认证`）

### 过滤语义

`query` 中同一维度多个取值为 **或**（`--tag P0 --tag P1` 命中任一），跨维度为 **与**。`--ext` 值先按 JSON 字面量解析（`--ext sprint=3` → 数字 3，`--ext flag=true` → 布尔），失败按原字符串比较。

---

## 存储格式（JSONL）

数据包是单一 JSONL 文件（约定扩展名 `.dtp`，亦接受 `.jsonl`；`.gz` 后缀透明解压）。每行一个 JSON 对象，按 `type` 分四类：

```jsonl
{"type":"packet_meta","packet_id":"pkt-...","name":"智能客服系统","version":"v1.0.0","created_at":"...","updated_at":"...","root_node_id":"n_root","metadata":{}}
{"type":"node","id":"n_root","parent_id":null,"node_type":"folder","title":"智能客服系统","description":"","content":"","extensions":{},"created_at":"...","updated_at":"...","version":1,"hash":"sha256...","tags":[],"status":"draft"}
{"type":"node","id":"fr001","parent_id":"n_root","node_type":"requirement","title":"FR-001 用户认证",...,"version":2,...}
{"type":"changelog","node_id":"fr001","field":"content","old_hash":"...","new_hash":"...","timestamp":"...","user":"张三","version":2}
{"type":"node_delete","id":"fr001","timestamp":"..."}
```

核心规则：

- **Append-Only**：所有写操作只追加行。节点更新 = 追加新的完整 `node` 行（同 id 后行覆盖前行）；删除 = 追加 `node_delete` 墓碑行。加载时重放全文件得到当前状态。
- **packet_meta**：惯例首行；每次写入会追加最新 meta 行（多行时**最后一个生效**），保持 append-only 同时让 `updated_at` 演进。
- **node_type / status**：小写枚举。`node_type ∈ folder | document | requirement | knowledge | index`；`status ∈ draft | review | approved | archived`（对应需求文档 Rust 版的 `NodeType`/`Status` 枚举）。
- **changelog.version**：该变更产生的节点版本号，供 `history` 精确关联（旧格式缺省时按时间戳兜底）。`*created` / `*deleted` / `*moved` / `*checkout` 为生命周期标记字段；扩展字段变更记为 `extensions.<key>`。
- **哈希**：`node.hash` 为内容字段（parent_id、node_type、title、description、content、tags、status、extensions）的 SHA-256，键序规范化——同内容必同哈希，`verify` 据此检测篡改。`changelog` 中的 old_hash/new_hash 为**字段值**的哈希。
- **崩溃安全**：末行残缺（写入中断）加载时告警跳过；中部损坏则拒绝。变更命令写入前自动轮换备份 `<packet>.bak.1..3`，写入经 `<packet>.lock` 文件锁互斥（陈旧锁自动检测回收）。
- **扩展字段 append-only**：`update --ext` 默认只允许新增键；修改已有键需显式 `--force`（删除键不支持）。
- **pack 快照**：仅保留各节点最新版本 + 完整 changelog（不含历史版本与墓碑），适合分发归档；`checkout` 旧版本需保留原始文件。

### 语义路径

以节点标题为段、`/` 分隔，从根节点标题开始：`/包名/模块/子项`。标题中的 `/` 以 `\/` 转义。路径索引在加载与每次结构变更后重建（O(1) 查询，同时维护 id→path 反查表供排序使用）。

---

## `--json` 输出（Agent 集成）

所有命令（含报错）支持结构化 JSON 输出，成功为 `{"ok":true,...}`，失败为 `{"ok":false,"error":{"code","message"}}`：

```bash
dtp query --tag P0 --json
# {"nodes":[{"id":"fr001","title":"FR-001 用户认证",...}],"count":1,"ok":true}

dtp get 不存在的节点 --json
# {"ok":false,"error":{"code":"NOT_FOUND","message":"节点不存在：不存在的节点"}}
```

常用错误码：`USAGE`（用法错误，退出码 2）、`NO_PACKET`、`NOT_FOUND`、`AMBIGUOUS_ID`、`NODE_DELETED`、`ID_EXISTS`、`EXT_IMMUTABLE`、`MOVE_CYCLE`、`VERSION_NOT_FOUND`、`LOCKED`、`STRUCTURE`、`CORRUPT_LINE`、`EXISTS`（退出码 2）、`INVALID_TYPE`、`INVALID_STATUS`（退出码 2）、`SCHEMA_INVALID`、`SCHEMA_DRIFT`、`TEMPLATE_MISSING`、`INTERNAL`。

退出码：`0` 成功；`2` 用法/文件已存在；`1` 其他错误；`verify` 发现问题时退出码为 `1` 且正常输出报告。

---

## 架构与开发

```
dtp/
├── bin/dtp.js            # 入口（shebang）
├── src/
│   ├── main.js           # 命令分发、上下文构造、退出码
│   ├── cli.js            # 零依赖参数解析器 + 帮助渲染
│   ├── packet.js         # Packet：核心操作（add/update/rm/mv/checkout）、索引重建
│   ├── storage.js        # JSONL 解析/追加、gzip、备份轮换、文件锁
│   ├── model/node.js     # 节点模型、枚举校验、内容哈希、--ext 解析
│   ├── path.js           # 语义路径（转义/解析/规范化）
│   ├── hash.js           # SHA-256、canonicalJson
│   ├── query.js          # 组合过滤引擎
│   ├── export.js         # Markdown / HTML 导出
│   ├── output.js         # 输出通道（--json/--quiet/--pretty）、终端表格与颜色
│   └── commands/         # 20 个子命令（每命令一文件）
└── test/                 # node:test 单元 + CLI 端到端 + 性能
```

设计要点：

- **单写多读**：读命令不加锁直接加载；变更命令持有文件锁完成「加载 → 内存变更 → 备份 → 单次 append 落盘」。
- **一次加载**：全量载入内存并重建派生索引（children / path↔id / tag / type / status），结构变更后重建；万级节点加载 < 500ms。
- **Rust 版对照**：serde ↔ JSON 内建、clap ↔ 自研解析器、sha2/chrono/uuid ↔ `node:crypto` 内建、anyhow ↔ `DtpError{code}`。
- **实现差异**（相对需求文档 Rust 稿）：枚举序列化为小写字符串；`*deleted` 变更的 `new_hash` 为 `null`（文档中为非空 `String`）；changelog 增加 `version` 关联字段；`node_delete` 墓碑行类型为文档未明确的删除语义给出落地方式。

```bash
npm test        # 136 个用例：单元 / 端到端 / 性能（10k 节点加载 <500ms、组合过滤 <100ms）
```

## 性能实测（Node 22，参考值）

| 指标 | 需求 | 实测 |
|------|------|------|
| 加载 10,000 节点（23.3 MB） | < 500ms | ~340ms |
| 组合过滤（tag+type+status+keyword） | < 100ms | ~10ms |
| ID 查询 / 路径查询 | O(1) | Map 直查 |

## 后续演进

远程存储（S3/Git）、HTTP API、分支/合并、AI 辅助（自动生成描述、标签推荐）——`extensions` 与 `metadata` 字段已为这些扩展预留空间，无需修改核心模型。

## 许可证

[MIT](./LICENSE)
