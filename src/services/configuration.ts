import * as vscode from 'vscode';
import { CONFIG_KEYS, DEFAULT_CONFIG, LEGACY_CONFIG_KEYS } from '../common/constants';
import { l10n } from '../l10n';

/**
 * 配置管理服务
 * 支持从旧版本配置迁移到新版本配置
 */
export class ConfigurationService {
  private static instance: ConfigurationService;
  private hasMigrated = false;

  private constructor() {
    // 在第一次实例化时执行迁移
    this.migrateLegacyConfig();
  }

  /**
   * 获取单例实例
   */
  public static getInstance(): ConfigurationService {
    if (!ConfigurationService.instance) {
      ConfigurationService.instance = new ConfigurationService();
    }
    return ConfigurationService.instance;
  }

  /**
   * 迁移旧版本配置到新版本配置
   * 从 opencode.* 迁移到 opencode-web.*
   */
  private async migrateLegacyConfig(): Promise<void> {
    if (this.hasMigrated) {
      return;
    }

    const config = vscode.workspace.getConfiguration();
    const migrationMap: Array<{ oldKey: string; newKey: string; defaultValue: any }> = [
      { oldKey: LEGACY_CONFIG_KEYS.PORT, newKey: CONFIG_KEYS.PORT, defaultValue: DEFAULT_CONFIG.PORT },
      { oldKey: LEGACY_CONFIG_KEYS.TIMEOUT, newKey: CONFIG_KEYS.TIMEOUT, defaultValue: DEFAULT_CONFIG.TIMEOUT },
      { oldKey: LEGACY_CONFIG_KEYS.KILL_ON_EXIT, newKey: CONFIG_KEYS.KILL_ON_EXIT, defaultValue: DEFAULT_CONFIG.KILL_ON_EXIT },
      { oldKey: LEGACY_CONFIG_KEYS.LANGUAGE, newKey: CONFIG_KEYS.LANGUAGE, defaultValue: 'auto' },
      { oldKey: LEGACY_CONFIG_KEYS.TERMINAL_STARTUP_DELAY, newKey: CONFIG_KEYS.TERMINAL_STARTUP_DELAY, defaultValue: DEFAULT_CONFIG.TERMINAL_STARTUP_DELAY },
    ];

    let migratedCount = 0;

    for (const { oldKey, newKey, defaultValue } of migrationMap) {
      const oldValue = config.inspect<any>(oldKey)?.globalValue;
      const newValue = config.inspect<any>(newKey)?.globalValue;

      // 迁移条件：
      // 1. 旧配置有用户设置的值（不是 undefined）
      // 2. 新配置没有用户设置的值（是 undefined 或与默认值相同）
      if (oldValue !== undefined && (newValue === undefined || newValue === defaultValue)) {
        try {
          await config.update(newKey, oldValue, vscode.ConfigurationTarget.Global);
          migratedCount++;
        } catch (error) {
          // 静默失败，不影响用户使用
        }
      }
    }

    if (migratedCount > 0) {
      // 显示通知告知用户
      vscode.window.showInformationMessage(
        l10n.t('message.configMigrated', migratedCount.toString())
      );
    }

    this.hasMigrated = true;
  }

  /**
   * 获取端口号
   */
  public getPort(): number {
    return this.getConfig(CONFIG_KEYS.PORT, DEFAULT_CONFIG.PORT);
  }

  /**
   * 获取超时时间
   */
  public getTimeout(): number {
    return this.getConfig(CONFIG_KEYS.TIMEOUT, DEFAULT_CONFIG.TIMEOUT);
  }

  /**
   * 获取关闭 VSCode 时是否终止进程
   */
  public getKillOnExit(): boolean {
    return this.getConfig(CONFIG_KEYS.KILL_ON_EXIT, DEFAULT_CONFIG.KILL_ON_EXIT);
  }

  /**
   * 获取终端启动延迟（毫秒）
   */
  public getTerminalStartupDelay(): number {
    return this.getConfig(CONFIG_KEYS.TERMINAL_STARTUP_DELAY, DEFAULT_CONFIG.TERMINAL_STARTUP_DELAY);
  }

  /**
   * 获取配置值
   */
  private getConfig<T>(key: string, defaultValue: T): T {
    const config = vscode.workspace.getConfiguration();
    return config.get<T>(key, defaultValue);
  }

  /**
   * 更新配置值
   */
  public async updateConfig(key: string, value: any): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }

  /**
   * 监听配置变化
   */
  public onDidChangeConfiguration(
    callback: (event: vscode.ConfigurationChangeEvent) => void
  ): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(callback);
  }
}
