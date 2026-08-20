/**
 * Just enough of the ISO base media format to drive Media Source Extensions from YouTube's
 * fragmented MP4 video track.
 *
 * Two small ranges up front say everything. `init_range` is the ftyp+moov the decoder is
 * configured from; `index_range` is a single `sidx` box that lists every fragment — its byte size
 * and its duration — so the exact byte range of the fragment covering any moment is known without
 * reading a stream. That is what lets the feed fetch bounded ranges (which googlevideo serves at
 * full speed) instead of the open-ended request a plain `<video src>` makes (which it throttles to
 * roughly twice the bitrate, starving a long watch).
 */

export interface Fragment {
  /** Offset from the start of the file. */
  byte: number;
  /** Bytes. */
  size: number;
  /** Presentation time of the fragment's first sample, in seconds. */
  time: number;
  /** Seconds. */
  duration: number;
}

/**
 * Parses the `sidx` into a fragment table. `buffer` holds the file from byte 0 through the end of
 * the index range; `indexEnd` is the last byte of the `sidx` box, whose next byte anchors the
 * offsets inside it.
 */
export function parseSidx(buffer: Buffer, indexEnd: number): Fragment[] {
  const box = findBox(buffer, 'sidx');
  if (!box) {
    throw new Error('The video track carries no sidx index.');
  }

  let at = box.start;
  const version = buffer[at];
  at += 4; // version + flags
  at += 4; // reference_id
  const timescale = buffer.readUInt32BE(at);
  at += 4;
  // earliest_presentation_time and first_offset are 32-bit in v0, 64-bit in v1.
  at += version === 0 ? 4 : 8; // earliest_presentation_time (unused: the table starts at 0)
  const firstOffset = version === 0 ? buffer.readUInt32BE(at) : readU64(buffer, at);
  at += version === 0 ? 4 : 8;
  at += 2; // reserved
  const count = buffer.readUInt16BE(at);
  at += 2;

  const fragments: Fragment[] = [];
  // The anchor is the byte after the sidx box; offsets in it are relative to there.
  let byte = indexEnd + 1 + firstOffset;
  let ticks = 0;
  for (let i = 0; i < count; i++) {
    // High bit of the first word is the reference type; YouTube only ever writes media references.
    const size = buffer.readUInt32BE(at) & 0x7fffffff;
    const duration = buffer.readUInt32BE(at + 4);
    at += 12; // size+type, duration, SAP word
    fragments.push({ byte, size, time: ticks / timescale, duration: duration / timescale });
    byte += size;
    ticks += duration;
  }
  return fragments;
}

/** The fragment covering `time`: the last one starting at or before it. */
export function fragmentAt(fragments: Fragment[], time: number): number {
  let found = 0;
  for (let i = 0; i < fragments.length; i++) {
    if (fragments[i].time > time) {
      break;
    }
    found = i;
  }
  return found;
}

interface Box {
  /** Offset of the box's payload, past its 8-byte header. */
  start: number;
  end: number;
}

/** Finds a top-level box by type. Only the small init+index buffer is ever walked, so this is flat. */
function findBox(buffer: Buffer, type: string): Box | undefined {
  let at = 0;
  while (at + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(at);
    if (buffer.toString('latin1', at + 4, at + 8) === type) {
      return { start: at + 8, end: at + size };
    }
    if (size < 8) {
      break; // a zero or oversmall size would loop forever
    }
    at += size;
  }
  return undefined;
}

function readU64(buffer: Buffer, at: number): number {
  return Number(buffer.readBigUInt64BE(at));
}
