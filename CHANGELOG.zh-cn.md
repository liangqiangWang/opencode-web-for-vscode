# Changelog

## [0.1.6] - 2026-08-05
### 新增功能
- 新增 node:test + vscode mock 单元测试基础设施（无新增依赖），覆盖 Webview 加载状态切换与判断，共 70 个用例
- 抽取 stateUtils 共享 Webview 状态持久化判断逻辑，扩展端 / Webview 端 / 单测共用同一套判断标准

### 修复
- 切换侧边栏不再重载已加载的 webview（retainContextWhenHidden + ready 状态静默健康检查）

---

## [0.1.4] - 2026-06-07
### 新增功能
- 右键菜单不再需要选中文本（命令本已支持）
- appendCode 添加行号信息
- 新增终端启动延迟配置项
- webview/浏览器打开 opencode web 时以工作区根目录为项目目录

### 修复
- 修复配置键迁移遗漏，统一使用 opencode-web 命名空间

---

## [0.1.3] - 2025-06-07
### 新增功能
- 新增关闭 VSCode 时是否终止 OpenCode 进程的配置（`opencode-web.killOnExit`）
- 侧边栏新增设置菜单，可快速访问扩展配置
- 支持检测并连接外部已运行的 OpenCode 进程（修改端口号匹配外部进程即可）
- 自动从旧版 `opencode.*` 配置键迁移至 `opencode-web.*`

### 重构
- 重命名配置键从 `opencode` 到 `opencode-web`，并添加自动迁移逻辑

---

## [0.1.2] - 2025-05-23
### 功能
- 多语言支持（英文、中文、日语、韩语）

### 重构
- 重构 WebviewProvider 架构

---

## [0.1.1] - 初始版本

### 功能
- VSCode 终端集成 OpenCode 进程管理
- 双终端架构（后台守护进程 + TUI 终端）
- 跨 Shell 兼容性（PowerShell、cmd、Git Bash、WSL）
- Webview 面板支持侧边栏和编辑器视图
- 语言切换功能
- 语言状态和进程健康调试命令
- 进程健康监控和调试工具

---