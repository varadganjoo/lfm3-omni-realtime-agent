import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveCall, mediaSocketURL } from '../src/web/live.js';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('live media uses encrypted WebSockets on the LAN HTTPS page', () => {
  assert.equal(mediaSocketURL(new URL('https://192.168.50.10:8443')), 'wss://192.168.50.10:8443/api/live/media');
  assert.equal(mediaSocketURL(new URL('http://127.0.0.1:8787')), 'ws://127.0.0.1:8787/api/live/media');
});

test('interruption stops queued audio and late answers cannot restart playback', () => {
  const events = [], stopped = [];
  const call = new LiveCall({ onEvent: event => events.push(event) });
  call.socket = { readyState: WebSocket.OPEN, send() {} }; call.ready = true;
  call.sources.add({ stop() { stopped.push(true); }, disconnect() {} });
  call.receive(JSON.stringify({ type: 'answer', generation: 3, text: 'Old answer.' }));
  assert.equal(call.blocked, false);
  call.interrupt();
  assert.equal(stopped.length, 1);
  assert.equal(call.sources.size, 0);
  assert.equal(call.blocked, true);
  call.receive(JSON.stringify({ type: 'answer', generation: 3, text: 'Too late.' }));
  assert.equal(call.blocked, true);
  assert.equal(events.length, 1);
  call.receive(JSON.stringify({ type: 'interrupted', generation: 4 }));
  call.receive(JSON.stringify({ type: 'answer', generation: 5, text: 'New answer.' }));
  assert.equal(call.blocked, false);
  assert.equal(events.at(-1).text, 'New answer.');
});

test('the actual microphone worklet emits clipped PCM16 in 20 ms packets', () => {
  const packets = [];
  let Capture;
  vm.runInNewContext(readFileSync(new URL('../src/web/capture.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: buffer => packets.push(buffer) }; } },
    registerProcessor: (_name, constructor) => { Capture = constructor; }, Int16Array
  });
  const capture = new Capture();
  capture.process([[new Float32Array(319).fill(2)]]);
  assert.equal(packets.length, 0);
  capture.process([[new Float32Array([-2])]]);
  assert.equal(packets[0].byteLength, 640);
  const pcm = new Int16Array(packets[0]);
  assert.equal(pcm[0], 32767);
  assert.equal(pcm[319], -32768);
});

test('a microphone permission result arriving after disconnect cannot replace a newer stream', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldContext = globalThis.AudioContext;
  t.after(() => { Object.defineProperty(globalThis, 'navigator', descriptor); globalThis.AudioContext = oldContext; });
  let grant, stopped = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise(resolve => { grant = resolve; }) } } });
  globalThis.AudioContext = class {
    state = 'running'; destination = {};
    async resume() {}
    createGain() { return { connect() {} }; }
    async close() { this.state = 'closed'; }
  };
  const call = new LiveCall({ onStream() {}, onClose() {}, onEvent() {} });
  const connecting = call.connect(false);
  await new Promise(resolve => setImmediate(resolve));
  await call.disconnect();
  const newer = { marker: 'newer stream' }; call.stream = newer;
  grant({ getTracks: () => [{ stop() { stopped++; } }] });
  await connecting;
  assert.equal(stopped, 1);
  assert.equal(call.stream, newer);
});

test('stopping a live call immediately releases devices, queued speech and the media socket', async () => {
  const released = [];
  const call = new LiveCall({ onStream: stream => released.push(stream), onClose: () => released.push('closed') });
  call.ready = true; call.blocked = false;
  call.socket = { close: () => released.push('socket') };
  call.stream = { getTracks: () => [{ stop: () => released.push('mic') }, { stop: () => released.push('camera') }] };
  call.sources.add({ stop: () => released.push('speech'), disconnect() {} });
  call.captureContext = { state: 'running', close: async () => released.push('capture') };
  call.playContext = { state: 'running', close: async () => released.push('playback') };
  await call.disconnect();
  assert.equal(call.ready, false);
  assert.equal(call.blocked, true);
  assert.equal(call.stream, null);
  assert.equal(call.socket, null);
  assert.deepEqual(released, ['speech', 'socket', 'mic', 'camera', 'capture', 'playback', null, 'closed']);
});
