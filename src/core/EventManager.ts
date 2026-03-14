import { EventEmitter } from 'events';
import { ProcessStateChangeEvent, ConnectionChangeEvent, EventType } from './eventTypes';
import { OpenCodeStatus } from './types';

/**
 * OpenCode 事件管理器
 * 采用单例模式，用于在组件之间传递状态变化事件
 */
export class OpenCodeEventManager extends EventEmitter {
  private static instance: OpenCodeEventManager;

  private constructor() {
    super();
    this.setMaxListeners(50); // 增加监听器限制以支持多个组件
  }

  /**
   * 获取事件管理器单例实例
   */
  public static getInstance(): OpenCodeEventManager {
    if (!OpenCodeEventManager.instance) {
      OpenCodeEventManager.instance = new OpenCodeEventManager();
    }
    return OpenCodeEventManager.instance;
  }

  /**
   * 触发进程状态变化事件
   */
  public emitProcessStateChanged(data: ProcessStateChangeEvent): boolean {
    this.log('进程状态变化:', data);
    return this.emit(EventType.ProcessStateChanged, data);
  }

  /**
   * 订阅进程状态变化事件
   */
  public onProcessStateChanged(
    callback: (data: ProcessStateChangeEvent) => void
  ): this {
    return this.on(EventType.ProcessStateChanged, callback);
  }

  /**
   * 触发连接状态变化事件
   */
  public emitConnectionChanged(data: ConnectionChangeEvent): boolean {
    this.log('连接状态变化:', data);
    return this.emit(EventType.ConnectionChanged, data);
  }

  /**
   * 订阅连接状态变化事件
   */
  public onConnectionChanged(
    callback: (data: ConnectionChangeEvent) => void
  ): this {
    return this.on(EventType.ConnectionChanged, callback);
  }

  /**
   * 触发进程错误事件
   */
  public emitProcessError(error: string): boolean {
    this.log('进程错误:', error);
    return this.emit(EventType.ProcessError, { error, timestamp: Date.now() });
  }

  /**
   * 订阅进程错误事件
   */
  public onProcessError(
    callback: (data: { error: string; timestamp: number }) => void
  ): this {
    return this.on(EventType.ProcessError, callback);
  }

  /**
   * 移除所有监听器（用于清理）
   */
  public removeAllListenersForEvent(eventType: EventType): this {
    return this.removeAllListeners(eventType);
  }

  /**
   * 日志输出
   */
  private log(message: string, data: any): void {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[EventManager] ${message}`, data);
    }
  }
}

// 导出单例获取函数
export function getEventManager(): OpenCodeEventManager {
  return OpenCodeEventManager.getInstance();
}
