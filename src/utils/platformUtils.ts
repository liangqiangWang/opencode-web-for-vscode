/**
 * 平台工具函数
 */

/**
 * 判断是否为 Windows 系统
 */
export function isWindows(): boolean {
  return process.platform.includes('win32');
}

/**
 * 获取平台特定的 shell 选项
 * Windows 需要 shell: true 来查找 npm 安装的可执行文件
 */
export function getShellOption(): { shell: boolean } | {} {
  return isWindows() ? { shell: true } : {};
}

/**
 * 获取平台特定的命令扩展名
 */
export function getCommandExtension(): string {
  return isWindows() ? '.cmd' : '';
}
