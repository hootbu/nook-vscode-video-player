export interface VideoResult {
  id: string;
  title: string;
  channel: string;
  duration: string;
  views: string;
  published: string;
  thumbnail: string;
  live: boolean;
}

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/search';
const CLIENT_VERSION = '2.20240401.00.00';

/** Extracts an 11-character video id from any common watch/share/embed URL. */
export function parseVideoId(input: string): string | undefined {
  const text = input.trim();
  if (/^[\w-]{11}$/.test(text)) {
    return text;
  }

  let url: URL;
  try {
    url = new URL(text.startsWith('http') ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  if (!/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(url.hostname)) {
    return undefined;
  }

  const fromQuery = url.searchParams.get('v');
  if (fromQuery && /^[\w-]{11}$/.test(fromQuery)) {
    return fromQuery;
  }

  const path = url.pathname.replace(/^\/(embed|shorts|live|v)\//, '/').slice(1);
  return /^[\w-]{11}$/.test(path) ? path : undefined;
}

export async function search(
  query: string,
  language: string,
  region: string
): Promise<VideoResult[]> {
  const response = await fetch(INNERTUBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: {
        client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: language, gl: region }
      },
      query
    })
  });

  if (!response.ok) {
    throw new Error(`Search failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as any;
  const sections =
    body?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer
      ?.contents ?? [];

  return sections
    .flatMap((section: any) => section?.itemSectionRenderer?.contents ?? [])
    .map((item: any) => item?.videoRenderer)
    .filter((video: any) => video?.videoId)
    .map(toResult);
}

function toResult(video: any): VideoResult {
  const thumbnails = video.thumbnail?.thumbnails ?? [];
  const badges: string[] = (video.badges ?? []).map(
    (badge: any) => badge?.metadataBadgeRenderer?.style ?? ''
  );

  return {
    id: video.videoId,
    title: video.title?.runs?.[0]?.text ?? '',
    channel: video.ownerText?.runs?.[0]?.text ?? '',
    duration: video.lengthText?.simpleText ?? '',
    views: video.shortViewCountText?.simpleText ?? '',
    published: video.publishedTimeText?.simpleText ?? '',
    thumbnail: thumbnails[thumbnails.length - 1]?.url ?? '',
    live: badges.includes('BADGE_STYLE_TYPE_LIVE_NOW')
  };
}
