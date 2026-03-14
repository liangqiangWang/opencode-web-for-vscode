import * as vscode from 'vscode';
import { OpenCodeManager } from '../core/OpenCodeManager';
import { registerAppendCodeCommand } from './appendCodeCommand';

/**
 * 注册所有命令
 */
export function registerAllCommands(
  context: vscode.ExtensionContext,
  manager: OpenCodeManager
): void {
  // 注册添加代码命令
  context.subscriptions.push(
    registerAppendCodeCommand(context, manager)
  );
}
