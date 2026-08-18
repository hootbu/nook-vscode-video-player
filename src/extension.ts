import * as vscode from 'vscode';
import { AudioFeed, packPackets } from './audio';
import { History } from './history';
import { DEFAULT_HEIGHT, pickQuality, StreamInfo, StreamResolver } from './stream';
import { CuePoint } from './webm';
import { ChannelBrowser, ChannelPage, parseVideoId, search } from './youtube';

const VIEW_ID = 'nookPanel.view';
/** How far behind an estimated seek target to start reading, so the covering cluster is not missed. */
const BACKTRACK_SECONDS = 20;
/** Longer titles are cut down for the status bar, which has the rest of the workbench to share. */
const STATUS_TITLE_LENGTH = 40;

export function activate(context: vscode.ExtensionContext) {
  const provider = new PlayerViewProvider(context.extensionUri, new History(context.globalState));
  context.subscriptions.push(
    { dispose: () => provider.dispose() },
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('nook.togglePlay', () => provider.togglePlay())
  );
}

export function deactivate() {}

/**
 * Picture and sound take separate paths. The video track is H.264, which this build decodes
 * natively, so the webview points a <video> element straight at it. The audio track is Opus,
 * which VS Code's trimmed ffmpeg cannot decode at all — so the packets are demuxed here and
 * handed to a WebAssembly decoder inside the webview, which feeds WebAudio. Nothing is
 * downloaded ahead of what is being watched, and nothing touches disk.
 */
class PlayerViewProvider implements vscode.WebviewViewProvider {
  private readonly resolver = new StreamResolver();
  private readonly channels = new ChannelBrowser();
  // Right-hand side, and a priority high enough to sit among the editor's own items rather than
  // out at the very edge beside the notification bell.
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private view?: vscode.WebviewView;
  private session?: Session;
  /** Stamps each feed so the webview can tell a superseded one's packets from the current ones. */
  private generation = 0;
  /** Ceiling the viewer picked; kept across videos, since a taller one is not always offered. */
  private maxHeight = DEFAULT_HEIGHT;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly history: History
  ) {
    this.status.command = 'nook.togglePlay';
  }

  dispose() {
    this.session?.feed?.dispose();
    this.history.dispose();
    this.status.dispose();
  }

  /** Reaches the player from the palette or the status bar, where there is nothing to click on. */
  togglePlay() {
    this.view?.webview.postMessage({ type: 'toggle' });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'search') {
        await this.handleSearch(view.webview, message.query, message.channelId);
      } else if (message.type === 'ready') {
        this.sendHistory(view.webview);
      } else if (message.type === 'playstate') {
        this.showStatus(message.playing);
      } else if (message.type === 'clear-history') {
        this.history.clear();
        this.sendHistory(view.webview);
      } else if (message.type === 'channel') {
        await this.handleChannel(view.webview, () =>
          this.channels.open(message.id, message.filter)
        );
      } else if (message.type === 'channel-more') {
        await this.handleChannel(view.webview, () => this.channels.more(), true);
      } else if (message.type === 'play') {
        await this.handlePlay(view.webview, message.id);
      } else if (message.type === 'progress') {
        this.session?.feed?.advance(message.time);
        if (this.session) {
          this.history.position(this.session.id, message.time);
        }
      } else if (message.type === 'seek') {
        await this.handleSeek(view.webview, message.time);
      } else if (message.type === 'stop') {
        this.session?.feed?.dispose();
      } else if (message.type === 'refresh-video') {
        await this.handleRefresh(view.webview);
      } else if (message.type === 'quality') {
        this.handleQuality(view.webview, message.height);
      } else if (message.type === 'openExternal') {
        vscode.env.openExternal(vscode.Uri.parse(`https://www.youtube.com/watch?v=${message.id}`));
      } else if (message.type === 'maximize') {
        vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
      } else if (message.type === 'fullscreen') {
        // Fallback for when the webview is denied the Fullscreen API: filling the window and then
        // the screen is as close as the workbench gets to the same thing.
        await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
        await vscode.commands.executeCommand('workbench.action.toggleFullScreen');
      }
    });

    view.onDidDispose(() => {
      this.view = undefined;
      this.session?.feed?.dispose();
      this.status.hide();
    });
  }

  private sendHistory(webview: vscode.Webview) {
    webview.postMessage({ type: 'history', items: this.history.list() });
  }

  /** The status bar carries the playing video, so it stays visible with the panel collapsed. */
  private showStatus(playing: boolean) {
    const title = this.session?.info.title;
    if (!title) {
      this.status.hide();
      return;
    }
    const short =
      title.length > STATUS_TITLE_LENGTH ? `${title.slice(0, STATUS_TITLE_LENGTH - 1)}…` : title;
    this.status.text = `$(${playing ? 'play' : 'debug-pause'}) ${short}`;
    this.status.tooltip = `${title}\n${playing ? 'Pause' : 'Play'}`;
    this.status.show();
  }

  /** `channelId` narrows the query to one channel — the sidebar is showing it. */
  private async handleSearch(webview: vscode.Webview, query: string, channelId?: string) {
    const directId = parseVideoId(query);
    if (directId) {
      await this.handlePlay(webview, directId);
      return;
    }
    if (channelId) {
      await this.handleChannel(webview, () => this.channels.search(channelId, query));
      return;
    }

    const config = vscode.workspace.getConfiguration('nook');
    try {
      const results = await search(
        query,
        config.get<string>('language', 'tr'),
        config.get<string>('region', 'TR')
      );
      webview.postMessage({ type: 'results', results });
    } catch (error) {
      webview.postMessage({ type: 'error', message: (error as Error).message });
    }
  }

  /** `append` distinguishes another page of the same list from a fresh one. */
  private async handleChannel(
    webview: vscode.Webview,
    load: () => Promise<ChannelPage>,
    append = false
  ) {
    try {
      webview.postMessage({ type: 'channel', append, ...(await load()) });
    } catch (error) {
      webview.postMessage({ type: 'error', message: (error as Error).message });
    }
  }

  private async handlePlay(webview: vscode.Webview, id: string) {
    this.session?.feed?.dispose();
    try {
      const info = await this.resolver.resolve(id);
      const resumeAt = this.history.resumeAt(id);
      const session: Session = { id, info, resumeAt: resumeAt || undefined };
      this.session = session;
      this.history.record({
        id,
        title: info.title,
        channel: info.author,
        duration: info.duration
      });
      this.sendHistory(webview);

      const video = pickQuality(info.videos, this.maxHeight);
      webview.postMessage({
        type: 'play',
        id,
        title: info.title,
        duration: info.duration,
        resumeAt,
        video: video.url,
        quality: video.height,
        qualities: info.videos.map(({ height, label, codec }) => ({ height, label, codec }))
      });
      session.feed = this.startFeed(webview, session, {});
      this.showStatus(true);
    } catch (error) {
      this.session = undefined;
      this.status.hide();
      webview.postMessage({ type: 'error', message: (error as Error).message });
    }
  }

  /**
   * Mints a fresh URL for the picture. googlevideo answers a spent or over-used URL with a 403
   * whose body is text/plain, and the `<video>` element cannot tell that from a corrupt file — it
   * reports a format error and stops. The audio feed already re-resolves on a 403; this is the
   * same recovery for the other half.
   */
  private async handleRefresh(webview: vscode.Webview) {
    const session = this.session;
    if (!session) {
      return;
    }
    try {
      session.info = await this.resolver.resolve(session.id);
      const video = pickQuality(session.info.videos, this.maxHeight);
      webview.postMessage({ type: 'video-url', video: video.url, quality: video.height });
    } catch (error) {
      webview.postMessage({ type: 'error', message: (error as Error).message });
    }
  }

  /**
   * Swaps the picture for another track of the same video. Sound is untouched: it rides a separate
   * stream, so the webview only re-buffers the video and re-pins the audio it already holds.
   */
  private handleQuality(webview: vscode.Webview, height: number) {
    this.maxHeight = height;
    const session = this.session;
    if (!session) {
      return;
    }
    const video = pickQuality(session.info.videos, height);
    webview.postMessage({ type: 'video-url', video: video.url, quality: video.height });
  }

  /**
   * Restarts the feed at the requested position. The track's index says which byte the cluster
   * covering the target starts at, so the reader lands right on it. Without an index the offset is
   * estimated from the ratio of the seek time to the duration, and the reader finds the first
   * cluster after it. Either way nothing can begin until the head has been read from the top.
   */
  private async handleSeek(webview: vscode.Webview, time: number) {
    const session = this.session;
    if (!session) {
      return;
    }
    const size = session.feed?.size ?? 0;
    const head = session.head;
    session.feed?.dispose();

    let startByte = 0;
    const cue = head && lastCueBefore(session.cues ?? [], time);
    if (cue) {
      startByte = cue.byte;
    } else if (head && size) {
      // Land before the target, not after it: clusters are seconds long, and the reader can only
      // pick up at the start of one. Overshooting would leave a silent gap; the extra audio that
      // arrives early is simply dropped by the webview as already past.
      const before = Math.max(0, time - BACKTRACK_SECONDS);
      const ratio = session.info.duration > 0 ? Math.min(before / session.info.duration, 1) : 0;
      startByte = Math.floor(size * ratio);
    }
    session.feed = this.startFeed(webview, session, { startByte, startTime: time, head });
  }

  private startFeed(
    webview: vscode.Webview,
    session: Session,
    options: { startByte?: number; startTime?: number; head?: Buffer }
  ): AudioFeed {
    const generation = ++this.generation;
    const feed: AudioFeed = new AudioFeed(
      async (renew) => {
        if (renew) {
          session.info = await this.resolver.resolve(session.id);
          const video = pickQuality(session.info.videos, this.maxHeight);
          webview.postMessage({ type: 'video-url', video: video.url, quality: video.height });
        }
        return session.info.audioUrl;
      },
      {
        head: (head, cues) => {
          session.head = head;
          if (cues.length) {
            session.cues = cues;
          }
          // OpusHead only exists at the top of the file, so a video being resumed is read from the
          // start until it turns up — and only then can the feed jump to where it was left off.
          // By now the track's size is known too, which is what makes that jump possible.
          if (session.resumeAt !== undefined) {
            const target = session.resumeAt;
            session.resumeAt = undefined;
            void this.handleSeek(webview, target);
            return;
          }
          webview.postMessage({ type: 'audio-head', generation, head: head.toString('base64') });
        },
        packets: (packets) => {
          webview.postMessage({ type: 'audio', generation, batch: packPackets(packets) });
        },
        ended: () => webview.postMessage({ type: 'audio-end', generation }),
        failed: (message) => webview.postMessage({ type: 'error', message })
      },
      options
    );
    // Carry the known size across restarts so seeks keep landing in the right place.
    if (session.feed?.size) {
      feed.size = session.feed.size;
    }
    return feed;
  }

  private render(webview: vscode.Webview): string {
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));
    const nonce = createNonce();

    const csp = [
      `default-src 'none'`,
      `img-src https://i.ytimg.com https://yt3.ggpht.com data:`,
      // googlevideo answers with a redirect to another edge node often enough that the CSP has to
      // cover where those land too, not just the host the URL was minted with.
      `media-src https://*.googlevideo.com https://*.youtube.com https://*.googleusercontent.com`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      // 'wasm-unsafe-eval' is what lets the bundled Opus decoder instantiate.
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('main.css')}">
</head>
<body>
  <div id="stage">
    <div id="player-pane">
      <div id="screen">
        <video id="video" playsinline muted></video>
        <div id="placeholder">
          <p>Search for something, or paste a link.</p>
        </div>
      </div>
      <div id="controls">
        <button id="play" class="ctl" title="Play / Pause">
          <svg viewBox="0 0 16 16" class="icon-play"><path d="M4 2.5v11l9-5.5z"/></svg>
          <svg viewBox="0 0 16 16" class="icon-pause hidden"><path d="M4.5 2.5h3v11h-3zm4.5 0h3v11h-3z"/></svg>
        </button>
        <input id="seek" type="range" min="0" max="1000" value="0" title="Position">
        <span id="time">0:00 / 0:00</span>
        <div id="volume-wrap">
          <button id="mute" class="ctl" title="Mute">
            <svg viewBox="0 0 16 16" class="icon-sound"><path d="M8 2 4.5 5H2v6h2.5L8 14z"/><path d="M10.6 5.4a3.7 3.7 0 0 1 0 5.2" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
            <svg viewBox="0 0 16 16" class="icon-muted hidden"><path d="M8 2 4.5 5H2v6h2.5L8 14z"/><path d="M10.6 5.9l3.4 3.4m0-3.4l-3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>
          </button>
          <input id="volume" type="range" min="0" max="100" value="100" title="Volume">
        </div>
        <div class="menu-wrap">
          <button id="quality" class="ctl" title="Quality" aria-haspopup="true" disabled>
            <svg viewBox="0 0 16 16"><path d="M8 5.4A2.6 2.6 0 1 0 8 10.6 2.6 2.6 0 0 0 8 5.4m0 1.5a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2"/><path d="m6.9 1.5h2.2l.3 1.7 1.2.7 1.6-.6 1.1 1.9-1.3 1.1v1.4l1.3 1.1-1.1 1.9-1.6-.6-1.2.7-.3 1.7H6.9l-.3-1.7-1.2-.7-1.6.6-1.1-1.9 1.3-1.1V6.3L2.7 5.2l1.1-1.9 1.6.6 1.2-.7z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
          </button>
          <div id="quality-menu" class="menu"></div>
        </div>
        <button id="toggle-sidebar" class="ctl" title="Hide search">
          <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.4 10.4 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </button>
        <button id="fullscreen" class="ctl" title="Fullscreen">
          <svg viewBox="0 0 16 16"><path d="M2 6V2h4v1.5H3.5V6zm8-4h4v4h-1.5V3.5H10zM2 10h1.5v2.5H6V14H2zm10.5 0H14v4h-4v-1.5h2.5z"/></svg>
        </button>
        <button id="maximize" class="ctl" title="Maximize / restore panel">
          <svg viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor"/><rect x="2.5" y="8.5" width="11" height="4"/></svg>
        </button>
      </div>
    </div>
    <div id="splitter" title="Drag to resize"></div>
    <aside id="sidebar">
      <form id="search-form">
        <input id="search-input" type="text" placeholder="Search or paste a link…" autocomplete="off" spellcheck="false">
        <button id="show-history" type="button" title="Recently watched">
          <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.4V8l2.6 1.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </form>
      <div id="channel-bar" class="hidden">
        <button id="channel-back" title="Back to search results">
          <svg viewBox="0 0 16 16"><path d="M9.8 3.2 5 8l4.8 4.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span id="channel-name"></span>
      </div>
      <div id="filters" class="hidden"></div>
      <div id="history-bar" class="hidden">
        <span>Recently watched</span>
        <button id="history-clear" type="button">Clear</button>
      </div>
      <div id="status"></div>
      <div id="results"></div>
      <button id="more" class="hidden">Load more</button>
    </aside>
  </div>
  <script nonce="${nonce}" src="${asset('opus-decoder.min.js')}"></script>
  <script nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>`;
  }
}

interface Session {
  id: string;
  info: StreamInfo;
  feed?: AudioFeed;
  head?: Buffer;
  /** The audio track's index, once the feed has read past it. */
  cues?: CuePoint[];
  /** Set only until the head arrives and the feed can be moved to where watching left off. */
  resumeAt?: number;
}

/** The cue whose cluster covers `time`: the last one starting at or before it. */
function lastCueBefore(cues: CuePoint[], time: number): CuePoint | undefined {
  let found: CuePoint | undefined;
  for (const cue of cues) {
    if (cue.time > time) {
      break;
    }
    found = cue;
  }
  return found;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () =>
    alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  ).join('');
}
