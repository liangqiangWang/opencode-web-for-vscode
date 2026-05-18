/**
 * OpenCode Webview 提供者 - 简化重构版本
 * 负责在侧边栏显示 OpenCode Web 界面
 */

import * as vscode from 'vscode';
import { ConfigurationService } from '../../services/configuration';
import { WebviewMessage, IWebviewProvider } from './types';
import { OpenCodeManager } from '../../core/OpenCodeManager';
import { getEventManager, OpenCodeEventManager } from '../../core/EventManager';
import { ProcessStateChangeEvent, ConnectionChangeEvent, EventType } from '../../core/eventTypes';
import { OpenCodeStatus } from '../../core/types';
import { l10n } from '../../l10n';

/**
 * Webview 视图类型常量
 */
const WEBVIEW_VIEW_TYPE = 'opencodeWebview';

/**
 * OpenCode Webview 提供者类 - 简化版本
 */
export class OpencodeWebviewProvider implements vscode.WebviewViewProvider, IWebviewProvider {
  private webviewView: vscode.WebviewView | undefined;
  private webviewPanel: vscode.WebviewPanel | undefined;
  private helpWebviewPanel: vscode.WebviewPanel | undefined;
  private outputChannel: vscode.OutputChannel;
  private isConnected: boolean = false;
  private isInstalled: boolean = false;
  private isInitialized: boolean = false; // 是否已初始化
  private isStarting: boolean = false; // 是否正在启动中
  private isRestarting: boolean = false; // 是否正在重启中
  private visibilityChangeTimer: NodeJS.Timeout | undefined; // 可见性变化防抖定时器
  private statusCheckTimer: NodeJS.Timeout | undefined; // 状态检查定时器
  private restartTimeoutTimer: NodeJS.Timeout | undefined; // 重启超时定时器
  private eventManager: OpenCodeEventManager;

  // 初始化锁机制
  private initializationLock: Promise<void> | undefined; // 当前正在执行的初始化 Promise
  private initializationVersion: number = 0; // 初始化版本号，用于丢弃过期的状态更新

  constructor(
    private context: vscode.ExtensionContext,
    private configurationService: ConfigurationService,
    private openCodeManager: OpenCodeManager,
    private onOpenInBrowser: () => void,
    private onToggleSidebar: () => void,
    private onOpenTui: () => void
  ) {
    this.outputChannel = vscode.window.createOutputChannel('OpenCode Webview');
    this.eventManager = getEventManager();
    this.setupEventListeners();
    this.log('Webview Provider 已创建');
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    // 监听进程状态变化事件
    this.eventManager.onProcessStateChanged((data: ProcessStateChangeEvent) => {
      this.log(`收到进程状态变化事件: ${data.status}`);
      this.handleProcessStateChange(data);
    });

    // 监听连接状态变化事件
    this.eventManager.onConnectionChanged((data: ConnectionChangeEvent) => {
      this.log(`收到连接状态变化事件: ${data.connected}`);
      this.handleConnectionChange(data);
    });
  }

  /**
   * 处理进程状态变化
   */
  private handleProcessStateChange(data: ProcessStateChangeEvent): void {
    this.log(`处理进程状态变化: ${data.status}, isRestarting: ${this.isRestarting}, isStarting: ${this.isStarting}`);

    switch (data.status) {
      case OpenCodeStatus.Running:
        // Running 状态总是优先，清除所有启动/重启标志
        this.isStarting = false;
        this.isRestarting = false;
        this.isConnected = true;
        this.setState('ready', '');
        this.log('✅ 状态已更新为 ready');

        // 清除重启超时定时器
        if (this.restartTimeoutTimer) {
          clearTimeout(this.restartTimeoutTimer);
          this.restartTimeoutTimer = undefined;
          this.log('已清除重启超时定时器');
        }
        break;

      case OpenCodeStatus.NotRunning:
        // NotRunning 状态只在非启动/重启时显示错误
        // 但总是要更新连接状态
        this.isConnected = false;

        if (this.isStarting || this.isRestarting) {
          this.log('正在启动/重启中，NotRunning 事件不更新 UI（但更新连接状态）');
          // 不 return，继续执行以更新连接状态
        } else {
          this.isStarting = false;
          this.isRestarting = false;
          this.setState('error', l10n.t('status.notRunning'));
          this.log('状态已更新为 error（未运行）');
        }
        break;

      case OpenCodeStatus.NotInstalled:
        this.isStarting = false;
        this.isRestarting = false;
        this.isConnected = false;
        this.isInstalled = false;
        this.setState('notInstalled', l10n.t('status.notInstalled'));
        this.log('状态已更新为 notInstalled');
        break;

      case OpenCodeStatus.Restarting:
        this.isRestarting = true;
        this.isStarting = false;
        this.setState('restarting', l10n.t('status.restarting'));
        this.log('状态已更新为 restarting');

        // 设置重启超时（30 秒后自动恢复）
        if (this.restartTimeoutTimer) {
          clearTimeout(this.restartTimeoutTimer);
        }
        this.restartTimeoutTimer = setTimeout(async () => {
          this.log('⚠️ 重启超时（30 秒），检查实际状态并恢复');
          this.isRestarting = false;

          // 检查实际状态并更新 UI
          const actualStatus = await this.openCodeManager.getStatus();
          this.log(`超时检查实际状态: ${actualStatus}`);

          if (actualStatus === OpenCodeStatus.Running) {
            this.isConnected = true;
            this.setState('ready', '');
          } else {
            this.isConnected = false;
            this.setState('error', l10n.t('status.notRunning'));
          }
        }, 30000);
        break;

      case OpenCodeStatus.Error:
        this.isStarting = false;
        this.isRestarting = false;
        this.isConnected = false;
        this.setState('error', data.error || l10n.t('status.error'));
        this.log('状态已更新为 error');
        break;
    }
  }

  /**
   * 处理连接状态变化
   */
  private handleConnectionChange(data: ConnectionChangeEvent): void {
    this.isConnected = data.connected;
    if (data.connected) {
      this.setState('ready', '');
    } else {
      // 如果正在启动或重启，不要覆盖启动状态
      if (this.isStarting || this.isRestarting) {
        this.log('正在启动/重启中，忽略连接断开事件');
        return;
      }
      this.setState('error', l10n.t('status.notRunning'));
    }
  }

  /**
   * 恢复 Webview 状态
   * 当 webview 可见时调用，会主动检查实际状态并更新 UI
   */
  private async restoreWebviewState(): Promise<void> {
    this.log('========== restoreWebviewState 开始 ==========');

    // 首先检查 webviewView 的 HTML 是否为空
    if (this.webviewView) {
      const isHtmlEmpty = !this.webviewView.webview.html || this.webviewView.webview.html.trim() === '';

      if (isHtmlEmpty) {
        this.log('webviewView HTML 为空，重新生成 HTML');
        const webview = this.webviewView.webview;
        const url = this.getOpenCodeUrl();
        webview.html = this.getWebviewContent(url);

        // 等待 HTML 加载完成后再恢复状态
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // 检查 OpenCode 的实际状态
    let actualStatus: OpenCodeStatus;
    try {
      actualStatus = await this.openCodeManager.getStatus();
      this.log(`Webview 可见，检查实际状态: ${actualStatus}`);
    } catch (error) {
      this.log(`检查状态失败: ${error}`);
      actualStatus = OpenCodeStatus.NotRunning;
    }

    // 同步本地状态标志
    if (actualStatus === OpenCodeStatus.Running) {
      this.isConnected = true;
      this.isInstalled = true;
      this.isStarting = false;
      this.isRestarting = false;
      this.log('状态同步: OpenCode 运行中，设置 ready');
      this.setState('ready', '');
      // 启动定期状态检查
      this.startPeriodicStatusCheck();
    } else if (actualStatus === OpenCodeStatus.NotRunning) {
      this.isConnected = false;
      this.isInstalled = true;
      this.isStarting = false;
      this.isRestarting = false;
      this.log('状态同步: OpenCode 未运行，显示错误');
      this.setState('error', l10n.t('status.notRunning'));
    } else if (actualStatus === OpenCodeStatus.NotInstalled) {
      this.isConnected = false;
      this.isInstalled = false;
      this.isStarting = false;
      this.isRestarting = false;
      this.log('状态同步: OpenCode 未安装，显示安装提示');
      this.setState('notInstalled', l10n.t('status.notInstalled'));
    }

    this.log('========== restoreWebviewState 完成 ==========');
  }

  /**
   * 实现 WebviewViewProvider 接口
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.log('========== resolveWebviewView 被调用 ==========');
    this.webviewView = webviewView;

    // 检查 HTML 是否为空（重载窗口时 HTML 会被清空）
    const isHtmlEmpty = !webviewView.webview.html || webviewView.webview.html.trim() === '';

    // 调试模式或 HTML 为空时，重置初始化状态
    if (isHtmlEmpty || !this.isInitialized) {
      this.log(`重置初始化状态 - HTML为空: ${isHtmlEmpty}, 已初始化: ${this.isInitialized}`);
      this.isInitialized = false;
      this.isStarting = false;
      this.isRestarting = false;
      this.initializationLock = undefined;
    }

    // 检查是否已经初始化过
    const wasAlreadyInitialized = this.isInitialized;

    webviewView.webview.options = {
      enableScripts: true,
      // 注意：retainContextWhenHidden 只对 WebviewPanel 可用，不对 WebviewView 可用
      // WebviewView 会自动保持状态
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'resources')
      ]
    };

    // 监听消息
    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        this.log(`收到 Webview 消息: ${JSON.stringify(message)}`);
        await this.handleMessage(message);
      },
      undefined,
      this.context.subscriptions
    );

    // 监听 webview 可见性变化，添加防抖逻辑
    webviewView.onDidChangeVisibility(() => {
      this.log(`Webview 可见性变化: ${webviewView.visible}`);
      if (webviewView.visible) {
        // 清除之前的定时器
        if (this.visibilityChangeTimer) {
          clearTimeout(this.visibilityChangeTimer);
        }

        // 添加 300ms 防抖，避免快速切换时频繁更新
        this.visibilityChangeTimer = setTimeout(async () => {
          this.log('防抖延迟结束，恢复 webview 状态');
          if (this.isInitialized) {
            // 已初始化，直接恢复状态
            await this.restoreWebviewState();
          } else {
            // 未初始化，触发初始化
            this.log('Webview 可见但未初始化，触发初始化');
            // 等待一小段时间确保 webview 完全加载
            await new Promise(resolve => setTimeout(resolve, 100));
            await this.restoreWebviewState();
          }
        }, 300);
      }
    });

    // 只在首次或需要重建 HTML 时更新
    const needsHtmlUpdate = !this.isInitialized || isHtmlEmpty;

    this.log(`Webview HTML 是否需要更新: ${needsHtmlUpdate}, 已初始化: ${this.isInitialized}, HTML为空: ${isHtmlEmpty}, 已连接: ${this.isConnected}`);

    if (needsHtmlUpdate) {
      this.updateWebview();
      this.log('HTML 已重新设置，等待 ready 消息');

      // 添加超时检测：如果 5 秒后仍未初始化，主动触发初始化
      setTimeout(async () => {
        if (!this.isInitialized) {
          this.log('警告：5 秒后仍未收到 ready 消息，主动触发初始化');
          // 直接调用初始化，不依赖 ready 消息
          await this.initializeOpenCode();
        }
      }, 5000);
    } else {
      this.log('Webview HTML 已存在，保持当前状态');
    }

    // 只有在 HTML 不为空且已初始化的情况下，才立即恢复状态
    if (wasAlreadyInitialized && !isHtmlEmpty) {
      this.log('Webview 已初始化过且 HTML 存在，立即恢复状态');
      setTimeout(async () => {
        await this.restoreWebviewState();
      }, 50);
    }

    this.log('Webview 视图已创建');
  }

  /**
   * 处理来自 Webview 的消息
   */
  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      this.log(`处理消息类型: ${message.type}`);

      switch (message.type) {
        case 'ready':
          this.log('收到 ready 消息，开始初始化流程');
          // 总是重新检查状态，确保状态同步
          // 不再依赖 isInitialized 标志，避免状态过期问题
          this.log('重新检查 OpenCode 状态...');
          await this.initializeOpenCode();
          break;

        case 'startOpencode':
          // 用户点击启动按钮
          await this.startOpenCode();
          break;

        case 'checkConnection':
          // 检查连接状态
          await this.checkAndNotifyConnection();
          break;

        case 'openInBrowser':
          this.onOpenInBrowser();
          break;

        case 'toggleSidebar':
          this.onToggleSidebar();
          break;

        case 'openTui':
          this.onOpenTui();
          break;

        case 'showHelp':
          // 显示帮助面板
          await this.showHelpPanel();
          break;

        case 'changeLanguage':
          // 打开语言设置
          vscode.commands.executeCommand('workbench.action.openSettings', 'opencode.language');
          break;

        default:
          this.log(`未知消息类型: ${message.type}`);
      }
    } catch (error) {
      this.log(`处理消息时出错: ${error}`);
      // 发生错误时，确保不会卡在 loading 状态
      this.setState('error', l10n.t('message.initFailed', String(error)));
    }
  }

  /**
   * 初始化 OpenCode（带初始化锁，防止并发初始化）
   */
  private async initializeOpenCode(): Promise<void> {
    this.log('========== initializeOpenCode 开始 ==========');
    this.log(`当前状态 - isInitialized: ${this.isInitialized}, isStarting: ${this.isStarting}, isConnected: ${this.isConnected}`);

    // 如果已有初始化正在进行，等待它完成后创建新的初始化
    // 这样可以避免并发初始化，但也允许在初始化完成后重新检查状态
    if (this.initializationLock) {
      this.log('初始化正在进行中，等待现有初始化完成...');
      try {
        await this.initializationLock;
        this.log('现有初始化已完成，创建新的初始化');
      } catch (error) {
        this.log(`等待初始化失败: ${error}，继续创建新的初始化`);
      }
      // 不 return，继续创建新的初始化
    }

    // 创建新的初始化 Promise
    const currentVersion = ++this.initializationVersion;
    this.log(`创建新的初始化 Promise，版本: ${currentVersion}`);

    this.initializationLock = (async () => {
      try {
        this.log(`开始初始化 OpenCode (版本 ${currentVersion})...`);

        // 等待 webview JavaScript 完全加载
        // 防止消息在 webview 准备好之前发送
        await new Promise(resolve => setTimeout(resolve, 200));
        this.log('Webview JavaScript 加载等待完成');

        // 设置初始化标志，防止重复初始化
        this.isInitialized = true;
        this.log('设置 isInitialized = true');

        // 使用 OpenCodeManager 的统一状态检查
        this.log('检查 OpenCode 状态（通过 OpenCodeManager）...');

        // 先显示加载状态
        this.setState('loading', l10n.t('status.checkingStatus'));
        this.log('已设置 loading 状态');

        // 通过 OpenCodeManager 获取状态（已包含安装检查）
        // 添加超时保护，防止健康检查挂起
        const statusPromise = this.openCodeManager.getStatus();
        const timeoutPromise = new Promise<OpenCodeStatus>((resolve) => {
          setTimeout(() => {
            this.log('getStatus() 超时（5秒），返回 NotRunning');
            resolve(OpenCodeStatus.NotRunning);
          }, 5000);
        });

        const status = await Promise.race([statusPromise, timeoutPromise]);
        this.log(`getStatus() 返回: ${status}`);

        // 检查是否已被新的初始化取代
        if (currentVersion !== this.initializationVersion) {
          this.log(`初始化版本 ${currentVersion} 已过期，当前版本: ${this.initializationVersion}，忽略状态更新`);
          return;
        }

        this.log(`OpenCode 状态: ${status} (版本 ${currentVersion})`);

        // 根据状态设置 UI
        switch (status) {
          case OpenCodeStatus.NotInstalled:
            this.isInstalled = false;
            this.isConnected = false;
            this.setState('notInstalled', l10n.t('status.notInstalled'));
            break;

          case OpenCodeStatus.NotRunning:
            this.isInstalled = true;
            this.isConnected = false;
            this.setState('error', l10n.t('status.notRunning'));
            break;

          case OpenCodeStatus.Running:
            this.isInstalled = true;
            this.isConnected = true;
            this.setState('ready', '');
            break;

          default:
            this.log(`未知状态: ${status}`);
            this.setState('error', l10n.t('message.unknownState'));
        }

        // 启动定期状态检查（仅在成功初始化后）
        this.startPeriodicStatusCheck();

      } catch (error) {
        this.log(`初始化失败: ${error}`);
        this.setState('error', l10n.t('message.initFailed', error));
      } finally {
        // 清除初始化锁
        this.initializationLock = undefined;
      }
    })();

    // 等待初始化完成
    await this.initializationLock;
  }

  /**
   * 启动定期状态检查
   * 用于检测 OpenCode 状态变化并及时更新 UI
   */
  private startPeriodicStatusCheck(): void {
    // 清除之前的定时器
    if (this.statusCheckTimer) {
      clearInterval(this.statusCheckTimer);
    }

    // 每 5 秒检查一次状态
    this.statusCheckTimer = setInterval(async () => {
      // 只在 Webview 可见时检查
      if (this.webviewView && this.webviewView.visible) {
        try {
          const currentStatus = await this.openCodeManager.getStatus();
          this.log(`定期状态检查: ${currentStatus}`);

          // 如果状态是 Running 但 UI 没有更新，强制更新
          if (currentStatus === OpenCodeStatus.Running && !this.isConnected) {
            this.log('检测到状态不匹配，强制更新为 ready');
            this.isConnected = true;
            this.isInstalled = true;
            this.setState('ready', '');
          }
        } catch (error) {
          this.log(`定期状态检查失败: ${error}`);
        }
      }
    }, 5000);

    this.log('已启动定期状态检查（每 5 秒）');
  }

  /**
   * 停止定期状态检查
   */
  private stopPeriodicStatusCheck(): void {
    if (this.statusCheckTimer) {
      clearInterval(this.statusCheckTimer);
      this.statusCheckTimer = undefined;
      this.log('已停止定期状态检查');
    }
  }

  /**
   * 启动 OpenCode
   */
  private async startOpenCode(): Promise<void> {
    try {
      this.log('开始启动 OpenCode...');
      this.isStarting = true;

      // 检查是否有工作区
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.log('没有打开的工作区');
        this.isStarting = false;
        this.setState('error', l10n.t('message.noWorkspace'));
        return;
      }

      // 立即显示启动中状态
      this.setState('loading', l10n.t('status.starting'));

      // 在后台启动
      const success = await this.openCodeManager.startInBackground();

      if (success) {
        this.log('OpenCode 启动成功，等待连接检查...');
        this.setState('loading', l10n.t('status.waiting'));

        // 等待3秒后检查连接
        setTimeout(async () => {
          const connected = await this.checkConnection();
          this.isConnected = connected; // 更新连接状态
          this.isStarting = false; // 清除启动状态
          if (connected) {
            this.log('连接成功');
            this.setState('ready', '');
          } else {
            this.log('连接失败');
            this.setState('error', l10n.t('message.startTimeout'));
          }
        }, 3000);
      } else {
        this.log('OpenCode 启动失败');
        this.isStarting = false; // 清除启动状态
        this.setState('error', l10n.t('message.startFailed'));
      }
    } catch (error) {
      this.log(`启动失败: ${error}`);
      this.isStarting = false; // 清除启动状态
      this.setState('error', l10n.t('message.startFailed', error));
    }
  }

  /**
   * 检查连接状态
   * 使用 OpenCodeManager 的公共方法，确保与 TUI 使用相同的检查逻辑
   */
  private async checkConnection(): Promise<boolean> {
    try {
      return await this.openCodeManager.checkConnection();
    } catch (error) {
      this.log(`连接检查异常: ${error}`);
      return false;
    }
  }

  /**
   * 检查并通知连接状态
   */
  private async checkAndNotifyConnection(): Promise<void> {
    const connected = await this.checkConnection();
    this.isConnected = connected;

    if (connected) {
      this.setState('ready', '');
    } else {
      this.setState('error', l10n.t('status.disconnected'));
    }
  }


  /**
   * 设置 Webview 状态
   */
  private setState(state: string, message: string): void {
    this.postMessageToWebview({
      type: 'setState',
      state: state,
      message: message
    });
  }

  /**
   * 发送消息到 Webview（带错误处理）
   */
  private postMessageToWebview(message: any): void {
    try {
      if (this.webviewView) {
        this.webviewView.webview.postMessage(message);
      }
      if (this.webviewPanel) {
        this.webviewPanel.webview.postMessage(message);
      }
    } catch (error) {
      // Webview 可能已被释放，忽略错误
      this.log(`发送消息到 Webview 失败（可能已被释放）: ${error}`);
    }
  }

  /**
   * 更新 Webview 内容
   */
  private updateWebview(): void {
    if (this.webviewView) {
      const webview = this.webviewView.webview;
      const url = this.getOpenCodeUrl();
      webview.html = this.getWebviewContent(url);
    }

    if (this.webviewPanel) {
      this.updateWebviewPanel();
    }
  }

  /**
   * 更新 Webview 面板内容
   */
  private updateWebviewPanel(): void {
    if (!this.webviewPanel) {
      return;
    }

    const webview = this.webviewPanel.webview;
    const url = this.getOpenCodeUrl();
    webview.html = this.getWebviewContent(url);
  }

  /**
   * 获取 OpenCode URL
   */
  private getOpenCodeUrl(): string {
    const port = this.configurationService.getPort();
    return `http://localhost:${port}`;
  }

  /**
   * 获取 Webview HTML 内容 - 简化版本
   */
  private getWebviewContent(url: string): string {
    // 获取语言包并转换为 JSON 字符串
    const bundle = l10n.getBundle();
    const bundleJson = JSON.stringify(bundle);
    const language = l10n.getLanguage();

    this.log(`生成 Webview HTML，语言: ${language}，bundle 大小: ${bundleJson.length}`);

    return `<!DOCTYPE html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://localhost:*; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <title>OpenCode</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      background-color: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      overflow: hidden;
    }
    .container {
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    .webview-container {
      flex: 1;
      overflow: hidden;
      position: relative;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
    }

    /* 现代化错误容器 */
    .modern-error-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 32px;
      text-align: center;
      animation: fadeIn 0.3s ease-in;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* 图标包裹器 */
    .icon-wrapper {
      width: 64px;
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 24px;
      border-radius: 16px;
      background: linear-gradient(135deg, var(--vscode-editor-background) 0%, var(--vscode-input-background) 100%);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }

    .error-icon-svg {
      width: 32px;
      height: 32px;
      color: var(--vscode-errorForeground);
    }

    /* 错误标题 */
    .error-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--vscode-editor-foreground);
      margin-bottom: 8px;
    }

    /* 错误描述 */
    .error-description {
      font-size: 14px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 24px;
      max-width: 300px;
      line-height: 1.5;
    }

    /* 操作按钮 */
    .action-button {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 24px;
      border: none;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s ease;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    .action-button:hover {
      background-color: var(--vscode-button-hoverBackground);
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
      transform: translateY(-1px);
    }

    .action-button:active {
      transform: translateY(0);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    .action-button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .action-button svg {
      transition: transform 0.2s ease;
    }

    .action-button:hover svg:not(.spin) {
      transform: scale(1.1);
    }

    /* 语言切换浮动按钮 */
    .language-toggle-button {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 1000;
      width: 36px;
      height: 36px;
      border: none;
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
    }
    .language-toggle-button:hover {
      background-color: var(--vscode-button-secondaryHoverBackground);
      transform: scale(1.05);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    }

    .spin {
      animation: spin 1s linear infinite;
    }

    /* 状态容器 */
    .status-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 20px;
      text-align: center;
    }

    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 4px solid var(--vscode-editor-background);
      border-top: 4px solid var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 20px;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .status-text {
      font-size: 16px;
      color: var(--vscode-editor-foreground);
      margin-bottom: 8px;
    }

    /* 旧样式兼容 */
    .error-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .error-message {
      font-size: 16px;
      color: var(--vscode-errorForeground);
      margin-bottom: 8px;
      font-weight: 500;
    }

    .error-hint {
      font-size: 14px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 20px;
    }

    .start-button {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      border: none;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      border-radius: 4px;
      font-size: 14px;
      font-weight: 500;
      transition: background-color 0.2s;
    }

    .start-button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    .start-button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="webview-container" id="webviewContainer">
      <div class="status-container">
        <div class="loading-spinner"></div>
        <div class="status-text">${l10n.t('status.initializing')}</div>
      </div>
    </div>
  </div>

  <script>
    console.log('=== 脚本开始执行 ===');

    // 保存 OpenCode URL 到全局变量
    const url = '${url}';
    console.log('OpenCode URL:', url);

    // 注入语言包
    try {
      window.L10N_BUNDLE = ${bundleJson};
      window.L10N_LANGUAGE = '${language}';
      console.log('语言包注入成功，语言:', window.L10N_LANGUAGE);

      // Webview 端翻译函数
      function t(key, ...args) {
        const keys = key.split('.');
        let value = window.L10N_BUNDLE;

        for (const k of keys) {
          value = value?.[k];
        }

        if (typeof value !== 'string') return key;
        return value.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? '');
      }
    } catch (error) {
      console.error('语言包加载失败:', error);
      // 提供默认翻译函数
      function t(key, ...args) {
        return key;
      }
    }

    const vscode = acquireVsCodeApi();
    console.log('vscode API 已获取:', typeof vscode !== 'undefined');
    const SAVED_STATE_KEY = 'opencodeState';
    const STATE_EXPIRY_MS = 300000; // 5分钟有效期

    // 保存状态到 vscode.persistence
    function saveState(state, message) {
      // 不保存错误状态，避免下次启动时显示错误信息
      if (state === 'error' || state === 'notInstalled') {
        console.log('Not saving error state:', state);
        return;
      }
      const stateData = {
        state,
        message,
        timestamp: Date.now()
      };
      vscode.setState(stateData);
      console.log('State saved:', stateData);
    }

    // 从 vscode.persistence 加载状态
    function loadState() {
      const savedState = vscode.getState();
      if (savedState) {
        console.log('State loaded:', savedState);
        return savedState;
      }
      return null;
    }

    // 检查保存的状态是否有效
    function isStateValid(savedState) {
      if (!savedState) return false;
      const age = Date.now() - savedState.timestamp;
      // 以下状态不恢复，总是重新检查：
      // - error: 错误状态可能已经改变
      // - notInstalled: 安装状态可能已经改变
      // - loading: 加载状态是临时的，不应该被持久化
      // - restarting: 重启状态是临时的，不应该被持久化
      const invalidStates = ['error', 'notInstalled', 'loading', 'restarting'];
      if (invalidStates.includes(savedState.state)) {
        console.log('状态无效或为临时状态，需要重新检查:', savedState.state);
        return false;
      }
      return age < STATE_EXPIRY_MS;
    }

    function setState(state, message) {
      console.log('setState:', state, message);

      // 保存状态
      saveState(state, message);

      const container = document.getElementById('webviewContainer');

      if (state === 'ready') {
        container.innerHTML = \`
          <iframe src="\${url}" frameborder="0" id="opencodeFrame"></iframe>
          <button class="language-toggle-button" id="languageButton" title="\${t('button.changeLanguage')}">
            <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
              <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z"/>
            </svg>
          </button>
        \`;
        const langBtn = document.getElementById('languageButton');
        if (langBtn) {
          langBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'changeLanguage' });
          });
        }
      } else if (state === 'error') {
        container.innerHTML = \`
          <div class="modern-error-container">
            <div class="icon-wrapper">
              <svg class="error-icon-svg" viewBox="0 0 48 48">
                <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="2"/>
                <path d="M15 15 L33 33 M33 15 L15 33" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </div>
            <h2 class="error-title">\${t('status.error')}</h2>
            <p class="error-description">\${message || t('message.serviceNotRunning')}</p>
            <button class="action-button" id="startButton">
              <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
              \${t('button.start')}
            </button>
          </div>
        \`;
        const startBtn = document.getElementById('startButton');
        if (startBtn) {
          startBtn.addEventListener('click', () => {
            startBtn.disabled = true;
            startBtn.innerHTML = \`
              <svg class="spin" viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="32" stroke-linecap="round"/>
              </svg>
              \${t('button.starting')}
            \`;
            vscode.postMessage({ type: 'startOpencode' });
          });
        }
      } else if (state === 'loading') {
        container.innerHTML = \`
          <div class="status-container">
            <div class="loading-spinner"></div>
            <div class="status-text">\${message}</div>
          </div>
        \`;
      } else if (state === 'restarting') {
        container.innerHTML = \`
          <div class="status-container">
            <div class="loading-spinner"></div>
            <div class="status-text">\${message}</div>
          </div>
        \`;
      } else if (state === 'notInstalled') {
        container.innerHTML = \`
          <div class="modern-error-container">
            <div class="icon-wrapper">
              <svg class="error-icon-svg" viewBox="0 0 48 48">
                <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="2"/>
                <path d="M15 15 L33 33 M33 15 L15 33" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </div>
            <h2 class="error-title">\${t('status.notInstalled')}</h2>
            <p class="error-description">\${message || t('message.pleaseInstall')}</p>
            <button class="action-button" id="helpButton">
              <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
              </svg>
              \${t('button.help')}
            </button>
          </div>
        \`;
        const helpBtn = document.getElementById('helpButton');
        if (helpBtn) {
          helpBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'showHelp' });
          });
        }
      }
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      console.log('收到消息:', message);

      switch (message.type) {
        case 'setState':
          setState(message.state, message.message);
          break;
        case 'error':
          setState('error', message.message || t('status.disconnected'));
          break;
        case 'loading':
          setState('loading', message.message || t('status.loading'));
          break;
        case 'ready':
          // 这个消息不应该出现，所有状态都应该通过 'setState' 来设置
          console.warn('收到意外的 ready 消息，已忽略');
          break;
      }
    });

    window.addEventListener('load', () => {
      console.log('=== 页面 load 事件触发 ===');
      console.log('vscode API 可用:', typeof vscode !== 'undefined');
      console.log('当前状态:', {
        isInitialized: false,
        language: window.L10N_LANGUAGE,
        bundleKeys: Object.keys(window.L10N_BUNDLE || {}).length
      });

      // 检查是否有保存的有效状态
      const savedState = loadState();
      console.log('保存的状态:', savedState);
      console.log('状态是否有效:', isStateValid(savedState));

      if (isStateValid(savedState)) {
        // 恢复保存的状态，不发送 ready 消息
        console.log('恢复保存的状态:', savedState);
        setState(savedState.state, savedState.message);
      } else {
        // 首次加载或状态过期，发送 ready 消息
        console.log('首次加载或状态过期，初始化...');
        setTimeout(() => {
          console.log('=== 发送 ready 消息 ===');
          try {
            vscode.postMessage({ type: 'ready' });
            console.log('ready 消息已发送');
          } catch (error) {
            console.error('发送 ready 消息失败:', error);
          }
        }, 100);
      }
    });

    // 添加 DOMContentLoaded 作为备用
    document.addEventListener('DOMContentLoaded', () => {
      console.log('=== DOMContentLoaded 事件触发 ===');
    });
  </script>
</body>
</html>`;
  }

  /**
   * 在浏览器中打开
   */
  public openInBrowser(): void {
    const url = this.getOpenCodeUrl();
    vscode.env.openExternal(vscode.Uri.parse(url));
    this.log(`已在浏览器中打开: ${url}`);
  }

  /**
   * 切换侧边栏位置
   * 从左侧栏切换到编辑器右侧，或关闭编辑器右侧的面板
   */
  public toggleSidebar(): void {
    if (this.webviewView && !this.webviewPanel) {
      // 当前在侧边栏显示，切换到编辑器右侧
      this.createOrShowWebviewPanel();
    } else if (this.webviewPanel) {
      // 当前在编辑器右侧显示，关闭面板
      this.webviewPanel.dispose();
      this.webviewPanel = undefined;
    }
    // 如果 webviewView 不存在（面板已存在但侧边栏视图不可见），则不做任何操作
  }

  /**
   * 创建或显示 Webview 面板
   * 在编辑器右侧创建 WebviewPanel，类似 TUI 终端的行为
   */
  private createOrShowWebviewPanel(): void {
    if (this.webviewPanel) {
      // 如果面板已存在，显示它
      this.webviewPanel.reveal(this.webviewPanel.viewColumn || vscode.ViewColumn.Beside, true);
      return;
    }

    // 在编辑器右侧创建面板（类似 ViewColumn.Beside 的行为）
    this.webviewPanel = vscode.window.createWebviewPanel(
      WEBVIEW_VIEW_TYPE,
      'OpenCode',
      vscode.ViewColumn.Beside, // 在当前编辑器旁边创建
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'resources')
        ]
      }
    );

    this.webviewPanel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        await this.handleMessage(message);
      },
      undefined,
      this.context.subscriptions
    );

    // 监听 webviewPanel 视图状态变化
    this.webviewPanel.onDidChangeViewState(async () => {
      const isActive = this.webviewPanel?.active;
      const isVisible = this.webviewPanel?.visible;
      this.log(`WebviewPanel 视图状态变化: active=${isActive}, visible=${isVisible}`);

      // 当 webviewPanel 失去焦点或隐藏时，重新检查左侧栏 webview 的状态
      if ((!isActive || !isVisible) && this.webviewView) {
        this.log('WebviewPanel 失去焦点，恢复左侧栏 webview 状态');
        await this.restoreWebviewState();
      }
    });

    // 监听 webviewPanel 关闭事件
    this.webviewPanel.onDidDispose(async () => {
      this.log('WebviewPanel 已关闭');
      this.webviewPanel = undefined;

      // 重新恢复左侧栏 webview 的状态
      if (this.webviewView) {
        this.log('恢复左侧栏 webview 状态');
        await this.restoreWebviewState();
      }
    });

    this.updateWebviewPanel();
    this.log('Webview 面板已在编辑器右侧创建');
  }

  /**
   * 刷新 Webview
   */
  public refresh(): void {
    this.updateWebview();
  }

  /**
   * 显示安装指南
   */
  public async showInstallGuide(): Promise<void> {
    this.postMessageToWebview({ type: 'setState', state: 'error', message: l10n.t('message.pleaseInstall') });
  }

  /**
   * 显示帮助面板
   */
  public async showHelpPanel(): Promise<void> {
    // 如果帮助面板已存在，直接显示
    if (this.helpWebviewPanel) {
      this.helpWebviewPanel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    // 创建新的帮助面板
    this.helpWebviewPanel = vscode.window.createWebviewPanel(
      'opencodeHelp',
      'OpenCode 帮助',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'resources')
        ]
      }
    );

    // 从文件读取帮助内容并设置
    try {
      const helpContent = await this.getHelpContent();
      this.helpWebviewPanel.webview.html = helpContent;
    } catch (error) {
      this.log(`加载帮助文档失败: ${error}`);
      this.helpWebviewPanel.webview.html = this.getFallbackHelpContent();
    }

    // 监听面板关闭事件
    this.helpWebviewPanel.onDidDispose(() => {
      this.helpWebviewPanel = undefined;
    });
  }

  /**
   * 生成帮助文档内容
   * 从独立的 HTML 文件读取帮助文档，支持多语言
   */
  private async getHelpContent(): Promise<string> {
    try {
      const currentLang = l10n.getLanguage();
      const helpFileName = `help.${currentLang}.html`;
      this.log(`Loading help file: ${helpFileName}`);

      const helpUri = vscode.Uri.joinPath(this.context.extensionUri, 'resources', helpFileName);
      const helpData = await vscode.workspace.fs.readFile(helpUri);
      const helpText = Buffer.from(helpData).toString('utf-8');
      return helpText;
    } catch (error) {
      this.log(`读取帮助文档失败: ${error}，尝试英文版本`);
      try {
        const helpUri = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'help.en.html');
        const helpData = await vscode.workspace.fs.readFile(helpUri);
        const helpText = Buffer.from(helpData).toString('utf-8');
        return helpText;
      } catch {
        this.log(`英文版本也加载失败，使用备用内容`);
        return this.getFallbackHelpContent();
      }
    }
  }

  /**
   * 备用帮助文档内容（当文件读取失败时使用）
   */
  private getFallbackHelpContent(): string {
    return `<!DOCTYPE html>
<html lang="${l10n.getLanguage()}">
<head>
  <meta charset="UTF-8">
  <title>${l10n.t('help.title')}</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
    }
  </style>
</head>
<body>
  <h1>${l10n.t('help.unableToLoad')}</h1>
  <p>${l10n.t('help.helpFileNotFound')}</p>
</body>
</html>`;
  }

  /**
   * 智能刷新 Webview
   */
  public async refreshWebview(): Promise<void> {
    this.log('开始刷新 Webview');

    // 检查 webview 是否还有效
    if (!this.webviewView || !this.webviewView.webview) {
      this.log('Webview 已被释放，无法刷新');
      return;
    }

    // 显示加载状态
    this.setState('loading', l10n.t('status.refreshing'));

    try {
      // 使用 Promise.race 添加超时保护
      const statusPromise = this.openCodeManager.getStatus();
      const timeoutPromise = new Promise<OpenCodeStatus>((resolve) => {
        setTimeout(() => resolve(OpenCodeStatus.NotRunning), 3000);
      });

      const status = await Promise.race([statusPromise, timeoutPromise]);
      this.log(`刷新检查到的状态: ${status}`);

      if (status === OpenCodeStatus.Running) {
        // 已启动，验证连接是否真正可用
        this.log('OpenCode 进程运行中，验证连接...');
        const isConnected = await this.openCodeManager.checkConnection(2000);

        if (isConnected) {
          // 连接正常，重新加载 iframe（不管 TUI 终端是否存在）
          this.log('OpenCode 连接正常，重新加载 iframe');
          this.updateWebview();
          // 确保状态更新为 ready
          setTimeout(() => {
            this.setState('ready', '');
          }, 100);
        } else {
          // 进程运行但连接失败
          this.log('OpenCode 进程运行但连接失败');
          this.setState('error', l10n.t('message.restartFailed', 'OpenCode'));
        }
      } else {
        // 未启动或未安装，显示相应的启动界面
        this.log(`OpenCode 状态: ${status}`);
        if (status === OpenCodeStatus.NotInstalled) {
          this.setState('notInstalled', l10n.t('status.notInstalled'));
        } else {
          this.setState('error', l10n.t('status.notRunning'));
        }
      }
    } catch (error) {
      this.log(`刷新过程中出错: ${error}`);
      // 出错时显示未启动状态
      this.setState('error', l10n.t('status.notRunning'));
    }
  }

  /**
   * 销毁资源
   */
  public dispose(): void {
    // 清理可见性变化定时器
    if (this.visibilityChangeTimer) {
      clearTimeout(this.visibilityChangeTimer);
    }

    // 清理重启超时定时器
    if (this.restartTimeoutTimer) {
      clearTimeout(this.restartTimeoutTimer);
    }

    // 清理状态检查定时器
    this.stopPeriodicStatusCheck();

    // 清理事件监听器
    this.eventManager.removeAllListenersForEvent(EventType.ProcessStateChanged);
    this.eventManager.removeAllListenersForEvent(EventType.ConnectionChanged);

    if (this.webviewPanel) {
      this.webviewPanel.dispose();
    }

    if (this.helpWebviewPanel) {
      this.helpWebviewPanel.dispose();
    }

    this.outputChannel.dispose();
  }

  /**
   * 日志输出
   */
  private log(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }
}
