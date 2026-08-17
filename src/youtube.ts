import { innertube } from './innertube';

export interface VideoResult {
  id: string;
  title: string;
  channel: string;
  /** "UC…", empty when the result carried no owner link. */
  channelId: string;
  duration: string;
  views: string;
  published: string;
  thumbnail: string;
  live: boolean;
}

export interface ChannelPage {
  channel: string;
  /** "Latest", "Popular", "Oldest" — whatever this channel offers. */
  filters: string[];
  filter: string;
  videos: VideoResult[];
  hasMore: boolean;
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
  const owner = video.ownerText?.runs?.[0];

  return {
    id: video.videoId,
    title: video.title?.runs?.[0]?.text ?? '',
    channel: owner?.text ?? '',
    channelId: owner?.navigationEndpoint?.browseEndpoint?.browseId ?? '',
    duration: video.lengthText?.simpleText ?? '',
    views: video.shortViewCountText?.simpleText ?? '',
    published: video.publishedTimeText?.simpleText ?? '',
    thumbnail: thumbnails[thumbnails.length - 1]?.url ?? '',
    live: badges.includes('BADGE_STYLE_TYPE_LIVE_NOW')
  };
}

/**
 * A channel's video list, paged. The list object itself holds the continuation token, so it is
 * kept between calls rather than re-fetched: paging and switching filters both start from it.
 */
export class ChannelBrowser {
  private list?: VideoList;
  private name = '';
  private filter = '';
  private searching = false;

  async open(id: string, filter?: string): Promise<ChannelPage> {
    const channel = await this.channel(id);
    this.list = (await channel.getVideos()) as unknown as VideoList;
    this.searching = false;
    // The unfiltered list is already the first filter ("Latest"), so only anything else costs a
    // second request.
    if (filter && filter !== this.list.filters[0]) {
      this.list = await this.list.applyFilter(filter);
    }
    this.filter = filter || this.list.filters[0] || '';
    return this.page();
  }

  /** Searching inside a channel drops the filters; YouTube ranks these by relevance instead. */
  async search(id: string, query: string): Promise<ChannelPage> {
    const channel = await this.channel(id);
    this.list = (await channel.search(query)) as unknown as VideoList;
    this.searching = true;
    this.filter = '';
    return this.page();
  }

  async more(): Promise<ChannelPage> {
    if (!this.list?.has_continuation) {
      throw new Error('There is nothing more to load.');
    }
    this.list = await this.list.getContinuation();
    return this.page();
  }

  private async channel(id: string) {
    const channel = await (await innertube()).getChannel(id);
    this.name = channel.metadata?.title ?? '';
    return channel;
  }

  private page(): ChannelPage {
    const list = this.list!;
    return {
      channel: this.name,
      // Whatever a channel search offers would filter the search, not the video list the sidebar's
      // chips page through, so it is withheld.
      filters: this.searching ? [] : (list.filters ?? []),
      filter: this.filter,
      videos: (list.videos ?? [])
        .map((node) => fromNode(node, this.name))
        .filter((video): video is VideoResult => video !== undefined),
      hasMore: Boolean(list.has_continuation)
    };
  }
}

/**
 * The structural slice of youtubei.js's channel feeds this uses. `Channel`, `FilteredChannelList`
 * and `ChannelListContinuation` are three distinct classes that all page and filter the same way,
 * and only this much of them is needed.
 */
interface VideoList {
  videos: any[];
  filters: string[];
  has_continuation: boolean;
  getContinuation(): Promise<VideoList>;
  applyFilter(filter: string): Promise<VideoList>;
}

/**
 * Channel listings arrive as `LockupView` — YouTube's newer, flatter card — while a channel search
 * still answers with the classic `Video` node. Both are flattened to the same shape here.
 */
function fromNode(node: any, channel: string): VideoResult | undefined {
  if (node?.type === 'LockupView') {
    return node.content_type === 'VIDEO' ? fromLockup(node, channel) : undefined;
  }
  return node?.id && node?.title ? fromVideo(node, channel) : undefined;
}

function fromLockup(node: any, channel: string): VideoResult {
  // One row of "631K views • 2 days ago", split into parts by the renderer.
  const parts: string[] = (node.metadata?.metadata?.metadata_rows ?? [])
    .flatMap((row: any) => row?.metadata_parts ?? [])
    .map((part: any) => part?.text?.text ?? '')
    .filter(Boolean);
  const badge: string = (node.content_image?.overlays ?? [])
    .flatMap((overlay: any) => overlay?.badges ?? [])
    .map((item: any) => item?.text ?? '')
    .find(Boolean) ?? '';
  const live = /live/i.test(badge);

  return {
    id: node.content_id ?? '',
    title: node.metadata?.title?.text ?? '',
    channel,
    channelId: '',
    duration: live ? '' : badge,
    views: parts.find((part) => /view/i.test(part)) ?? '',
    published: parts.find((part) => /ago/i.test(part)) ?? '',
    thumbnail: node.content_image?.image?.[0]?.url ?? '',
    live
  };
}

function fromVideo(node: any, channel: string): VideoResult {
  return {
    id: node.id,
    title: node.title?.text ?? '',
    channel,
    channelId: '',
    duration: node.duration?.text ?? '',
    views: node.short_view_count?.text ?? node.view_count?.text ?? '',
    published: node.published?.text ?? '',
    thumbnail: node.thumbnails?.[0]?.url ?? '',
    live: Boolean(node.is_live)
  };
}
