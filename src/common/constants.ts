/**
 * OpenCode 插件常量定义
 */

// 配置键
export const CONFIG_KEYS = {
  PORT: 'opencode.port',
  TIMEOUT: 'opencode.timeout',
} as const;

// 默认配置值
export const DEFAULT_CONFIG = {
  PORT: 4099,
  TIMEOUT: 5000,
} as const;

// 终端名称
export const TERMINAL_NAME = 'opencode-TUI';
export const BACKGROUND_TERMINAL_NAME = 'opencode-daemon';

// HTTP 端点
export const API_ENDPOINTS = {
  HEALTH: '/global/health',
  APPEND_PROMPT: '/tui/append-prompt',
  SUBMIT_PROMPT: '/tui/submit-prompt',
} as const;

// 安装命令
export const INSTALL_COMMANDS = {
  WINDOWS: 'npm install -g opencode-ai',
  UNIX: 'npm install -g opencode-ai',
} as const;

// 检测命令
export const CHECK_COMMANDS = {
  WINDOWS: 'where opencode',
  UNIX: 'which opencode',
} as const;

// 启动参数
export const START_ARGS = {
  PORT: '--port',
  ATTACH: 'attach',
  DIR: '--dir',
} as const;

// Windows 特定命令
export const WINDOWS_COMMANDS = {
  // 方法1：使用 taskkill（跨 shell 兼容，PowerShell/cmd/bash 都支持）
  KILL_PROCESS_BY_PORT_TASKKILL: (port: number) =>
    `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`,
  // 方法2：使用 PowerShell 查找并终止进程（仅 PowerShell）
  KILL_PROCESS_BY_PORT_POWERSHELL: (port: number) =>
    `powershell -Command "try { $pid = (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess; if ($pid) { Stop-Process -Id $pid -Force } } catch {}"`,
  // 方法3：使用 Git Bash/WSL bash 语法
  KILL_PROCESS_BY_PORT_BASH: (port: number) =>
    `pid=$(lsof -ti:${port} 2>/dev/null || netstat -aon | findstr :${port} | awk '{print $5}' | head -1); if [ -n "$pid" ]; then taskkill //F //PID $pid 2>/dev/null || kill -9 $pid 2>/dev/null; fi`,
  // 检查 npm 全局包
  NPM_CHECK_GLOBAL: 'npm list -g opencode-ai --depth=0',
  // 获取 npm 前缀路径
  NPM_GET_PREFIX: 'npm config get prefix',
} as const;
