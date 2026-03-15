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
    switch (data.status) {
      case OpenCodeStatus.Running:
        this.isStarting = false;
        this.isRestarting = false;
        this.isConnected = true;
        this.setState('ready', '');
        break;
      case OpenCodeStatus.NotRunning:
        // 如果正在启动或重启，不要覆盖启动状态
        if (this.isStarting || this.isRestarting) {
          this.log('正在启动/重启中，忽略 NotRunning 事件');
          this.isConnected = false;
          return;
        }
        this.isStarting = false;
        this.isRestarting = false;
        this.isConnected = false;
        this.setState('error', 'OpenCode 未启动');
        break;
      case OpenCodeStatus.NotInstalled:
        this.isStarting = false;
        this.isRestarting = false;
        this.isConnected = false;
        this.isInstalled = false;
        this.setState('notInstalled', 'OpenCode 未安装');
        break;
      case OpenCodeStatus.Restarting:
        this.isRestarting = true;
        this.isStarting = false;
        this.setState('restarting', '正在重启 OpenCode...');
        break;
      case OpenCodeStatus.Error:
        this.isStarting = false;
        this.isRestarting = false;
        this.isConnected = false;
        this.setState('error', data.error || 'OpenCode 发生错误');
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
      this.setState('error', 'OpenCode 未启动');
    }
  }

  /**
   * 恢复 Webview 状态
   * 当 webview 可见时调用，会主动检查实际状态
   */
  private async restoreWebviewState(): Promise<void> {
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

    // 先检查 OpenCode 的实际状态
    try {
      const actualStatus = await this.openCodeManager.getStatus();
      this.log(`Webview 可见，检查实际状态: ${actualStatus}`);

      // 同步本地状态
      if (actualStatus === OpenCodeStatus.Running) {
        this.isConnected = true;
        this.isInstalled = true;
        this.isStarting = false;
        this.isRestarting = false;
      } else if (actualStatus === OpenCodeStatus.NotRunning) {
        this.isConnected = false;
        this.isInstalled = true;
        this.isStarting = false;
        this.isRestarting = false;
      } else if (actualStatus === OpenCodeStatus.NotInstalled) {
        this.isConnected = false;
        this.isInstalled = false;
        this.isStarting = false;
        this.isRestarting = false;
      }
    } catch (error) {
      this.log(`检查状态失败: ${error}`);
    }

    // 根据同步后的状态更新 UI
    if (this.isConnected) {
      this.setState('ready', '');
    } else if (this.isRestarting) {
      this.setState('restarting', '正在重启 OpenCode...');
    } else if (this.isStarting) {
      this.setState('loading', '正在启动 OpenCode...');
    } else if (this.isInstalled) {
      this.setState('error', 'OpenCode 未启动');
    } else {
      this.setState('notInstalled', 'OpenCode 未安装');
    }
  }

  /**
   * 实现 WebviewViewProvider 接口
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.webviewView = webviewView;

    // 检查 HTML 是否为空（重载窗口时 HTML 会被清空）
    const isHtmlEmpty = !webviewView.webview.html || webviewView.webview.html.trim() === '';

    // 如果 HTML 为空，需要重置初始化状态
    if (isHtmlEmpty && this.isInitialized) {
      this.log('检测到 HTML 为空但 isInitialized 为 true，重置初始化状态');
      this.isInitialized = false;
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
    switch (message.type) {
      case 'ready':
        // 只在第一次初始化时执行完整的初始化流程
        if (!this.isInitialized) {
          await this.initializeOpenCode();
        } else {
          // 已经初始化过，恢复当前状态
          this.log('Webview 已就绪，恢复当前状态');
          if (this.isConnected) {
            this.setState('ready', '');
          } else if (this.isStarting) {
            this.setState('loading', '正在启动 OpenCode...');
          } else if (this.isInstalled) {
            this.setState('error', 'OpenCode 未启动');
          } else {
            this.setState('notInstalled', 'OpenCode 未安装');
          }
        }
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
    }
  }

  /**
   * 初始化 OpenCode（带初始化锁，防止并发初始化）
   */
  private async initializeOpenCode(): Promise<void> {
    // 如果已有初始化正在进行，等待它完成
    if (this.initializationLock) {
      this.log('初始化正在进行中，等待现有初始化完成...');
      try {
        await this.initializationLock;
        this.log('现有初始化已完成');
      } catch (error) {
        this.log(`等待初始化失败: ${error}`);
      }
      return;
    }

    // 创建新的初始化 Promise
    const currentVersion = ++this.initializationVersion;

    this.initializationLock = (async () => {
      try {
        this.log(`开始初始化 OpenCode (版本 ${currentVersion})...`);

        // 等待 webview JavaScript 完全加载
        // 防止消息在 webview 准备好之前发送
        await new Promise(resolve => setTimeout(resolve, 200));

        // 设置初始化标志，防止重复初始化
        this.isInitialized = true;

        // 使用 OpenCodeManager 的统一状态检查
        this.log('检查 OpenCode 状态（通过 OpenCodeManager）...');

        // 先显示加载状态
        this.setState('loading', '正在检查 OpenCode 状态...');

        // 通过 OpenCodeManager 获取状态（已包含安装检查）
        const status = await this.openCodeManager.getStatus();

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
            this.setState('notInstalled', 'OpenCode 未安装');
            break;

          case OpenCodeStatus.NotRunning:
            this.isInstalled = true;
            this.isConnected = false;
            this.setState('error', 'OpenCode 未启动');
            break;

          case OpenCodeStatus.Running:
            this.isInstalled = true;
            this.isConnected = true;
            this.setState('ready', '');
            break;

          default:
            this.log(`未知状态: ${status}`);
            this.setState('error', '未知的 OpenCode 状态');
        }
      } catch (error) {
        this.log(`初始化失败: ${error}`);
        this.setState('error', `初始化失败: ${error}`);
      } finally {
        // 清除初始化锁
        this.initializationLock = undefined;
      }
    })();

    // 等待初始化完成
    await this.initializationLock;
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
        this.setState('error', '请先打开一个工作区（文件夹）后再启动 OpenCode');
        return;
      }

      // 立即显示启动中状态
      this.setState('loading', '正在启动 OpenCode...');

      // 在后台启动
      const success = await this.openCodeManager.startInBackground();

      if (success) {
        this.log('OpenCode 启动成功，等待连接检查...');
        this.setState('loading', '等待 OpenCode 就绪...');

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
            this.setState('error', '启动超时，请手动检查');
          }
        }, 3000);
      } else {
        this.log('OpenCode 启动失败');
        this.isStarting = false; // 清除启动状态
        this.setState('error', '启动失败，请检查日志');
      }
    } catch (error) {
      this.log(`启动失败: ${error}`);
      this.isStarting = false; // 清除启动状态
      this.setState('error', `启动失败: ${error}`);
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
      this.setState('error', '连接已断开');
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
    return `<!DOCTYPE html>
<html lang="zh-CN">
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
        <div class="status-text">正在初始化...</div>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
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
        container.innerHTML = '<iframe src="${url}" frameborder="0" id="opencodeFrame"></iframe>';
      } else if (state === 'error') {
        container.innerHTML = \`
          <div class="modern-error-container">
            <div class="icon-wrapper">
              <svg class="error-icon-svg" viewBox="0 0 48 48">
                <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="2"/>
                <path d="M15 15 L33 33 M33 15 L15 33" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </div>
            <h2 class="error-title">当前状态</h2>
            <p class="error-description">\${message || 'OpenCode 服务当前未运行'}</p>
            <button class="action-button" id="startButton">
              <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
              启动 OpenCode
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
              正在启动...
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
            <h2 class="error-title">OpenCode 未安装</h2>
            <p class="error-description">\${message || '请先安装 OpenCode CLI 工具'}</p>
            <button class="action-button" id="helpButton">
              <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
              </svg>
              查看帮助
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
          setState('error', message.message || '无法连接到 OpenCode');
          break;
        case 'loading':
          setState('loading', message.message || '正在加载...');
          break;
        case 'ready':
          // 这个消息不应该出现，所有状态都应该通过 'setState' 来设置
          console.warn('收到意外的 ready 消息，已忽略');
          break;
      }
    });

    window.addEventListener('load', () => {
      console.log('页面加载完成');

      // 检查是否有保存的有效状态
      const savedState = loadState();

      if (isStateValid(savedState)) {
        // 恢复保存的状态，不发送 ready 消息
        console.log('恢复保存的状态:', savedState);
        setState(savedState.state, savedState.message);
      } else {
        // 首次加载或状态过期，发送 ready 消息
        console.log('首次加载或状态过期，初始化...');
        setTimeout(() => {
          vscode.postMessage({ type: 'ready' });
        }, 100);
      }
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
    this.postMessageToWebview({ type: 'setState', state: 'error', message: '请先安装 OpenCode' });
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
   * 从独立的 HTML 文件读取帮助文档
   */
  private async getHelpContent(): Promise<string> {
    try {
      const helpUri = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'help.html');
      const helpData = await vscode.workspace.fs.readFile(helpUri);
      const helpText = Buffer.from(helpData).toString('utf-8');
      return helpText;
    } catch (error) {
      this.log(`读取帮助文档失败: ${error}`);
      return this.getFallbackHelpContent();
    }
  }

  /**
   * 备用帮助文档内容（当文件读取失败时使用）
   */
  private getFallbackHelpContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>OpenCode 帮助</title>
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
  <h1>无法加载帮助文档</h1>
  <p>帮助文档文件不存在或无法读取。请重新安装扩展。</p>
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
    this.setState('loading', '正在刷新...');

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
          this.setState('error', 'OpenCode 需要重启');
        }
      } else {
        // 未启动或未安装，显示相应的启动界面
        this.log(`OpenCode 状态: ${status}`);
        if (status === OpenCodeStatus.NotInstalled) {
          this.setState('notInstalled', 'OpenCode 未安装');
        } else {
          this.setState('error', 'OpenCode 未启动');
        }
      }
    } catch (error) {
      this.log(`刷新过程中出错: ${error}`);
      // 出错时显示未启动状态
      this.setState('error', 'OpenCode 未启动');
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
