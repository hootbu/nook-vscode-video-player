import { CuePoint, OpusPacket, WebmOpusReader } from './webm';

const CHUNK_SIZE = 512 * 1024;
/** How far ahead of playback the feed is allowed to run before it waits. */
const LEAD_SECONDS = 15;
const RENEW_ATTEMPTS = 2;
const RENEW_DELAY_MS = 700;

export interface AudioSink {
  /** `cues` is the track's index — empty when the feed was started mid-file with a known head. */
  head(head: Buffer, cues: CuePoint[]): void;
  packets(packets: OpusPacket[]): void;
  ended(): void;
  failed(message: string): void;
}

/**
 * Streams the Opus track to the webview, staying a little ahead of playback and no further.
 * Nothing is written to disk and nothing is fetched that will not be heard — pause the video and
 * the feed stops pulling within seconds.
 *
 * Playback may start anywhere: given a byte offset and a previously captured OpusHead, the reader
 * hunts for the next cluster instead of parsing from the top of the file.
 */
export class AudioFeed {
  private readonly abort = new AbortController();
  private readonly reader: WebmOpusReader;
  private position: number;
  private ahead = 0;
  private target = 0;
  private wake?: () => void;
  private headSent = false;

  /** Total size of the audio track, learned from the first response; 0 until then. */
  size = 0;

  constructor(
    private readonly urlFor: (renew: boolean) => Promise<string>,
    private readonly sink: AudioSink,
    options: { startByte?: number; startTime?: number; head?: Buffer } = {}
  ) {
    this.position = options.startByte ?? 0;
    this.ahead = options.startTime ?? 0;
    this.target = this.ahead;
    this.reader = new WebmOpusReader(this.position > 0);

    if (options.head) {
      this.headSent = true;
      sink.head(options.head, []);
    }

    this.run().catch((error: Error) => {
      if (!this.abort.signal.aborted) {
        sink.failed(error.message);
      }
    });
  }

  /** Reports where playback is, so the feed knows whether more audio is needed. */
  advance(time: number) {
    this.target = time;
    this.wake?.();
  }

  dispose() {
    this.abort.abort();
    this.wake?.();
  }

  private async run() {
    while (!this.abort.signal.aborted) {
      await this.waitUntilHungry();
      if (this.abort.signal.aborted) {
        return;
      }
      // Asking past the end earns a 403 here rather than a 416, so the end is checked first.
      if (this.size && this.position >= this.size) {
        break;
      }

      const last = this.size
        ? Math.min(this.position + CHUNK_SIZE, this.size) - 1
        : this.position + CHUNK_SIZE - 1;
      const response = await this.fetchRange(`bytes=${this.position}-${last}`);
      if (response.status === 416) {
        break;
      }
      if (response.status !== 206 || !response.body) {
        throw new Error(
          response.status === 403
            ? 'YouTube refused the audio stream (HTTP 403); it usually clears within a minute.'
            : `Audio stream responded with HTTP ${response.status}`
        );
      }
      this.size = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]) || this.size;

      let received = 0;
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (this.abort.signal.aborted) {
          return;
        }
        received += part.length;
        this.emit(this.reader.push(Buffer.from(part)));
        await this.waitUntilHungry();
      }

      this.position += received;
      if (received === 0 || (this.size && this.position >= this.size)) {
        break;
      }
    }

    if (!this.abort.signal.aborted) {
      this.sink.ended();
    }
  }

  private emit(packets: OpusPacket[]) {
    // Held until the first cluster: the Cues sit between the head and it, and a seek made on the
    // head's arrival (resuming a video) needs them complete.
    if (!this.headSent && this.reader.head && this.reader.atClusters) {
      this.headSent = true;
      this.sink.head(this.reader.head, this.reader.cues);
    }
    if (packets.length) {
      this.ahead = packets[packets.length - 1].time;
      this.sink.packets(packets);
    }
  }

  /** A wake-up is only a prompt to re-check: one wake must not buy one fetch on its own. */
  private async waitUntilHungry(): Promise<void> {
    while (this.ahead > this.target + LEAD_SECONDS && !this.abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = undefined;
          resolve();
        };
      });
    }
  }

  /** 403 means the URL is spent rather than retryable, so the streams get re-resolved. */
  private async fetchRange(range: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const url = await this.urlFor(attempt > 0);
      const response = await fetch(url, {
        headers: { Range: range },
        signal: this.abort.signal
      });
      if (response.status !== 403 || attempt === RENEW_ATTEMPTS) {
        return response;
      }
      await response.body?.cancel().catch(() => {});
      await delay(RENEW_DELAY_MS * (attempt + 1), this.abort.signal);
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      },
      { once: true }
    );
  });
}

/**
 * Packs packets into one transferable blob: a count, then per-packet lengths and times, then the
 * payloads. One base64 string per batch beats thousands of JSON-encoded byte arrays.
 */
export function packPackets(packets: OpusPacket[]): string {
  const total = packets.reduce((sum, packet) => sum + packet.data.length, 0);
  const buffer = Buffer.alloc(4 + packets.length * 6 + total);
  buffer.writeUInt32LE(packets.length, 0);

  let lengthAt = 4;
  let timeAt = 4 + packets.length * 2;
  let dataAt = 4 + packets.length * 6;
  for (const packet of packets) {
    buffer.writeUInt16LE(packet.data.length, lengthAt);
    buffer.writeUInt32LE(Math.round(packet.time * 1000), timeAt);
    packet.data.copy(buffer, dataAt);
    lengthAt += 2;
    timeAt += 4;
    dataAt += packet.data.length;
  }
  return buffer.toString('base64');
}
