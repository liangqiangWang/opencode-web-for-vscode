import './setup';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { getEventManager } from '../src/core/EventManager';
import { EventType } from '../src/core/eventTypes';
import { OpenCodeStatus } from '../src/core/types';

test('processStateChanged 事件收发', () => {
  const em = getEventManager();
  let received: { status?: OpenCodeStatus; timestamp?: number } = {};
  em.onProcessStateChanged((data) => {
    received = data;
  });
  em.emitProcessStateChanged({ status: OpenCodeStatus.Running, timestamp: 123 });
  assert.equal(received.status, OpenCodeStatus.Running);
  assert.equal(received.timestamp, 123);
  em.removeAllListenersForEvent(EventType.ProcessStateChanged);
});

test('connectionChanged 事件收发', () => {
  const em = getEventManager();
  let received: { connected?: boolean; timestamp?: number } = {};
  em.onConnectionChanged((data) => {
    received = data;
  });
  em.emitConnectionChanged({ connected: true, timestamp: 456 });
  assert.equal(received.connected, true);
  assert.equal(received.timestamp, 456);
  em.removeAllListenersForEvent(EventType.ConnectionChanged);
});

test('processError 事件收发', () => {
  const em = getEventManager();
  let received: { error?: string; timestamp?: number } = {};
  em.onProcessError((data) => {
    received = data;
  });
  em.emitProcessError('boom');
  assert.equal(received.error, 'boom');
  assert.ok(typeof received.timestamp === 'number' && received.timestamp > 0);
  em.removeAllListenersForEvent(EventType.ProcessError);
});

test('removeAllListenersForEvent 移除后不再触发', () => {
  const em = getEventManager();
  let count = 0;
  em.onProcessStateChanged(() => {
    count++;
  });
  em.removeAllListenersForEvent(EventType.ProcessStateChanged);
  em.emitProcessStateChanged({ status: OpenCodeStatus.Running, timestamp: 1 });
  assert.equal(count, 0);
});
