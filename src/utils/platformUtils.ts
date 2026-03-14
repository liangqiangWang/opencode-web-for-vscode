/**
 * 平台工具函数
 */

/**
 * 判断是否为 Windows 系统
 */
export function isWindows(): boolean {
  return process.platform.includes('win32');
}
