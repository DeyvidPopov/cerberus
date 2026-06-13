import { afterEach, describe, expect, it, vi } from 'vitest';

import { continuousAuthWsUrl, openContinuousAuth } from './ws';

// A minimal WebSocket stand-in: records the URL + offered subprotocols, captures
// the message listener, and lets a test drive `readyState`, inbound messages, send.
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  private messageListener: ((event: { data: unknown }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void {
    if (type === 'message') {
      this.messageListener = listener;
    }
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(data: unknown): void {
    this.messageListener?.({ data });
  }
}

const Ctor = FakeWebSocket as unknown as typeof WebSocket;

afterEach(() => {
  FakeWebSocket.instances.length = 0;
});

describe('continuousAuthWsUrl', () => {
  it('derives a ws:// URL on the continuous-auth path from the API origin', () => {
    expect(continuousAuthWsUrl()).toMatch(/^ws:\/\/.+\/ws\/continuous-auth$/u);
  });
});

describe('openContinuousAuth', () => {
  it('offers the main subprotocol and the bearer.<token> auth subprotocol', () => {
    openContinuousAuth('tok-123', { onLocked: vi.fn() }, Ctor);
    const ws = FakeWebSocket.instances[0];
    expect(ws?.protocols).toEqual(['cerberus.continuous-auth.v1', 'bearer.tok-123']);
  });

  it('streams a window as a validated mouse_window message when the socket is open', () => {
    const client = openContinuousAuth('tok', { onLocked: vi.fn() }, Ctor);
    const features = Array.from({ length: 9 }, (_v, i) => i);
    client.sendWindow(features);
    const ws = FakeWebSocket.instances[0];
    const sent = JSON.parse(ws?.sent[0] ?? '{}') as Record<string, unknown>;
    expect(sent).toMatchObject({ type: 'mouse_window', featureSchemaVersion: 1, features });
  });

  it('does not send when the socket is not open', () => {
    const client = openContinuousAuth('tok', { onLocked: vi.fn() }, Ctor);
    const ws = FakeWebSocket.instances[0];
    if (ws) {
      ws.readyState = 0; // CONNECTING
    }
    client.sendWindow([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ws?.sent).toHaveLength(0);
  });

  it('invokes onLocked on a valid lock message and ignores anything else', () => {
    const onLocked = vi.fn();
    openContinuousAuth('tok', { onLocked }, Ctor);
    const ws = FakeWebSocket.instances[0];

    ws?.emit('not json');
    ws?.emit(JSON.stringify({ type: 'something_else' }));
    expect(onLocked).not.toHaveBeenCalled();

    ws?.emit(JSON.stringify({ type: 'locked', reason: 'risk' }));
    expect(onLocked).toHaveBeenCalledTimes(1);
  });
});
