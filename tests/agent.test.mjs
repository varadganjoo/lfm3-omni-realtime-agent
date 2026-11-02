import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, runTurn } from '../src/server/agent.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'local-speech-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, store: new Store(directory) };
}
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

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
  store.run('remember_fact', { key: 'preferred_drink', value: 'tea' });
  const restarted = new Store(directory);
  assert.equal(restarted.memories[0].value, 'tea');
  restarted.run('remember_fact', { key: 'preferred_drink', value: 'coffee' });
  assert.equal(restarted.memories.length, 1);
  assert.match(restarted.instructions(), /coffee/);
  restarted.forget('preferred_drink');
  assert.deepEqual(new Store(directory).memories, []);
});

test('invalid model tool arguments do not change stored data', t => {
  const { store } = fixture(t);
  assert.throws(() => store.run('remember_fact', '{broken'));
  assert.throws(() => store.run('remember_fact', { key: '../bad', value: 'no' }));
  assert.throws(() => store.run('remember_fact', { key: 'good', value: 7 }));
  assert.throws(() => store.run('run_shell', { command: 'no' }));
  assert.deepEqual(store.memories, []);
});

test('tool loop reports results and deduplicates repeated note calls', async t => {
  const { store, directory } = fixture(t);
  const messages = [{ role: 'user', content: 'Save a note.' }], events = [];
  let round = 0;
  const answer = await runTurn({ store, messages, events, complete: async history => {
    assert.equal(history[0].role, 'system');
    if (++round <= 2) return { role: 'assistant', content: null, tool_calls: [call(String(round), 'save_note', { title: 'Test', body: 'Once.' })] };
    assert.equal(history.at(-1).role, 'tool');
    return { role: 'assistant', content: 'Saved.' };
  } });
  assert.equal(answer, 'Saved.');
  assert.equal(events.length, 1);
  assert.equal(readdirSync(join(directory, 'notes')).length, 1);
});

test('tool failures are returned to the model without claiming success', async t => {
  const { store } = fixture(t), events = [];
  let round = 0;
  await runTurn({ store, messages: [], events, complete: async history => {
    if (!round++) return { role: 'assistant', tool_calls: [call('bad', 'save_note', { title: 'x', body: '' })] };
    assert.match(history.at(-1).content, /error/);
    return { role: 'assistant', content: 'The note could not be saved.' };
  } });
  assert.ok(events[0].error);
});

test('a runaway tool loop stops and abort prevents writes', async t => {
  const { store } = fixture(t);
  let count = 0;
  await assert.rejects(runTurn({ store, messages: [], events: [], complete: async () => ({ role: 'assistant', tool_calls: [call(String(++count), 'remember_fact', { key: 'test', value: String(count) })] }) }), /kept requesting tools/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runTurn({ store, messages: [], events: [], signal: abort.signal, complete: async () => { throw new Error('should not call'); } }), /abort/i);
  assert.equal(count, 4);
});
