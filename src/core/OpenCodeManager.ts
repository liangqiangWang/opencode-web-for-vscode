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
  TERMINAL_NAME,
  BACKGROUND_TERMINAL_NAME,
  WINDOWS_COMMANDS
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
  private terminal?: vscode.Terminal;  // TUI 终端
  private backgroundTerminal?: vscode.Terminal;  // 后台终端

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

    // 监听终端关闭事件
    const closeDisposable = vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal.name === BACKGROUND_TERMINAL_NAME) {
        this.log('Background terminal closed');
        this.backgroundTerminal = undefined;

        // 触发状态变化事件
        this.eventManager.emitProcessStateChanged({
          status: OpenCodeStatus.NotRunning,
          timestamp: Date.now()
        });

        this.eventManager.emitConnectionChanged({
          connected: false,
          timestamp: Date.now()
        });
      }
    });

    context.subscriptions.push(closeDisposable);
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
      this.log(`无法启动 OpenCode: ${message}`);
      this.eventManager.emitProcessError(message);
      return false;
    }

    try {
      // 检查后台终端是否已存在
      const existingBackground = vscode.window.terminals.find(
        terminal => terminal.name === BACKGROUND_TERMINAL_NAME
      );

      if (existingBackground) {
        // 终端存在，检查进程是否还在运行
        const isRunning = await this.checkConnection();
        if (isRunning) {
          this.log('Background terminal already exists and process is running');
          this.backgroundTerminal = existingBackground;
          return true;
        } else {
          // 终端存在但进程已死，清理并重新创建
          this.log('Existing terminal found but process is not running, disposing it');
          existingBackground.dispose();
        }
      }

      // 创建后台终端
      const terminal = this.createBackgroundTerminal(workspacePath);

      // 构建启动命令
      const command = isWindows()
        ? `opencode.cmd ${START_ARGS.PORT} ${this.config.defaultPort}`
        : `opencode ${START_ARGS.PORT} ${this.config.defaultPort}`;

      this.log(`启动 OpenCode: ${command}`);

      // 发送命令到终端（终端在后台执行，不显示）
      terminal.sendText(command);

      // 等待服务就绪（HTTP 健康检查）
      const isReady = await this.waitForReady();

      if (!isReady) {
        this.log('OpenCode 启动超时');
        this.eventManager.emitProcessError('启动超时');
        return false;
      }

      // 等待启动完成
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 最终检查一次连接
      const finalCheck = await this.checkConnection();

      if (!finalCheck) {
        this.log('OpenCode 连接检查失败');
        this.eventManager.emitProcessError('连接检查失败');
        return false;
      }

      this.log('OpenCode 后台启动成功');

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
      this.log(`OpenCode 后台启动失败: ${error}`);
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
      if (isWindows()) {
        // Windows: 使用增强检测
        inPath = await this.checkWindowsInstallation();
      } else {
        // Unix: 保持现有逻辑
        const command = CHECK_COMMANDS.UNIX;
        await execAsync(command, { timeout: 2000 });
        inPath = true;
        this.log('OpenCode 命令在 PATH 中找到');
      }
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
   * Windows 专用安装检测（多层检测，跨 shell 兼容）
   * 针对 nvm 和标准 npm 安装进行优化
   * 支持 PowerShell、cmd、Git Bash、WSL 等多种 shell
   */
  private async checkWindowsInstallation(): Promise<boolean> {
    this.log('开始 Windows 安装检查（跨 shell 兼容）');

    // 方法1a: 尝试 where 命令（PowerShell/cmd）
    try {
      const { stdout } = await execAsync('where opencode', { timeout: 2000 });
      this.log(`✅ [方法1a] 通过 where 找到: ${stdout.trim()}`);
      return true;
    } catch (error: any) {
      this.log(`❌ [方法1a] where 失败`);
    }

    // 方法1b: 尝试 which 命令（Git Bash/WSL）
    try {
      const { stdout } = await execAsync('which opencode', { timeout: 2000, shell: true as any });
      this.log(`✅ [方法1b] 通过 which 找到: ${stdout.trim()}`);
      return true;
    } catch (error: any) {
      this.log(`❌ [方法1b] which 失败`);
    }

    // 方法2: 检查 npm 全局包（兼容 nvm）
    try {
      const { stdout } = await execAsync(WINDOWS_COMMANDS.NPM_CHECK_GLOBAL, {
        timeout: 3000,
        shell: true as any
      });

      if (stdout.includes('opencode-ai')) {
        this.log(`✅ [方法2] 通过 npm 全局包找到`);
        return true;
      }
    } catch (error: any) {
      this.log(`❌ [方法2] npm 检查失败`);
    }

    // 方法3: 直接检查 npm bin 路径（最可靠）
    try {
      const { stdout: npmBinPath } = await execAsync(WINDOWS_COMMANDS.NPM_GET_PREFIX, {
        timeout: 2000,
        shell: true as any
      });

      const path = require('path');
      const fs = require('fs');

      const possiblePaths = [
        path.join(npmBinPath.trim(), 'opencode.cmd'),
        path.join(npmBinPath.trim(), 'opencode'),
        path.join(npmBinPath.trim(), 'node_modules', '.bin', 'opencode.cmd'),
      ];

      for (const exePath of possiblePaths) {
        if (fs.existsSync(exePath)) {
          this.log(`✅ [方法3] 通过文件路径找到: ${exePath}`);
          return true;
        }
      }
    } catch (error: any) {
      this.log(`❌ [方法3] npm 路径检查失败`);
    }

    this.log('❌ Windows 安装检查: 未找到');
    return false;
  }

  /**
   * 验证 OpenCode 是否可以实际执行
   * 通过执行 opencode --version 命令
   */
  private verifyOpenCodeExecutable(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.log('验证 OpenCode 可执行性');

        const spawnOptions: any = {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        };

        // Windows: 需要 shell: true 来执行 .cmd 文件
        if (isWindows()) {
          spawnOptions.shell = true;
        }

        const command = isWindows() ? 'opencode.cmd' : 'opencode';
        const proc = spawn(command, ['--version'], spawnOptions);

        let timedOut = false;
        let output = '';
        let errorOutput = '';

        // 设置超时（5秒）
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
          this.log('❌ 验证超时（5秒）');
          resolve(false);
        }, 5000);

        // 捕获输出
        if (proc.stdout) {
          proc.stdout.on('data', (data: Buffer) => {
            output += data.toString();
          });
        }

        if (proc.stderr) {
          proc.stderr.on('data', (data: Buffer) => {
            errorOutput += data.toString();
          });
        }

        proc.on('error', (error: Error) => {
          clearTimeout(timer);
          this.log(`❌ 验证失败: ${error.message}`);
          resolve(false);
        });

        proc.on('close', (code: number | null) => {
          clearTimeout(timer);
          if (!timedOut) {
            const success = code === 0;
            this.log(`${success ? '✅' : '❌'} 验证结果: ${success ? '成功' : '失败'} (退出码: ${code})`);
            resolve(success);
          }
        });

      } catch (error: any) {
        this.log(`❌ 验证异常: ${error.message}`);
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
   * 创建后台终端（不显示给用户）
   * 用于启动和管理 OpenCode 主进程
   */
  private createBackgroundTerminal(workspacePath: string): vscode.Terminal {
    const terminal = vscode.window.createTerminal({
      name: BACKGROUND_TERMINAL_NAME,
      cwd: workspacePath,
      // 不指定 location → 终端隐藏
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

    this.backgroundTerminal = terminal;
    this.log('Background terminal created');
    return terminal;
  }

  /**
   * 跨平台终止占用指定端口的进程
   * 支持多种 shell：PowerShell、cmd、Git Bash、WSL
   * @param port 端口号
   * @returns 是否成功终止
   */
  private async killProcessByPortCrossPlatform(port: number): Promise<boolean> {
    if (!isWindows()) {
      // Unix/macOS: 使用 lsof
      try {
        const command = `lsof -ti:${port} | xargs kill -9`;
        await execAsync(command, { timeout: 5000 });
        this.log('[Unix] ✅ 进程已终止');
        return true;
      } catch (error) {
        this.log('[Unix] ⚠️ 进程终止失败');
        return false;
      }
    }

    // Windows: 尝试多种方法（兼容不同 shell）
    const methods = [
      {
        name: 'taskkill (cmd)',
        command: `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /F /PID %a`,
        shell: false
      },
      {
        name: 'taskkill (PowerShell)',
        command: `powershell -Command "$pids = (Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess; if ($pids) { Stop-Process -Id $pids -Force -ErrorAction SilentlyContinue }"`,
        shell: true as any
      },
      {
        name: 'bash/netstat',
        command: `pid=$(netstat -aon | findstr :${port} | awk '{print $5}' | head -1 | cut -d: -f2); if [ -n "$pid" ]; then taskkill //F //PID $pid 2>/dev/null; fi`,
        shell: true as any
      }
    ];

    for (const method of methods) {
      try {
        await execAsync(method.command, { timeout: 5000, shell: method.shell });
        this.log(`✅ 通过 ${method.name} 终止进程`);
        return true;
      } catch (error: any) {
        // 静默失败，尝试下一个方法
      }
    }

    return false;
  }

  /**
   * 清理资源（扩展停用时调用）
   */
  public async cleanup(): Promise<void> {
    const terminal = this.backgroundTerminal;

    if (terminal) {
      this.log('清理后台终端（扩展停用）');

      // 发送 Ctrl+C + exit 让终端主动退出
      try {
        terminal.sendText('\x03');
        terminal.sendText('exit');
      } catch (error) {
        this.log(`⚠️ 发送命令失败: ${error}`);
      }

      // 等待进程和终端优雅退出
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 销毁终端引用
      try {
        terminal.sendText('exit');
        await new Promise(resolve => setTimeout(resolve, 500));
        terminal.dispose();
        this.log('✅ 后台终端已清理');
      } catch (error) {
        this.log(`⚠️ 清理终端失败: ${error}`);
      }
      this.backgroundTerminal = undefined;

      // 使用系统命令确保进程被终止
      const port = this.config.defaultPort;
      await this.killProcessByPortCrossPlatform(port);

      this.log('✅ 清理完成');
    }
  }

  /**
   * 杀掉 OpenCode 进程
   * @param emitEvent 是否触发事件（默认为 true）
   */
  async killProcess(emitEvent: boolean = true): Promise<void> {
    this.log('开始终止 OpenCode 进程');

    try {
      // 保存终端引用到本地变量，避免被 onDidCloseTerminal 事件影响
      const terminal = this.backgroundTerminal;

      if (terminal) {
        // 方式1：发送 Ctrl+C + exit 到终端（优雅关闭）
        try {
          terminal.sendText('\x03');  // Ctrl+C
          terminal.sendText('exit');
        } catch (error) {
          this.log(`⚠️ 发送命令失败: ${error}`);
        }

        // 等待进程和终端优雅退出
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 方式2：清理终端引用
        try {
          terminal.sendText('exit');
          await new Promise(resolve => setTimeout(resolve, 500));
          terminal.dispose();
          this.log('✅ 后台终端已销毁');
        } catch (error) {
          this.log(`⚠️ 销毁终端失败: ${error}`);
        }
        this.backgroundTerminal = undefined;
      }

      // 方式3：使用系统命令确保进程被终止（跨 shell 兼容）
      const port = this.config.defaultPort;
      const killed = await this.killProcessByPortCrossPlatform(port);
      if (!killed) {
        this.log('⚠️ 系统命令失败（可能进程已不存在）');
      }

      this.log('✅ 进程终止完成');

      // 触发事件
      if (emitEvent) {
        this.eventManager.emitProcessStateChanged({
          status: OpenCodeStatus.NotRunning,
          timestamp: Date.now()
        });

        this.eventManager.emitConnectionChanged({
          connected: false,
          timestamp: Date.now()
        });
      }
    } catch (error: any) {
      this.log(`❌ 进程终止错误: ${error.message}`);

      // 即使出错也触发事件（进程可能已经不存在）
      if (emitEvent) {
        this.eventManager.emitProcessStateChanged({
          status: OpenCodeStatus.NotRunning,
          timestamp: Date.now()
        });

        this.eventManager.emitConnectionChanged({
          connected: false,
          timestamp: Date.now()
        });
      }
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
