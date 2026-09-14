# dtp Web UI（可视化控制台）

零依赖（node:* only）的液态玻璃风控制台：树浏览、查询、统计、校验、模版管理与编辑，直接复用仓库 `src/` 引擎（Packet / withLock / filterNodes / export / template / lint），与 CLI 共享同一数据文件与文件锁——界面改的就是 CLI 看到的。

## 启动

```bash
dtp web                # 工作区自动解析：DTP_WORKSPACE > .dtp/（有 config.json 时）
dtp web --open         # 启动后自动开浏览器（默认不开）
dtp web --port 4762    # 换端口（默认 127.0.0.1:4761，仅本机访问）
dtp web --dir ./docs   # 显式指定工作区目录（目录内 *.dtp 全部可见）
```

无工作区时启动会报错并指引 `dtp init` 建包；端口被占会明确提示旧实例占用。

## 开发直跑

```bash
node webui/server.js   # 等价 dtp web；HOST/PORT/DTP_WORKSPACE 环境变量生效
```

## 结构

- `server.js` — HTTP 服务：`public/` 静态文件 + `/api/*` JSON API；`export start({host, port, workspace})` 供 `dtp web` import 直启
- `api.js` — API 层：工作区注入式（`configureWorkspace`），响应形状遵循 CLI `--json` 契约 `{ok:true,...} / {ok:false,error:{code,message}}`；读路径带 (mtime,size) 缓存，写路径锁内直读
- `public/` — 前端（原生 JS，无构建）
- API 冒烟回归：`test/webui-api.test.js`（随主测试套件 `npm test` 运行）

> 本目录随 npm 包分发；`gui-test-screenshots/` 为开发截图存档，不参与分发。
