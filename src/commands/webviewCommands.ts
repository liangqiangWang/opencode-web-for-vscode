/**
 * OpenCode Webview 相关命令注册
 */

import * as vscode from 'vscode';
import { OpencodeWebviewProvider } from '../views/webview/WebviewProvider';
import { OpenCodeManager } from '../core/OpenCodeManager';
import { l10n } from '../l10n';

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
        l10n.t('message.killConfirm'),
        { modal: true },
        l10n.t('button.confirm')
      );

      if (confirmed === l10n.t('button.confirm')) {
        // 显示操作中提示
        vscode.window.showInformationMessage(l10n.t('message.killInProgress'));

        try {
          await openCodeManager.killProcess(true, true);
          // 主动刷新状态以反映进程已终止
          await webviewProvider.refreshWebview();
        } catch (error) {
          vscode.window.showErrorMessage(l10n.t('message.killFailed', String(error)));
        }
      }
    })
  );

  // 强制终止所有 opencode 进程（调试用）
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.killAllProcesses', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        '确定要强制终止所有 opencode 进程吗？这会终止所有运行中的 opencode 实例。',
        { modal: true },
        '确定'
      );

      if (confirmed === '确定') {
        try {
          const killedCount = await openCodeManager.killAllOpenCodeProcesses();
          vscode.window.showInformationMessage(`已终止 ${killedCount} 个 opencode 进程`);
        } catch (error) {
          vscode.window.showErrorMessage(`终止失败: ${error}`);
        }
      }
    })
  );

  // 重启进程
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.restartProcess', async () => {
      const confirmed = await vscode.window.showWarningMessage(
        l10n.t('message.restartConfirm'),
        { modal: true },
        l10n.t('button.confirm')
      );

      if (confirmed === l10n.t('button.confirm')) {
        // 显示操作中提示
        vscode.window.showInformationMessage(l10n.t('message.restartInProgress'));

        try {
          await openCodeManager.restartProcess();
          // 主动刷新状态以反映重启结果
          await webviewProvider.refreshWebview();
        } catch (error) {
          vscode.window.showErrorMessage(l10n.t('message.restartFailed', error));
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

  // 问题反馈
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.reportIssue', () => {
      vscode.env.openExternal(vscode.Uri.parse('https://github.com/liangqiangWang/opencode-web-for-vscode/issues'));
    })
  );

  // 刷新 Webview
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.refreshWebview', async () => {
      try {
        await webviewProvider.refreshWebview();
      } catch (error) {
        vscode.window.showErrorMessage(l10n.t('message.refreshFailed', error));
      }
    })
  );

  // 切换语言
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.changeLanguage', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'opencode.language');
    })
  );

  // 调试：显示当前语言状态
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.debugLanguage', () => {
      const config = vscode.workspace.getConfiguration('opencode');
      const userLanguage = config.get<string>('language');
      const vscodeLang = vscode.env.language;
      const currentLang = l10n.getLanguage();
      const sampleTranslation = l10n.t('status.checkingStatus');

      const message = `
Language Debug Info:
- User config (opencode.language): ${userLanguage}
- VSCode display language: ${vscodeLang}
- Current active language: ${currentLang}
- Sample translation "status.checkingStatus": ${sampleTranslation}
      `.trim();

      console.log(message);
      vscode.window.showInformationMessage(message);
    })
  );

  // 调试：诊断 OpenCode 状态
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.debugStatus', async () => {
      const config = vscode.workspace.getConfiguration('opencode');
      const port = config.get<number>('port', 4099);
      const timeout = config.get<number>('timeout', 5000);

      let diagnosis = `
=== OpenCode Status Diagnosis ===
配置:
- 端口: ${port}
- 超时: ${timeout}ms

检查进程状态...
      `.trim();

      try {
        // 检查进程状态
        const status = await openCodeManager.getStatus();
        diagnosis += `\n✓ 进程状态: ${status}`;

        // 检查健康状态
        diagnosis += `\n检查健康状态...`;
        const healthStart = Date.now();
        const isHealthy = await openCodeManager.checkConnection(timeout);
        const healthTime = Date.now() - healthStart;

        diagnosis += `\n✓ 健康检查: ${isHealthy ? '成功' : '失败'} (${healthTime}ms)`;

        // 检查端口占用
        diagnosis += `\n\n检查端口占用...`;
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        try {
          if (process.platform === 'win32') {
            const { stdout } = await execAsync(`netstat -aon | findstr :${port}`, { timeout: 2000 });
            diagnosis += `\n✓ 端口 ${port} 占用情况:\n${stdout || '(无)'}`;
          } else {
            const { stdout } = await execAsync(`lsof -i :${port}`, { timeout: 2000 });
            diagnosis += `\n✓ 端口 ${port} 占用情况:\n${stdout || '(无)'}`;
          }
        } catch (error) {
          diagnosis += `\n✓ 端口 ${port} 未被占用`;
        }

        diagnosis += `\n\n=== 诊断完成 ===`;

        console.log(diagnosis);
        vscode.window.showInformationMessage('诊断完成，请查看控制台和输出面板');

      } catch (error) {
        diagnosis += `\n✗ 诊断失败: ${error}`;
        console.error(diagnosis);
        vscode.window.showErrorMessage(`诊断失败: ${error}`);
      }
    })
  );

  // 调试：强制设置 ready 状态（绕过初始化流程）
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.forceReady', async () => {
      try {
        console.log('[Debug] 强制设置 ready 状态');

        // 直接调用 WebviewProvider 的内部方法（如果可访问）
        // 或者通过事件系统触发状态更新
        const { getEventManager } = await import('../core/EventManager');
        const { OpenCodeStatus } = await import('../core/types');
        const eventManager = getEventManager();

        eventManager.emitProcessStateChanged({
          status: OpenCodeStatus.Running,
          timestamp: Date.now()
        });

        eventManager.emitConnectionChanged({
          connected: true,
          timestamp: Date.now()
        });

        vscode.window.showInformationMessage('已强制设置 ready 状态');
      } catch (error) {
        vscode.window.showErrorMessage(`强制设置失败: ${error}`);
      }
    })
  );

  // 调试：检查进程健康状态
  context.subscriptions.push(
    vscode.commands.registerCommand('opencode-web.debugProcessHealth', async () => {
      try {
        const config = vscode.workspace.getConfiguration('opencode');
        const port = config.get<number>('port', 4099);

        let diagnosis = `
========== OpenCode 进程健康诊断 ==========
端口: ${port}
        `.trim();

        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        // 检查端口占用
        diagnosis += `\n\n1. 端口占用检查:`;
        try {
          if (process.platform === 'win32') {
            const { stdout } = await execAsync(`netstat -aon | findstr :${port}`, { timeout: 2000 });
            if (stdout.trim()) {
              diagnosis += `\n✓ 端口 ${port} 被占用:\n${stdout}`;
            } else {
              diagnosis += `\n✗ 端口 ${port} 未被占用`;
            }
          } else {
            const { stdout } = await execAsync(`lsof -i :${port}`, { timeout: 2000 });
            if (stdout.trim()) {
              diagnosis += `\n✓ 端口 ${port} 被占用:\n${stdout}`;

              // 提取 PID
              const lines = stdout.trim().split('\n');
              if (lines.length > 1) {
                const parts = lines[1].trim().split(/\s+/);
                if (parts.length >= 2) {
                  const pid = parts[1];
                  diagnosis += `\n  进程 PID: ${pid}`;

                  // 检查进程详情
                  try {
                    const { stdout: psOutput } = await execAsync(`ps -p ${pid} -o pid,ppid,comm,stat,time`, { timeout: 2000 });
                    diagnosis += `\n  进程详情:\n  ${psOutput.trim().replace(/\n/g, '\n  ')}`;
                  } catch (psError) {
                    diagnosis += `\n  ⚠️ 无法获取进程详情 (进程可能已退出)`;
                  }

                  // 检查进程 CPU 和内存使用
                  try {
                    const { stdout: topOutput } = await execAsync(`ps -p ${pid} -o %cpu,%mem`, { timeout: 2000 });
                    diagnosis += `\n  资源使用: ${topOutput.trim()}`;
                  } catch (topError) {
                    // 忽略
                  }
                }
              }
            } else {
              diagnosis += `\n✗ 端口 ${port} 未被占用`;
            }
          }
        } catch (error) {
          diagnosis += `\n✗ 端口检查失败: ${error}`;
        }

        // 检查 HTTP 健康端点
        diagnosis += `\n\n2. HTTP 健康检查:`;
        try {
          const fetch = require('node-fetch');
          const healthUrl = `http://localhost:${port}/global/health`;
          const response = await fetch(healthUrl, { method: 'GET', timeout: 2000 });
          diagnosis += `\n✓ 健康检查成功: ${response.status} ${response.statusText}`;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          diagnosis += `\n✗ 健康检查失败: ${errorMessage}`;
        }

        // 检查终端状态
        diagnosis += `\n\n3. 后台终端检查:`;
        const backgroundTerminals = vscode.window.terminals.filter(
          t => t.name === 'opencode-daemon'
        );
        if (backgroundTerminals.length > 0) {
          diagnosis += `\n✓ 后台终端存在 (${backgroundTerminals.length} 个)`;
        } else {
          diagnosis += `\n✗ 后台终端不存在`;
        }

        diagnosis += `\n\n========== 诊断完成 ==========`;

        console.log(diagnosis);
        vscode.window.showInformationMessage('进程健康诊断完成，请查看控制台');

      } catch (error) {
        console.error('进程健康诊断失败:', error);
        vscode.window.showErrorMessage(`诊断失败: ${error}`);
      }
    })
  );
}
