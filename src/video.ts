import type { VideoOption } from './stream';
import { Fragment, fragmentAt, parseSidx } from './mp4';

/**
 * How far ahead of playback the feed keeps the picture buffered before it waits. Generous enough
 * that a slow edge or a URL renewal is absorbed without the playhead ever reaching the buffer's
 * edge; still small next to the SourceBuffer's quota.
 */
const LEAD_SECONDS = 45;
/** Fragment fetches kept in flight at once; sends still go out strictly in order. */
const PIPELINE = 2;
const RENEW_ATTEMPTS = 2;
const RENEW_DELAY_MS = 700;
/**
 * No bounded range takes this long at full speed; a request still open past it is a connection
 * googlevideo silently dropped, and waiting on it would freeze the picture with no error to show.
 */
const FETCH_TIMEOUT_MS = 30000;

export interface VideoSink {
  /** The ftyp+moov the SourceBuffer is initialised with, and the codec string it needs. */
  init(head: Buffer, mime: string, duration: number): void;
  /** One fragment, with the media time of its first sample. */
  fragment(data: Buffer, time: number): void;
  ended(): void;
  failed(message: string): void;
}

/**
 * Streams the fragmented-MP4 video track to the webview, staying a little ahead of playback and no
 * further — the same discipline as the audio feed. Every fetch is a bounded byte range taken
 * straight from the sidx index, which googlevideo serves at full speed; the open-ended request a
 * plain `<video src>` makes is throttled to about twice the bitrate, which is what starved long
 * watches into stalling.
 *
 * Nothing is written to disk and nothing is fetched that will not be shown: pause the picture and
 * the feed stops pulling within a couple of fragments.
 */
export class VideoFeed {
  private readonly abort = new AbortController();
  private fragments: Fragment[] = [];
  private next = 0;
  private target: number;
  private ahead = 0;
  private wake?: () => void;

  constructor(
    private readonly urlFor: (renew: boolean) => Promise<VideoOption>,
    private readonly sink: VideoSink,
    private readonly duration: number,
    options: { startTime?: number } = {}
  ) {
    this.target = options.startTime ?? 0;
    this.ahead = this.target;
    this.run().catch((error: Error) => {
      if (!this.abort.signal.aborted) {
        sink.failed(error.message);
      }
    });
  }

  /** Reports where playback is, so the feed knows whether more picture is needed. */
  advance(time: number) {
    this.target = time;
    this.wake?.();
  }

  dispose() {
    this.abort.abort();
    this.wake?.();
  }

  private async run() {
    await this.readIndex();
    if (this.abort.signal.aborted) {
      return;
    }
    this.next = fragmentAt(this.fragments, this.target);
    this.ahead = this.fragments[this.next]?.time ?? this.target;

    // Fetches run a little ahead of sends: while one fragment is being handed over, the next is
    // already on the wire. Strictly serial requests paid every request's dead time — TTFB, the odd
    // edge redirect — out of the lead, which drained it over minutes and stalled the picture.
    const inflight: Promise<Buffer>[] = [];
    while (!this.abort.signal.aborted) {
      await this.waitUntilHungry();
      if (this.abort.signal.aborted) {
        return;
      }
      if (this.next >= this.fragments.length) {
        break;
      }

      while (inflight.length < PIPELINE && this.next + inflight.length < this.fragments.length) {
        const upcoming = this.fragments[this.next + inflight.length];
        const request = this.fetchRange(upcoming.byte, upcoming.byte + upcoming.size - 1);
        // Surfaced when its turn comes; without a handler an early failure is an unhandled rejection.
        request.catch(() => {});
        inflight.push(request);
      }
      const data = await inflight.shift()!;
      if (this.abort.signal.aborted) {
        return;
      }
      const fragment = this.fragments[this.next];
      this.sink.fragment(data, fragment.time);
      this.ahead = fragment.time + fragment.duration;
      this.next++;
    }

    if (!this.abort.signal.aborted) {
      this.sink.ended();
    }
  }

  /** Reads the init segment and the sidx once, and hands the init segment to the webview. */
  private async readIndex() {
    const video = await this.urlFor(false);
    if (video.indexEnd === undefined || video.initEnd === undefined) {
      throw new Error('This video offers no fragment index.');
    }
    const buffer = await this.fetchRange(0, video.indexEnd);
    this.fragments = parseSidx(buffer, video.indexEnd);
    if (!this.abort.signal.aborted) {
      this.sink.init(buffer.subarray(0, video.initEnd + 1), video.mime, this.duration);
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

  /**
   * 403 means the URL is spent rather than retryable, so the streams get re-resolved. A request
   * that produces nothing for too long counts the same: the connection is dead, and a fresh one —
   * against a freshly minted URL if need be — is the only way forward.
   *
   * googlevideo also caps how many bytes one response may carry, so a short 206 is not a failure:
   * the remainder is asked for until the range is whole — a truncated fragment must never be
   * passed on as if it were complete.
   */
  private async fetchRange(first: number, last: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let at = first;
    let attempt = 0;
    let renew = false;
    while (true) {
      const video = await this.urlFor(renew);
      renew = false;
      let response: RangeResult | undefined;
      try {
        response = await this.timedFetch(video.url, `bytes=${at}-${last}`);
      } catch (error) {
        if (this.abort.signal.aborted || attempt === RENEW_ATTEMPTS) {
          throw error;
        }
      }
      if (response && (response.status === 206 || response.status === 200) && response.buffer.length) {
        parts.push(response.buffer);
        at += response.buffer.length;
        if (at > last) {
          return parts.length === 1 ? parts[0] : Buffer.concat(parts);
        }
        continue; // capped response: fetch the rest of the range against the same URL
      }
      if (response && response.status !== 403 && response.status !== 206 && response.status !== 200) {
        throw new Error(`Video stream responded with HTTP ${response.status}`);
      }
      if (attempt === RENEW_ATTEMPTS) {
        throw new Error(
          response?.status === 403
            ? 'YouTube refused the video stream (HTTP 403); it usually clears within a minute.'
            : 'Video stream kept answering with an empty body.'
        );
      }
      attempt++;
      renew = true;
      await delay(RENEW_DELAY_MS * attempt, this.abort.signal);
    }
  }

  /** One whole request — headers and body — under a deadline, without outliving `dispose`. */
  private async timedFetch(url: string, range: string): Promise<RangeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Video fetch timed out')), FETCH_TIMEOUT_MS);
    const forward = () => controller.abort();
    this.abort.signal.addEventListener('abort', forward, { once: true });
    try {
      const response = await fetch(url, { headers: { Range: range }, signal: controller.signal });
      if (response.status === 206 || response.status === 200) {
        return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };
      }
      await response.body?.cancel().catch(() => {});
      return { status: response.status, buffer: Buffer.alloc(0) };
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', forward);
    }
  }
}

interface RangeResult {
  status: number;
  buffer: Buffer;
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
