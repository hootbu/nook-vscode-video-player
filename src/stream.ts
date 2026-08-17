import type { Innertube } from 'youtubei.js' with { 'resolution-mode': 'import' };

export interface StreamInfo {
  id: string;
  title: string;
  /** Seconds. */
  duration: number;
  videoUrl: string;
  videoMime: string;
  /** WebM/Opus, audio only. */
  audioUrl: string;
}

/**
 * VS Code's Electron ships an ffmpeg without Opus or AAC decoders, so YouTube's own player can
 * never produce sound inside a webview. Instead the extension fetches the raw adaptive streams
 * itself: a video-only track the webview can decode natively, and an Opus track that
 * `server.ts` decodes to PCM on the extension host.
 */
export class StreamResolver {
  private client?: Promise<Innertube>;

  async resolve(id: string): Promise<StreamInfo> {
    const yt = await this.innertube();
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
    const video =
      pickVideo(formats, 'avc1') ?? pickVideo(formats, 'vp9') ?? pickVideo(formats, '');
    if (!audio || !video) {
      throw new Error('No playable streams were offered for this video.');
    }

    if (!audio.url || !video.url) {
      throw new Error('Streams need deciphering, which is not supported.');
    }

    return {
      id,
      title: info.basic_info.title ?? '',
      duration: audio.approx_duration_ms
        ? audio.approx_duration_ms / 1000
        : (info.basic_info.duration ?? 0),
      videoUrl: video.url,
      videoMime: video.mime_type,
      audioUrl: audio.url
    };
  }

  private innertube(): Promise<Innertube> {
    // A locally generated visitor id trips YouTube's bot check; let the session fetch a real one.
    // ANDROID_VR URLs need no signature or n-parameter transform, so the player script (whose
    // deciphering would require a JS evaluator) is skipped entirely.
    this.client ??= import('youtubei.js').then(({ Innertube, Log }) => {
      Log.setLevel(Log.Level.NONE);
      return Innertube.create({ retrieve_player: false });
    });
    return this.client;
  }
}

type Format = Awaited<ReturnType<Innertube['getInfo']>>['streaming_data'] extends
  | { adaptive_formats: (infer F)[] }
  | undefined
  ? F
  : never;

/** Highest-bitrate video-only track of the given codec at panel-friendly 720p or below. */
function pickVideo(formats: Format[], codec: string): Format | undefined {
  return formats
    .filter(
      (f) => f.has_video && !f.has_audio && f.mime_type.includes(codec) && (f.height ?? 0) <= 720
    )
    .sort((a, b) => b.bitrate - a.bitrate)[0];
}
