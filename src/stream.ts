import type { Innertube, Player } from 'youtubei.js' with { 'resolution-mode': 'import' };
import { innertube, withPlayer } from './innertube';

/** Highest picture the panel offers; above this the decode cost outruns what a panel can show. */
const MAX_HEIGHT = 1080;
/** Picked when nothing else is asked for. */
export const DEFAULT_HEIGHT = 720;

export interface VideoOption {
  height: number;
  /** "720p", "1080p60". */
  label: string;
  /** "H.264", "VP9", "AV1" — shown because only H.264 is certain to decode here. */
  codec: string;
  mime: string;
  url: string;
  /** Bytes, when YouTube says. */
  length?: number;
  /** Last byte of the ftyp+moov init segment. */
  initEnd?: number;
  /** First and last byte of the sidx box, which indexes every fragment. */
  indexStart?: number;
  indexEnd?: number;
}

export interface StreamInfo {
  id: string;
  title: string;
  /** Channel name, as the watch page shows it. */
  author: string;
  /** Seconds. */
  duration: number;
  videoUrl: string;
  videoMime: string;
  /** One track per available height, tallest first. */
  videos: VideoOption[];
  /** WebM/Opus, audio only. */
  audioUrl: string;
}

/**
 * Tallest option at or below the requested height, with one override: H.264 outranks a taller VP9
 * or AV1 track. A height only appears in another codec when no H.264 is offered at it, and picking
 * one leaves the `<video>` element rejecting the source outright — a taller picture is worth
 * nothing if it cannot be decoded. A video offering no H.264 at all still gets a track; choosing
 * one of those knowingly is what the menu is for.
 */
export function pickQuality(videos: VideoOption[], maxHeight: number): VideoOption {
  const allowed = videos.filter((video) => video.height <= maxHeight);
  return (
    allowed.find((video) => video.codec === 'H.264') ?? allowed[0] ?? videos[videos.length - 1]
  );
}

/**
 * Clients asked for stream URLs, in order. The web client only offers server-side ABR (no plain
 * URLs). VISIONOS still hands out directly fetchable URLs for both Opus and H.264 tracks, with no
 * PO token. TV_SIMPLY does too, but signed, so it costs the player script — it is the fallback for
 * the day VISIONOS goes the way of ANDROID_VR, whose URLs began serving only their first few
 * megabytes in 2026-08 (403 beyond that; long enough for a clip, not for a video).
 */
const CLIENTS = ['VISIONOS', 'TV_SIMPLY'] as const;

/**
 * VS Code's Electron ships an ffmpeg without Opus or AAC decoders, so YouTube's own player can
 * never produce sound inside a webview. Instead the extension fetches the raw adaptive streams
 * itself: a video-only track the webview can decode natively, and an Opus track that
 * `server.ts` decodes to PCM on the extension host.
 */
export class StreamResolver {
  /** Each client gets a go; if none serves the video, the first one's complaint is the one told. */
  async resolve(id: string): Promise<StreamInfo> {
    let firstError: unknown;
    for (const client of CLIENTS) {
      try {
        return await resolveWith(id, client);
      } catch (error) {
        firstError ??= error;
      }
    }
    throw firstError;
  }
}

async function resolveWith(id: string, client: (typeof CLIENTS)[number]): Promise<StreamInfo> {
  const yt = client === 'TV_SIMPLY' ? await withPlayer() : await innertube();
  const info = await yt.getInfo(id, { client });

  const status = info.playability_status;
  if (status && status.status !== 'OK') {
    throw new Error(status.reason || `Video is not playable (${status.status}).`);
  }
  if (info.basic_info.is_live) {
    throw new Error('Live streams are not supported.');
  }

  const formats = info.streaming_data?.adaptive_formats ?? [];
  const audio = formats
    .filter((f) => f.has_audio && !f.has_video && f.mime_type.includes('opus'))
    .sort((a, b) => b.bitrate - a.bitrate)[0];
  const videos = await collectVideos(formats, yt.session.player);
  if (!audio || !videos.length) {
    throw new Error('No playable streams were offered for this video.');
  }

  const video = pickQuality(videos, DEFAULT_HEIGHT);
  if (!(await servesWhole(video.url, video.length))) {
    throw new Error('YouTube is serving only part of this video\'s stream.');
  }

  return {
    id,
    title: info.basic_info.title ?? '',
    author: info.basic_info.author ?? '',
    duration: audio.approx_duration_ms
      ? audio.approx_duration_ms / 1000
      : (info.basic_info.duration ?? 0),
    videoUrl: video.url,
    videoMime: video.mime,
    videos,
    audioUrl: await audio.decipher(yt.session.player)
  };
}

/**
 * Whether the URL serves the track to its end. A capped client answers everything past its first
 * few megabytes with a 403, so one request for the last byte tells — and a spent URL fails the
 * same way, which is equally worth moving on from. Unknown length: nothing to check against.
 */
async function servesWhole(url: string, length?: number): Promise<boolean> {
  if (!length) {
    return true;
  }
  const response = await fetch(url, { headers: { Range: `bytes=${length - 1}-${length - 1}` } });
  await response.body?.cancel().catch(() => {});
  return response.status === 206;
}

type Format = Awaited<ReturnType<Innertube['getInfo']>>['streaming_data'] extends
  | { adaptive_formats: (infer F)[] }
  | undefined
  ? F
  : never;

/** One video-only track per height, best codec first and bitrate as the tie-breaker. */
async function collectVideos(formats: Format[], player?: Player): Promise<VideoOption[]> {
  const best = new Map<number, Format>();
  for (const format of formats) {
    const height = format.height ?? 0;
    if (!format.has_video || format.has_audio || !height || height > MAX_HEIGHT) {
      continue;
    }
    const current = best.get(height);
    if (!current || score(format) > score(current)) {
      best.set(height, format);
    }
  }

  const sorted = [...best.values()].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  return Promise.all(
    sorted.map(async (format) => ({
      height: format.height ?? 0,
      label: `${format.height}p${(format.fps ?? 0) >= 50 ? format.fps : ''}`,
      codec: codecOf(format.mime_type),
      mime: format.mime_type,
      // Plain for the primary client; the fallback's are signed and come out of the player script.
      url: await format.decipher(player),
      length: format.content_length,
      initEnd: format.init_range?.end,
      indexStart: format.index_range?.start,
      indexEnd: format.index_range?.end
    }))
  );
}

/** H.264 outranks everything: it is the one codec this build is certain to decode. */
function score(format: Format): number {
  const codec = format.mime_type.includes('avc1') ? 2 : format.mime_type.includes('vp9') ? 1 : 0;
  return codec * 1e9 + format.bitrate;
}

function codecOf(mime: string): string {
  if (mime.includes('avc1')) {
    return 'H.264';
  }
  return mime.includes('vp9') ? 'VP9' : mime.includes('av01') ? 'AV1' : '';
}
