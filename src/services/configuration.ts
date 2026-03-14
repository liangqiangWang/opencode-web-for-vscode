import * as vscode from 'vscode';
import { CONFIG_KEYS, DEFAULT_CONFIG } from '../common/constants';

/**
 * 配置管理服务
 */
export class ConfigurationService {
  private static instance: ConfigurationService;

  private constructor() {}

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
