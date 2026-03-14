import fetch from 'node-fetch';
import { OpenCodeConfig } from './types';
import { API_ENDPOINTS } from '../common/constants';

/**
 * OpenCode HTTP 客户端
 * 负责与 opencode 服务进行通信
 */
export class OpenCodeClient {
  private port: number;
  private baseUrl: string;
  private config: OpenCodeConfig;

  constructor(port: number, config: OpenCodeConfig) {
    this.port = port;
    this.baseUrl = `http://localhost:${port}`;
    this.config = config;
  }

  /**
   * 检查 opencode 服务健康状态
   * @param timeout 超时时间（毫秒）
   * @returns 服务是否健康
   */
  async checkHealth(timeout?: number): Promise<boolean> {
    const checkTimeout = timeout || this.config.healthCheckTimeout;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, checkTimeout);

      fetch(`${this.baseUrl}${API_ENDPOINTS.HEALTH}`, {
        method: 'GET'
      })
        .then((response: any) => {
          clearTimeout(timer);
          resolve(response.ok);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(false);
        });
    });
  }

  /**
   * 发送文本到 opencode TUI
   * @param text 要发送的文本
   * @returns 是否发送成功
   */
  async appendPrompt(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, this.config.healthCheckTimeout);

      fetch(`${this.baseUrl}${API_ENDPOINTS.APPEND_PROMPT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text })
      })
        .then((response: any) => {
          clearTimeout(timer);
          resolve(response.ok);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(false);
        });
    });
  }

  /**
   * 提交当前的 prompt
   * @returns 是否提交成功
   */
  async submitPrompt(): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, this.config.healthCheckTimeout);

      fetch(`${this.baseUrl}${API_ENDPOINTS.SUBMIT_PROMPT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      })
        .then((response: any) => {
          clearTimeout(timer);
          resolve(response.ok);
        })
        .catch(() => {
          clearTimeout(timer);
          resolve(false);
        });
    });
  }

  /**
   * 检查 opencode 应用是否就绪
   * @returns 应用是否就绪
   */
  async checkAppReady(): Promise<boolean> {
    return await this.checkHealth();
  }
}
