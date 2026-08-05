import './setup';
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import {
  isStateValid,
  INVALID_STATES,
  STATE_EXPIRY_MS,
  SavedWebviewState,
} from '../src/views/webview/stateUtils';

describe('isStateValid - 保存状态的有效性判断', () => {
  test('空状态（null / undefined）返回 false', () => {
    assert.equal(isStateValid(null), false);
    assert.equal(isStateValid(undefined), false);
  });

  test('所有临时状态均返回 false（不可恢复）', () => {
    const now = Date.now();
    for (const invalid of INVALID_STATES) {
      assert.equal(
        isStateValid({ state: invalid, message: '', timestamp: now } as SavedWebviewState),
        false,
        `临时状态 ${invalid} 不应被恢复`
      );
    }
  });

  test('可持久化状态在有效期内返回 true', () => {
    const now = Date.now();
    assert.equal(isStateValid({ state: 'ready', message: '', timestamp: now }), true);
    assert.equal(isStateValid({ state: 'idle', message: '', timestamp: now - 10_000 }), true);
  });

  test('超过有效期的状态返回 false', () => {
    const expired = Date.now() - STATE_EXPIRY_MS - 1000;
    assert.equal(isStateValid({ state: 'ready', message: '', timestamp: expired }), false);
  });

  test('恰好等于有效期边界时返回 false（要求 age < STATE_EXPIRY_MS）', () => {
    const boundary = Date.now() - STATE_EXPIRY_MS;
    assert.equal(isStateValid({ state: 'ready', message: '', timestamp: boundary }), false);
  });
});
