import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

async function page() {
  class Element {
    children = []; textContent = ''; disabled = false;
    classList = { toggle() {}, remove() {} };
    cloneNode() { const copy = new Element(); copy.isWelcome = this.isWelcome; return copy; }
    querySelector() { return this.children.find(child => child.isWelcome) || null; }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
  }
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const welcome = new Element(); welcome.isWelcome = true;
  get('conversation').append(welcome);
  let offline = false;
  const context = vm.createContext({
    document: { body: { dataset: {} }, getElementById: get, createElement: () => new Element(), querySelector: () => null, addEventListener() {} },
    window: { addEventListener() {} }, setInterval() {}, URL,
    LiveCall: class {},
    fetch: async () => {
      if (offline) throw new Error('Connection unavailable');
      return { ok: true, json: async () => ({ ready: true, liveReady: true, memories: [], notes: [] }) };
    }
  });
  vm.runInContext(readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8').replace(/^import .*\r?\n/, ''), context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, context, goOffline: () => { offline = true; } };
}

test('a lost app connection disables new work and reports the offline state', async () => {
  const { get, context, goOffline } = await page();
  assert.equal(get('start-live').disabled, false);
  goOffline();
  await vm.runInContext('refresh()', context);
  assert.equal(get('start-live').disabled, true);
  assert.equal(get('send').disabled, true);
  assert.equal(get('health').textContent, 'Local app unavailable');
  assert.match(get('status').textContent, /Connection unavailable/);
});

test('new chat restores the welcome state instead of leaving an empty pane', async () => {
  const { get } = await page();
  get('conversation').replaceChildren();
  await get('new-chat').onclick();
  assert.equal(get('conversation').children.length, 1);
  assert.equal(get('conversation').children[0].isWelcome, true);
  assert.match(get('status').textContent, /Notes and memories stay saved/);
});
