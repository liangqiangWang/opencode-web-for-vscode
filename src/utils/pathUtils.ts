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

/**
 * URL-safe base64 编码
 * 将标准 base64 转换为 URL-safe 格式（替换 +/ 为 -_，去掉 = 填充）
 */
export function urlSafeBase64Encode(data: string): string {
  return Buffer.from(data, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 将文件系统路径编码为 URL-safe base64 格式
 * 路径统一使用正斜杠后编码
 */
export function encodePathForUrl(filePath: string): string {
  return urlSafeBase64Encode(normalizePath(filePath));
}
