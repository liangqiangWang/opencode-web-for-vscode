/**
 * OpenCode Webview 提供者 - 重构简化版本
 * 负责在侧边栏显示 OpenCode Web 界面
 */

import * as vscode from 'vscode';
import { ConfigurationService } from '../../services/configuration';
import { WebviewMessage, IWebviewProvider } from './types';
import { OpenCodeManager } from '../../core/OpenCodeManager';
import { getEventManager, OpenCodeEventManager } from '../../core/EventManager';
import { EventType } from '../../core/eventTypes';
import { OpenCodeStatus } from '../../core/types';
import { l10n } from '../../l10n';
import { encodePathForUrl } from '../../utils/pathUtils';

/**
 * Webview 视图类型常量
 */
const WEBVIEW_VIEW_TYPE = 'opencodeWebview';

/**
 * Webview 状态枚举
 */
type WebviewState =
  | 'initializing'      // 初始化中
  | 'ready'            // OpenCode 运行中
  | 'idle'             // 空闲（未启动）
  | 'externalRunning'  // 外部进程运行中
  | 'error'            // 错误状态
  | 'notInstalled'     // 未安装
  | 'restarting';      // 重启中

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
    poll: NodeJS.Timeout | undefined;
  } = { visibility: undefined, startup: undefined, restart: undefined, poll: undefined };

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
   * 注意：不再依赖 OpenCodeManager 的事件系统
   * 所有状态检查都通过直接 HTTP 调用
   */
  private setupEventListeners(): void {
    // 不再监听 OpenCodeManager 的事件
    // 所有状态通过 HTTP 健康检查获取
    this.log('事件监听器设置完成（不依赖 OpenCodeManager 事件）');
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
      // Windows 环境下使用更长的超时（环境变量可能未就绪）
      const isWindows = process.platform === 'win32';
      const timeout = isWindows ? 10000 : 5000;
      
      // 单次状态检查
      const result = await this.checkStatusWithTimeout(timeout);

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
        // 检查是否有外部进程
        const hasExternal = await this.openCodeManager.hasExternalOpenCodeProcess();
        if (hasExternal) {
          // 外部进程运行，直接显示 iframe
          return { state: 'ready', message: '' };
        }

        // 尝试连接检查以区分"未运行"和"超时"
        const connected = await this.openCodeManager.checkConnection(2000);
        if (connected) {
          return { state: 'ready', message: '' };
        }
        return { state: 'idle', message: l10n.t('status.notRunning') };
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
      case 'idle':
        this.setState('idle', result.message || l10n.t('status.notRunning'));
        break;
      case 'externalRunning':
        this.setState('externalRunning', result.message || l10n.t('status.externalProcessRunning'));
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
  private clearTimers(type?: 'visibility' | 'startup' | 'restart' | 'poll' | 'all'): void {
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
    if (type === 'poll' || type === 'all') {
      if (this.timers.poll) {
        clearInterval(this.timers.poll);
        this.timers.poll = undefined;
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

        case 'connectToExternal':
          await this.connectToExternalProcess();
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
          vscode.commands.executeCommand('workbench.action.openSettings', 'opencode-web.language');
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
   * 使用直接 HTTP 健康检查，不依赖事件系统
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

      // 在后台启动（只负责启动进程）
      const success = await this.openCodeManager.startInBackground();

      if (success) {
        this.log('OpenCode 启动命令已发送，开始健康检查...');
        this.setState('loading', l10n.t('status.waiting'));
        // 直接使用 HTTP 健康检查
        await this.healthCheckPolling();
      } else {
        this.log('OpenCode 启动命令失败，尝试健康检查...');
        this.setState('loading', l10n.t('status.waiting'));
        // 即使失败也尝试健康检查（进程可能已在运行）
        await this.healthCheckPolling();
      }
    } catch (error) {
      this.log(`启动失败: ${error}`);
      this.currentState = 'error';
      this.setState('error', l10n.t('message.startFailed', String(error)));
    }
  }

  /**
   * 连接到外部 OpenCode 进程
   * 直接切换到 ready 状态，不创建 TUI 终端
   */
  private async connectToExternalProcess(): Promise<void> {
    this.setState('loading', l10n.t('status.connecting'));

    // 直接切换到 ready 状态，不执行 attach()
    // 因为进程已经在运行，只是需要确认用户想要连接
    const isConnected = await this.openCodeManager.checkConnection(2000);

    if (isConnected) {
      this.currentState = 'ready';
      this.setState('ready', '');
    } else {
      // 连接检查失败，回退到 idle 状态
      this.currentState = 'idle';
      this.setState('idle', l10n.t('status.notRunning'));
    }
  }

  /**
   * 直接通过 HTTP 健康检查 API 轮询服务状态
   * 使用 /global/health 端点，简单可靠
   */
  private async healthCheckPolling(): Promise<void> {
    const maxAttempts = 15; // 最多检查 15 次
    const interval = 1000; // 每次间隔 1 秒
    let attempts = 0;

    this.log(`开始健康检查轮询（最多 ${maxAttempts} 次，间隔 ${interval}ms）`);

    // 清除之前的轮询定时器
    this.clearTimers('poll');

    this.timers.poll = setInterval(async () => {
      attempts++;
      this.log(`健康检查 ${attempts}/${maxAttempts}`);

      // 检查是否已经就绪
      if (this.currentState === 'ready') {
        this.log('状态已是 ready，停止轮询');
        this.clearTimers('poll');
        return;
      }

      try {
        // 直接使用 OpenCodeManager 的 checkConnection（内部调用 /global/health）
        const healthy = await this.openCodeManager.checkConnection(2000);

        if (healthy) {
          this.log('健康检查成功：服务已就绪');
          this.clearTimers('poll');
          this.currentState = 'ready';
          this.setState('ready', '');
          return;
        }

        // 达到最大尝试次数
        if (attempts >= maxAttempts) {
          this.log(`健康检查达到最大次数 (${maxAttempts})，服务未就绪`);
          this.clearTimers('poll');
          this.currentState = 'error';
          this.setState('error', l10n.t('message.startTimeout'));
        }
      } catch (error) {
        this.log(`健康检查失败: ${error}`);
      }
    }, interval);
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
   * 单工作区时编码路径为 URL-safe base64 追加到 URL
   * 多工作区或没有工作区时不追加路径
   */
  private getOpenCodeUrl(): string {
    const port = this.configurationService.getPort();
    const baseUrl = `http://localhost:${port}`;

    const workspaceFolder = this.openCodeManager.getWorkspacePath();
    if (workspaceFolder) {
      const encodedPath = encodePathForUrl(workspaceFolder);
      return `${baseUrl}/${encodedPath}/session`;
    }

    return baseUrl;
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

    /* 语言切换按钮容器 - 仅在 ready 状态下显示 */
    .language-button-container {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 1000;
      padding: 12px;
      pointer-events: none;
    }

    .language-button-container .language-toggle-button {
      pointer-events: auto;
      position: static;
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

    .idle-icon-svg {
      width: 32px;
      height: 32px;
      color: var(--vscode-button-background);
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
        container.innerHTML = \`<iframe src="\${url}" frameborder="0" id="opencodeFrame"></iframe>\`;
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
      } else if (state === 'idle') {
        container.innerHTML = \`
          <div class="modern-error-container">
            <div class="icon-wrapper">
              <svg class="idle-icon-svg" viewBox="0 0 48 48">
                <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="2"/>
                <path d="M20 14 L34 24 L20 34 Z" fill="currentColor"/>
              </svg>
            </div>
            <h2 class="error-title">\${t('status.readyToStart')}</h2>
            <p class="error-description">\${message || t('message.clickToStart')}</p>
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
      } else if (state === 'externalRunning') {
        container.innerHTML = \`
          <div class="modern-error-container">
            <div class="icon-wrapper">
              <svg class="external-icon-svg" viewBox="0 0 48 48">
                <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="2"/>
                <path d="M18 12 L30 24 L18 36 Z" fill="currentColor"/>
              </svg>
            </div>
            <h2 class="error-title">\${t('status.externalProcessRunning')}</h2>
            <p class="error-description">\${t('message.connectToExternalProcess')}</p>
            <button class="action-button" id="connectButton">
              <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
              \${t('button.connectToProcess')}
            </button>
          </div>
        \`;
        const connectBtn = document.getElementById('connectButton');
        if (connectBtn) {
          connectBtn.addEventListener('click', () => {
            connectBtn.disabled = true;
            connectBtn.innerHTML = \`
              <svg class="spin" viewBox="0 0 24 24" style="width:16px;height:16px;fill:currentColor">
                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="32" stroke-linecap="round"/>
              </svg>
              \${t('button.connecting')}
            \`;
            vscode.postMessage({ type: 'connectToExternal' });
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
   * 直接使用 HTTP 健康检查，可靠快速
   */
  public async refreshWebview(): Promise<void> {
    this.log('开始刷新 Webview（直接 HTTP 健康检查）');

    if (!this.webviewView || !this.webviewView.webview) {
      this.log('Webview 已被释放，无法刷新');
      return;
    }

    // 停止之前的轮询
    this.clearTimers('poll');

    this.setState('loading', l10n.t('status.refreshing'));

    try {
      // 直接使用 HTTP 健康检查（简单可靠）
      const isConnected = await this.openCodeManager.checkConnection(5000);

      if (isConnected) {
        this.log('刷新：健康检查成功，服务已就绪');
        this.currentState = 'ready';
        this.setState('ready', '');
      } else {
        this.log('刷新：健康检查失败，服务未就绪');
        this.currentState = 'idle';
        this.setState('idle', l10n.t('status.notRunning'));
      }
    } catch (error) {
      this.log(`刷新过程中出错: ${error}`);
      this.currentState = 'error';
      this.setState('error', l10n.t('message.refreshFailed', String(error)));
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
