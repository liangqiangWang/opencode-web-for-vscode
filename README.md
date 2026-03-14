# OpenCode Web Integration

[![VSCode](https://img.shields.io/badge/VSCode-Extension-blue)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.x-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

一款用可以在侧边栏使用 OpenCode web 功能的 VSCode 扩展。

## 特性

- 🖥️ **侧边栏集成**：在 VSCode 侧边栏显示 OpenCode Web 界面
- 🚀 **快速启动**：通过单个命令直接从 VSCode 启动 OpenCode
- 📝 **代码集成**：将选中的代码片段连同上下文一起发送到 OpenCode TUI
- ⚙️ **可配置**：自定义端口
- 🔄 **进程管理**：支持重启和停止 OpenCode 进程

## 安装

### 前置要求

1. 全局安装 [OpenCode](https://github.com/opencode-ai/opencode)：
   ```bash
   npm install -g opencode-ai
   ```

2. 从 VSCode 市场安装此扩展（搜索 "OpenCode Web Integration"）

## 使用

### 启动 OpenCode

1. 左侧栏使用 OpenCode Web
<img src="https://raw.githubusercontent.com/liangqiangWang/opencode-web-for-vscode/master/screenshot/side_view.png" width="600"/>

2. 在编辑器区域使用 OpenCode Web
除了左侧栏，也可以在编辑器区域显示
<img src="https://raw.githubusercontent.com/liangqiangWang/opencode-web-for-vscode/master/screenshot/main_web_view.png" width="600"/>

### 发送代码到 OpenCode TUI 输入框
1. 在编辑器中选择代码
2. 右键点击并选择 `添加到 OpenCode 终端`
3. 选中的代码将连同文件上下文一起发送到 OpenCode
<img src="https://raw.githubusercontent.com/liangqiangWang/opencode-web-for-vscode/master/screenshot/send_data.png" width="600"/>

### 进程管理

<img src="https://raw.githubusercontent.com/liangqiangWang/opencode-web-for-vscode/master/screenshot/menu_view.png" width="600"/>

在侧边栏顶部工具栏：
- **刷新连接**：刷新 OpenCode Web 页面
- **打开 TUI 终端**：在右侧编辑器区域打开终端
- **更多操作**：
  - 在编辑器中打开
  - 在浏览器中打开
  - 查看帮助
  - **进程管理**：
    - 重启进程
    - 停止进程

## 配置

你可以在 VSCode 设置中配置此扩展：

| 设置 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `opencode.port` | number | `4099` | OpenCode 服务器端口 |
| `opencode.timeout` | number | `5000` | 连接超时时间（毫秒） |



## 许可证

MIT

## 支持

如有问题和功能建议，请访问 [GitHub 仓库](https://github.com/liangqiangWang/opencode-web-for-vscode)。

