---
name: dtp
description: "使用 dtp（DocTree Packet CLI）在任意项目中创建、初始化与管理版本化文档数据包。当用户提到 dtp、文档包、数据包、.dtp 目录、dtp init/template/lint/web/enforce、需求管理、故事包、回归包、需求登记，或想把项目文档、需求、登记记录做成带版本台账与校验的数据包时使用本技能——即使用户没直接说出 dtp 这个名字，只要意图是把文档做成带版本与校验的数据包也应使用。"
---

# dtp 使用（DocTree Packet CLI ≥ v1.9）

dtp 把项目文档做成树形、append-only、可校验的 JSONL 数据包。数据统一落在项目相对目录 `.dtp/`，CLI 与 webui 共享同一引擎与文件锁。

## 前置检查

```bash
dtp --version        # ≥ v1.9.0；未装则先装（离线 tgz：npm i -g --offline doctree-packet-cli-1.9.0.tgz）
```

Agent 契约：所有命令支持 `--json`（单行 {"ok":true,...}；退出码 2=用法错误、1=业务错误）。脚本与多 Agent 编排一律加 `--json` 并解析 ok 字段。

节点引用三种写法：完整 ID / 唯一前缀 / `/语义路径`。

## 初始化（在项目根目录执行；数据落 .dtp/）

```bash
dtp init 我的文档包                          # 空壳包（.dtp/config.json 记录默认包）
dtp init 需求管理 --template user-stories    # 内置「用户故事」模版
dtp init 回归登记 --template dtp-regression  # 内置「回归登记」模版
dtp init X --template ./my.schema.json       # 自定义 schema
```

- **默认包 = 第一个 init 的包**（记录在 .dtp/config.json）；操作其他包必须显式 `--packet .dtp/<名>.dtp`
- 显式 `--packet` 是高级用法：完全不创建/依赖 .dtp/ 与 config（自管布局）
- 模版 schema 拷贝到 `.dtp/templates/`，可本地演进（不受工具升级影响）

## 日常命令

```bash
dtp tree                     # 树形浏览
dtp ls                       # 直接子节点
dtp get <节点>               # 详情（含版本/扩展）
dtp add <父引用> --title "标题" --type requirement --tags a,b --ext k=v --status draft --content "正文"
dtp update <节点> --title/--description/--content/--status/--tags/--ext   # ext 已有键覆盖需 --force
dtp mv <节点> <新父> / dtp rm <节点> --yes
dtp query --tag story --type requirement --status draft --ext priority=P1 --keyword 关键词 --parent <引用> --limit 20
dtp history <节点> / dtp checkout <节点> <版本号>
dtp export --format md|html --output 文件
dtp pack / dtp unpack        # 快照打包与还原
```

## 写路径校验（enforce）

包绑定了模版且 enforce 开启时，违规的 add/update 被**即时拒绝**：

```bash
dtp lint --packet .dtp/需求管理.dtp                     # 前置门：0 error 才能开
dtp template bind .dtp/templates/user-stories.schema.json --packet .dtp/需求管理.dtp --enforce
dtp template bind .dtp/templates/user-stories.schema.json --packet .dtp/需求管理.dtp --no-enforce   # 急修通道
```

- 拒绝时返回 `SCHEMA_VIOLATION`（exit 1）+ error.violations 逐条 {rule,message,hint}，包文件字节零变化
- **按 violations[].hint 修正后重写**即可；warn 级（如编号空洞）不拦截，随成功写入以 `schema_warnings` 透传
- 段标题（content_sections）**必须精确匹配**（如【需求拆分】），括注/修饰写进段内正文
- 未被任何规则认领的节点不拦截（非封闭容器）

## 可视化

```bash
dtp web --open    # http://127.0.0.1:4761；有 .dtp/config.json 的项目零参数直接用
```

## 集成与约定

- `.dtp/` 提交 git（数据包即项目文档资产）；`.dtp/*.bak.*` 自动轮换备份，加入 .gitignore
- 模版自定义：`dtp template new` 生成骨架 → `dtp template check` 自检 → `dtp template bind --enforce` 开启强制
- 多 Agent 协作（故事包/回归包/登记闭环）：见包内 docs/playbook-story-collab.md
- 模版 DSL 与规则全集：包内 docs/templates/README.md

## 常见坑（agent 必读）

- 段标题必须精确匹配（【需求拆分】），括注写段内正文——变体会被 content.sections 拒绝
- 默认包 = 第一个 init 的包；对其他包操作忘记 --packet 是最常见错误
- enforce 包的违规写入被拒时，先读 violations[].hint，不要盲目 --force/--no-enforce
- rm 不拦 ref_exists 悬挂（事后 lint 会报）；mv/checkout 未接入写路径校验
- 尚未发布 npm：安装走离线 tgz