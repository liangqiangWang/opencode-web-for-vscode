/**
 * OpenCode Webview 提供者 - 重构简化版本
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
 * Webview 状态枚举
 */
type WebviewState =
  | 'initializing'    // 初始化中
  | 'ready'          // OpenCode 运行中
  | 'error'          // 错误状态
  | 'notInstalled'   // 未安装
  | 'restarting';    // 重启中

/**
 * OpenCode Webview 提供者类 - 重构版本
 */
export class OpencodeWebviewProvider implements vscode.WebviewViewProvider, IWebviewProvider {
  // === Webview 引用 ===
  private webviewView: vscode.WebviewView | undefined;
  private webviewPanel: vscode.WebviewPanel | undefined;
  private helpWebviewPanel: vscode.WebviewPanel | undefined;

  // === 状态管理（简化） ===
  private currentState: WebviewState = 'initializing';
  private isInitializing: boolean = false;

  // === 定时器管理（统一） ===
  private timers: {
    visibility: NodeJS.Timeout | undefined;
    startup: NodeJS.Timeout | undefined;
    restart: NodeJS.Timeout | undefined;
  } = { visibility: undefined, startup: undefined, restart: undefined };

  // === 其他 ===
  private outputChannel: vscode.OutputChannel;
  private eventManager: OpenCodeEventManager;

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
   * 处理进程状态变化事件
   */
  private handleProcessStateChange(data: ProcessStateChangeEvent): void {
    // 在重启或启动过程中，忽略 NotRunning 事件
    // 因为这是中间状态，不应该覆盖当前状态
    if (data.status === OpenCodeStatus.NotRunning) {
      if (this.currentState === 'restarting') {
        this.log('重启过程中忽略 NotRunning 事件');
        return;
      }
      if (this.currentState === 'initializing') {
        this.log('启动过程中忽略 NotRunning 事件');
        return;
      }
    }

    const newState = this.mapOpenCodeStatusToWebviewState(data.status);
    if (newState) {
      this.currentState = newState;
      this.updateUIByStatus({ state: newState, message: data.error || '' });

      // 处理重启超时
      if (data.status === OpenCodeStatus.Restarting) {
        this.clearTimers('restart');
        this.timers.restart = setTimeout(async () => {
          this.log('重启超时（30 秒），检查实际状态');
          await this.initializeWebview();
        }, 30000);
      } else if (data.status === OpenCodeStatus.Running) {
        // 清除所有定时器
        this.clearTimers('all');
        this.log('进程运行中，清除所有定时器');
      }
    }
  }

  /**
   * 处理连接状态变化事件
   */
  private handleConnectionChange(data: ConnectionChangeEvent): void {
    if (data.connected) {
      // 连接成功，清除重启超时定时器
      this.clearTimers('restart');
      this.currentState = 'ready';
      this.setState('ready', '');
    } else {
      // 连接断开，只在非初始化、非重启、非启动状态下显示错误
      if (!this.isInitializing && this.currentState !== 'restarting' && this.currentState !== 'initializing') {
        this.currentState = 'error';
        this.setState('error', l10n.t('status.notRunning'));
      }
      // 在重启或启动过程中忽略连接断开事件
      if (this.currentState === 'restarting' || this.currentState === 'initializing') {
        this.log('重启/启动过程中忽略连接断开事件');
      }
    }
  }

  /**
   * 映射 OpenCodeStatus 到 WebviewState
   */
  private mapOpenCodeStatusToWebviewState(status: OpenCodeStatus): WebviewState | null {
    switch (status) {
      case OpenCodeStatus.Running:
        return 'ready';
      case OpenCodeStatus.NotRunning:
        return 'error';
      case OpenCodeStatus.NotInstalled:
        return 'notInstalled';
      case OpenCodeStatus.Restarting:
        return 'restarting';
      case OpenCodeStatus.Error:
        return 'error';
      default:
        return null;
    }
  }

  /**
   * 统一的 Webview 初始化方法
   * 带防抖，防止重复调用
   */
  private async initializeWebview(): Promise<void> {
    // 防止重复初始化
    if (this.isInitializing) {
      this.log('初始化正在进行中，跳过');
      return;
    }

    this.isInitializing = true;
    this.currentState = 'initializing';
    this.setState('loading', l10n.t('status.checkingStatus'));

    try {
      // 单次状态检查（5 秒超时）
      const result = await this.checkStatusWithTimeout(5000);

      // 更新状态
      this.currentState = result.state;
      this.updateUIByStatus(result);

      this.log(`初始化完成: ${result.state}`);
    } catch (error) {
      this.log(`初始化失败: ${error}`);
      this.currentState = 'error';
      this.setState('error', l10n.t('message.initFailed', String(error)));
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * 带超时和错误分类的状态检查
   */
  private async checkStatusWithTimeout(timeout: number): Promise<{
    state: WebviewState;
    message: string;
  }> {
    const statusPromise = this.openCodeManager.getStatus();

    const timeoutPromise = new Promise<OpenCodeStatus>((resolve) => {
      setTimeout(() => resolve(OpenCodeStatus.NotRunning), timeout);
    });

    const status = await Promise.race([statusPromise, timeoutPromise]);

    // 映射状态
    switch (status) {
      case OpenCodeStatus.Running:
        return { state: 'ready', message: '' };
      case OpenCodeStatus.NotInstalled:
        return { state: 'notInstalled', message: l10n.t('status.notInstalled') };
      case OpenCodeStatus.NotRunning:
      default:
        // 尝试连接检查以区分"未运行"和"超时"
        const connected = await this.openCodeManager.checkConnection(2000);
        if (connected) {
          return { state: 'ready', message: '' };
        }
        return { state: 'error', message: l10n.t('status.notRunning') };
    }
  }

  /**
   * 根据状态结果更新 UI
   */
  private updateUIByStatus(result: { state: WebviewState; message: string }): void {
    switch (result.state) {
      case 'ready':
        this.setState('ready', '');
        break;
      case 'error':
        this.setState('error', result.message || l10n.t('status.error'));
        break;
      case 'notInstalled':
        this.setState('notInstalled', result.message || l10n.t('status.notInstalled'));
        break;
      case 'restarting':
        this.setState('restarting', result.message || l10n.t('status.restarting'));
        break;
      case 'initializing':
        this.setState('loading', result.message || l10n.t('status.checkingStatus'));
        break;
      default:
        this.log(`未知状态: ${result.state}`);
    }
  }

  /**
   * 清理指定类型的定时器
   */
  private clearTimers(type?: 'visibility' | 'startup' | 'restart' | 'all'): void {
    if (type === 'visibility' || type === 'all') {
      if (this.timers.visibility) {
        clearTimeout(this.timers.visibility);
        this.timers.visibility = undefined;
      }
    }
    if (type === 'startup' || type === 'all') {
      if (this.timers.startup) {
        clearTimeout(this.timers.startup);
        this.timers.startup = undefined;
      }
    }
    if (type === 'restart' || type === 'all') {
      if (this.timers.restart) {
        clearTimeout(this.timers.restart);
        this.timers.restart = undefined;
      }
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
    this.log('========== resolveWebviewView 被调用 ==========');
    this.webviewView = webviewView;

    // 配置 webview
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'resources')
      ]
    };

    // 设置消息监听
    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => await this.handleMessage(message),
      undefined,
      this.context.subscriptions
    );

    // 设置可见性监听（带防抖）
    webviewView.onDidChangeVisibility(() => {
      this.log(`Webview 可见性变化: ${webviewView.visible}`);
      if (webviewView.visible) {
        this.clearTimers('visibility');
        this.timers.visibility = setTimeout(() => {
          this.initializeWebview();
        }, 300);
      }
    });

    // 更新 HTML 内容
    this.updateWebview();

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
          this.log('收到 ready 消息，开始初始化');
          await this.initializeWebview();
          break;

        case 'startOpencode':
          await this.startOpenCode();
          break;

        case 'checkConnection':
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
          await this.showHelpPanel();
          break;

        case 'changeLanguage':
          vscode.commands.executeCommand('workbench.action.openSettings', 'opencode.language');
          break;

        default:
          this.log(`未知消息类型: ${message.type}`);
      }
    } catch (error) {
      this.log(`处理消息时出错: ${error}`);
      this.setState('error', l10n.t('message.initFailed', String(error)));
    }
  }

  /**
   * 启动 OpenCode
   */
  private async startOpenCode(): Promise<void> {
    try {
      this.log('开始启动 OpenCode...');
      this.currentState = 'initializing';
      this.setState('loading', l10n.t('status.starting'));

      // 检查工作区
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        this.currentState = 'error';
        this.setState('error', l10n.t('message.noWorkspace'));
        return;
      }

      // 在后台启动
      const success = await this.openCodeManager.startInBackground();

      if (success) {
        this.log('OpenCode 启动成功，等待进程事件...');
        this.setState('loading', l10n.t('status.waiting'));
        // 事件系统会处理后续状态更新
      } else {
        // 启动失败，但可能是超时导致的，等待几秒后再次检查状态
        this.log('OpenCode 启动返回失败，等待进程可能仍在启动...');
        this.setState('loading', l10n.t('status.waiting'));

        // 等待 5 秒后再次检查状态
        setTimeout(async () => {
          const status = await this.openCodeManager.getStatus();
          this.log(`延迟检查状态: ${status}`);

          if (status === OpenCodeStatus.Running) {
            this.currentState = 'ready';
            this.setState('ready', '');
          } else if (status === OpenCodeStatus.NotRunning) {
            // 再检查一次连接，可能只是健康检查超时
            const connected = await this.openCodeManager.checkConnection(3000);
            if (connected) {
              this.currentState = 'ready';
              this.setState('ready', '');
            } else {
              this.currentState = 'error';
              this.setState('error', l10n.t('message.startTimeout'));
            }
          } else {
            this.currentState = 'error';
            this.setState('error', l10n.t('message.startFailed'));
          }
        }, 5000);
      }
    } catch (error) {
      this.log(`启动失败: ${error}`);
      this.currentState = 'error';
      this.setState('error', l10n.t('message.startFailed', String(error)));
    }
  }

  /**
   * 检查并通知连接状态
   */
  private async checkAndNotifyConnection(): Promise<void> {
    const connected = await this.openCodeManager.checkConnection();

    if (connected) {
      this.currentState = 'ready';
      this.setState('ready', '');
    } else {
      this.currentState = 'error';
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
   * 获取 Webview HTML 内容
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
      function t(key, ...args) {
        return key;
      }
    }

    const vscode = acquireVsCodeApi();
    const SAVED_STATE_KEY = 'opencodeState';
    const STATE_EXPIRY_MS = 300000; // 5分钟有效期

    // 保存状态到 vscode.persistence
    function saveState(state, message) {
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
      const invalidStates = ['error', 'notInstalled', 'loading', 'restarting'];
      if (invalidStates.includes(savedState.state)) {
        console.log('状态无效或为临时状态，需要重新检查:', savedState.state);
        return false;
      }
      return age < STATE_EXPIRY_MS;
    }

    function setState(state, message) {
      console.log('setState:', state, message);
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
          console.warn('收到意外的 ready 消息，已忽略');
          break;
      }
    });

    window.addEventListener('load', () => {
      console.log('=== 页面 load 事件触发 ===');

      const savedState = loadState();
      console.log('保存的状态:', savedState);
      console.log('状态是否有效:', isStateValid(savedState));

      if (isStateValid(savedState)) {
        console.log('恢复保存的状态:', savedState);
        setState(savedState.state, savedState.message);
      } else {
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
   */
  public toggleSidebar(): void {
    if (this.webviewView && !this.webviewPanel) {
      this.createOrShowWebviewPanel();
    } else if (this.webviewPanel) {
      this.webviewPanel.dispose();
      this.webviewPanel = undefined;
    }
  }

  /**
   * 创建或显示 Webview 面板
   */
  private createOrShowWebviewPanel(): void {
    if (this.webviewPanel) {
      this.webviewPanel.reveal(this.webviewPanel.viewColumn || vscode.ViewColumn.Beside, true);
      return;
    }

    this.webviewPanel = vscode.window.createWebviewPanel(
      WEBVIEW_VIEW_TYPE,
      'OpenCode',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'resources')
        ]
      }
    );

    this.webviewPanel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => await this.handleMessage(message),
      undefined,
      this.context.subscriptions
    );

    // 简化：只监听关闭事件
    this.webviewPanel.onDidDispose(() => {
      this.log('WebviewPanel 已关闭');
      this.webviewPanel = undefined;
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
    if (this.helpWebviewPanel) {
      this.helpWebviewPanel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

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

    try {
      const helpContent = await this.getHelpContent();
      this.helpWebviewPanel.webview.html = helpContent;
    } catch (error) {
      this.log(`加载帮助文档失败: ${error}`);
      this.helpWebviewPanel.webview.html = this.getFallbackHelpContent();
    }

    this.helpWebviewPanel.onDidDispose(() => {
      this.helpWebviewPanel = undefined;
    });
  }

  /**
   * 生成帮助文档内容
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
   * 备用帮助文档内容
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

    if (!this.webviewView || !this.webviewView.webview) {
      this.log('Webview 已被释放，无法刷新');
      return;
    }

    this.setState('loading', l10n.t('status.refreshing'));

    try {
      const statusPromise = this.openCodeManager.getStatus();
      const timeoutPromise = new Promise<OpenCodeStatus>((resolve) => {
        setTimeout(() => resolve(OpenCodeStatus.NotRunning), 3000);
      });

      const status = await Promise.race([statusPromise, timeoutPromise]);
      this.log(`刷新检查到的状态: ${status}`);

      if (status === OpenCodeStatus.Running) {
        const isConnected = await this.openCodeManager.checkConnection(2000);

        if (isConnected) {
          this.log('OpenCode 连接正常，重新加载 iframe');
          this.updateWebview();
          setTimeout(() => {
            this.setState('ready', '');
          }, 100);
        } else {
          this.log('OpenCode 进程运行但连接失败');
          this.setState('error', l10n.t('message.restartFailed', 'OpenCode'));
        }
      } else {
        this.log(`OpenCode 状态: ${status}`);
        if (status === OpenCodeStatus.NotInstalled) {
          this.setState('notInstalled', l10n.t('status.notInstalled'));
        } else {
          this.setState('error', l10n.t('status.notRunning'));
        }
      }
    } catch (error) {
      this.log(`刷新过程中出错: ${error}`);
      this.setState('error', l10n.t('status.notRunning'));
    }
  }

  /**
   * 销毁资源
   */
  public dispose(): void {
    // 清理所有定时器
    this.clearTimers('all');

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
