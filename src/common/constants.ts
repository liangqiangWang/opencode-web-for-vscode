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
