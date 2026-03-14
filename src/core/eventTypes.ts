import { OpenCodeStatus } from './types';

/**
 * 进程状态变化事件
 */
export interface ProcessStateChangeEvent {
  status: OpenCodeStatus;
  timestamp: number;
  error?: string;
}

/**
 * 连接状态变化事件
 */
export interface ConnectionChangeEvent {
  connected: boolean;
  timestamp: number;
  error?: string;
}

/**
 * 事件类型枚举
 */
export enum EventType {
  ProcessStateChanged = 'processStateChanged',
  ConnectionChanged = 'connectionChanged',
  ProcessError = 'processError'
}
