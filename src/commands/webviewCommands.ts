/**
 * OpenCode Webview 相关命令注册
 */

import * as vscode from 'vscode';
import { OpencodeWebviewProvider } from '../views/webview/WebviewProvider';
import { OpenCodeManager } from '../core/OpenCodeManager';

/**
 * 注册 Webview 相关命令
 */
export function registerWebviewCommands(
  context: vscode.ExtensionContext,
  webviewProvider: OpencodeWebviewProvider,
  openCodeManager: OpenCodeManager
): void {
  // 在浏览器中打开
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.openInBrowser', () => {
      webviewProvider.openInBrowser();
    })
  );

  // 切换侧边栏
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.toggleSidebar', () => {
      webviewProvider.toggleSidebar();
    })
  );

  // 打开 TUI 终端
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.openTui', () => {
      openCodeManager.showTui();
    })
  );

  // 杀掉进程
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.killProcess', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        '确定要杀掉 OpenCode 进程吗？',
        { modal: true },
        '确定'
      );

      if (confirmed === '确定') {
        try {
          await openCodeManager.killProcess();
          // 事件系统会自动通知 WebviewProvider 更新状态
          // 不再需要显式的 showInformationMessage
        } catch (error) {
          vscode.window.showErrorMessage(`终止进程失败: ${error}`);
        }
      }
    })
  );

  // 重启进程
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.restartProcess', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        '确定要重启 OpenCode 进程吗？',
        { modal: true },
        '确定'
      );

      if (confirmed === '确定') {
        try {
          await openCodeManager.restartProcess();
          // 事件系统会自动通知 WebviewProvider 更新状态
          // 不再需要显式的 showInformationMessage
        } catch (error) {
          vscode.window.showErrorMessage(`重启进程失败: ${error}`);
        }
      }
    })
  );

  // 显示帮助
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.showHelp', () => {
      webviewProvider.showHelpPanel();
    })
  );

  // 刷新 Webview
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.refreshWebview', async () => {
      try {
        await webviewProvider.refreshWebview();
      } catch (error) {
        vscode.window.showErrorMessage(`刷新失败: ${error}`);
      }
    })
  );
}
