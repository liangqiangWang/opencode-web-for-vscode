# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供项目指导。

## 项目概述

这是一个 VSCode 扩展，用于集成 OpenCode AI 助手到开发工作流中。该扩展在 VSCode 侧边栏提供 OpenCode Web 界面，支持启动/连接 OpenCode 服务，并能将选中的代码发送到 OpenCode 进行处理。

## 开发命令

### 构建和编译
```bash
# 安装依赖
npm install

# 开发模式编译
npm run compile

# 监听模式编译（开发时使用）
npm run watch

# 生产环境打包
npm run package

# 运行测试
npm test
```

### 发布准备
```bash
# VSCode 扩展发布前准备
npm run vscode:prepublish
```

## 项目架构

### 分层架构
项目采用清晰的分层架构模式：

**核心层（Core Layer）**
- `OpenCodeManager.ts` - OpenCode 进程管理器，负责启动、连接和交互
- `OpenCodeClient.ts` - HTTP 客户端，与 OpenCode 服务通信
- `EventManager.ts` - 事件管理器，组件间通信
- `types.ts` - 核心类型定义
- `eventTypes.ts` - 事件类型定义

**视图层（View Layer）**
- `webview/WebviewProvider.ts` - 侧边栏 Webview 提供者，显示 OpenCode Web 界面
- `webview/types.ts` - Webview 类型定义

**命令层（Command Layer）**
- `commands/appendCodeCommand.ts` - 追加代码命令
- `commands/webviewCommands.ts` - Webview 相关命令（打开浏览器、切换侧边栏、打开 TUI、进程管理、帮助、刷新）

**服务层（Service Layer）**
- `services/configuration.ts` - 配置服务，管理扩展设置

**工具层（Utils Layer）**
- `utils/pathUtils.ts` - 路径处理工具（仅保留 `normalizePath()`）
- `utils/platformUtils.ts` - 平台检测工具（仅保留 `isWindows()`）

**通用层（Common Layer）**
- `common/constants.ts` - 常量定义
- `common/errors.ts` - 自定义错误类（仅保留 `WorkspaceError` 和 `OpenCodeTimeoutError`）

### 关键组件交互

1. **插件激活流程**（extension.ts）
   - 初始化 ConfigurationService
   - 创建 OpenCodeManager 实例（传入 context）
   - 注册 WebviewProvider
   - 注册所有命令处理器

2. **OpenCode 管理器**（OpenCodeManager.ts）
   - 检查 OpenCode 安装状态（内嵌逻辑，未使用 InstallationService）
   - 启动新进程或连接到现有进程
   - 通过 HTTP 客户端与 OpenCode 服务通信
   - 使用统一方法 `createOpenCodeTerminal()` 创建终端（在右侧编辑器区域）
   - 管理文件引用和代码上下文
   - 通过 EventManager 触发事件通知其他组件

3. **Webview 提供者**（WebviewProvider.ts）
   - 在侧边栏显示 OpenCode Web 界面（通过 iframe）
   - 支持 WebviewView 和 WebviewPanel 两种显示模式
   - 检查安装状态和连接状态
   - 提供安装指南界面
   - 监听 EventManager 的事件来更新 UI

4. **命令处理**
   - `opencode-web.appendCode` - 发送选中代码到 OpenCode
   - `opencode-web.openInBrowser` - 在浏览器中打开
   - `opencode-web.toggleSidebar` - 切换侧边栏位置
   - `opencode-web.openTui` - 打开 TUI 终端（在右侧编辑器区域）
   - `opencode-web.killProcess` - 停止 OpenCode 进程
   - `opencode-web.restartProcess` - 重启 OpenCode 进程
   - `opencode-web.showHelp` - 显示帮助面板
   - `opencode-web.refreshWebview` - 刷新 Webview

## 重要配置

### VSCode 配置
在 `package.json` 中定义了两个配置项：
- `opencode.port`（默认：4099）- OpenCode 服务端口
- `opencode.timeout`（默认：5000）- 连接超时时间（毫秒）

### 构建配置
- **TypeScript**：使用 `tsconfig.json` 配置，输出目录为 `out/`
- **Webpack**：使用 `webpack.config.js`，输出目录为 `dist/`
- **入口文件**：`src/extension.ts`
- **输出文件**：`dist/extension.js`

### 依赖管理
主要依赖：
- `node-fetch` - HTTP 请求
- `@types/vscode` - VSCode API 类型定义
- `typescript` - TypeScript 编译器
- `webpack` - 模块打包器

## 开发注意事项

### 代码规范
- 使用 TypeScript 严格模式
- 遵循分层架构，保持职责分离
- 使用异步/等待模式处理异步操作
- 避免死代码，定期清理未使用的代码

### 错误处理
- 只保留实际使用的自定义错误类（`WorkspaceError` 和 `OpenCodeTimeoutError`）
- 通过 VSCode 的 `showErrorMessage` 显示用户友好的错误信息
- 在日志中记录详细的错误信息

### 配置管理
- 使用 `ConfigurationService` 单例管理配置
- 支持配置热更新（通过 `onDidChangeConfiguration` 监听）

### 事件驱动架构
- 使用 `EventManager` 进行组件间通信
- 避免组件间直接依赖
- 通过事件解耦，提高可维护性

### 终端管理
- 所有终端创建必须使用统一方法 `createOpenCodeTerminal()`
- 终端默认在右侧编辑器区域显示（`viewColumn: vscode.ViewColumn.Beside`）
- 终端名称统一为 `TERMINAL_NAME` 常量（'opencode-TUI'）
- 自动添加 OpenCode 图标和环境变量

### Webview 安全
- 使用 Content Security Policy 限制资源加载
- 只允许从 localhost 加载 OpenCode 服务
- 启用脚本支持但限制本地资源访问

## 调试技巧

### 查看 Webview 日志
打开 VSCode 输出面板，选择 "OpenCode Webview" 频道。

### 调试扩展
1. 按 F5 启动扩展开发主机
2. 在新窗口中测试扩展功能
3. 使用调试器设置断点

### 测试 OpenCode 连接
检查 `http://localhost:4099` 是否可访问。

## 测试

运行测试前需要先编译：
```bash
npm run test-compile
npm test
```

## 发布

使用 vsce 发布扩展：
```bash
npm install -g vsce
vsce publish
```

