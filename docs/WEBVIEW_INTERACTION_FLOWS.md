# Webview 交互流程文档

## 目录

1. [页面类型](#页面类型)
2. [可用命令](#可用命令)
3. [状态流转图](#状态流转图)
4. [完整交互流程](#完整交互流程)
5. [自动刷新机制](#自动刷新机制)

---

## 页面类型

### 1. Ready 页面 (ready)

**UI 显示：**
- OpenCode webview iframe（全屏显示 OpenCode 界面）
- 右上角：语言切换浮动按钮（地球图标）

**按钮：**
- 语言切换按钮（右上角）

**状态：**
- `currentState = 'ready'`
- OpenCode 进程运行中
- HTTP 服务可访问

---

### 2. Error 页面 (error)

**UI 显示：**
- 错误图标（X 图标）
- 错误标题："OpenCode 未启动"
- 错误描述："OpenCode 服务未运行，请点击启动按钮启动服务"
- **启动按钮**（主要操作）

**按钮：**
- **启动按钮**：点击启动 OpenCode 进程

**状态：**
- `currentState = 'error'`
- OpenCode 未运行（已安装但未启动）
- 或进程已崩溃

---

### 3. NotInstalled 页面 (notInstalled)

**UI 显示：**
- 错误图标（X 图标）
- 错误标题："OpenCode 未安装"
- 错误描述："请先安装 OpenCode，然后在终端运行 'opencode' 命令"
- **帮助按钮**（主要操作）

**按钮：**
- **帮助按钮**：点击显示安装指南

**状态：**
- `currentState = 'notInstalled'`
- opencode 命令未安装
- 或不在 PATH 中

---

### 4. Loading 页面 (loading)

**UI 显示：**
- 加载动画（旋转的 spinner）
- 状态文本（动态变化）

**可能的文本：**
- "正在初始化..."
- "正在检查状态..."
- "正在启动..."
- "正在等待..."
- "正在刷新..."

**按钮：**
- 无（等待状态，不可操作）

**状态：**
- `currentState = 'initializing'` 或临时 loading 状态
- 系统正在执行某个操作
- 用户需要等待

---

### 5. Restarting 页面 (restarting)

**UI 显示：**
- 加载动画（旋转的 spinner）
- 状态文本："正在重启..."

**按钮：**
- 无（等待状态，不可操作）

**状态：**
- `currentState = 'restarting'`
- 进程正在重启
- 用户需要等待

---

## 可用命令

### 命令面板命令 (Ctrl+Shift+P)

| 命令 | 说明 | 触发条件 |
|------|------|----------|
| `OpenCode: Start` | 启动 OpenCode | Error 页面 |
| `OpenCode: Kill Process` | 停止 OpenCode 进程 | Ready 页面 |
| `OpenCode: Restart Process` | 重启 OpenCode 进程 | 任意状态 |
| `OpenCode: Refresh` | 刷新状态 | 任意状态 |
| `OpenCode: Toggle Sidebar` | 切换侧边栏位置 | 任意状态 |
| `OpenCode: Open in Browser` | 在浏览器中打开 | Ready 页面 |
| `OpenCode: Open TUI` | 打开 TUI 终端 | Ready/Error 页面 |

### Webview 内按钮

| 按钮 | 当前页面 | 行为 |
|------|---------|------|
| **启动按钮** | Error | 发送 `startOpencode` 消息 |
| **帮助按钮** | NotInstalled | 发送 `showHelp` 消息 |
| **语言切换** | Ready | 打开语言设置 |

---

## 状态流转图

```
┌────────────────────────────────────────────────────────────────────────┐
│                           状态流转图                                    │
└────────────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════════════════

[初始化/重载窗口]
        │
        ▼
┌───────────────┐
│ loading 状态   │
│ "正在初始化"  │
└───────┬───────┘
        │
        ├───── checkStatusWithTimeout (5 秒超时)
        │
        ▼
   ┌────────────┐
   │ 检查结果   │
   └─────┬────┘
        │
        ├─ Running ─────────────────────────┐
        │                                 │
        ▼                                 ▼
   [Ready 页面]                      [Error 页面]
        │                                 │
        │                                 ├─ 用户点击启动
        │                                 │
        │                                 ▼
        │                            [启动流程]
        │                            │
        │                            └─ 成功 → Ready
        │                            └─ 失败 → Error
        │
        ├─ NotRunning ─────────────────────┤
        │                                 │
        ▼                                 ▼
   [Error 页面]                      [Error 页面]
   (未运行)                           (进程崩溃)
        │
        ├─ NotInstalled ───────────────────┤
        │                                 │
        ▼                                 ▼
   [NotInstalled 页面]              [Error 页面]
   (未安装)                           (其他错误)

═══════════════════════════════════════════════════════════════════════════════

[Ready 页面] ─────用户点击停止─────→ [killProcess 流程]
                                           │
                                           ▼
                                    [检查状态]
                                    │
                                    ├─ 进程已停止 ─→ [Error 页面]
                                    │
                                    └─ 进程仍在运行 ─→ [Ready 页面]

═══════════════════════════════════════════════════════════════════════════════

[任意状态] ─────用户点击重启─────→ [restartProcess 流程]
                                           │
                                           ▼
                                    [显示 Restarting]
                                    │
                                    └─ [等待重启完成]
                                        │
                                        ▼
                                    [检查状态]
                                        │
                                        ├─ 成功 → [Ready 页面]
                                        │
                                        └─ 失败 → [Error 页面]

═══════════════════════════════════════════════════════════════════════════════

[任意状态] ─────用户点击刷新─────→ [refreshWebview 流程]
                                           │
                                           ▼
                                    [显示 Loading]
                                    │
                                    └─ [HTTP 健康检查]
                                        │
                                        ├─ 成功 → [Ready 页面]
                                        │
                                        └─ 失败 → [Error 页面]
```

---

## 完整交互流程

### 1. 启动流程

**触发条件**：在 Error 页面点击"启动按钮"

**状态变化：**
```
[Error 页面]
    ↓
[Loading 页面] (显示 "正在启动...")
    ↓
[调用 startInBackground()]
    ↓
[Loading 页面] (显示 "正在等待...")
    ↓
[healthCheckPolling()] (每 1 秒检查一次，最多 15 秒)
    │
    ├─ 成功 → [Ready 页面] (显示 OpenCode webview)
    │
    └─ 失败 → [Error 页面] (显示 "启动超时")
```

**关键代码位置：**
- [WebviewProvider.ts:375-405](src/views/webview/WebviewProvider.ts#L375) - `startOpenCode()`
- [WebviewProvider.ts:420-458](src/views/webview/WebviewProvider.ts#L420) - `healthCheckPolling()`

**是否会自动刷新：**
- ✅ **是**：通过 `healthCheckPolling()` 自动检查和切换状态

---

### 2. 停止流程

**触发条件**：在 Ready 页面通过命令面板执行"OpenCode: Kill Process"

**状态变化：**
```
[Ready 页面]
    ↓
[用户确认停止]
    ↓
[调用 killProcess()] (OpenCodeManager 终止进程)
    ↓
[调用 refreshWebview()] (主动检查状态)
    ↓
[HTTP 健康检查]
    │
    ├─ 成功 → [Ready 页面] (进程仍在运行)
    │
    └─ 失败 → [Error 页面] (进程已停止)
```

**关键代码位置：**
- [webviewCommands.ts:41-56](src/commands/webviewCommands.ts#L41) - `opencode-web.killProcess` 命令
- [WebviewProvider.ts:1085-1132](src/views/webview/WebviewProvider.ts#L1085) - `refreshWebview()`

**是否会自动刷新：**
- ✅ **是**：停止后自动调用 `refreshWebview()` 检查状态

---

### 3. 重启流程

**触发条件**：在任意状态通过命令面板执行"OpenCode: Restart Process"

**状态变化：**
```
[当前页面]
    ↓
[用户确认重启]
    ↓
[调用 restartProcess()] (OpenCodeManager 重启进程)
    │
    ├─ 终止旧进程
    ├─ 启动新进程
    │
    ↓
[调用 refreshWebview()] (主动检查状态)
    ↓
[HTTP 健康检查]
    │
    ├─ 成功 → [Ready 页面]
    │
    └─ 失败 → [Error 页面]
```

**关键代码位置：**
- [webviewCommands.ts:81-96](src/commands/webviewCommands.ts#L81) - `opencode-web.restartProcess` 命令
- [WebviewProvider.ts:1085-1132](src/views/webview/WebviewProvider.ts#L1085) - `refreshWebview()`

**是否会自动刷新：**
- ✅ **是**：重启后自动调用 `refreshWebview()` 检查状态

---

### 4. 刷新流程

**触发条件**：在任意状态通过命令面板执行"OpenCode: Refresh"

**状态变化：**
```
[当前页面]
    ↓
[Loading 页面] (显示 "正在刷新...")
    ↓
[HTTP 健康检查] (5 秒超时)
    │
    ├─ 成功 → [Ready 页面]
    │
    └─ 失败 → [Error 页面]
```

**关键代码位置：**
- [webviewCommands.ts:109-116](src/commands/webviewCommands.ts#L109) - `opencode-web.refreshWebview` 命令
- [WebviewProvider.ts:1085-1132](src/views/webview/WebviewProvider.ts#L1085) - `refreshWebview()`

**是否会自动刷新：**
- ✅ **是**：手动刷新，所以会刷新

---

### 5. 初始化流程

**触发条件**：打开侧边栏、重载窗口、首次加载

**状态变化：**
```
[Webview 可见]
    ↓
[检查持久化状态]
    │
    ├─ 有效且为 ready → [Ready 页面] (快速恢复)
    │
    └─ 无效或首次 → [发送 ready 消息]
        ↓
    [initializeWebview()] (带防抖，300ms)
        │
        ├─ NotInstalled → [NotInstalled 页面]
        │
        ├─ NotRunning → [Error 页面]
        │
        └─ Running → [Ready 页面]
```

**关键代码位置：**
- [WebviewProvider.ts:314-336](src/views/webview/WebviewProvider.ts#L314) - `resolveWebviewView()`
- [WebviewProvider.ts:357-433](src/views/webview/WebviewProvider.ts#L357) - `initializeWebview()`

**是否会自动刷新：**
- ✅ **是**：打开时自动检查状态并更新

---

### 6. 可见性变化流程

**触发条件**：用户切换侧边栏可见性（隐藏→显示）

**状态变化：**
```
[Webview 重新可见]
    ↓
[防抖 300ms]
    ↓
[initializeWebview()] (重新检查状态)
    │
    └─ [显示当前状态]
```

**关键代码位置：**
- [WebviewProvider.ts:294-301](src/views/webview/WebviewProvider.ts#L294) - `onDidChangeVisibility`

**是否会自动刷新：**
- ✅ **是**：重新可见时自动检查状态

---

## 自动刷新机制

### 何时自动刷新

| 操作 | 是否自动刷新 | 刷新方式 |
|------|-------------|---------|
| **启动** | ✅ 是 | `healthCheckPolling()` |
| **停止** | ✅ 是 | `refreshWebview()` |
| **重启** | ✅ 是 | `refreshWebview()` |
| **刷新** | ✅ 是 | `refreshWebview()` |
| **初始化** | ✅ 是 | `initializeWebview()` |
| **可见性变化** | ✅ 是 | `initializeWebview()` |
| **进程崩溃** | ❌ 否 | 需要手动刷新 |
| **网络断开** | ❌ 否 | 需要手动刷新 |

### 健康检查机制

**启动轮询 (healthCheckPolling)**
- **触发时机**：`startInBackground()` 返回后
- **检查间隔**：每 1 秒检查一次
- **最大次数**：15 次（最多 15 秒）
- **检查方式**：`checkConnection(2000)` - HTTP `/global/health` API

**直接刷新 (refreshWebview)**
- **触发时机**：停止、重启、刷新命令执行后
- **超时时间**：5 秒
- **检查方式**：`checkConnection(5000)` - HTTP `/global/health` API

**初始化检查 (initializeWebview)**
- **触发时机**：打开侧边栏、重载窗口
- **超时时间**：5 秒
- **检查方式**：`checkStatusWithTimeout()` → `getStatus()`

### HTTP 健康检查 API

根据 OpenCode 官方文档：

```http
GET /global/health
```

**响应：**
```json
{
  "healthy": true,
  "version": "0.1.0"
}
```

**实现位置**：
- [OpenCodeClient.ts:25-72](src/core/OpenCodeClient.ts#L25) - `checkHealth()` 方法
- 使用 `fetch()` 访问 `http://localhost:{port}/global/health`

---

## 状态持久化

### 持久化规则

| 状态 | 是否持久化 | 原因 |
|------|-----------|------|
| **ready** | ✅ 是 | 用户最常访问的状态，持久化可加快恢复 |
| **error** | ❌ 否 | 错误状态会变化，不应持久化 |
| **notInstalled** | ❌ 否 | 安装状态可能改变 |
| **loading** | ❌ 否 | 临时状态，不应持久化 |
| **restarting** | ❌ 否 | 临时状态，不应持久化 |

### 持久化有效期

- **有效期**：5 分钟（300,000 ms）
- **存储位置**：`vscode.setState()` (VSCode persistence API)
- **恢复时机**：重载窗口、关闭后重新打开

### 恢复逻辑

```javascript
function isStateValid(savedState) {
  if (!savedState) return false;
  
  const age = Date.now() - savedState.timestamp;
  
  // 排除临时状态
  const invalidStates = ['error', 'notInstalled', 'loading', 'restarting'];
  if (invalidStates.includes(savedState.state)) {
    return false;
  }
  
  // 检查有效期
  return age < STATE_EXPIRY_MS; // 5 分钟
}
```

---

## 边缘情况处理

### 1. 进程崩溃

**现象**：进程在运行时崩溃
**当前行为**：不会自动检测
**用户操作**：需要手动点击刷新
**未来改进**：可考虑添加定期心跳检查

---

### 2. 网络断开

**现象**：网络临时断开，导致健康检查失败
**当前行为**：显示错误状态
**用户操作**：手动刷新
**恢复机制**：网络恢复后手动刷新可恢复

---

### 3. 端口冲突

**现象**：端口被其他程序占用
**当前行为**：启动失败，显示超时
**用户操作**：手动停止占用端口的进程
**恢复机制**：手动刷新后可检测到状态变化

---

### 4. 快速切换

**现象**：用户快速切换侧边栏可见性
**处理方式**：300ms 防抖，避免频繁检查
**实现**：`visibilityChangeTimer`

---

### 5. 重载窗口

**现象**：用户按 Cmd+R 重载窗口
**处理方式**：
1. 检查 HTML 是否为空 → 重置 `isInitialized`
2. 重新生成 HTML 内容
3. 检查持久化状态是否有效
4. 恢复有效状态或重新初始化

---

## 调试技巧

### 查看日志

**Output 面板**：
- 打开方式：`Ctrl+Shift+P` → "Output: Show Output Views"
- 选择："OpenCode Webview"
- 查看实时日志

**Debug Console**：
- 打开方式：`Cmd+Shift+Y` 或 View → Run
- 查看 `[L10n]` 开头的语言相关日志
- 查看 console.log 输出

**Webview 控制台**：
- 打开方式：Help → Toggle Developer Tools
- 查看 Webview 端 JavaScript 日志
- 查看 HTTP 请求和响应

### 关键日志关键词

搜索以下关键词定位问题：

| 关键词 | 含义 |
|--------|------|
| `开始刷新 Webview` | 手动刷新触发 |
| `健康检查` | HTTP 健康检查 |
| `启动 OpenCode` | 启动流程 |
| `OpenCode 启动成功` | 启动命令成功 |
| `轮询检查` | 自动轮询检查 |
| `状态已更新为 ready` | 状态更新成功 |
| `setState` | UI 状态设置 |

### 调试命令

| 命令 | 功能 |
|------|------|
| `OpenCode: Debug Language Status` | 查看语言状态 |
| `OpenCode: Debug Status` | 诊断 OpenCode 状态 |
| `OpenCode: Debug Process Health` | 检查进程健康状态 |

---

## 总结

### 核心设计原则

1. **简单直接**：使用 HTTP 健康检查，不依赖复杂的事件系统
2. **用户控制**：所有操作都有明确的用户触发点
3. **可预测**：状态变化清晰，用户知道当前处于什么状态
4. **快速响应**：检查间隔短（1 秒），用户体验流畅
5. **容错性**：超时保护机制，避免永久卡在某个状态

### 状态转换

```
initializing (启动/检查中)
    ↓
┌─── ready (运行中)
│
└─── error (未运行/错误)
    │
    └─── notInstalled (未安装)
```

### 自动刷新总结

| 操作 | 自动刷新 | 延迟 | 检查方式 |
|------|---------|------|---------|
| 启动 | ✅ | 1-15 秒 | 轮询 |
| 停止 | ✅ | <1 秒 | HTTP 检查 |
| 重启 | ✅ | 启动时间 | HTTP 检查 |
| 刷新 | ✅ | <5 秒 | HTTP 检查 |
| 初始化 | ✅ | <5 秒 | 状态检查 |
| 可见性变化 | ✅ | 300ms | 状态检查 |
| 进程崩溃 | ❌ | - | 需手动刷新 |
| 网络断开 | ❌ | - | 需手动刷新 |
