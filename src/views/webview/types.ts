/**
 * OpenCode Webview 相关类型定义
 */

/**
 * Webview 消息类型 - 简化版本
 */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'startOpencode' }
  | { type: 'checkConnection' }
  | { type: 'setState'; state: string; message: string }
  | { type: 'openInBrowser' }
  | { type: 'toggleSidebar' }
  | { type: 'openTui' }
  | { type: 'showHelp' };

/**
 * Webview 回调函数接口
 */
export interface WebviewCallbacks {
  /** 在浏览器中打开回调 */
  onOpenInBrowser: () => void;
  /** 切换侧边栏位置回调 */
  onToggleSidebar: () => void;
  /** 打开 TUI 终端回调 */
  onOpenTui: () => void;
}

/**
 * Webview 提供者接口
 */
export interface IWebviewProvider {
  /** 在浏览器中打开 */
  openInBrowser(): void;
  /** 切换侧边栏位置 */
  toggleSidebar(): void;
  /** 刷新 webview */
  refresh(): void;
  /** 销毁资源 */
  dispose(): void;
}
