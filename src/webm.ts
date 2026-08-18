/**
 * Just enough of WebM to pull Opus packets out of YouTube's audio track.
 *
 * A full demuxer is not needed and a streaming one is: packets are handed over as they arrive,
 * and playback may start from the middle of the file, where there is no EBML header to read —
 * clusters are self-describing, so the reader can hunt for one and pick up from there.
 *
 * The Cues index is picked up on the way past when reading from the top: YouTube writes it ahead
 * of the first cluster, and it says which byte each cluster starts at, which is what makes a seek
 * land exactly rather than by estimate.
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
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;

/** Containers whose header is stepped over so their children get parsed in turn. */
const MASTERS = new Set([
  ID_SEGMENT,
  ID_INFO,
  ID_TRACKS,
  ID_TRACK_ENTRY,
  ID_CUES,
  ID_CUE_POINT,
  ID_CUE_TRACK_POSITIONS,
  ID_CLUSTER,
  ID_BLOCK_GROUP
]);

/** Elements worth waiting for a full buffer to read; anything else is skipped when it straddles. */
const WANTED = new Set([
  ID_TIMECODE_SCALE,
  ID_CODEC_PRIVATE,
  ID_CUE_TIME,
  ID_CUE_CLUSTER_POSITION,
  ID_TIMECODE,
  ID_SIMPLE_BLOCK,
  ID_BLOCK
]);

const CLUSTER_MAGIC = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const UNKNOWN_SIZE = -1;

export interface OpusPacket {
  data: Buffer;
  /** Presentation time in seconds from the start of the track. */
  time: number;
}

/** One entry of the Cues index: the cluster starting at `byte` begins at `time`. */
export interface CuePoint {
  /** Seconds. */
  time: number;
  /** Offset from the start of the file. */
  byte: number;
}

export class WebmOpusReader {
  /** OpusHead, needed to configure the decoder (channel count and pre-skip live in it). */
  head?: Buffer;
  /** The Cues index, in file order; complete once the first cluster is reached. */
  cues: CuePoint[] = [];
  /** Whether the first cluster has been reached — past the header, and so past the Cues too. */
  atClusters = false;

  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private skipping = 0;
  /**
   * How many bytes have been consumed before `pending`; the file offset of `pending[0]` when
   * reading from the top, which is the only time the Cues, whose positions this anchors, are met.
   */
  private base = 0;
  /** File offset the Cues positions are relative to: the first byte inside the Segment. */
  private segmentAt = 0;
  private cueTime = 0;
  private clusterTime = 0;
  // Timecode units → seconds. The default TimecodeScale is 1ms, and it must be assumed when
  // starting mid-file, where the header that declares it is far behind us.
  private scale = 1e-3;
  private hunting: boolean;

  /** `fromCluster` starts mid-file, where the reader must find a cluster before it can parse. */
  constructor(fromCluster = false) {
    this.hunting = fromCluster;
  }

  push(chunk: Buffer): OpusPacket[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const packets: OpusPacket[] = [];
    let at = 0;

    for (;;) {
      if (this.skipping > 0) {
        const dropped = Math.min(this.skipping, this.pending.length - at);
        at += dropped;
        this.skipping -= dropped;
        if (this.skipping > 0) {
          break;
        }
      }

      if (this.hunting) {
        const hunted = this.hunt(at);
        at = hunted.at;
        if (!hunted.found) {
          break;
        }
        this.hunting = false;
      }

      const element = readElement(this.pending, at);
      if (!element) {
        break;
      }

      const body = at + element.header;
      if (MASTERS.has(element.id)) {
        if (element.id === ID_SEGMENT) {
          this.segmentAt = this.base + body;
        } else if (element.id === ID_CLUSTER) {
          this.atClusters = true;
        }
        at = body;
        continue;
      }
      if (element.size === UNKNOWN_SIZE) {
        at = body;
        continue;
      }

      const end = body + element.size;
      if (end > this.pending.length) {
        if (WANTED.has(element.id)) {
          break; // wait for the rest of it
        }
        this.skipping = end - this.pending.length;
        at = this.pending.length;
        continue;
      }

      this.read(element.id, this.pending.subarray(body, end), packets);
      at = end;
    }

    this.base += at;
    this.pending = at > 0 ? this.pending.subarray(at) : this.pending;
    return packets;
  }

  /**
   * Finds the start of the next real cluster at or after `at`, or undefined if more bytes are
   * needed. The four magic bytes turn up inside compressed audio often enough that a match on its
   * own means nothing; a genuine cluster header is followed immediately by its Timecode, so each
   * candidate is checked for one before it is trusted.
   */
  private hunt(at: number): { at: number; found: boolean } {
    let from = at;
    for (;;) {
      const found = this.pending.indexOf(CLUSTER_MAGIC, from);
      if (found < 0) {
        // Keep only the tail: the magic sequence may be split across this boundary.
        const keep = Math.max(at, this.pending.length - (CLUSTER_MAGIC.length - 1));
        return { at: keep, found: false };
      }

      const cluster = readElement(this.pending, found);
      const child = cluster ? readElement(this.pending, found + cluster.header) : undefined;
      if (!cluster || !child) {
        if (this.pending.length - found < 32) {
          return { at: found, found: false }; // not enough bytes to judge it yet
        }
        from = found + 1;
        continue;
      }
      if (cluster.id === ID_CLUSTER && child.id === ID_TIMECODE) {
        return { at: found, found: true };
      }
      from = found + 1;
    }
  }

  private read(id: number, body: Buffer, packets: OpusPacket[]) {
    if (id === ID_CODEC_PRIVATE) {
      if (!this.head && body.subarray(0, 8).toString('latin1') === 'OpusHead') {
        this.head = Buffer.from(body);
      }
      return;
    }
    if (id === ID_TIMECODE_SCALE) {
      this.scale = readUint(body) / 1e9;
      return;
    }
    if (id === ID_CUE_TIME) {
      this.cueTime = readUint(body) * this.scale;
      return;
    }
    if (id === ID_CUE_CLUSTER_POSITION) {
      this.cues.push({ time: this.cueTime, byte: this.segmentAt + readUint(body) });
      return;
    }
    if (id === ID_TIMECODE) {
      this.clusterTime = readUint(body);
      return;
    }
    if (id === ID_SIMPLE_BLOCK || id === ID_BLOCK) {
      const frame = readBlock(body);
      if (frame) {
        packets.push({
          data: Buffer.from(frame.data),
          time: (this.clusterTime + frame.offset) * this.scale
        });
      }
    }
  }
}

interface Element {
  id: number;
  size: number;
  header: number;
}

function readElement(buffer: Buffer, at: number): Element | undefined {
  const id = readVint(buffer, at, true);
  if (!id) {
    return undefined;
  }
  const size = readVint(buffer, at + id.length, false);
  if (!size) {
    return undefined;
  }
  return { id: id.value, size: size.unknown ? UNKNOWN_SIZE : size.value, header: id.length + size.length };
}

interface Vint {
  value: number;
  length: number;
  unknown: boolean;
}

/**
 * EBML variable-size integer. Ids keep their marker bit (that is how they are written down in
 * the spec and compared here); sizes have it stripped.
 */
function readVint(buffer: Buffer, at: number, keepMarker: boolean): Vint | undefined {
  if (at >= buffer.length) {
    return undefined;
  }
  const first = buffer[at];
  if (first === 0) {
    return undefined; // 5+ byte lengths do not occur in these files
  }
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) {
    length++;
  }
  if (at + length > buffer.length) {
    return undefined;
  }

  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buffer[at + i];
    allOnes = allOnes && buffer[at + i] === 0xff;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function readUint(body: Buffer): number {
  let value = 0;
  for (const byte of body) {
    value = value * 256 + byte;
  }
  return value;
}

/** A block is [track vint][int16 timecode][flags][frame]; YouTube's Opus never uses lacing. */
function readBlock(body: Buffer): { data: Buffer; offset: number } | undefined {
  const track = readVint(body, 0, false);
  if (!track || body.length < track.length + 4) {
    return undefined;
  }
  let at = track.length;
  const offset = body.readInt16BE(at);
  at += 2;
  const flags = body[at];
  at += 1;
  if ((flags & 0x06) !== 0) {
    return undefined; // laced blocks would need splitting; they do not appear here
  }
  return { data: body.subarray(at), offset };
}
