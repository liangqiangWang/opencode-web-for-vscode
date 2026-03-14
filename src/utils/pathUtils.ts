import * as path from 'path';
import { isWindows } from './platformUtils';

/**
 * 路径工具函数
 */

/**
 * 规范化路径（统一使用正斜杠）
 */
export function normalizePath(filePath: string): string {
  return isWindows() ? filePath.replace(/\\/g, '/') : filePath;
}
