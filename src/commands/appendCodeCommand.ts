import * as vscode from 'vscode';
import { OpenCodeManager } from '../core/OpenCodeManager';
import { l10n } from '../l10n';

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
      vscode.window.showWarningMessage(l10n.t('message.noActiveEditor'));
      return;
    }

    // 获取选中的代码
    const data = manager.getFileReference(editor);
    if (!data) {
      vscode.window.showWarningMessage(l10n.t('message.pleaseSelectCode'));
      return;
    }

    const { selectedText, absolutePath, startLine, endLine } = data;
    let lineRange = '';
    if (startLine) {
      lineRange = `${startLine}`
      if (endLine) {
        lineRange += `-${endLine}`
      }
    }

    const text = `
${selectedText ? selectedText + "\n" : ""}
File: ${absolutePath}${lineRange ? "\nLine: " + lineRange : ""}
    `;

    console.log("Append prompt to OpenCode TUI:", text);
    await manager.appendPromptToTUI(text);
  });
}
