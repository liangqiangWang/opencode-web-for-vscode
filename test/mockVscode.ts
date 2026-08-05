/**
 * VSCode API 模拟模块
 * 由 test/setup.ts 通过拦截 `require('vscode')` 注入，供单元测试使用。
 *
 * 使用方式：先调用状态设置辅助函数（setConfigValue / setWorkspaceFolders 等），
 * 再执行被测代码；每个测试前调用 resetVscodeMock() 恢复默认状态。
 */

/** 模拟对象内部状态 */
interface MockState {
  workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
  terminals: any[];
  language: string;
  configValues: Map<string, any>;
}

const state: MockState = {
  workspaceFolders: undefined,
  terminals: [],
  language: 'en',
  configValues: new Map(),
};

// === 状态设置辅助函数 ===

/** 设置 vscode.workspace.workspaceFolders */
export function setWorkspaceFolders(folders: Array<{ uri: { fsPath: string } }> | undefined): void {
  state.workspaceFolders = folders;
}

/** 设置 vscode.window.terminals */
export function setTerminals(terminals: any[]): void {
  state.terminals = terminals;
}

/** 设置 vscode.env.language */
export function setLanguage(language: string): void {
  state.language = language;
}

/** 设置配置值（完整键名，如 'opencode-web.port'） */
export function setConfigValue(key: string, value: any): void {
  state.configValues.set(key, value);
}

/** 清空所有配置值 */
export function clearConfigValues(): void {
  state.configValues.clear();
}

/** 恢复所有模拟状态的默认值 */
export function resetVscodeMock(): void {
  state.workspaceFolders = undefined;
  state.terminals = [];
  state.language = 'en';
  state.configValues.clear();
}

// === VSCode API 模拟 ===

export const vscodeMock = {
  workspace: {
    getConfiguration(section?: string) {
      return {
        get: <T>(key: string, defaultValue?: T): T | undefined => {
          const fullKey = section ? `${section}.${key}` : key;
          return state.configValues.has(fullKey) ? state.configValues.get(fullKey) : defaultValue;
        },
        inspect: (key: string) => {
          const fullKey = section ? `${section}.${key}` : key;
          return {
            globalValue: state.configValues.get(fullKey),
            defaultValue: undefined,
            key: fullKey,
          };
        },
        update: async () => undefined,
      };
    },
    get workspaceFolders() {
      return state.workspaceFolders;
    },
    onDidChangeConfiguration: () => ({ dispose() {} }),
    fs: {
      readFile: async () => new Uint8Array(Buffer.from('mock content')),
    },
  },
  window: {
    createOutputChannel: (name: string) => ({
      name,
      appendLine: () => {},
      append: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {},
    }),
    createTerminal: (options?: any) => ({
      name: options?.name ?? 'mock-terminal',
      sendText: () => {},
      show: () => {},
      dispose: () => {},
    }),
    createWebviewPanel: (_type: string, _title: string, _column: any, _options: any) => ({
      webview: {
        html: '',
        options: {},
        postMessage: () => {},
        onDidReceiveMessage: () => ({ dispose() {} }),
      },
      viewColumn: 2,
      onDidDispose: () => ({ dispose() {} }),
      onDidChangeViewState: () => ({ dispose() {} }),
      reveal: () => {},
      dispose: () => {},
    }),
    get terminals() {
      return state.terminals;
    },
    onDidCloseTerminal: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showOpenDialog: async () => undefined,
    registerWebviewViewProvider: () => ({ dispose() {} }),
  },
  env: {
    get language() {
      return state.language;
    },
    openExternal: async () => true,
  },
  Uri: {
    joinPath: (_base: any, ..._parts: string[]) => ({
      fsPath: '/mock/path',
      toString: () => '/mock/path',
    }),
    parse: (value: string) => ({ fsPath: value, toString: () => value }),
    file: (value: string) => ({ fsPath: value, toString: () => value }),
  },
  ViewColumn: { Beside: 2, Active: -1, One: 1 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  commands: {
    executeCommand: async () => undefined,
  },
};
