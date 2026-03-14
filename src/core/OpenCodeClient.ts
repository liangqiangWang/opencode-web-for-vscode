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
   * 检查 opencode 服务健康状态（优化版，使用 Promise.race 实现超时）
   * @param timeout 超时时间（毫秒）
   * @returns 服务是否健康
   */
  async checkHealth(timeout?: number): Promise<boolean> {
    const checkTimeout = timeout || this.config.healthCheckTimeout;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(false);
      }, checkTimeout);
    });

    const fetchPromise = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}${API_ENDPOINTS.HEALTH}`, {
          method: 'GET'
        });
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return response.ok;
      } catch (error) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return false;
      }
    })();

    // 使用 Promise.race 实现超时
    return Promise.race([fetchPromise, timeoutPromise]);
  }

  /**
   * 发送文本到 opencode TUI（优化版，使用 Promise.race 实现超时）
   * @param text 要发送的文本
   * @returns 是否发送成功
   */
  async appendPrompt(text: string): Promise<boolean> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(false);
      }, this.config.healthCheckTimeout);
    });

    const fetchPromise = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}${API_ENDPOINTS.APPEND_PROMPT}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ text })
        });
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return response.ok;
      } catch (error) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return false;
      }
    })();

    return Promise.race([fetchPromise, timeoutPromise]);
  }

  /**
   * 提交当前的 prompt（优化版，使用 Promise.race 实现超时）
   * @returns 是否提交成功
   */
  async submitPrompt(): Promise<boolean> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(false);
      }, this.config.healthCheckTimeout);
    });

    const fetchPromise = (async () => {
      try {
        const response = await fetch(`${this.baseUrl}${API_ENDPOINTS.SUBMIT_PROMPT}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return response.ok;
      } catch (error) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return false;
      }
    })();

    return Promise.race([fetchPromise, timeoutPromise]);
  }

  /**
   * 检查 opencode 应用是否就绪
   * @returns 应用是否就绪
   */
  async checkAppReady(): Promise<boolean> {
    return await this.checkHealth();
  }
}
