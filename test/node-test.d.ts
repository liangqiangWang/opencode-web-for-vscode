/**
 * Node.js 内置测试模块 `node:test` 的类型声明
 * 当前项目使用 @types/node@14，尚未包含 node:test 的类型定义，
 * 这里仅声明测试代码中实际使用到的 API。
 */
declare module 'node:test' {
  export interface MockTimers {
    /**
     * 启用模拟计时器
     * @param options.apis 需要模拟的计时器创建 API（clear 方法会自动同步模拟）
     */
    enable(options?: {
      apis?: ('setTimeout' | 'setInterval' | 'setImmediate' | 'Date' | 'performance' | 'queueMicrotask')[];
    }): void;
    /** 恢复真实计时器并清空所有待执行的模拟计时器 */
    reset(): void;
    /** 快进模拟时间，触发到期的计时器回调 */
    tick(milliseconds: number): void;
  }

  export interface MockTracker {
    timers: MockTimers;
  }

  export interface TestContext {
    mock: MockTracker;
  }

  export function test(
    name: string,
    fn: (t: TestContext) => void | Promise<void>,
    options?: unknown
  ): void;
  export function describe(name: string, fn: () => void): void;
  export function it(
    name: string,
    fn: (t: TestContext) => void | Promise<void>,
    options?: unknown
  ): void;
  export function beforeEach(fn: (t: TestContext) => void | Promise<void>): void;
  export function afterEach(fn: (t: TestContext) => void | Promise<void>): void;
}
