import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fragmentAt, parseSidx } from '../mp4';

/**
 * A handful of bytes standing in for YouTube's init+index range: an ftyp and moov of no interest
 * to the parser, then a v0 sidx listing three fragments. The parser only has to find the sidx,
 * read its timescale and references, and turn them into byte offsets and times.
 */
function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/** A v0 sidx with the given timescale and [size, duration] references, first_offset 0. */
function sidx(timescale: number, refs: Array<[number, number]>): Buffer {
  const head = Buffer.alloc(12);
  head.writeUInt8(0, 0); // version 0, so 32-bit times
  head.writeUInt32BE(1, 4); // reference_id
  head.writeUInt32BE(timescale, 8);
  const tail = Buffer.alloc(8);
  tail.writeUInt32BE(0, 0); // earliest_presentation_time
  tail.writeUInt32BE(0, 4); // first_offset
  const count = Buffer.alloc(4);
  count.writeUInt16BE(0, 0); // reserved
  count.writeUInt16BE(refs.length, 2);
  const entries = Buffer.concat(
    refs.map(([size, duration]) => {
      const entry = Buffer.alloc(12);
      entry.writeUInt32BE(size & 0x7fffffff, 0); // reference type 0 (media)
      entry.writeUInt32BE(duration, 4);
      entry.writeUInt32BE(0, 8); // SAP
      return entry;
    })
  );
  return box('sidx', Buffer.concat([head, tail, count, entries]));
}

test('the sidx becomes a table of byte offsets and times', () => {
  const ftyp = box('ftyp', Buffer.alloc(16));
  const moov = box('moov', Buffer.alloc(40));
  const index = sidx(1000, [
    [500, 2000],
    [300, 1000],
    [700, 3000]
  ]);
  const file = Buffer.concat([ftyp, moov, index]);
  const indexEnd = file.length - 1;

  const fragments = parseSidx(file, indexEnd);
  assert.equal(fragments.length, 3);

  // The first fragment begins right after the sidx box; each following one after the last.
  assert.deepEqual(fragments[0], { byte: indexEnd + 1, size: 500, time: 0, duration: 2 });
  assert.deepEqual(fragments[1], { byte: indexEnd + 1 + 500, size: 300, time: 2, duration: 1 });
  assert.deepEqual(fragments[2], { byte: indexEnd + 1 + 800, size: 700, time: 3, duration: 3 });
});

test('fragmentAt finds the fragment covering a moment', () => {
  const index = sidx(1000, [
    [500, 2000],
    [300, 1000],
    [700, 3000]
  ]);
  const fragments = parseSidx(index, index.length - 1);
  // times: [0, 2, 3]
  assert.equal(fragmentAt(fragments, 0), 0);
  assert.equal(fragmentAt(fragments, 1.9), 0);
  assert.equal(fragmentAt(fragments, 2), 1);
  assert.equal(fragmentAt(fragments, 2.5), 1);
  assert.equal(fragmentAt(fragments, 3), 2);
  assert.equal(fragmentAt(fragments, 999), 2);
});

test('a missing sidx is a clear failure, not a silent empty table', () => {
  const file = Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', Buffer.alloc(16))]);
  assert.throws(() => parseSidx(file, file.length - 1), /sidx/);
});
