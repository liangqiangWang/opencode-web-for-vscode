# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供项目指导。

## 项目概述

VSCode 扩展，用于集成 OpenCode AI 助手。在侧边栏提供 OpenCode Web 界面，支持启动/连接 OpenCode 服务，发送代码到 OpenCode 处理。

## 快速开始

```bash
npm install
npm run compile    # 开发模式
npm run watch      # 监听模式
npm run package    # 生产打包
```

## 项目架构

**分层架构**：
- **核心层**：`OpenCodeManager.ts`（进程管理）、`OpenCodeClient.ts`（HTTP 客户端）、`EventManager.ts`（事件系统）
- **视图层**：`WebviewProvider.ts`（侧边栏 Webview）
- **命令层**：`commands/`（各种命令处理器）
- **服务层**：`ConfigurationService.ts`（配置管理）

**关键流程**：
1. `extension.ts` 激活 → 创建 `OpenCodeManager` → 注册 `WebviewProvider` → 注册命令
2. `OpenCodeManager` 检查安装 → 启动进程 → HTTP 通信 → 触发事件更新 UI

## 核心设计原则

### 双终端架构

项目使用**双终端架构**分离进程管理和用户交互：

| 终端类型 | 名称 | 可见性 | 命令 | 生命周期 |
|---------|------|--------|------|---------|
| **后台终端** | `opencode-daemon` | 隐藏 | `opencode --port 4099` | 启动 → VSCode 关闭 |
| **TUI 终端** | `opencode-TUI` | 显示 | `opencode attach http://...` | 按需创建，可关闭 |

**关键特性**：
- ✅ 关闭 TUI 终端**不影响**后台进程
- ✅ 后台进程持续运行，Webview 始终可访问
- ✅ VSCode 关闭时自动清理后台终端

**实现代码**：
```typescript
// 创建后台终端（隐藏）
const terminal = vscode.window.createTerminal({
  name: BACKGROUND_TERMINAL_NAME,
  cwd: workspacePath,
  // 不指定 location = 隐藏
  env: { OPENCODE_CALLER: 'vscode' }
});
terminal.sendText('opencode --port 4099');
```

### 事件驱动架构

使用 `EventManager` 进行组件间通信，避免直接依赖：
- `ProcessStateChanged` - 进程状态变化
- `ConnectionChanged` - 连接状态变化
- `ProcessError` - 错误事件

## Windows 平台关键注意事项

### ⚠️ 跨 Shell 兼容性

**问题**：Windows 用户可能使用 **PowerShell、cmd、Git Bash、WSL** 等不同默认终端

**解决方案**：实现跨平台命令回退机制

#### 1. 安装检测（多方法回退）

```typescript
// 方法1a: where 命令（PowerShell/cmd）
await execAsync('where opencode', { timeout: 2000 });

// 方法1b: which 命令（Git Bash/WSL）
await execAsync('which opencode', { timeout: 2000, shell: true });

// 方法2: npm 全局包检查
await execAsync('npm list -g opencode-ai --depth=0');

// 方法3: 文件路径验证
const prefix = await execAsync('npm config get prefix');
const paths = [
  path.join(prefix, 'opencode.cmd'),
  path.join(prefix, 'opencode'),
  path.join(prefix, 'node_modules', '.bin', 'opencode.cmd')
];
// 检查文件是否存在
```

#### 2. 进程终止（跨 Shell 三层保险）

```typescript
// 按优先级尝试不同方法
const methods = [
  {
    name: 'taskkill (cmd)',
    command: `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`
  },
  {
    name: 'taskkill (PowerShell)',
    command: `powershell -Command "Stop-Process -Id $pid -Force"`
  },
  {
    name: 'bash/netstat',
    command: `pid=$(netstat -aon | findstr :${port} | awk '{print $5}' | head -1); taskkill //F //PID $pid`
  }
];

// 依次尝试，直到成功
for (const method of methods) {
  try {
    await execAsync(method.command, { timeout: 5000 });
    return true;
  } catch {
    continue; // 尝试下一个方法
  }
}
```

### 关键陷阱和解决方案

#### 陷阱 1：spawn .cmd 文件需要 shell: true

❌ **错误**：
```typescript
spawn('opencode.cmd', ['--version'], {}); // spawn EINVAL
```

✅ **正确**：
```typescript
spawn('opencode.cmd', ['--version'], { shell: true });
```

#### 陷阱 2：时序竞争 - onDidCloseTerminal 清空引用

❌ **错误**：
```typescript
this.backgroundTerminal.sendText('exit');
// 触发 onDidCloseTerminal → this.backgroundTerminal = undefined
if (this.backgroundTerminal) {  // false，跳过清理
  this.backgroundTerminal.dispose();
}
```

✅ **正确**：
```typescript
const terminal = this.backgroundTerminal;  // 保存到本地变量
terminal.sendText('exit');
// onDidCloseTerminal 不会影响本地变量
terminal.dispose();
this.backgroundTerminal = undefined;
```

#### 陷阱 3：terminal.dispose() 不保证进程终止

❌ **错误**：
```typescript
terminal.dispose();
// 进程可能还在运行
```

✅ **正确**（三层保险）：
```typescript
// 1. 优雅关闭
terminal.sendText('\x03');  // Ctrl+C
terminal.sendText('exit');
await sleep(2000);

// 2. 强制终止
terminal.dispose();

// 3. 系统命令确保
await execAsync('taskkill /F /PID <pid>');
```

#### 陷阱 4：多个 Webview 实例状态不同步

❌ **问题**：关闭编辑器 webview 后，左侧栏 webview 状态错误

✅ **解决**：监听 webviewPanel 生命周期
```typescript
this.webviewPanel.onDidChangeViewState(async () => {
  if (!this.webviewPanel?.active && this.webviewView) {
    await this.restoreWebviewState();  // 重新检测实际状态
  }
});

this.webviewPanel.onDidDispose(async () => {
  if (this.webviewView) {
    await this.restoreWebviewState();
  }
});
```

## Webview 初始化核心要点

### 关键字段（WebviewProvider）

- `isInitialized` - 避免重复初始化
- `initializationLock` - 防止并发初始化
- `initializationVersion` - 丢弃过期的状态更新
- `visibilityChangeTimer` - 防抖处理（300ms）

### 关键边界场景

#### 1. 重载窗口（Cmd+R）
```typescript
// HTML 被清空但 isInitialized 仍为 true
const isHtmlEmpty = !webviewView.webview.html;
if (isHtmlEmpty && this.isInitialized) {
  this.isInitialized = false;  // 重置
}
```

#### 2. TUI 终端被关闭
- ❌ **错误理解**：关闭 TUI = 进程停止
- ✅ **正确理解**：TUI 和后台进程独立，Webview 仍可访问

#### 3. 状态持久化
```javascript
// ✅ 可以持久化：ready
// ❌ 不持久化（临时）：loading, error, notInstalled, restarting

function isStateValid(savedState) {
  const invalidStates = ['error', 'notInstalled', 'loading', 'restarting'];
  if (invalidStates.includes(savedState.state)) {
    return false; // 临时状态，不恢复
  }
  return Date.now() - savedState.timestamp < STATE_EXPIRY_MS;
}
```

## 最佳实践

### ✅ 应该做的

1. **使用本地变量保存引用** - 避免事件监听器时序竞争
   ```typescript
   const terminal = this.backgroundTerminal;  // 保存引用
   ```

2. **多层检测机制** - 不依赖单一检测方法
   ```typescript
   try { method1 } catch { try { method2 } catch { method3 } }
   ```

3. **添加详细日志** - 使用分隔符和步骤标记
   ```typescript
   this.log('========== 开始 xxx ==========');
   this.log('[步骤1] ...');
   ```

4. **跨 Shell 兼容** - 提供多种命令回退
   ```typescript
   // PowerShell、cmd、bash 都要支持
   ```

5. **清理资源** - 在 deactivate() 中清理
   ```typescript
   export async function deactivate() {
     await openCodeManager.cleanup();
   }
   ```

### ❌ 不应该做的

1. **不要假设环境变量** - Node.js 的 PATH 可能与终端不同
2. **不要使用 detached 进程** - 会成为僵尸进程
3. **不要假设 terminal.dispose() 终止进程** - 需要系统命令确保
4. **不要持久化临时状态** - loading/error/notInstalled 不应持久化
5. **不要忽略 Windows 特殊性** - .cmd 文件需要 shell: true

## 调试技巧

### 查看日志
1. 打开输出面板：`Ctrl+Shift+P` → "Output: Show Output Views"
2. 查找关键标记：`========== 开始 xxx ==========`
3. 验证所有步骤日志是否完整

### 验证进程终止（Windows）
```powershell
# 检查端口占用
netstat -ano | findstr :4099
# 应该无输出

# 检查进程
tasklist | findstr node.exe
```

### 关键日志位置
- **初始化**：`[OpenCodeManager] 开始初始化 OpenCode`
- **Windows 检查**：`========== 开始 Windows 安装检查 ==========`
- **进程终止**：`========== 开始终止 OpenCode 进程 ==========`
- **跨 shell 尝试**：`[步骤4] 尝试方法: taskkill (cmd)`

## 相关文件

**核心实现**：
- [OpenCodeManager.ts](src/core/OpenCodeManager.ts) - 进程管理、终端创建、跨 shell 兼容
- [WebviewProvider.ts](src/views/webview/WebviewProvider.ts) - UI 状态管理、webview 生命周期
- [extension.ts](src/extension.ts) - 扩展激活/停用、清理逻辑

**配置**：
- [constants.ts](src/common/constants.ts) - 常量定义、跨 shell 命令
- [platformUtils.ts](src/utils/platformUtils.ts) - 平台检测工具

## 架构演进

**v1.0（spawn + detached）**：
- ❌ Windows 弹出控制台窗口
- ❌ 需要额外权限
- ❌ 僵尸进程问题

**v2.0（VSCode Terminal）**：
- ✅ 无控制台窗口
- ✅ 自动清理
- ✅ 跨 shell 兼容
- ✅ 代码量减少 65%

**关键改进**：使用 VSCode Terminal 替代 spawn，实现更简单、更可靠的进程管理。
