import './setup';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizePath, urlSafeBase64Encode, encodePathForUrl } from '../src/utils/pathUtils';

test('urlSafeBase64Encode 不包含 URL 不安全字符', () => {
  // 包含多字节字符、+ 和 / 的输入，确保输出对 URL 安全
  const encoded = urlSafeBase64Encode('中文/路径+特殊\x00');
  assert.ok(!encoded.includes('+'), '不应包含 +');
  assert.ok(!encoded.includes('/'), '不应包含 /');
  assert.ok(!encoded.includes('='), '不应包含 = 填充');
});

test('encodePathForUrl 编码后可通过 base64 解码还原路径', () => {
  const p = '/Users/hudi/My Project/src/file.ts';
  const encoded = encodePathForUrl(p);
  const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
  // 非 Windows 下 normalizePath 保持原样
  assert.equal(decoded, p);
});

test('encodePathForUrl 输出满足 URL-safe base64 正则', () => {
  const encoded = encodePathForUrl('/a/b/c');
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
});

test('normalizePath 在非 Windows 下保持原样', () => {
  const p = '/Users/hudi/src/file.ts';
  assert.equal(normalizePath(p), p);
});
