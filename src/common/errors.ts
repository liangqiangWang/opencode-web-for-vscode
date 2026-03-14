/**
 * 自定义错误类
 */

/**
 * OpenCode 启动超时错误
 */
export class OpenCodeTimeoutError extends Error {
  constructor(timeout: number) {
    super(`OpenCode start timeout after ${timeout}ms`);
    this.name = 'OpenCodeTimeoutError';
  }
}

/**
 * 工作区错误
 */
export class WorkspaceError extends Error {
  constructor(message: string) {
    super(`Workspace error: ${message}`);
    this.name = 'WorkspaceError';
  }
}
