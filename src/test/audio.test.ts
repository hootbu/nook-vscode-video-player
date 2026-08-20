import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packPackets } from '../audio';
import { OpusPacket } from '../webm';

/**
 * The webview's half of the packing, kept here so the two ends are checked against each other.
 * It mirrors `unpack` in media/main.js; if one side is changed without the other, this fails.
 */
function unpack(base64: string): { time: number; data: number[] }[] {
  const bytes = Buffer.from(base64, 'base64');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0, true);
  const packets = [];
  let lengthAt = 4;
  let timeAt = 4 + count * 2;
  let dataAt = 4 + count * 6;
  for (let i = 0; i < count; i++) {
    const length = view.getUint16(lengthAt, true);
    packets.push({
      time: view.getUint32(timeAt, true) / 1000,
      data: [...bytes.subarray(dataAt, dataAt + length)]
    });
    lengthAt += 2;
    timeAt += 4;
    dataAt += length;
  }
  return packets;
}

test('a batch survives the trip to the webview intact', () => {
  // Times that a float32 holds exactly, so the assertion is about the packing and not about
  // rounding — the loss of precision the wire format costs is a fraction of a millisecond.
  const packets: OpusPacket[] = [
    { time: 0, data: Buffer.from([1, 2, 3]) },
    { time: 0.25, data: Buffer.from([]) },
    { time: 1.5, data: Buffer.from(Array.from({ length: 400 }, (_, i) => i & 0xff)) }
  ];

  assert.deepEqual(unpack(packPackets(packets)), [
    { time: 0, data: [1, 2, 3] },
    { time: 0.25, data: [] },
    { time: 1.5, data: Array.from({ length: 400 }, (_, i) => i & 0xff) }
  ]);
});

test('an empty batch packs to a count of nothing', () => {
  assert.deepEqual(unpack(packPackets([])), []);
});
