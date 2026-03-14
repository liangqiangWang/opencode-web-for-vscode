import * as vscode from 'vscode';
import { OpenCodeManager } from '../core/OpenCodeManager';

/**
 * 添加代码到 OpenCode 命令
 */
export function registerAppendCodeCommand(
  context: vscode.ExtensionContext,
  manager: OpenCodeManager
): vscode.Disposable {
  return vscode.commands.registerCommand('opencode-web.appendCode', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('No active editor');
      return;
    }

    // 获取选中的代码
    const data = manager.getFileReference(editor);
    if (!data) {
      vscode.window.showWarningMessage('Please select code first');
      return;
    }

    const { selectedText, absolutePath } = data;

    const text = `
${selectedText ? selectedText + "\n" : ""}
File: ${absolutePath}
    `;

    console.log("Append prompt to OpenCode TUI:", text);
    await manager.appendPromptToTUI(text);
  });
}
