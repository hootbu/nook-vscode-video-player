import assert from 'node:assert/strict';
import { test } from 'node:test';
import { History, Watched } from '../history';

/** Stands in for the extension's globalState, which is a key-value store and nothing more. */
function memento(initial: Watched[] = []) {
  const store = new Map<string, unknown>([['player.history', initial]]);
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, fallback?: T) => (store.get(key) as T) ?? fallback,
    update: async (key: string, value: unknown) => void store.set(key, value),
    /** What has actually been written, for asserting that it survives a restart. */
    stored: () => store.get('player.history') as Watched[]
  };
}

function watched(id: string, position: number, duration = 600): Watched {
  return { id, title: id, channel: 'Someone', position, duration, at: 1 };
}

test('a half-watched video is picked up where it was left', () => {
  const history = new History(memento([watched('a', 300)]));
  assert.equal(history.resumeAt('a'), 300);
});

test('neither end of a video is worth returning to', () => {
  const history = new History(
    memento([watched('barely', 4), watched('finished', 595), watched('middle', 300)])
  );

  assert.equal(history.resumeAt('barely'), 0);
  assert.equal(history.resumeAt('finished'), 0);
  assert.equal(history.resumeAt('middle'), 300);
  assert.equal(history.resumeAt('never-watched'), 0);
});

test('watching again keeps the position already recorded', () => {
  const store = memento([watched('a', 300)]);
  const history = new History(store);

  history.record({ id: 'a', title: 'A', channel: 'Someone', duration: 600 });

  assert.equal(history.resumeAt('a'), 300);
  assert.equal(store.stored().length, 1);
});

test('the newest watch comes first and the list is capped', () => {
  const store = memento();
  const history = new History(store);

  for (let i = 0; i < 60; i++) {
    history.record({ id: `v${i}`, title: `V${i}`, channel: 'Someone', duration: 600 });
  }

  const list = history.list();
  assert.equal(list.length, 50);
  assert.equal(list[0].id, 'v59');
  assert.equal(list[49].id, 'v10');
  // The oldest ten are gone rather than lingering out of sight.
  assert.equal(history.resumeAt('v0'), 0);
});

test('positions are written out, not only held in memory', () => {
  const store = memento();
  const history = new History(store);
  history.record({ id: 'a', title: 'A', channel: 'Someone', duration: 600 });

  history.position('a', 420);
  history.dispose();

  assert.equal(store.stored()[0].position, 420);
  assert.equal(new History(store).resumeAt('a'), 420);
});

test('clearing leaves nothing behind', () => {
  const store = memento([watched('a', 300)]);
  const history = new History(store);

  history.clear();

  assert.deepEqual(history.list(), []);
  assert.deepEqual(store.stored(), []);
});
