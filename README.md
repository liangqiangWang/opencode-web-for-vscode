# OpenCode Web Integration

[![VSCode](https://img.shields.io/badge/VSCode-Extension-blue)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-4.x-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

**Languages:** **English** | [简体中文](README.zh-cn.md)

A VSCode extension that integrates OpenCode Web functionality into the sidebar.

## Features

- 🌐 **Multi-language Support**: Supports English, Simplified Chinese, Japanese, and Korean, automatically following VSCode interface language
- 🖥️ **Sidebar Integration**: Display OpenCode Web interface in VSCode sidebar
- 🚀 **Quick Launch**: Launch OpenCode directly from VSCode with a single command
- 📝 **Code Integration**: Send selected code snippets along with context to OpenCode TUI
- ⚙️ **Configurable**: Customize port and language settings
- 🔄 **Process Management**: Support restarting and stopping OpenCode processes

## Installation

### Prerequisites

1. Globally install [OpenCode](https://github.com/opencode-ai/opencode):
   ```bash
   npm install -g opencode-ai
   ```

2. Install this extension from VSCode Marketplace (search "OpenCode Web Integration")

## Usage

### Launch OpenCode

1. Use OpenCode Web in the left sidebar
   <img src="https://raw.githubusercontent.com/liangqiangWang/opencode-web-for-vscode/master/screenshot/side_view.png" width="600"/>

2. Use OpenCode Web in the editor area
   Besides the left sidebar, you can also display it in the editor area
   <img src="https://raw.githubusercontent.com/liangqiangWang/opencode-web-for-vscode/master/screenshot/main_web_view.png" width="600"/>

### Send Code to OpenCode TUI

1. Select code in the editor
2. Right-click and select `Append to OpenCode Terminal`
3. Selected code will be sent to OpenCode along with file context
   <img src="https://raw.githubusercontent.com/liangqiangWang/opencode-web-for-vscode/master/screenshot/send_data.png" width="600"/>

### Process Management

<img src="https://raw.githubusercontent.com/liangqiangWang/opencode-web-for-vscode/master/screenshot/en_us/menu_view.png" width="600"/>

In the sidebar toolbar:
- **Refresh Connection**: Refresh the OpenCode Web page
- **Open TUI Terminal**: Open terminal in the right editor area
- **More Actions**:
  - Open in Editor
  - Open in Browser
  - View Help
  - **Process Management**:
    - Restart Process
    - Stop Process

## Configuration

You can configure this extension in VSCode Settings:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `opencode.port` | number | `4099` | OpenCode server port |
| `opencode.timeout` | number | `5000` | Connection timeout (milliseconds) |
| `opencode.language` | string | `auto` | Interface language (`auto`/`en`/`zh-cn`/`ja`/`ko`) |

### Language Switching

The extension supports the following languages:
- **Auto**: Follow VSCode interface language
- **English (en)**
- **Simplified Chinese (zh-cn)**
- **Japanese (ja)**
- **Korean (ko)**

You can switch languages through:
1. Modify the `opencode.language` configuration in settings
2. Click the language switch button in the top-right corner of the Webview (when OpenCode is running)
3. Via the sidebar "More Actions" menu → "Change Language"

## License

MIT

## Support

For issues and feature requests, please visit the [GitHub repository](https://github.com/liangqiangWang/opencode-web-for-vscode).
