import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/agent.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'local-speech-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new Store(directory) };
}

test('notes stay inside the note folder even with path-like titles', t => {
  const { store, directory } = fixture(t);
  const saved = store.run('save_note', { title: '../../outside', body: 'A real note.' });
  assert.match(saved.filename, /^[a-f0-9-]+\.md$/);
  assert.equal(readdirSync(join(directory, 'notes')).length, 1);
  assert.equal(readFileSync(join(directory, 'notes', saved.filename), 'utf8'), '# ../../outside\n\nA real note.\n');
  assert.throws(() => store.run('save_note', { title: 'x', body: 'y', path: 'outside.md' }));
  assert.throws(() => store.run('save_note', { title: 'x', body: '' }));
});

test('memory survives restart, corrections replace facts, forgetting persists', t => {
  const { store, directory } = fixture(t);
  store.run('remember_fact', { key: 'preferred_drink' }, 'Remember that I prefer tea.');
  const restarted = new Store(directory);
  assert.equal(restarted.memories[0].value, 'I prefer tea.');
  restarted.run('remember_fact', { key: 'preferred_drink' }, 'Remember: I prefer coffee.');
  assert.equal(restarted.memories.length, 1);
  assert.match(restarted.instructions(), /coffee/);
  restarted.forget('preferred_drink');
  assert.deepEqual(new Store(directory).memories, []);
});

test('memory writes require explicit user text and reject model-authored facts', t => {
  const { store } = fixture(t);
  const key = 'preferred_name';
  assert.throws(() => store.run('remember_fact', { key }, "What's your name?"), /Start with/);
  assert.throws(() => store.run('remember_fact', { key, value: 'Harv' }, 'Remember that my name is Ada.'));
  assert.deepEqual(store.memories, []);
  const result = store.run('remember_fact', { key }, 'Remember that my name is Ada.');
  assert.equal(result.value, 'my name is Ada.');
});

test('invalid model tool arguments do not change stored data', t => {
  const { store } = fixture(t);
  assert.throws(() => store.run('remember_fact', '{broken'));
  assert.throws(() => store.run('remember_fact', { key: '../bad' }, 'Remember: no.'), /lowercase/);
  assert.throws(() => store.run('remember_fact', { key: 'good', value: 7 }));
  assert.throws(() => store.run('run_shell', { command: 'no' }));
  assert.deepEqual(store.memories, []);
});
