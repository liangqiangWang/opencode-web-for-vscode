/**
 * OpenCode 核心类型定义
 */

/**
 * OpenCode 配置选项
 */
export interface OpenCodeConfig {
  /** 默认端口 */
  defaultPort: number;
  /** 健康检查超时时间（毫秒） */
  healthCheckTimeout: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 重试间隔（毫秒） */
  retryInterval: number;
}

/**
 * OpenCode 进程状态
 */
export enum OpenCodeStatus {
  /** 未安装 */
  NotInstalled = 'not_installed',
  /** 未运行 */
  NotRunning = 'not_running',
  /** 运行中 */
  Running = 'running',
  /** 重启中 */
  Restarting = 'restarting',
  /** 错误 */
  Error = 'error',
}

/**
 * 文件引用信息
 */
export interface FileReference {
  /** 完整引用字符串 @path#L1-L10 */
  reference: string;
  /** 相对路径 */
  relativePath: string;
  /** 绝对路径 */
  absolutePath: string;
  /** 起始行号 */
  startLine?: number;
  /** 结束行号 */
  endLine?: number;
  /** 选中的文本内容 */
  selectedText?: string;
}

/**
 * OpenCode 项目信息
 */
export interface OpenCodeProject {
  /** 项目 ID */
  id: string;
  /** 项目名称 */
  name: string;
  /** 项目路径 */
  path: string;
  /** 其他属性 */
  [key: string]: any;
}

/**
 * Session 信息
 */
export interface OpenCodeSession {
  /** Session ID */
  id: string;
  /** 创建时间 */
  createdAt: number;
  /** 其他属性 */
  [key: string]: any;
}
