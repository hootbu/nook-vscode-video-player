import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpusPacket, WebmOpusReader } from '../webm';

/**
 * Enough of a WebM writer to build the shapes the reader has to survive. Real YouTube audio cannot
 * be checked into a repository, and a handful of bytes is a sharper test anyway: the interesting
 * cases here are a file arriving in pieces and a file joined halfway through.
 */

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_CUES = 0x1c53bb6b;
const ID_CUE_POINT = 0xbb;
const ID_CUE_TIME = 0xb3;
const ID_CUE_TRACK_POSITIONS = 0xb7;
const ID_CUE_CLUSTER_POSITION = 0xf1;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;

/** Element ids are written with their marker bit, exactly as the spec lists them. */
function idBytes(id: number): Buffer {
  const bytes: number[] = [];
  for (let rest = id; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest & 0xff);
  }
  return Buffer.from(bytes);
}

function sizeBytes(length: number): Buffer {
  if (length < 0x7f) {
    return Buffer.from([0x80 | length]);
  }
  if (length < 0x3fff) {
    return Buffer.from([0x40 | (length >> 8), length & 0xff]);
  }
  return Buffer.from([0x20 | ((length >> 16) & 0xff), (length >> 8) & 0xff, length & 0xff]);
}

function el(id: number, body: Buffer): Buffer {
  return Buffer.concat([idBytes(id), sizeBytes(body.length), body]);
}

function uint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  return Buffer.from(bytes);
}

function opusHead(channels = 2, preSkip = 312): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = channels;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48000, 12);
  return head;
}

/** `[track vint][int16 timecode][flags][frame]`, the only block layout YouTube's Opus uses. */
function block(offset: number, payload: string, flags = 0x80): Buffer {
  const timecode = Buffer.alloc(2);
  timecode.writeInt16BE(offset);
  return Buffer.concat([
    Buffer.from([0x81]),
    timecode,
    Buffer.from([flags]),
    Buffer.from(payload, 'latin1')
  ]);
}

function cluster(timecode: number, blocks: Buffer[]): Buffer {
  return el(
    ID_CLUSTER,
    Buffer.concat([
      el(ID_TIMECODE, uint(timecode)),
      ...blocks.map((body) => el(ID_SIMPLE_BLOCK, body))
    ])
  );
}

/** `scale` is TimecodeScale in nanoseconds; 1000000 is the default of one millisecond. */
function file(scale = 1_000_000): Buffer {
  return el(
    ID_SEGMENT,
    Buffer.concat([
      el(ID_INFO, el(ID_TIMECODE_SCALE, uint(scale))),
      el(ID_TRACKS, el(ID_TRACK_ENTRY, el(ID_CODEC_PRIVATE, opusHead()))),
      cluster(0, [block(0, 'one'), block(20, 'two')]),
      cluster(1000, [block(0, 'three')])
    ])
  );
}

/**
 * The same file with a Cues index ahead of the clusters, as YouTube writes it. Positions in the
 * index count from the first byte inside the Segment; the index's own length moves the clusters,
 * so it is built again until it agrees with itself.
 */
function indexedFile(): { source: Buffer; clusters: number[] } {
  const header = Buffer.concat([
    el(ID_INFO, el(ID_TIMECODE_SCALE, uint(1_000_000))),
    el(ID_TRACKS, el(ID_TRACK_ENTRY, el(ID_CODEC_PRIVATE, opusHead())))
  ]);
  const clusters = [cluster(0, [block(0, 'one'), block(20, 'two')]), cluster(1000, [block(0, 'three')])];
  const times = [0, 1000];

  let positions = [0, 0];
  let cues: Buffer;
  for (;;) {
    cues = el(
      ID_CUES,
      Buffer.concat(
        positions.map((position, i) =>
          el(
            ID_CUE_POINT,
            Buffer.concat([
              el(ID_CUE_TIME, uint(times[i])),
              el(ID_CUE_TRACK_POSITIONS, el(ID_CUE_CLUSTER_POSITION, uint(position)))
            ])
          )
        )
      )
    );
    const first = header.length + cues.length;
    const next = [first, first + clusters[0].length];
    if (next[0] === positions[0] && next[1] === positions[1]) {
      break;
    }
    positions = next;
  }

  const source = el(ID_SEGMENT, Buffer.concat([header, cues, ...clusters]));
  const segmentAt = source.length - (header.length + cues.length + clusters[0].length + clusters[1].length);
  return { source, clusters: positions.map((position) => segmentAt + position) };
}

function payloads(packets: OpusPacket[]): string[] {
  return packets.map((packet) => packet.data.toString('latin1'));
}

test('reads the head, the packets and their times', () => {
  const reader = new WebmOpusReader();
  const packets = reader.push(file());

  assert.deepEqual(reader.head, opusHead());
  assert.deepEqual(payloads(packets), ['one', 'two', 'three']);
  assert.deepEqual(
    packets.map((packet) => packet.time),
    [0, 0.02, 1]
  );
});

test('TimecodeScale sets the unit times are counted in', () => {
  const packets = new WebmOpusReader().push(file(500_000));

  assert.deepEqual(
    packets.map((packet) => packet.time),
    [0, 0.01, 0.5]
  );
});

test('a file arriving one byte at a time reads the same as one arriving whole', () => {
  const source = file();
  const reader = new WebmOpusReader();
  const packets: OpusPacket[] = [];
  for (let at = 0; at < source.length; at++) {
    packets.push(...reader.push(source.subarray(at, at + 1)));
  }

  assert.deepEqual(reader.head, opusHead());
  assert.deepEqual(payloads(packets), ['one', 'two', 'three']);
  assert.deepEqual(
    packets.map((packet) => packet.time),
    [0, 0.02, 1]
  );
});

test('starting mid-file skips to the first real cluster', () => {
  // The tail of some earlier block, carrying the cluster magic in its compressed audio: four
  // matching bytes prove nothing, and only the Timecode that must follow a real header does.
  const decoy = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
  const reader = new WebmOpusReader(true);
  const packets = reader.push(Buffer.concat([decoy, cluster(2000, [block(0, 'later')])]));

  assert.equal(reader.head, undefined);
  assert.deepEqual(payloads(packets), ['later']);
  // No TimecodeScale to be found this far in, so the one-millisecond default is assumed.
  assert.deepEqual(
    packets.map((packet) => packet.time),
    [2]
  );
});

test('laced blocks are dropped rather than mangled', () => {
  const laced = cluster(0, [block(0, 'fixed-lacing', 0x82)]);
  assert.deepEqual(new WebmOpusReader(true).push(laced), []);
});

test('the Cues index is read on the way past, with positions counted from the top of the file', () => {
  const { source, clusters } = indexedFile();
  const reader = new WebmOpusReader();
  const packets = reader.push(source);

  assert.equal(reader.atClusters, true);
  assert.deepEqual(reader.cues, [
    { time: 0, byte: clusters[0] },
    { time: 1, byte: clusters[1] }
  ]);
  // The index really does point at cluster headers, and the rest still reads as before.
  assert.equal(source.readUInt32BE(clusters[1]), ID_CLUSTER);
  assert.deepEqual(payloads(packets), ['one', 'two', 'three']);
});

test('the index reads the same when the file arrives one byte at a time', () => {
  const { source, clusters } = indexedFile();
  const reader = new WebmOpusReader();
  for (let at = 0; at < source.length; at++) {
    reader.push(source.subarray(at, at + 1));
  }

  assert.deepEqual(
    reader.cues.map((cue) => cue.byte),
    clusters
  );
});

test('a reader started at an indexed position picks up that cluster and no earlier one', () => {
  const { source, clusters } = indexedFile();
  const reader = new WebmOpusReader(true);
  const packets = reader.push(source.subarray(clusters[1]));

  assert.deepEqual(payloads(packets), ['three']);
  assert.deepEqual(
    packets.map((packet) => packet.time),
    [1]
  );
});

test('the head is not enough to be past the index: atClusters waits for the first cluster', () => {
  const { source, clusters } = indexedFile();
  const reader = new WebmOpusReader();
  reader.push(source.subarray(0, clusters[0]));

  assert.ok(reader.head);
  assert.equal(reader.atClusters, false);
  reader.push(source.subarray(clusters[0]));
  assert.equal(reader.atClusters, true);
});
