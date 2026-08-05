/**
 * 测试环境初始化
 * 必须在所有被测模块之前导入：
 * 通过拦截 `require('vscode')` 注入 VSCode API 模拟，使源码无需真实 VSCode 环境即可加载。
 */
import { Module } from 'module';
import { vscodeMock } from './mockVscode';

// 保存原始 _load
const originalLoad = (Module as any)._load;

// 拦截 require('vscode')，返回模拟对象
(Module as any)._load = function (request: string, parent: any, isMain: boolean): any {
  if (request === 'vscode') {
    return vscodeMock;
  }
  // eslint-disable-next-line prefer-rest-params
  return originalLoad.apply(this, arguments);
};
