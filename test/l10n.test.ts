import './setup';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { l10n } from '../src/l10n';
import { Bundle } from '../src/l10n/l10n';

// 注意：l10n 为单例，未调用 setContext 时使用硬编码的默认英文语言包。

test('t: 嵌套键正确解析', () => {
  assert.equal(l10n.t('status.initializing'), 'Initializing...');
  assert.equal(l10n.t('status.notInstalled'), 'OpenCode Not Installed');
  assert.equal(l10n.t('button.start'), 'Start OpenCode');
});

test('t: 占位符 {0} 替换', () => {
  assert.equal(l10n.t('message.initFailed', 'boom'), 'Initialization failed: boom');
  assert.equal(l10n.t('message.restartFailed', 'err'), 'Failed to restart process: err');
  assert.equal(l10n.t('message.killFailed', '123'), 'Failed to kill process: 123');
});

test('t: 缺失键返回键本身', () => {
  assert.equal(l10n.t('status.doesNotExist'), 'status.doesNotExist');
  assert.equal(l10n.t('not.exist.deep.key'), 'not.exist.deep.key');
});

test('t: 缺少占位符参数时替换为空字符串', () => {
  assert.equal(l10n.t('message.initFailed'), 'Initialization failed: ');
});

test('getBundle 返回包含全部一级命名空间的对象', () => {
  const bundle = l10n.getBundle();
  for (const namespace of ['status', 'button', 'message', 'description', 'help']) {
    assert.ok(bundle[namespace], `缺少命名空间 ${namespace}`);
  }
  assert.equal(typeof (bundle.status as Bundle).initializing, 'string');
});

test('getLanguage 返回非空字符串', () => {
  const lang = l10n.getLanguage();
  assert.ok(lang.length > 0);
});
