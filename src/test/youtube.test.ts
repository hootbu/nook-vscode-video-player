import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromNode, parseVideoId, search } from '../youtube';

test('parseVideoId recognises the forms a link can take', () => {
  const id = 'dQw4w9WgXcQ';
  const forms = [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?v=${id}&list=PL123&t=42s`,
    `https://youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `youtube.com/watch?v=${id}`,
    `  https://m.youtube.com/watch?v=${id}  `
  ];

  for (const form of forms) {
    assert.equal(parseVideoId(form), id, form);
  }
});

test('parseVideoId turns down anything that is not a video link', () => {
  const rejected = [
    'cat videos',
    'https://vimeo.com/123456',
    // A lookalike host: the check is on the domain, not on the string containing it.
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=tooshort',
    'https://www.youtube.com/results?search_query=music',
    ''
  ];

  for (const input of rejected) {
    assert.equal(parseVideoId(input), undefined, input);
  }
});

test('search asks in the requested language and flattens what comes back', async () => {
  const calls: { url: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, json: async () => SEARCH_RESPONSE } as Response;
  }) as typeof fetch;

  try {
    const results = await search('aphex twin', 'tr', 'TR');

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /youtubei\/v1\/search$/);
    assert.equal(calls[0].body.query, 'aphex twin');
    assert.equal(calls[0].body.context.client.hl, 'tr');
    assert.equal(calls[0].body.context.client.gl, 'TR');

    // The shelves and channel cards between the videos are dropped, not turned into blank rows.
    assert.deepEqual(results, [
      {
        id: 'dQw4w9WgXcQ',
        title: 'Xtal',
        channel: 'Aphex Twin',
        channelId: 'UCabc123',
        duration: '4:51',
        views: '12M views',
        published: '14 years ago',
        // The largest thumbnail offered, not the first.
        thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg',
        live: false
      },
      {
        id: 'liveVideoX',
        title: 'Live set',
        channel: 'Aphex Twin',
        channelId: 'UCabc123',
        duration: '',
        views: '4.2K watching',
        published: '',
        thumbnail: 'https://i.ytimg.com/vi/liveVideoX/hq720.jpg',
        live: true
      }
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test('search reports a refusal rather than returning nothing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 429 }) as Response) as typeof fetch;

  try {
    await assert.rejects(() => search('anything', 'en', 'US'), /HTTP 429/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a channel listing card is flattened into a result', () => {
  assert.deepEqual(fromNode(LOCKUP, 'Aphex Twin'), {
    id: 'abcdefghijk',
    title: 'Windowlicker',
    channel: 'Aphex Twin',
    channelId: '',
    duration: '4:01',
    views: '631K views',
    published: '2 days ago',
    thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
    live: false
  });
});

test('a live channel card carries no duration', () => {
  const live = structuredClone(LOCKUP);
  live.content_image.overlays[0].badges[0].text = 'LIVE';

  const result = fromNode(live, 'Aphex Twin');
  assert.equal(result?.live, true);
  assert.equal(result?.duration, '');
});

test('a channel search answers with the older node, and reads the same', () => {
  assert.deepEqual(fromNode(VIDEO_NODE, 'Aphex Twin'), {
    id: 'abcdefghijk',
    title: 'Windowlicker',
    channel: 'Aphex Twin',
    channelId: '',
    duration: '4:01',
    views: '631K views',
    published: '2 days ago',
    thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
    live: false
  });
});

test('anything that is not a video is left out of the list', () => {
  assert.equal(fromNode({ type: 'LockupView', content_type: 'PLAYLIST' }, 'Aphex Twin'), undefined);
  assert.equal(fromNode({}, 'Aphex Twin'), undefined);
  assert.equal(fromNode(undefined, 'Aphex Twin'), undefined);
});

// --- fixtures, trimmed to the fields the parsers read ---

const SEARCH_RESPONSE = {
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            {
              itemSectionRenderer: {
                contents: [
                  { channelRenderer: { channelId: 'UCabc123' } },
                  {
                    videoRenderer: {
                      videoId: 'dQw4w9WgXcQ',
                      title: { runs: [{ text: 'Xtal' }] },
                      ownerText: {
                        runs: [
                          {
                            text: 'Aphex Twin',
                            navigationEndpoint: { browseEndpoint: { browseId: 'UCabc123' } }
                          }
                        ]
                      },
                      lengthText: { simpleText: '4:51' },
                      shortViewCountText: { simpleText: '12M views' },
                      publishedTimeText: { simpleText: '14 years ago' },
                      thumbnail: {
                        thumbnails: [
                          { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg' },
                          { url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg' }
                        ]
                      }
                    }
                  }
                ]
              }
            },
            { continuationItemRenderer: {} },
            {
              itemSectionRenderer: {
                contents: [
                  {
                    videoRenderer: {
                      videoId: 'liveVideoX',
                      title: { runs: [{ text: 'Live set' }] },
                      ownerText: {
                        runs: [
                          {
                            text: 'Aphex Twin',
                            navigationEndpoint: { browseEndpoint: { browseId: 'UCabc123' } }
                          }
                        ]
                      },
                      shortViewCountText: { simpleText: '4.2K watching' },
                      thumbnail: {
                        thumbnails: [{ url: 'https://i.ytimg.com/vi/liveVideoX/hq720.jpg' }]
                      },
                      badges: [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW' } }]
                    }
                  }
                ]
              }
            }
          ]
        }
      }
    }
  }
};

const LOCKUP: any = {
  type: 'LockupView',
  content_type: 'VIDEO',
  content_id: 'abcdefghijk',
  metadata: {
    title: { text: 'Windowlicker' },
    metadata: {
      metadata_rows: [
        {
          metadata_parts: [
            { text: { text: '631K views' } },
            { text: { text: '2 days ago' } }
          ]
        }
      ]
    }
  },
  content_image: {
    image: [{ url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' }],
    overlays: [{ badges: [{ text: '4:01' }] }]
  }
};

const VIDEO_NODE = {
  id: 'abcdefghijk',
  title: { text: 'Windowlicker' },
  duration: { text: '4:01' },
  short_view_count: { text: '631K views' },
  published: { text: '2 days ago' },
  thumbnails: [{ url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' }],
  is_live: false
};
