import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { EventEmitter, once } from 'events';
import { AddressInfo } from 'net';
import { Readable } from 'stream';
import * as prism from 'prism-media';
import { StreamInfo, StreamResolver } from './stream';

export interface Playback {
  title: string;
  duration: number;
  video: string;
  audio: string;
}

/**
 * Loopback HTTP server the webview streams media from. `/video` proxies YouTube's video-only
 * track (Chromium decodes that fine); `/audio` serves the Opus track re-encoded as WAV, since
 * PCM is one of the few audio formats VS Code's stripped-down ffmpeg can play.
 */
export class PlayerServer {
  private server?: http.Server;
  private origin = '';
  private readonly token = randomBytes(8).toString('hex');
  private readonly resolver = new StreamResolver();
  private session?: Session;

  async start(): Promise<void> {
    const server = http.createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    this.server = server;
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async load(id: string, onError: (message: string) => void): Promise<Playback> {
    const info = await this.resolver.resolve(id);
    this.session?.dispose();
    this.session = new Session(info, () => this.resolver.resolve(id), onError);
    const base = `${this.origin}/${this.token}`;
    return {
      title: info.title,
      duration: info.duration,
      video: `${base}/video?v=${id}`,
      audio: `${base}/audio?v=${id}`
    };
  }

  dispose() {
    this.session?.dispose();
    this.server?.close();
    this.server = undefined;
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const url = new URL(request.url ?? '/', this.origin);
    const [, token, kind] = url.pathname.split('/');
    const session = this.session;
    if (token !== this.token || !session || url.searchParams.get('v') !== session.id) {
      response.writeHead(404).end();
      return;
    }
    if (kind === 'video') {
      session.proxyVideo(request, response);
    } else if (kind === 'audio') {
      session.wav.serve(request, response);
    } else {
      response.writeHead(404).end();
    }
  }
}

class Session {
  readonly id: string;
  readonly wav: WavStore;
  private readonly abort = new AbortController();
  private renewal?: Promise<StreamInfo>;

  constructor(
    private info: StreamInfo,
    private readonly reresolve: () => Promise<StreamInfo>,
    onError: (message: string) => void
  ) {
    this.id = info.id;
    this.wav = new WavStore(info.duration);
    this.decodeAudio().catch((error: Error) => {
      this.wav.settle();
      if (!this.abort.signal.aborted) {
        onError(`Audio decoding failed: ${error.message}`);
      }
    });
  }

  dispose() {
    this.abort.abort();
    this.wav.dispose();
  }

  /**
   * Streaming URLs go stale: they carry an expiry, and googlevideo also starts answering 403
   * outright once an address has asked for too much too quickly. Retrying the same URL never
   * recovers from either, but a freshly resolved one does, so the whole set is re-fetched.
   * Callers racing on the same failure share a single renewal.
   */
  private renew(): Promise<StreamInfo> {
    this.renewal ??= this.reresolve().then(
      (info) => {
        this.info = info;
        this.renewal = undefined;
        return info;
      },
      (error) => {
        this.renewal = undefined;
        throw error;
      }
    );
    return this.renewal;
  }

  /** Hands out the current URL, re-resolving first when the last one was refused. */
  private urlFor(kind: 'video' | 'audio'): (renew: boolean) => Promise<string> {
    return async (renew) => {
      const info = renew ? await this.renew() : this.info;
      return kind === 'video' ? info.videoUrl : info.audioUrl;
    };
  }

  async proxyVideo(request: http.IncomingMessage, response: http.ServerResponse) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : undefined;
    const signal = AbortSignal.any([this.abort.signal, closeSignal(response)]);

    try {
      for await (const { chunk, total } of fetchInChunks(this.urlFor('video'), start, end, signal)) {
        if (!response.headersSent) {
          const last = end === undefined ? total - 1 : Math.min(end, total - 1);
          response.writeHead(206, {
            'Content-Type': this.info.videoMime,
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${last}/${total}`,
            'Content-Length': last - start + 1
          });
        }
        if (!response.write(chunk)) {
          await once(response, 'drain', { signal });
        }
      }
      if (!response.headersSent) {
        response.writeHead(416);
      }
    } catch {
      if (!response.headersSent) {
        response.writeHead(502);
      }
    }
    response.end();
  }

  private async decodeAudio() {
    const signal = this.abort.signal;
    const demuxer = new prism.opus.WebmDemuxer();
    let head: Buffer | undefined;
    demuxer.on('head', (data: Buffer) => {
      head = data;
    });

    // Feed the demuxer in the background; the loop below drains it as packets appear.
    (async () => {
      for await (const { chunk } of fetchInChunks(this.urlFor('audio'), 0, undefined, signal)) {
        if (!demuxer.write(chunk)) {
          await once(demuxer, 'drain', { signal });
        }
      }
      demuxer.end();
    })().catch((error) => demuxer.destroy(error));

    const { OpusDecoder } = await import('opus-decoder');
    let decoder: InstanceType<typeof OpusDecoder> | undefined;
    try {
      for await (const packet of demuxer as AsyncIterable<Buffer>) {
        if (!decoder) {
          // OpusHead: 8-byte magic, version, channel count, then pre-skip (uint16 LE).
          decoder = new OpusDecoder({
            channels: head?.[9] ?? 2,
            preSkip: head?.readUInt16LE(10) ?? 0,
            forceStereo: true
          });
          await decoder.ready;
        }
        const { channelData, samplesDecoded } = decoder.decodeFrame(packet);
        await this.wav.append(interleave(channelData, samplesDecoded));
      }
    } finally {
      decoder?.free();
    }
    await this.wav.finish();
  }
}

const CHUNK_SIZE = 4 * 1024 * 1024;

/**
 * googlevideo throttles open-ended requests down to roughly the media bitrate, but serves
 * bounded ranges at full speed, so anything longer than a few seconds is fetched piecewise.
 */
async function* fetchInChunks(
  urlFor: (renew: boolean) => Promise<string>,
  start: number,
  end: number | undefined,
  signal: AbortSignal
): AsyncGenerator<{ chunk: Buffer; total: number }> {
  let position = start;
  while (end === undefined || position <= end) {
    const last = end === undefined ? position + CHUNK_SIZE - 1 : Math.min(end, position + CHUNK_SIZE - 1);
    const response = await fetchRange(urlFor, `bytes=${position}-${last}`, signal);
    if (response.status === 416) {
      return;
    }
    if (response.status !== 206 || !response.body) {
      throw new Error(
        response.status === 403
          ? 'YouTube refused the stream (HTTP 403); it usually clears within a minute.'
          : `Upstream responded with HTTP ${response.status}`
      );
    }
    const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]);
    let received = 0;
    for await (const part of Readable.fromWeb(response.body as any) as AsyncIterable<Buffer>) {
      received += part.length;
      yield { chunk: part, total };
    }
    position += received;
    if (received === 0 || position >= total) {
      return;
    }
  }
}

const RENEW_ATTEMPTS = 2;
const RENEW_DELAY_MS = 700;

/**
 * Fetches one range, treating 403 as "this URL is spent" — the streams are re-resolved and the
 * same range asked for again. The pause in between matters as much as the new URL: a refusal
 * usually means the address is briefly out of favour, and fresh URLs are refused too until it
 * passes.
 */
async function fetchRange(
  urlFor: (renew: boolean) => Promise<string>,
  range: string,
  signal: AbortSignal
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetchFollowing(await urlFor(attempt > 0), range, signal);
    if (response.status !== 403 || attempt === RENEW_ATTEMPTS) {
      return response;
    }
    await response.body?.cancel().catch(() => {});
    await delay(RENEW_DELAY_MS * (attempt + 1), signal);
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
 * googlevideo occasionally answers a chunk with a 302 to another edge node. Redirects are
 * followed by hand so the Range header is guaranteed to travel along.
 */
async function fetchFollowing(url: string, range: string, signal: AbortSignal): Promise<Response> {
  let target = url;
  for (let hop = 0; ; hop++) {
    const response = await fetch(target, { headers: { Range: range }, signal, redirect: 'manual' });
    const location = response.headers.get('location');
    if (!location || hop >= 5 || ![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    target = new URL(location, target).toString();
  }
}

/** Aborts when the client goes away (or once the response is done, which is harmless). */
function closeSignal(response: http.ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.on('close', () => controller.abort());
  return controller.signal;
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BLOCK_ALIGN = CHANNELS * 2; // 16-bit
const HEADER_SIZE = 44;

/**
 * A WAV file being written to disk while it is already being served. Its total size is fixed
 * up front from the video duration so `<audio>` gets a real length and can seek; range requests
 * for bytes not decoded yet simply wait.
 */
class WavStore {
  private readonly dir: string;
  private readonly total: number;
  private readonly events = new EventEmitter();
  private readonly file: Promise<fs.promises.FileHandle>;
  private written = HEADER_SIZE;
  private done = false;

  constructor(duration: number) {
    const frames = Math.round(duration * SAMPLE_RATE);
    this.total = HEADER_SIZE + frames * BLOCK_ALIGN;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-player-'));
    this.file = fs.promises
      .open(path.join(this.dir, 'audio.wav'), 'w+')
      .then(async (handle) => {
        await handle.write(wavHeader(frames), 0, HEADER_SIZE, 0);
        return handle;
      });
    this.events.setMaxListeners(0);
  }

  async append(pcm: Buffer) {
    const length = Math.min(pcm.length, this.total - this.written);
    if (length <= 0 || this.done) {
      return;
    }
    await (await this.file).write(pcm, 0, length, this.written);
    this.written += length;
    this.events.emit('progress');
  }

  async finish() {
    // The duration was an estimate; pad with silence so the declared length holds.
    while (this.written < this.total && !this.done) {
      await this.append(Buffer.alloc(Math.min(1 << 16, this.total - this.written)));
    }
    this.settle();
  }

  dispose() {
    this.settle();
    this.file.then((handle) => handle.close()).catch(() => {});
    fs.rm(this.dir, { recursive: true, force: true }, () => {});
  }

  settle() {
    this.done = true;
    this.events.emit('progress');
  }

  async serve(request: http.IncomingMessage, response: http.ServerResponse) {
    const last = this.total - 1;
    let start = 0;
    let end = last;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, this.total - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), last) : last;
      if (start > last) {
        response.writeHead(416, { 'Content-Range': `bytes */${this.total}` }).end();
        return;
      }
    }

    response.writeHead(range ? 206 : 200, {
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${this.total}` } : {})
    });

    const signal = closeSignal(response);
    signal.addEventListener('abort', () => this.events.emit('progress'));

    let position = start;
    try {
      const handle = await this.file;
      while (position <= end && !signal.aborted) {
        const available = Math.min(this.written - 1, end);
        if (available < position) {
          if (this.done) {
            break;
          }
          await once(this.events, 'progress');
          continue;
        }
        const chunk = Buffer.alloc(Math.min(available - position + 1, 1 << 18));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) {
          break;
        }
        if (!response.write(chunk.subarray(0, bytesRead))) {
          await once(response, 'drain', { signal });
        }
        position += bytesRead;
      }
    } catch {
      // Client went away or the session was disposed; nothing to report.
    }
    response.end();
  }
}

function wavHeader(frames: number): Buffer {
  const dataSize = frames * BLOCK_ALIGN;
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BLOCK_ALIGN, 28);
  header.writeUInt16LE(BLOCK_ALIGN, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

function interleave(channels: Float32Array[], frames: number): Buffer {
  const out = Buffer.alloc(frames * BLOCK_ALIGN);
  const left = channels[0];
  const right = channels[1] ?? channels[0];
  for (let i = 0, offset = 0; i < frames; i++, offset += 4) {
    out.writeInt16LE(toInt16(left[i]), offset);
    out.writeInt16LE(toInt16(right[i]), offset + 2);
  }
  return out;
}

function toInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
}
