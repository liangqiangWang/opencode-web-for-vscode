import * as vscode from 'vscode';
import * as path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';

import { OpenCodeClient } from './OpenCodeClient';
import { OpenCodeConfig, OpenCodeStatus, FileReference } from './types';
import { normalizePath } from '../utils/pathUtils';
import { isWindows } from '../utils/platformUtils';
import { ConfigurationService } from '../services/configuration';
import {
  CHECK_COMMANDS,
  INSTALL_COMMANDS,
  START_ARGS,
  TERMINAL_NAME
} from '../common/constants';
import {
  OpenCodeTimeoutError,
  WorkspaceError
} from '../common/errors';
import { getEventManager } from './EventManager';

const execAsync = promisify(exec);

/**
 * 安装状态缓存
 */
interface InstallationCache {
  isInstalled: boolean | null;
  timestamp: number;
}

/**
 * OpenCode 核心管理器
 * 负责 opencode 进程的启动、连接和交互
 */
export class OpenCodeManager {
  private client: OpenCodeClient;
  private config: OpenCodeConfig;
  private baseUrl: string;
  private configService: ConfigurationService;
  private eventManager = getEventManager();
  private context: vscode.ExtensionContext;
  private opencodeProcess?: import('child_process').ChildProcess; // OpenCode 后台进程
  private terminal?: vscode.Terminal;

  // 安装状态缓存
  private installationCache: InstallationCache = {
    isInstalled: null,
    timestamp: 0
  };
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5分钟缓存

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.configService = ConfigurationService.getInstance();
    this.config = this.loadConfig();
    this.baseUrl = `http://localhost:${this.config.defaultPort}`;
    this.client = new OpenCodeClient(this.config.defaultPort, this.config);
  }

  /**
   * 启动或连接到 opencode 进程
   */
  async startOrAttach(): Promise<void> {
    // 检查是否已安装 opencode
    const isInstalled = await this.checkOpenCodeInstalled();
    if (!isInstalled) {
      const install = await vscode.window.showWarningMessage(
        'OpenCode is not installed. Do you want to install it?',
        'Install',
        'Cancel'
      );

      if (install === 'Install') {
        await this.installOpenCode();
      }
      return;
    }

    // 检查 opencode 是否正在运行
    const isRunning = await this.checkOpenCodeRunning();

    if (isRunning) {
      // 已运行，检查是否有 opencode 终端
      const existingTerminal = vscode.window.terminals.find(
        terminal => terminal.name === TERMINAL_NAME
      );

      if (existingTerminal) {
        // 显示现有终端
        existingTerminal.show();
      } else {
        // 连接到现有进程
        await this.attach(this.getWorkspacePath()!);
      }
    } else {
      // 未运行，启动 opencode
      const workspacePath = this.getWorkspacePath();
      await this.start(workspacePath!);
    }
  }

  /**
   * 启动一个opencode进程
   */
  public async start(workspacePath: string): Promise<void> {
    if (!workspacePath) {
      throw new WorkspaceError('Please open a workspace first');
    }

    // 不再显示启动消息，避免打扰用户
    // vscode.window.showInformationMessage('Starting OpenCode...');

    // 创建终端
    const terminal = this.createOpenCodeTerminal(workspacePath);
    terminal.show();

    // 发送启动命令
    const command = `opencode ${START_ARGS.PORT} ${this.config.defaultPort}`;
    terminal.sendText(command);

    // 等待服务就绪
    const isReady = await this.waitForReady();
    if (!isReady) {
      vscode.window.showErrorMessage('OpenCode start timeout');
      throw new OpenCodeTimeoutError(this.config.healthCheckTimeout);
    }

    // 等待启动完成
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  /**
   * 在后台启动一个 opencode 进程（不显示终端）
   */
  public async startInBackground(): Promise<boolean> {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      const message = '请先打开一个工作区（文件夹）后再启动 OpenCode';
      console.log(`无法启动 OpenCode: ${message}`);
      // 不再显示 toast，由调用方（WebviewProvider）在页面上显示提示
      this.eventManager.emitProcessError(message);
      return false;
    }

    try {
      // 检查是否已经在运行
      const isRunning = await this.checkConnection();
      if (isRunning) {
        console.log('OpenCode 已经在运行，无需重复启动');
        return true;
      }

      // 使用 child_process.spawn 直接启动后台进程
      const { spawn } = require('child_process');

      const args = [
        START_ARGS.PORT,
        String(this.config.defaultPort)
      ];

      console.log(`启动 OpenCode: opencode ${args.join(' ')}`);

      // 在后台启动 OpenCode 进程
      const childProc = spawn('opencode', args, {
        cwd: workspacePath,
        detached: true,  // 让进程独立于父进程运行
        stdio: ['ignore', 'pipe', 'pipe'],  // 重定向输出
        env: {
          ...process.env,  // 注意：这里的 process 是 Node.js 全局对象
          OPENCODE_CALLER: 'vscode'
        }
      });

      // 保存进程引用，用于后续管理
      this.opencodeProcess = childProc;

      // 监听进程输出（用于调试）
      if (childProc.stdout) {
        childProc.stdout.on('data', (data: Buffer) => {
          console.log(`[OpenCode] ${data.toString().trim()}`);
        });
      }

      if (childProc.stderr) {
        childProc.stderr.on('data', (data: Buffer) => {
          console.error(`[OpenCode Error] ${data.toString().trim()}`);
        });
      }

      // 监听进程退出
      childProc.on('exit', (code: number, signal: string) => {
        console.log(`OpenCode 进程退出，代码: ${code}, 信号: ${signal}`);
        this.eventManager.emitProcessStateChanged({
          status: OpenCodeStatus.NotRunning,
          timestamp: Date.now()
        });
      });

      childProc.on('error', (error: Error) => {
        console.error(`OpenCode 进程错误: ${error}`);
        this.eventManager.emitProcessError(`进程错误: ${error.message}`);
      });

      // 因为使用了 detached: true，让子进程独立运行
      childProc.unref();

      // 等待服务就绪
      const isReady = await this.waitForReady();

      if (!isReady) {
        console.log('OpenCode 启动超时');
        this.eventManager.emitProcessError('启动超时');
        return false;
      }

      // 等待启动完成
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 最终检查一次连接
      const finalCheck = await this.checkConnection();

      if (!finalCheck) {
        console.log('OpenCode 连接检查失败');
        this.eventManager.emitProcessError('连接检查失败');
        return false;
      }

      console.log('OpenCode 后台启动成功');

      // 触发进程状态变化事件
      this.eventManager.emitProcessStateChanged({
        status: OpenCodeStatus.Running,
        timestamp: Date.now()
      });

      // 触发连接状态变化事件
      this.eventManager.emitConnectionChanged({
        connected: true,
        timestamp: Date.now()
      });

      return true;
    } catch (error) {
      console.log(`OpenCode 后台启动失败: ${error}`);
      this.eventManager.emitProcessError(`启动失败: ${error}`);
      return false;
    }
  }

  /**
   * 连接到已有进程
   */
  public async attach(workspacePath: string): Promise<void> {
    if (!workspacePath) {
      throw new WorkspaceError('Please open a workspace first');
    }

    // 创建终端
    const terminal = this.createOpenCodeTerminal(workspacePath);
    terminal.show();

    // 发送 attach 命令
    const command = `opencode ${START_ARGS.ATTACH} ${this.baseUrl} ${START_ARGS.DIR} ${workspacePath}`;
    terminal.sendText(command);

    // 等待服务就绪
    const isReady = await this.waitForReady();
    if (!isReady) {
      vscode.window.showErrorMessage('OpenCode attach timeout');
      throw new OpenCodeTimeoutError(this.config.healthCheckTimeout);
    }

    // 等待attach 完成
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  /**
   * 发送prompt到 opencode TUI
   */
  async sendPromptToTUI(content: string): Promise<void> {
    if (!content) {
      vscode.window.showErrorMessage('No content to send');
      return;
    }

    // 检查 opencode 是否正在运行，未运行则先启动
    const isRunning = await this.checkOpenCodeRunning();
    if (!isRunning) {
      const success = await this.startInBackground();
      if (success) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 等待启动完成
        // vscode.window.showInformationMessage('OpenCode is ready');
      } else {
        vscode.window.showErrorMessage('Failed to start OpenCode');
        return;
      }
    }

    // 确保 TUI 终端显示（如果已存在就显示，不存在就创建）
    await this.showTui();

    vscode.window.showInformationMessage('Sending code to OpenCode...');

    // 添加 prompt
    const appendSuccess = await this.client.appendPrompt(content);
    if (!appendSuccess) {
      vscode.window.showErrorMessage('Failed to send code to OpenCode');
      return;
    }

    // 添加一个小延迟，确保 prompt 被追加
    await new Promise(resolve => setTimeout(resolve, 100));

    // 再自动提交 prompt
    const submitSuccess = await this.client.submitPrompt();
    if (submitSuccess) {
      vscode.window.showInformationMessage('Code sent to OpenCode');
    } else {
      vscode.window.showErrorMessage('Code added, please press Enter to send manually');
    }
  }

  /**
   * 添加prompt到 opencode TUI
   */
  async appendPromptToTUI(content: string): Promise<void> {
    if (!content) {
      vscode.window.showErrorMessage('No content to send');
      return;
    }

    // 检查 opencode 是否正在运行，未运行则先启动
    const isRunning = await this.checkOpenCodeRunning();
    if (!isRunning) {
      const success = await this.startInBackground();
      if (success) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 等待启动完成
        vscode.window.showInformationMessage('OpenCode is ready');
      } else {
        vscode.window.showErrorMessage('Failed to start OpenCode');
        return;
      }
    }

    // 确保 TUI 终端显示（如果已存在就显示，不存在就创建）
    await this.showTui();

    // 添加prompt
    const appendSuccess = await this.client.appendPrompt(content);
    if (!appendSuccess) {
      vscode.window.showErrorMessage('Failed to send code to OpenCode');
      return;
    }
    vscode.window.showInformationMessage('已添加数据到 OpenCode 终端...');
  }

  /**
   * 检查 opencode 是否已安装（增强版，使用双重检测）
   * 1. 首先检查 PATH（快速）
   * 2. 然后实际执行命令（可靠）
   * 3. 使用缓存避免频繁检查
   */
  private async checkOpenCodeInstalled(): Promise<boolean> {
    // 检查缓存
    const now = Date.now();
    if (this.installationCache.isInstalled !== null &&
        (now - this.installationCache.timestamp) < this.CACHE_DURATION) {
      this.log(`使用缓存的安装状态: ${this.installationCache.isInstalled}`);
      return this.installationCache.isInstalled;
    }

    this.log('开始检查 OpenCode 安装状态...');

    // 方法1: 检查命令是否在 PATH 中（快速）
    let inPath = false;
    try {
      const command = isWindows() ? CHECK_COMMANDS.WINDOWS : CHECK_COMMANDS.UNIX;
      await execAsync(command, { timeout: 2000 });
      inPath = true;
      this.log('OpenCode 命令在 PATH 中找到');
    } catch (error) {
      this.log(`OpenCode 命令不在 PATH 中: ${error}`);
    }

    // 方法2: 实际执行命令验证（可靠，但需要超时保护）
    let canExecute = false;
    if (inPath) {
      canExecute = await this.verifyOpenCodeExecutable();
    }

    const isInstalled = inPath && canExecute;

    // 更新缓存
    this.installationCache = {
      isInstalled,
      timestamp: now
    };

    this.log(`OpenCode 安装状态最终结果: ${isInstalled} (PATH: ${inPath}, 可执行: ${canExecute})`);

    return isInstalled;
  }

  /**
   * 验证 OpenCode 是否可以实际执行
   * 通过执行 opencode --version 命令
   */
  private verifyOpenCodeExecutable(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.log('验证 OpenCode 可执行性...');

        const proc = spawn('opencode', ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let timedOut = false;

        // 设置超时（5秒）
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
          this.log('OpenCode 验证超时（5秒）');
          resolve(false);
        }, 5000);

        proc.on('error', (error) => {
          clearTimeout(timer);
          this.log(`OpenCode 执行失败: ${error.message}`);
          resolve(false);
        });

        proc.on('close', (code) => {
          clearTimeout(timer);
          if (!timedOut) {
            const success = code === 0;
            this.log(`OpenCode 验证结果: ${success ? '成功' : '失败'} (退出码: ${code})`);
            resolve(success);
          }
        });

      } catch (error) {
        this.log(`OpenCode 验证异常: ${error}`);
        resolve(false);
      }
    });
  }

  /**
   * 清除安装状态缓存
   * 用于强制重新检查安装状态
   */
  private clearInstallationCache(): void {
    this.installationCache = {
      isInstalled: null,
      timestamp: 0
    };
    this.log('已清除安装状态缓存');
  }

  /**
   * 日志输出（私有方法）
   */
  private log(message: string): void {
    console.log(`[OpenCodeManager] ${message}`);
  }

  /**
   * 安装 opencode
   */
  private async installOpenCode(): Promise<void> {
    try {
      const terminal = vscode.window.createTerminal('Install OpenCode');
      terminal.show();
      const command = isWindows() ? INSTALL_COMMANDS.WINDOWS : INSTALL_COMMANDS.UNIX;
      terminal.sendText(command);
      vscode.window.showInformationMessage('Installing OpenCode. Please restart VSCode after installation completes.');
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to install OpenCode: ${error}`);
    }
  }

  /**
   * 检查 opencode 是否正在运行（内部使用）
   */
  private async checkOpenCodeRunning(): Promise<boolean> {
    return await this.checkConnection();
  }

  /**
   * 检查 OpenCode 连接状态（公共方法）
   * 使用健康检查端点进行连接验证
   * @param timeout 可选的超时时间（毫秒）
   * @returns 是否已连接
   */
  public async checkConnection(timeout?: number): Promise<boolean> {
    return await this.client.checkHealth(timeout);
  }

  /**
   * 等待 opencode 就绪
   */
  private async waitForReady(): Promise<boolean> {
    const maxRetries = this.config.maxRetries;
    const retryInterval = this.config.retryInterval;

    for (let i = 0; i < maxRetries; i++) {
      const isReady = await this.client.checkAppReady();
      if (isReady) {
        return true;
      }
      // 等待一段时间后重试
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }

    return false;
  }

  /**
   * 获取文件引用信息
   */
  public getFileReference(editor: vscode.TextEditor): FileReference | null {
    const { document, selection } = editor;
    const workspacePath = this.getWorkspacePath();

    if (!workspacePath) {
      vscode.window.showErrorMessage('Please open a workspace first');
      return null;
    }

    // 获取文件的相对路径
    const absolutePath = document.uri.fsPath;
    const relativePath = normalizePath(path.relative(workspacePath, absolutePath));

    // 检查是否有选中的文本
    if (selection.isEmpty) {
      // 无选中，返回文件引用
      return {
        absolutePath,
        reference: `@${relativePath}`,
        relativePath
      };
    }

    // 有选中文本，返回行号范围
    const startLine = selection.start.line + 1; // 行号从 1 开始
    const endLine = selection.end.line + 1;

    let reference: string;
    if (startLine === endLine) {
      // 单行选中
      reference = `@${relativePath}#L${startLine}`;
    } else {
      // 多行选中
      reference = `@${relativePath}#L${startLine}-L${endLine}`;
    }

    // 获取选中文本
    const selectedText = document.getText(selection);

    return {
      reference,
      relativePath,
      absolutePath,
      startLine,
      endLine,
      selectedText
    };
  }

  /**
   * 获取工作区路径
   */
  private getWorkspacePath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    return workspaceFolders && workspaceFolders.length > 0
      ? workspaceFolders[0].uri.fsPath
      : undefined;
  }

  /**
   * 加载配置
   */
  private loadConfig(): OpenCodeConfig {
    const port = this.configService.getPort();
    const timeout = this.configService.getTimeout();

    return {
      defaultPort: port,
      healthCheckTimeout: timeout,
      maxRetries: 10,
      retryInterval: 500
    };
  }

  /**
   * 获取当前状态
   */
  async getStatus(): Promise<OpenCodeStatus> {
    const isInstalled = await this.checkOpenCodeInstalled();
    if (!isInstalled) {
      return OpenCodeStatus.NotInstalled;
    }

    const isRunning = await this.checkOpenCodeRunning();
    if (isRunning) {
      return OpenCodeStatus.Running;
    }

    return OpenCodeStatus.NotRunning;
  }

  /**
   * 重新加载配置
   */
  reloadConfig(): void {
    this.config = this.loadConfig();
    this.client = new OpenCodeClient(this.config.defaultPort, this.config);
  }

  /**
   * 显示 TUI 终端
   */
  async showTui(): Promise<void> {
    const workspacePath = this.getWorkspacePath();
    if (!workspacePath) {
      vscode.window.showErrorMessage('Please open a workspace first');
      return;
    }

    // 检查是否已存在 TUI 终端
    const existingTerminal = vscode.window.terminals.find(
      terminal => terminal.name === TERMINAL_NAME
    );

    if (existingTerminal) {
      // 终端已存在，直接显示它（复用）
      existingTerminal.show();
      return;
    }

    // 检查 OpenCode 是否正在运行
    const isRunning = await this.checkOpenCodeRunning();

    if (isRunning) {
      // OpenCode 正在运行，创建新的 TUI 终端并 attach
      const terminal = this.createOpenCodeTerminal(workspacePath);
      terminal.show();

      // 发送 attach 命令
      const command = `opencode ${START_ARGS.ATTACH} ${this.baseUrl} ${START_ARGS.DIR} ${workspacePath}`;
      terminal.sendText(command);

      // 等待 attach 完成
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      // OpenCode 未运行，创建新的 TUI 终端并启动
      const terminal = this.createOpenCodeTerminal(workspacePath);
      terminal.show();

      // 发送启动命令
      const command = `opencode ${START_ARGS.PORT} ${this.config.defaultPort}`;
      terminal.sendText(command);
    }
  }

  /**
   * 创建 OpenCode TUI 终端（统一方法）
   * @param workspacePath 工作区路径
   * @returns 终端实例
   */
  private createOpenCodeTerminal(workspacePath: string): vscode.Terminal {
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      cwd: workspacePath,
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      iconPath: vscode.Uri.joinPath(
        this.context.extensionUri,
        'resources',
        'icons',
        'opencode.svg'
      ),
      env: {
        OPENCODE_CALLER: 'vscode',
      },
    });

    // 保存终端引用
    this.terminal = terminal;

    return terminal;
  }

  /**
   * 杀掉 OpenCode 进程
   * @param emitEvent 是否触发事件（默认为 true）
   */
  async killProcess(emitEvent: boolean = true): Promise<void> {
    try {
      const port = this.config.defaultPort;
      const command = isWindows()
        ? `netstat -ano | findstr :${port} | awk '{print $5}' | xargs taskkill /F /PID`
        : `lsof -ti:${port} | xargs kill -9`;

      await execAsync(command);

      // 根据参数决定是否触发事件
      if (emitEvent) {
        // 触发进程状态变化事件
        this.eventManager.emitProcessStateChanged({
          status: OpenCodeStatus.NotRunning,
          timestamp: Date.now()
        });

        // 触发连接状态变化事件
        this.eventManager.emitConnectionChanged({
          connected: false,
          timestamp: Date.now()
        });
      }

      // 事件系统会自动通知 UI，不再需要显式通知
    } catch (error) {
      // 根据参数决定是否触发事件
      if (emitEvent) {
        // 如果进程不存在，这实际上是期望的结果
        // 仍然触发状态变化事件以确保 UI 同步
        this.eventManager.emitProcessStateChanged({
          status: OpenCodeStatus.NotRunning,
          timestamp: Date.now()
        });

        this.eventManager.emitConnectionChanged({
          connected: false,
          timestamp: Date.now()
        });
      }

      // 事件系统会自动通知 UI，不再需要显式通知
    }
  }

  /**
   * 重启 OpenCode 进程
   */
  async restartProcess(): Promise<void> {
    try {
      // 触发重启中状态
      this.eventManager.emitProcessStateChanged({
        status: OpenCodeStatus.Restarting,
        timestamp: Date.now()
      });

      // 先杀掉现有进程（不触发事件，避免覆盖 Restarting 状态）
      await this.killProcess(false);

      // 等待一下，确保进程被完全终止
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 在后台重新启动
      const success = await this.startInBackground();
      if (!success) {
        throw new Error('后台启动失败');
      }
      // startInBackground 成功后会自动触发 Running 状态
    } catch (error) {
      this.eventManager.emitProcessStateChanged({
        status: OpenCodeStatus.Error,
        timestamp: Date.now(),
        error: String(error)
      });
      this.eventManager.emitProcessError(`重启失败: ${error}`);
      vscode.window.showErrorMessage(`重启进程失败: ${error}`);
    }
  }
}
