import type { Innertube } from 'youtubei.js' with { 'resolution-mode': 'import' };
import { innertube } from './innertube';

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
}

export interface StreamInfo {
  id: string;
  title: string;
  /** Seconds. */
  duration: number;
  videoUrl: string;
  videoMime: string;
  /** One track per available height, tallest first. */
  videos: VideoOption[];
  /** WebM/Opus, audio only. */
  audioUrl: string;
}

/** Tallest option at or below the requested height, falling back to the shortest one offered. */
export function pickQuality(videos: VideoOption[], maxHeight: number): VideoOption {
  return videos.find((video) => video.height <= maxHeight) ?? videos[videos.length - 1];
}

/**
 * VS Code's Electron ships an ffmpeg without Opus or AAC decoders, so YouTube's own player can
 * never produce sound inside a webview. Instead the extension fetches the raw adaptive streams
 * itself: a video-only track the webview can decode natively, and an Opus track that
 * `server.ts` decodes to PCM on the extension host.
 */
export class StreamResolver {
  async resolve(id: string): Promise<StreamInfo> {
    const yt = await innertube();
    // The web client only offers server-side ABR (no plain URLs). ANDROID_VR still hands out
    // directly fetchable URLs for both Opus and H.264 tracks.
    const info = await yt.getInfo(id, { client: 'ANDROID_VR' });

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
    const videos = collectVideos(formats);
    if (!audio || !videos.length) {
      throw new Error('No playable streams were offered for this video.');
    }

    if (!audio.url) {
      throw new Error('Streams need deciphering, which is not supported.');
    }

    const video = pickQuality(videos, DEFAULT_HEIGHT);
    return {
      id,
      title: info.basic_info.title ?? '',
      duration: audio.approx_duration_ms
        ? audio.approx_duration_ms / 1000
        : (info.basic_info.duration ?? 0),
      videoUrl: video.url,
      videoMime: video.mime,
      videos,
      audioUrl: audio.url
    };
  }
}

type Format = Awaited<ReturnType<Innertube['getInfo']>>['streaming_data'] extends
  | { adaptive_formats: (infer F)[] }
  | undefined
  ? F
  : never;

/** One video-only track per height, best codec first and bitrate as the tie-breaker. */
function collectVideos(formats: Format[]): VideoOption[] {
  const best = new Map<number, Format>();
  for (const format of formats) {
    const height = format.height ?? 0;
    if (!format.has_video || format.has_audio || !format.url || !height || height > MAX_HEIGHT) {
      continue;
    }
    const current = best.get(height);
    if (!current || score(format) > score(current)) {
      best.set(height, format);
    }
  }

  return [...best.values()]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .map((format) => ({
      height: format.height ?? 0,
      label: `${format.height}p${(format.fps ?? 0) >= 50 ? format.fps : ''}`,
      codec: codecOf(format.mime_type),
      mime: format.mime_type,
      url: format.url!
    }));
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
