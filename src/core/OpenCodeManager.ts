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
import { l10n } from '../l10n';

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
        l10n.t('message.openCodeNotInstalled'),
        l10n.t('message.install'),
        l10n.t('message.cancel')
      );

      if (install === l10n.t('message.install')) {
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
      throw new WorkspaceError(l10n.t('message.pleaseOpenWorkspace'));
    }

    // 不再显示启动消息，避免打扰用户
    // vscode.window.showInformationMessage(l10n.t('status.starting'));

    // 创建终端
    const terminal = await this.createOpenCodeTerminal(workspacePath);
    terminal.show();

    // 发送启动命令（跨平台兼容）
    const command = `opencode ${START_ARGS.PORT} ${this.config.defaultPort}`;
    terminal.sendText(command);

    // 等待服务就绪
    const isReady = await this.waitForReady();
    if (!isReady) {
      vscode.window.showErrorMessage(l10n.t('message.openCodeStartTimeout'));
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
      const message = l10n.t('message.noWorkspace');
      this.log(`无法启动 OpenCode: ${message}`);
      this.eventManager.emitProcessError(message);
      return false;
    }

    try {
      this.log(`========== 开始后台启动流程 ==========`);
      this.log(`工作区路径: ${workspacePath}`);
      this.log(`平台: ${process.platform}`);

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
      let command: string;
      
      if (isWindows()) {
        // Windows: 使用增强的启动方式
        // 优先尝试完整路径，失败后回退到 PATH
        command = await this.getWindowsStartupCommand();
      } else {
        // Unix: 直接执行 opencode
        command = `opencode ${START_ARGS.PORT} ${this.config.defaultPort}`;
      }

      this.log(`启动命令: ${command}`);

      // 发送命令到终端（终端在后台执行，不显示）
      terminal.sendText(command);
      this.log('命令已发送到终端');

      // 等待服务就绪（HTTP 健康检查）
      // 启动时使用更长的超时时间（15 秒），因为进程启动可能较慢
      const isReady = await this.waitForReadyExtended(15000);

      if (!isReady) {
        this.log('OpenCode 启动超时');
        
        // Windows 特定诊断
        if (isWindows()) {
          this.log('========== Windows 启动失败诊断 ==========');
          await this.diagnoseWindowsStartup();
        }
        
        this.eventManager.emitProcessError(l10n.t('message.startTimeout'));

        // 检查进程是否崩溃
        await this.checkProcessHealth();

        return false;
      }

      // 等待启动完成
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 最终检查一次连接
      const finalCheck = await this.checkConnection();

      if (!finalCheck) {
        this.log('OpenCode 连接检查失败');

        // 检查进程是否崩溃
        await this.checkProcessHealth();

        this.eventManager.emitProcessError(l10n.t('message.startFailed'));
        return false;
      }

      this.log('OpenCode 后台启动成功');

      // 启动进程监控
      this.startProcessMonitoring();

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
      this.eventManager.emitProcessError(l10n.t('message.startFailed', String(error)));
      return false;
    }
  }

  /**
   * 等待 opencode 就绪（扩展版，支持自定义超时）
   */
  private async waitForReadyExtended(timeoutMs: number): Promise<boolean> {
    const maxRetries = Math.ceil(timeoutMs / this.config.retryInterval);
    const retryInterval = this.config.retryInterval;

    this.log(`等待 OpenCode 就绪（最长 ${timeoutMs}ms，重试间隔 ${retryInterval}ms）`);

    for (let i = 0; i < maxRetries; i++) {
      const isReady = await this.client.checkAppReady();
      if (isReady) {
        this.log(`OpenCode 就绪（第 ${i + 1} 次检查）`);
        return true;
      }
      // 等待一段时间后重试
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }

    this.log(`OpenCode 未在 ${timeoutMs}ms 内就绪`);
    return false;
  }

  /**
   * 获取 Windows 启动命令
   * 使用兼容性更好的方式：直接使用 opencode 命令
   */
  private async getWindowsStartupCommand(): Promise<string> {
    this.log('准备 Windows 启动命令...');

    // 直接使用 opencode 命令，让系统自动查找
    // 不依赖 .cmd 扩展名，兼容性更好
    return `opencode ${START_ARGS.PORT} ${this.config.defaultPort}`;
  }

  /**
   * Windows 启动失败诊断
   * 用于诊断 Windows 上启动失败的原因
   */
  private async diagnoseWindowsStartup(): Promise<void> {
    this.log('========== Windows 启动失败诊断 ==========');

    try {
      // 1. 检查 opencode 命令是否在 PATH 中
      this.log('步骤 1: 检查 opencode 命令是否在 PATH 中');
      try {
        const { stdout } = await execAsync('where opencode', { timeout: 2000 });
        this.log(`✅ 找到 opencode: ${stdout.trim()}`);
      } catch (error) {
        this.log('❌ opencode 不在 PATH 中');
        
        // 尝试找到 npm 安装路径
        try {
          const { stdout: npmPrefix } = await execAsync('npm config get prefix', { timeout: 2000 });
          const path = require('path');
          const fs = require('fs');
          const possiblePaths = [
            path.join(npmPrefix.trim(), 'opencode.cmd'),
            path.join(npmPrefix.trim(), 'node_modules', '.bin', 'opencode.cmd'),
            path.join(npmPrefix.trim(), 'node_modules', '.bin', 'opencode'),
          ];
          
          for (const exePath of possiblePaths) {
            if (fs.existsSync(exePath)) {
              this.log(`✅ 通过文件路径找到: ${exePath}`);
            } else {
              this.log(`❌ 路径不存在: ${exePath}`);
            }
          }
        } catch (npmError) {
          this.log(`❌ npm 检查失败: ${npmError}`);
        }
      }

      // 2. 尝试执行 opencode --version
      this.log('步骤 2: 测试 opencode 是否可执行');
      try {
        const { stdout, stderr } = await execAsync('opencode --version', {
          timeout: 5000,
          shell: true as any
        });
        this.log(`✅ opencode 执行成功，版本: ${stdout.trim()}`);
        if (stderr) {
          this.log(`  stderr: ${stderr}`);
        }
      } catch (error: any) {
        this.log(`❌ opencode 执行失败: ${error.message}`);
        if (error.stderr) {
          this.log(`  stderr: ${error.stderr}`);
        }
      }

      // 3. 检查端口占用
      this.log('步骤 3: 检查端口占用');
      const port = this.config.defaultPort;
      try {
        const { stdout } = await execAsync(`netstat -aon | findstr :${port}`, { timeout: 2000 });
        if (stdout.trim()) {
          this.log(`⚠️ 端口 ${port} 被占用:\n${stdout}`);
          
          // 尝试终止占用端口的进程
          this.log('尝试终止占用端口的进程...');
          await this.killProcessByPortCrossPlatform(port);
        } else {
          this.log(`✅ 端口 ${port} 未被占用`);
        }
      } catch (error) {
        this.log(`✅ 端口 ${port} 未被占用（检查失败）`);
      }

      // 4. 检查后台终端状态
      this.log('步骤 4: 检查后台终端状态');
      const allTerminals = vscode.window.terminals;
      this.log(`当前终端列表 (${allTerminals.length} 个):`);
      for (const t of allTerminals) {
        this.log(`  - ${t.name}`);
      }

      if (this.backgroundTerminal) {
        this.log('✅ 后台终端引用存在');
      } else {
        this.log('❌ 后台终端引用不存在');
      }

      // 5. 检查 node 进程
      this.log('步骤 5: 检查 node 进程');
      try {
        const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', {
          timeout: 2000
        });
        const nodeProcesses = stdout.trim().split('\n').filter(line => line.includes('node.exe'));
        this.log(`找到 ${nodeProcesses.length} 个 node 进程`);
        for (const proc of nodeProcesses) {
          this.log(`  ${proc}`);
        }
      } catch (error) {
        this.log('❌ 检查 node 进程失败');
      }

    } catch (error) {
      this.log(`诊断过程中出错: ${error}`);
    }

    this.log('========== Windows 诊断完成 ==========');
  }

  /**
   * 检查进程健康状态
   * 用于诊断进程是否崩溃或异常
   */
  private async checkProcessHealth(): Promise<void> {
    this.log('========== 检查进程健康状态 ==========');

    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);

      // 检查端口占用
      const port = this.config.defaultPort;

      if (process.platform === 'win32') {
        // Windows: 使用 netstat
        try {
          const { stdout } = await execAsync(`netstat -aon | findstr :${port}`, { timeout: 2000 });
          if (stdout.trim()) {
            this.log(`端口 ${port} 被占用:\n${stdout}`);
          } else {
            this.log(`端口 ${port} 未被占用`);
          }
        } catch (error) {
          this.log(`端口 ${port} 未被占用`);
        }
      } else {
        // Unix/macOS: 使用 lsof
        try {
          const { stdout } = await execAsync(`lsof -i :${port}`, { timeout: 2000 });
          if (stdout.trim()) {
            this.log(`端口 ${port} 被占用:\n${stdout}`);

            // 尝试获取进程详情
            const lines = stdout.trim().split('\n');
            if (lines.length > 0) {
              const firstLine = lines[0];
              const parts = firstLine.trim().split(/\s+/);
              if (parts.length >= 2) {
                const pid = parts[1];
                this.log(`进程 PID: ${pid}`);

                // 检查进程是否还在运行
                try {
                  const { stdout: psOutput } = await execAsync(`ps -p ${pid} -o comm=`, { timeout: 2000 });
                  this.log(`进程命令: ${psOutput.trim()}`);
                } catch (psError) {
                  this.log(`进程 ${pid} 不存在或已退出`);
                }
              }
            }
          } else {
            this.log(`端口 ${port} 未被占用`);
          }
        } catch (error) {
          this.log(`端口 ${port} 未被占用`);
        }
      }

      // 检查后台终端状态
      if (this.backgroundTerminal) {
        this.log('后台终端存在');
      } else {
        this.log('后台终端不存在');
      }

    } catch (error) {
      this.log(`进程健康检查失败: ${error}`);
    }

    this.log('========== 进程健康检查完成 ==========');
  }

  /**
   * 启动进程监控
   * 定期检查进程是否正常运行，如果崩溃则自动重启
   */
  private processMonitorTimer?: NodeJS.Timeout;

  private startProcessMonitoring(): void {
    // 清除之前的监控
    if (this.processMonitorTimer) {
      clearInterval(this.processMonitorTimer);
    }

    // 每 10 秒检查一次进程健康状态
    this.processMonitorTimer = setInterval(async () => {
      try {
        const isHealthy = await this.checkConnection(2000); // 使用较短的超时

        if (!isHealthy && this.backgroundTerminal) {
          this.log('⚠️ 进程健康检查失败，可能已崩溃');

          // 检查终端是否还存在
          const terminalExists = vscode.window.terminals.some(
            t => t.name === BACKGROUND_TERMINAL_NAME
          );

          if (!terminalExists) {
            this.log('后台终端已关闭，进程可能已崩溃');
            this.backgroundTerminal = undefined;

            // 触发进程状态变化事件
            this.eventManager.emitProcessStateChanged({
              status: OpenCodeStatus.NotRunning,
              timestamp: Date.now()
            });

            this.eventManager.emitConnectionChanged({
              connected: false,
              timestamp: Date.now()
            });

            // 停止监控
            this.stopProcessMonitoring();
          }
        }
      } catch (error) {
        this.log(`进程监控检查失败: ${error}`);
      }
    }, 10000);

    this.log('已启动进程监控（每 10 秒）');
  }

  /**
   * 停止进程监控
   */
  private stopProcessMonitoring(): void {
    if (this.processMonitorTimer) {
      clearInterval(this.processMonitorTimer);
      this.processMonitorTimer = undefined;
      this.log('已停止进程监控');
    }
  }

  /**
   * 连接到已有进程
   */
  public async attach(workspacePath: string): Promise<void> {
    if (!workspacePath) {
      throw new WorkspaceError(l10n.t('message.pleaseOpenWorkspace'));
    }

    // 创建终端
    const terminal = await this.createOpenCodeTerminal(workspacePath);
    terminal.show();

    // 发送 attach 命令（跨平台兼容）
    const command = `opencode ${START_ARGS.ATTACH} ${this.baseUrl} ${START_ARGS.DIR} ${workspacePath}`;
    terminal.sendText(command);

    // 等待服务就绪
    const isReady = await this.waitForReady();
    if (!isReady) {
      vscode.window.showErrorMessage(l10n.t('message.openCodeAttachTimeout'));
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
      vscode.window.showErrorMessage(l10n.t('message.noContentToSend'));
      return;
    }

    // 检查 opencode 是否正在运行，未运行则先启动
    const isRunning = await this.checkOpenCodeRunning();
    if (!isRunning) {
      const success = await this.startInBackground();
      if (success) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 等待启动完成
        // vscode.window.showInformationMessage(l10n.t('status.ready'));
      } else {
        vscode.window.showErrorMessage(l10n.t('message.failedToStart'));
        return;
      }
    }

    // 确保 TUI 终端显示（如果已存在就显示，不存在就创建）
    await this.showTui();

    vscode.window.showInformationMessage(l10n.t('message.sendingCode'));

    // 添加 prompt
    const appendSuccess = await this.client.appendPrompt(content);
    if (!appendSuccess) {
      vscode.window.showErrorMessage(l10n.t('message.failedToSend'));
      return;
    }

    // 添加一个小延迟，确保 prompt 被追加
    await new Promise(resolve => setTimeout(resolve, 100));

    // 再自动提交 prompt
    const submitSuccess = await this.client.submitPrompt();
    if (submitSuccess) {
      vscode.window.showInformationMessage(l10n.t('message.connected'));
    } else {
      vscode.window.showErrorMessage(l10n.t('message.codeAdded'));
    }
  }

  /**
   * 添加prompt到 opencode TUI
   */
  async appendPromptToTUI(content: string): Promise<void> {
    if (!content) {
      vscode.window.showErrorMessage(l10n.t('message.noContentToSend'));
      return;
    }

    // 检查 opencode 是否正在运行，未运行则先启动
    const isRunning = await this.checkOpenCodeRunning();
    if (!isRunning) {
      const success = await this.startInBackground();
      if (success) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 等待启动完成
        vscode.window.showInformationMessage(l10n.t('message.connected'));
      } else {
        vscode.window.showErrorMessage(l10n.t('message.failedToStart'));
        return;
      }
    }

    // 确保 TUI 终端显示（如果已存在就显示，不存在就创建）
    await this.showTui();

    // 添加prompt
    const appendSuccess = await this.client.appendPrompt(content);
    if (!appendSuccess) {
      vscode.window.showErrorMessage(l10n.t('message.failedToSend'));
      return;
    }
    vscode.window.showInformationMessage(l10n.t('message.dataAdded'));
  }

  /**
   * 检查 opencode 是否已安装（增强版，使用双重检测）
   * 1. 首先检查 PATH（快速）
   * 2. 然后实际执行命令（可靠）
   * 3. 使用缓存避免频繁检查
   * 4. Windows 环境下添加重试机制（环境变量可能未就绪）
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

    // Windows 环境下，添加重试机制（解决 VSCode 启动时环境变量未就绪问题）
    const maxRetries = isWindows() ? 3 : 1;
    let isInstalled = false;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      this.log(`安装检查尝试 ${attempt}/${maxRetries}`);
      
      // 方法1: 检查命令是否在 PATH 中（快速）
      let inPath = false;
      let commandPath: string | undefined;
      
      try {
        if (isWindows()) {
          // Windows: 使用增强检测
          const result = await this.checkWindowsInstallation();
          inPath = result.found;
          commandPath = result.path;
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
        canExecute = await this.verifyOpenCodeExecutable(commandPath);
      }

      isInstalled = inPath && canExecute;
      
      if (isInstalled || attempt === maxRetries) {
        // 成功或最后一次尝试
        break;
      }
      
      // 失败但还有重试机会，等待 1 秒后重试
      this.log(`安装检查失败，等待 1 秒后重试...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 更新缓存
    this.installationCache = {
      isInstalled,
      timestamp: now
    };

    this.log(`OpenCode 安装状态最终结果: ${isInstalled}`);

    return isInstalled;
  }

  /**
   * Windows 专用安装检测（多层检测，跨 shell 兼容）
   * 针对 nvm 和标准 npm 安装进行优化
   * 支持 PowerShell、cmd、Git Bash、WSL 等多种 shell
   */
  private async checkWindowsInstallation(): Promise<{ found: boolean; path?: string }> {
    this.log('开始 Windows 安装检查（跨 shell 兼容）');

    // 方法1a: 尝试 where 命令（PowerShell/cmd）
    try {
      const { stdout } = await execAsync('where opencode', { timeout: 5000 });
      const path = stdout.trim().split('\n')[0]; // 取第一个路径
      this.log(`✅ [方法1a] 通过 where 找到: ${path}`);
      return { found: true, path };
    } catch (error: any) {
      this.log(`❌ [方法1a] where 失败`);
    }

    // 方法1b: 尝试 which 命令（Git Bash/WSL）
    try {
      const { stdout } = await execAsync('which opencode', { timeout: 5000, shell: true as any });
      const path = stdout.trim().split('\n')[0];
      this.log(`✅ [方法1b] 通过 which 找到: ${path}`);
      return { found: true, path };
    } catch (error: any) {
      this.log(`❌ [方法1b] which 失败`);
    }

    // 方法2: 检查 npm 全局包（兼容 nvm）
    try {
      const { stdout } = await execAsync(WINDOWS_COMMANDS.NPM_CHECK_GLOBAL, {
        timeout: 5000,
        shell: true as any
      });

      if (stdout.includes('opencode-ai')) {
        this.log(`✅ [方法2] 通过 npm 全局包找到`);
        
        // 尝试获取完整路径
        try {
          const { stdout: npmPrefix } = await execAsync(WINDOWS_COMMANDS.NPM_GET_PREFIX, {
            timeout: 2000,
            shell: true as any
          });
          const pathModule = require('path');
          const fullPath = pathModule.join(npmPrefix.trim(), 'opencode.cmd');
          this.log(`[方法2] 推断路径: ${fullPath}`);
          return { found: true, path: fullPath };
        } catch {
          return { found: true };
        }
      }
    } catch (error: any) {
      this.log(`❌ [方法2] npm 检查失败`);
    }

    // 方法3: 直接检查 npm bin 路径（最可靠）
    try {
      const { stdout: npmBinPath } = await execAsync(WINDOWS_COMMANDS.NPM_GET_PREFIX, {
        timeout: 5000,
        shell: true as any
      });

      const path = require('path');
      const fs = require('fs');

      const possiblePaths = [
        path.join(npmBinPath.trim(), 'opencode.cmd'),
        path.join(npmBinPath.trim(), 'opencode'),
        path.join(npmBinPath.trim(), 'node_modules', '.bin', 'opencode.cmd'),
        path.join(npmBinPath.trim(), 'node_modules', '.bin', 'opencode'),
      ];

      for (const exePath of possiblePaths) {
        if (fs.existsSync(exePath)) {
          this.log(`✅ [方法3] 通过文件路径找到: ${exePath}`);
          return { found: true, path: exePath };
        }
      }
    } catch (error: any) {
      this.log(`❌ [方法3] npm 路径检查失败`);
    }

    this.log('❌ Windows 安装检查: 未找到');
    return { found: false };
  }

  /**
   * 验证 OpenCode 是否可以实际执行
   * 通过执行 opencode --version 命令
   * @param commandPath 可选的完整路径（Windows 需要完整路径）
   */
  private verifyOpenCodeExecutable(commandPath?: string): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.log('验证 OpenCode 可执行性');

        const command = commandPath || 'opencode';
        this.log(`执行命令: ${command}`);

        const proc = spawn(command, ['--version'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: !!commandPath, // Windows 使用完整路径时不需要 shell
        });

        let timedOut = false;
        let output = '';
        let errorOutput = '';

        // Windows 启动时环境变量可能未就绪，使用更长的超时
        const timeoutMs = isWindows() ? 10000 : 5000;
        
        // 设置超时
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
          this.log(`❌ 验证超时（${timeoutMs}ms）`);
          resolve(false);
        }, timeoutMs);

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
      vscode.window.showInformationMessage(l10n.t('message.installingComplete'));
    } catch (error) {
      vscode.window.showErrorMessage(l10n.t('message.installFailed', error));
    }
  }

  /**
   * 检查 opencode 是否正在运行（内部使用）
   */
  private async checkOpenCodeRunning(): Promise<boolean> {
    return await this.checkConnection();
  }

  /**
   * 检查是否有外部 opencode 进程在运行
   * 即端口健康，但没有 VSCode 后台终端
   * @returns 是否有外部进程运行
   */
  async hasExternalOpenCodeProcess(): Promise<boolean> {
    // 1. 检查端口健康
    const portHealthy = await this.checkConnection(2000);
    if (!portHealthy) {
      return false;
    }

    // 2. 检查是否有 VSCode 创建的后台终端
    const hasBackgroundTerminal = vscode.window.terminals.some(
      terminal => terminal.name === BACKGROUND_TERMINAL_NAME
    );

    // 端口健康但没有后台终端 = 外部进程
    return !hasBackgroundTerminal;
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
      vscode.window.showErrorMessage(l10n.t('message.pleaseOpenWorkspace'));
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
  public getWorkspacePath(): string | undefined {
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
    const terminalStartupDelay = this.configService.getTerminalStartupDelay();

    return {
      defaultPort: port,
      healthCheckTimeout: timeout,
      maxRetries: 10,
      retryInterval: 500,
      terminalStartupDelay
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
      vscode.window.showErrorMessage(l10n.t('message.pleaseOpenWorkspace'));
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
      const terminal = await this.createOpenCodeTerminal(workspacePath);
      terminal.show();

      // 发送 attach 命令（跨平台兼容）
      const command = `opencode ${START_ARGS.ATTACH} ${this.baseUrl} ${START_ARGS.DIR} ${workspacePath}`;
      terminal.sendText(command);

      // 等待 attach 完成
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      // OpenCode 未运行，创建新的 TUI 终端并启动
      const terminal = await this.createOpenCodeTerminal(workspacePath);
      terminal.show();

      // 发送启动命令（跨平台兼容）
      const command = `opencode ${START_ARGS.PORT} ${this.config.defaultPort}`;
      terminal.sendText(command);
    }
  }

  /**
   * 创建 OpenCode TUI 终端（统一方法）
   * @param workspacePath 工作区路径
   * @returns 终端实例
   */
  private async createOpenCodeTerminal(workspacePath: string): Promise<vscode.Terminal> {
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

    // 等待终端初始化完成
    if (this.config.terminalStartupDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.config.terminalStartupDelay));
    }

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
    this.log(`========== 开始终止端口 ${port} 的进程 ==========`);

    if (!isWindows()) {
      // Unix/macOS: 使用 lsof
      try {
        // 首先获取进程列表用于日志
        try {
          const listCommand = `lsof -i :${port}`;
          const { stdout } = await execAsync(listCommand, { timeout: 2000 });
          this.log(`[Unix] 端口 ${port} 占用情况:\n${stdout}`);
        } catch (listError) {
          this.log(`[Unix] 端口 ${port} 未被占用`);
        }

        // 终止进程
        const command = `lsof -ti:${port} | xargs kill -9`;
        const { stdout } = await execAsync(command, { timeout: 5000 });

        if (stdout.trim()) {
          this.log(`[Unix] ✅ 已终止进程 PID: ${stdout.trim()}`);
        } else {
          this.log(`[Unix] ⚠️ 没有找到占用端口 ${port} 的进程`);
        }

        // 验证终止是否成功
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          await execAsync(`lsof -i :${port}`, { timeout: 2000 });
          this.log(`[Unix] ⚠️ 端口 ${port} 仍被占用，可能终止失败`);
          return false;
        } catch (verifyError) {
          this.log(`[Unix] ✅ 端口 ${port} 已释放`);
          return true;
        }
      } catch (error) {
        this.log(`[Unix] ⚠️ 进程终止失败: ${error}`);
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
        this.log(`[Windows] 尝试方法: ${method.name}`);
        await execAsync(method.command, { timeout: 5000, shell: method.shell });
        this.log(`✅ 通过 ${method.name} 终止进程`);

        // 验证终止是否成功
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          const { stdout } = await execAsync(`netstat -aon | findstr :${port}`, { timeout: 2000 });
          if (stdout.trim()) {
            this.log(`⚠️ 端口 ${port} 仍被占用:\n${stdout}`);
            // 继续尝试下一个方法
          } else {
            this.log(`✅ 端口 ${port} 已释放`);
            return true;
          }
        } catch (verifyError) {
          this.log(`✅ 端口 ${port} 已释放`);
          return true;
        }
      } catch (error: any) {
        this.log(`⚠️ ${method.name} 失败: ${error.message || error}`);
        // 继续尝试下一个方法
      }
    }

    this.log(`[Windows] ⚠️ 所有方法都失败了`);
    return false;
  }

  /**
   * 查找所有 opencode 进程
   * @returns 进程 PID 列表
   */
  private async findAllOpenCodeProcesses(): Promise<number[]> {
    this.log('========== 查找所有 opencode 进程 ==========');
    const pids: number[] = [];

    try {
      if (isWindows()) {
        // Windows: 使用 tasklist 和 findstr
        const { stdout } = await execAsync(
          'tasklist /FI "IMAGENAME eq opencode.exe" /FO CSV /NH',
          { timeout: 5000 }
        );

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          // 解析 CSV 输出: "opencode.exe","12345","Console","1","150,000 K"
          const match = line.match(/^"opencode\.exe","(\d+)"/);
          if (match) {
            const pid = parseInt(match[1], 10);
            if (!pids.includes(pid)) {
              pids.push(pid);
            }
          }
        }

        // 同时检查 node.exe 进程（可能是 opencode.cmd）
        const { stdout: nodeStdout } = await execAsync(
          'tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH',
          { timeout: 5000 }
        );

        const nodeLines = nodeStdout.trim().split('\n');
        for (const line of nodeLines) {
          const match = line.match(/^"node\.exe","(\d+)"/);
          if (match) {
            const pid = parseInt(match[1], 10);
            // 检查是否是 opencode 进程（通过命令行）
            try {
              const { stdout: cmdLine } = await execAsync(
                `wmic process where ProcessId=${pid} get CommandLine /NOHDR`,
                { timeout: 2000 }
              );
              if (cmdLine.toLowerCase().includes('opencode')) {
                if (!pids.includes(pid)) {
                  pids.push(pid);
                }
              }
            } catch (cmdError) {
              // 忽略无法检查命令行的进程
            }
          }
        }
      } else {
        // Unix/macOS: 使用 ps 和 grep
        const { stdout } = await execAsync(
          'ps aux | grep -E "[o]pencode|[n]ode.*opencode" | awk \'{print $2}\'',
          { timeout: 5000 }
        );

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const pid = parseInt(line.trim(), 10);
          if (!isNaN(pid) && !pids.includes(pid)) {
            pids.push(pid);
          }
        }
      }

      this.log(`找到 ${pids.length} 个 opencode 进程: ${pids.join(', ') || '无'}`);
    } catch (error) {
      this.log(`查找进程失败: ${error}`);
    }

    return pids;
  }

  /**
   * 终止指定 PID 的进程
   * @param pid 进程 PID
   * @returns 是否成功终止
   */
  private async killProcessByPid(pid: number): Promise<boolean> {
    try {
      if (isWindows()) {
        await execAsync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
        this.log(`✅ 已终止进程 ${pid}`);
        return true;
      } else {
        await execAsync(`kill -9 ${pid}`, { timeout: 5000 });
        this.log(`✅ 已终止进程 ${pid}`);
        return true;
      }
    } catch (error) {
      this.log(`⚠️ 终止进程 ${pid} 失败: ${error}`);
      return false;
    }
  }

  /**
   * 终止所有 opencode 进程（强力清除）
   * 这是最终的保底方法，确保所有 opencode 进程都被终止
   * @returns 终止的进程数量
   */
  public async killAllOpenCodeProcesses(): Promise<number> {
    this.log('========== 开始终止所有 opencode 进程 ==========');

    // 1. 查找所有 opencode 进程
    const pids = await this.findAllOpenCodeProcesses();

    if (pids.length === 0) {
      this.log('没有找到运行中的 opencode 进程');
      return 0;
    }

    // 2. 终止所有找到的进程
    let killedCount = 0;
    for (const pid of pids) {
      const success = await this.killProcessByPid(pid);
      if (success) {
        killedCount++;
      }
    }

    // 3. 等待进程完全退出
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 4. 验证是否所有进程都被终止
    const remainingPids = await this.findAllOpenCodeProcesses();
    if (remainingPids.length > 0) {
      this.log(`⚠️ 仍有 ${remainingPids.length} 个进程未被终止: ${remainingPids.join(', ')}`);

      // 尝试再次终止
      for (const pid of remainingPids) {
        const success = await this.killProcessByPid(pid);
        if (success) {
          killedCount++;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    this.log(`========== 终止完成，共终止 ${killedCount} 个进程 ==========`);
    return killedCount;
  }

  /**
   * 清理资源（扩展停用时调用）
   */
  public async cleanup(): Promise<void> {
    this.log('========== 开始清理资源（扩展停用） ==========');

    // 停止进程监控
    this.stopProcessMonitoring();

    // 强制终止所有 opencode 进程（使用新的强力终止方法）
    try {
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
      }

      // 使用系统命令确保进程被终止
      this.log('使用系统命令确保所有 opencode 进程被终止');
      const port = this.config.defaultPort;

      // 步骤 1: 终止占用端口的进程
      await this.killProcessByPortCrossPlatform(port);

      // 步骤 2: 强制终止所有 opencode 进程
      await this.killAllOpenCodeProcesses();

      this.log('✅ 清理完成');
    } catch (error) {
      this.log(`⚠️ 清理过程中出错: ${error}`);
    }

    this.log('========== 清理完成 ==========');
  }

  /**
   * 杀掉 OpenCode 进程
   * @param emitEvent 是否触发事件（默认为 true）
   * @param forceAll 是否强制终止所有 opencode 进程（默认为 true）
   */
  async killProcess(emitEvent: boolean = true, forceAll: boolean = true): Promise<void> {
    this.log('========== 开始终止 OpenCode 进程 ==========');

    // 停止进程监控
    this.stopProcessMonitoring();

    try {
      // 步骤 1: 优雅关闭（通过终端）
      const terminal = this.backgroundTerminal;

      if (terminal) {
        this.log('步骤 1: 尝试优雅关闭（通过终端）');
        try {
          terminal.sendText('\x03');  // Ctrl+C
          terminal.sendText('exit');
          this.log('✅ 已发送 Ctrl+C + exit 到终端');
        } catch (error) {
          this.log(`⚠️ 发送命令失败: ${error}`);
        }

        // 等待进程和终端优雅退出
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 清理终端引用
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

      // 步骤 2: 终止占用端口的进程
      this.log('步骤 2: 终止占用端口的进程');
      const port = this.config.defaultPort;
      const portKilled = await this.killProcessByPortCrossPlatform(port);
      if (!portKilled) {
        this.log('⚠️ 端口终止方法失败（可能进程已不存在）');
      }

      // 步骤 3: 强制终止所有 opencode 进程（保底）
      if (forceAll) {
        this.log('步骤 3: 强制终止所有 opencode 进程（保底）');
        const allKilled = await this.killAllOpenCodeProcesses();
        this.log(`✅ 保底方法终止了 ${allKilled} 个进程`);
      }

      this.log('✅ 所有终止步骤已完成');

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

      // 即使出错也尝试保底方法
      try {
        if (forceAll) {
          this.log('尝试保底终止方法...');
          await this.killAllOpenCodeProcesses();
        }
      } catch (fallbackError) {
        this.log(`保底方法也失败了: ${fallbackError}`);
      }

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

    this.log('========== 进程终止流程完成 ==========');
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
      this.eventManager.emitProcessError(l10n.t('message.restartFailed', error));
      vscode.window.showErrorMessage(l10n.t('message.restartFailed', error));
    }
  }
}
