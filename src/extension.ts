import * as vscode from 'vscode';
import { OpenCodeManager } from './core/OpenCodeManager';
import { registerAllCommands } from './commands';
import { registerWebviewCommands } from './commands/webviewCommands';
import { OpencodeWebviewProvider } from './views/webview/WebviewProvider';
import { ConfigurationService } from './services/configuration';
import { l10n } from './l10n';

// 保存 OpenCodeManager 实例引用，用于 deactivate 清理
let openCodeManager: OpenCodeManager;

/**
 * 插件激活函数
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('OpenCode Integration extension is now active!');

  // 初始化 L10n（同步加载语言包）
  l10n.setContext(context);
  console.log('L10n initialized with language:', l10n.getLanguage());

  // 初始化配置服务
  const configService = ConfigurationService.getInstance();

  // 监听配置变化
  const configDisposable = configService.onDidChangeConfiguration(async (event) => {
    // 重新加载配置
    if (event.affectsConfiguration('opencode.port') ||
        event.affectsConfiguration('opencode.timeout')) {
      console.log('OpenCode configuration changed');
      // 可以在这里触发配置重新加载
    }

    // 监听语言配置变化
    if (event.affectsConfiguration('opencode.language')) {
      console.log('OpenCode language changed, reloading L10n');
      await l10n.reload();
      // 通知 webview 刷新
      vscode.commands.executeCommand('opencode-web.refreshWebview');
    }
  });
  context.subscriptions.push(configDisposable);

  // 创建核心管理器
  const manager = new OpenCodeManager(context);
  openCodeManager = manager;  // 保存引用

  // 创建 webview provider
  const webviewProvider = new OpencodeWebviewProvider(
    context,
    configService,
    manager,
    () => {
      // 在浏览器中打开回调
      const port = configService.getPort();
      vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
    },
    () => {
      // 切换侧边栏回调
      webviewProvider.toggleSidebar();
    },
    () => {
      // 打开 TUI 回调
      manager.showTui();
    }
  );

  // 注册 webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('opencodeWebview', webviewProvider)
  );

  // 注册所有命令
  registerAllCommands(context, manager);

  // 注册 webview 相关命令
  registerWebviewCommands(context, webviewProvider, manager);

  console.log('OpenCode Integration commands registered');
}

/**
 * 插件停用函数
 */
export async function deactivate() {
  console.log('OpenCode Integration extension is now deactivated!');

  // 清理后台终端（根据配置决定）
  if (openCodeManager) {
    const configService = ConfigurationService.getInstance();
    const shouldKill = configService.getKillOnExit();

    if (shouldKill) {
      await openCodeManager.cleanup();
      console.log('OpenCode process terminated on exit');
    } else {
      console.log('OpenCode process left running (killOnExit = false)');
    }
  }
}
