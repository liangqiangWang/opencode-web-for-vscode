/**
 * Webview 状态工具
 * 提供客户端状态持久化的判断逻辑，供扩展端与 Webview 端共用，
 * 避免内嵌在 HTML 中的判断逻辑与单元测试脱节。
 */

/**
 * 保存的状态有效期（毫秒）：5 分钟
 */
export const STATE_EXPIRY_MS = 300000;

/**
 * 不可持久化的临时状态
 * 这些状态是临时的，重新加载后必须重新检查，不能直接恢复
 */
export const INVALID_STATES = ['error', 'notInstalled', 'loading', 'restarting'] as const;

/**
 * 保存在 VSCode persistence 中的状态结构
 */
export interface SavedWebviewState {
  state: string;
  message: string;
  timestamp: number;
}

/**
 * 判断保存的状态是否有效（可恢复）
 * 规则：
 * 1. 状态为空 → 无效
 * 2. 状态为临时状态（error/notInstalled/loading/restarting）→ 无效
 * 3. 状态超过有效期（STATE_EXPIRY_MS）→ 无效
 */
export function isStateValid(savedState: SavedWebviewState | null | undefined): boolean {
  if (!savedState) {
    return false;
  }

  const age = Date.now() - savedState.timestamp;

  // 临时状态不恢复
  if ((INVALID_STATES as readonly string[]).includes(savedState.state)) {
    return false;
  }

  return age < STATE_EXPIRY_MS;
}
