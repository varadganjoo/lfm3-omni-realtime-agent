import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanPolicy, browserOrigin } from '../src/server/network.mjs';

const config = { address: '192.168.50.10', prefixLength: 24, certificateSha256: 'A'.repeat(64) };
const lan = lanPolicy(config);
function request(host, remoteAddress, encrypted = true) { return { headers: { host }, socket: { remoteAddress, encrypted } }; }

test('LAN accepts only its exact host, HTTPS and home subnet; forwarded headers do not grant access', () => {
  assert.equal(browserOrigin(request('192.168.50.10:8443', '192.168.50.50'), lan), lan.origin);
  assert.equal(browserOrigin(request('192.168.50.10:8443', '::ffff:192.168.50.50'), lan), lan.origin);
  for (const req of [request('evil.example:8443', '192.168.50.50'), request('192.168.50.10:8443', '192.168.51.50'), request('192.168.50.10:8443', '192.168.50.50', false), request('127.0.0.1:8787', '192.168.50.50', false)]) {
    req.headers['x-forwarded-for'] = '192.168.50.50';
    assert.equal(browserOrigin(req, lan), null);
  }
  assert.equal(browserOrigin(request('127.0.0.1:8787', '127.0.0.1', false), lan), 'http://127.0.0.1:8787');
  assert.equal(browserOrigin(request('192.168.50.10:8443', '192.168.50.50')), null);
  assert.equal(lan.allows(request('192.168.50.10:8789', '192.168.50.50', false), true), true);
  assert.equal(lan.allows(request('192.168.50.10:8789', '192.168.51.50', false), true), false);
});

test('invalid LAN settings fail closed', () => {
  for (const changes of [{ address: '0.0.0.0' }, { address: '8.8.8.8' }, { address: '<script>' }, { prefixLength: 0 }, { prefixLength: 33 }, { prefixLength: '24' }, { certificateSha256: 'bad' }]) {
    assert.throws(() => lanPolicy({ ...config, ...changes }), /Invalid LAN settings/);
  }
});
