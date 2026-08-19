(function () {
  const vscode = acquireVsCodeApi();

  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  const status = document.getElementById('status');
  const resultsEl = document.getElementById('results');
  const placeholder = document.getElementById('placeholder');
  const spinner = document.getElementById('spinner');
  const skipBadge = document.getElementById('skip');
  const video = document.getElementById('video');
  const stage = document.getElementById('stage');
  const sidebar = document.getElementById('sidebar');
  const splitter = document.getElementById('splitter');
  const playerPane = document.getElementById('player-pane');
  const playButton = document.getElementById('play');
  const closeButton = document.getElementById('close');
  const muteButton = document.getElementById('mute');
  const seek = document.getElementById('seek');
  const volume = document.getElementById('volume');
  const timeLabel = document.getElementById('time');
  const qualityButton = document.getElementById('quality');
  const qualityMenu = document.getElementById('quality-menu');
  const sidebarButton = document.getElementById('toggle-sidebar');
  const channelBar = document.getElementById('channel-bar');
  const channelName = document.getElementById('channel-name');
  const filtersEl = document.getElementById('filters');
  const moreButton = document.getElementById('more');
  const historyBar = document.getElementById('history-bar');
  const historyClear = document.getElementById('history-clear');
  const historyButton = document.getElementById('show-history');

  const state = Object.assign(
    { volume: 1, muted: false, sidebarWidth: 320, sidebarHeight: 200, sidebarHidden: false },
    vscode.getState()
  );

  function save() {
    vscode.setState(state);
  }

  /**
   * Sound for the video, decoded here rather than by the platform.
   *
   * VS Code's ffmpeg has no Opus decoder, so the packets arrive raw from the extension host and a
   * WebAssembly libopus turns them into PCM. WebAudio then plays that PCM on a schedule pinned to
   * the <video> element's clock, which stays the single source of truth for "where we are".
   */
  const audio = {
    context: null,
    gain: null,
    decoder: null,
    /** Decoded PCM held by media time, so it can be re-timed instead of thrown away. */
    chunks: [],
    pendingLeft: [],
    pendingRight: [],
    pendingFrames: 0,
    pendingStart: 0,
    anchorMedia: 0,
    anchorContext: 0,
    anchored: false,

    /** Batches shorter than this are held back; one source node per 20ms packet is wasteful. */
    batchSeconds: 0.25,
    /** Decoded audio this far behind the playhead is released. */
    keepBehindSeconds: 10,

    start() {
      if (!this.context) {
        this.context = new AudioContext({ sampleRate: 48000 });
        this.gain = this.context.createGain();
        this.gain.connect(this.context.destination);
        applyVolume();
      }
      if (this.context.state === 'suspended') {
        this.context.resume().catch(() => {});
      }
    },

    async configure(head) {
      this.clear();
      this.start();
      const channels = head[9] || 2;
      const preSkip = head[10] | (head[11] << 8);
      if (this.decoder) {
        this.decoder.free();
      }
      const { OpusDecoder } = window['opus-decoder'];
      this.decoder = new OpusDecoder({ channels, preSkip, forceStereo: true });
      await this.decoder.ready;
    },

    /** Throws everything away — only for a new video or a seek, where the audio is stale. */
    clear() {
      this.silence();
      this.chunks = [];
      this.pendingLeft = [];
      this.pendingRight = [];
      this.pendingFrames = 0;
      this.anchored = false;
    },

    /** Stops sound now but keeps the decoded audio, so playback can resume from it. */
    silence() {
      for (const chunk of this.chunks) {
        if (chunk.source) {
          // Drop the handler before stopping: it fires asynchronously, and a stopped source
          // must not report back once its chunk may already hold a newer one.
          chunk.source.onended = null;
          try {
            chunk.source.stop();
          } catch (error) {
            /* already finished */
          }
          chunk.source = null;
        }
        chunk.spent = false;
      }
      this.anchored = false;
    },

    anchor(mediaTime) {
      if (!this.context) {
        return;
      }
      this.anchorMedia = mediaTime;
      // A short lead so the first batch is scheduled in the future rather than the past.
      this.anchorContext = this.context.currentTime + 0.12;
      this.anchored = true;
    },

    /** Whether decoded audio for this media time is still in hand. */
    covers(mediaTime) {
      return this.chunks.some(
        (chunk) => chunk.start <= mediaTime && mediaTime < chunk.start + chunk.duration
      );
    },

    /** Where the sound believes it is, in media time. */
    playhead() {
      return this.anchored ? this.anchorMedia + (this.context.currentTime - this.anchorContext) : 0;
    },

    push(packets) {
      if (!this.decoder || !this.context) {
        return;
      }
      for (const packet of packets) {
        let decoded;
        try {
          decoded = this.decoder.decodeFrame(packet.data);
        } catch (error) {
          continue;
        }
        if (!decoded || !decoded.samplesDecoded) {
          continue;
        }
        if (this.pendingFrames === 0) {
          this.pendingStart = packet.time;
        }
        this.pendingLeft.push(decoded.channelData[0].slice());
        this.pendingRight.push((decoded.channelData[1] || decoded.channelData[0]).slice());
        this.pendingFrames += decoded.samplesDecoded;

        if (this.pendingFrames >= this.batchSeconds * 48000) {
          this.flush();
        }
      }
    },

    flush() {
      if (!this.pendingFrames) {
        return;
      }
      const frames = this.pendingFrames;
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      let at = 0;
      for (let i = 0; i < this.pendingLeft.length; i++) {
        left.set(this.pendingLeft[i], at);
        right.set(this.pendingRight[i], at);
        at += this.pendingLeft[i].length;
      }
      this.chunks.push({
        start: this.pendingStart,
        duration: frames / 48000,
        left: left,
        right: right,
        source: null,
        spent: false
      });
      this.pendingLeft = [];
      this.pendingRight = [];
      this.pendingFrames = 0;
      this.schedule();
    },

    /** Hands every not-yet-playing chunk to WebAudio at the time the anchor says it belongs. */
    schedule() {
      if (!this.anchored || !this.context) {
        return;
      }
      const now = this.context.currentTime;
      for (const chunk of this.chunks) {
        if (chunk.source || chunk.spent) {
          continue;
        }
        const when = this.anchorContext + (chunk.start - this.anchorMedia);
        let at = when;
        let offset = 0;
        if (when < now) {
          // Already overtaken: start partway in rather than dropping the whole chunk.
          offset = now - when;
          at = now;
          if (offset >= chunk.duration) {
            chunk.spent = true;
            continue;
          }
        }

        const buffer = this.context.createBuffer(2, chunk.left.length, 48000);
        buffer.copyToChannel(chunk.left, 0);
        buffer.copyToChannel(chunk.right, 1);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gain);
        source.start(at, offset);
        source.onended = () => {
          // Only if this is still the chunk's current source; an older one finishing must not
          // erase the reference to whatever replaced it.
          if (chunk.source === source) {
            chunk.source = null;
            chunk.spent = true;
          }
        };
        chunk.source = source;
      }
      this.prune();
    },

    prune() {
      const behind = this.playhead() - this.keepBehindSeconds;
      this.chunks = this.chunks.filter((chunk) => chunk.start + chunk.duration > behind);
    },

    /** Re-pins sound to the video's clock, replaying from decoded audio rather than refetching. */
    restart(mediaTime) {
      if (!this.context) {
        return;
      }
      this.silence();
      this.anchor(mediaTime);
      this.schedule();
    },

    /**
     * Nudges back into step when the two clocks drift apart. Only while the picture is genuinely
     * moving: a stalling video drifts by definition, and re-pinning against it every tick would
     * chop the sound to pieces instead of fixing anything.
     */
    sync(mediaTime, moving) {
      if (!this.context || !this.anchored || !moving) {
        return;
      }
      if (Math.abs(this.playhead() - mediaTime) > 0.3) {
        this.restart(mediaTime);
      }
    }
  };

  function applyVolume() {
    if (audio.gain) {
      audio.gain.gain.value = state.muted ? 0 : state.volume;
    }
  }

  // --- playback ---

  let duration = 0;
  let scrubbing = false;
  let currentId = '';
  // Where a half-watched video should pick up. The <video> element cannot be seeked before it
  // knows its own duration, so the position waits here for its metadata.
  let pendingResume = 0;
  /** Fresh URLs to try before a rejected source is reported as a real failure. */
  const VIDEO_RETRIES = 2;
  const SKIP_SECONDS = 10;
  let videoRetries = 0;
  // Which feed the sound currently belongs to; packets from an older one are ignored.
  let generation = -1;

  /** Drops whatever is loaded: picture, sound and the numbers on the bar go back to nothing. */
  function unload() {
    currentId = '';
    pendingResume = 0;
    videoRetries = 0;
    video.pause();
    video.removeAttribute('src');
    video.load();
    audio.clear();
    duration = 0;
    qualities = [];
    renderQuality(0);
    renderTime();
    setLoading(false);
  }

  function requestPlay(id) {
    // Go quiet immediately: resolving the new streams takes a moment, and the old video should
    // not keep playing underneath it.
    unload();
    setStatus('Loading…');
    currentId = id;
    setLoading(true);
    closeButton.disabled = false; // a slow resolve is something to be able to give up on
    vscode.postMessage({ type: 'play', id: id });
  }

  /** The close button: back to the empty screen, and the feed behind it is torn down too. */
  function closeVideo() {
    unload();
    setStatus('');
    placeholder.classList.remove('hidden');
    closeButton.disabled = true;
    vscode.postMessage({ type: 'close' });
  }

  function play(message) {
    placeholder.classList.add('hidden');
    closeButton.disabled = false;
    currentId = message.id || currentId;
    duration = message.duration || 0;
    audio.clear();
    audio.start();
    qualities = message.qualities || [];
    renderQuality(message.quality);
    pendingResume = message.resumeAt || 0;
    video.src = message.video;
    video.play().catch(() => {});
    seek.value = '0';
    renderTime();
    setStatus(pendingResume ? `Resuming at ${formatTime(pendingResume)}.` : '');
  }

  function setStatus(text) {
    status.textContent = text || '';
  }

  /**
   * The ring over the picture. On whenever the picture has been asked for and has not arrived —
   * a new video, a seek, a stall — and off as soon as it can play, or the wait is called off.
   */
  function setLoading(on) {
    spinner.classList.toggle('hidden', !on);
  }

  function unpack(base64) {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    const view = new DataView(bytes.buffer);
    const count = view.getUint32(0, true);
    const packets = [];
    let lengthAt = 4;
    let timeAt = 4 + count * 2;
    let dataAt = 4 + count * 6;
    for (let i = 0; i < count; i++) {
      const length = view.getUint16(lengthAt, true);
      const time = view.getFloat32(timeAt, true);
      packets.push({ time: time, data: bytes.subarray(dataAt, dataAt + length) });
      lengthAt += 2;
      timeAt += 4;
      dataAt += length;
    }
    return packets;
  }

  // --- controls ---

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(isFinite(seconds) ? seconds : 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const rest = String(total % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
  }

  function renderTime(current) {
    const at = current === undefined ? video.currentTime : current;
    timeLabel.textContent = `${formatTime(at)} / ${formatTime(duration)}`;
    if (!scrubbing) {
      seek.value = duration ? String(Math.round((at / duration) * 1000)) : '0';
    }
  }

  function renderVolume() {
    const silent = state.muted || state.volume === 0;
    muteButton.querySelector('.icon-sound').classList.toggle('hidden', silent);
    muteButton.querySelector('.icon-muted').classList.toggle('hidden', !silent);
    muteButton.title = silent ? 'Unmute' : 'Mute';
    if (document.activeElement !== volume) {
      volume.value = String(Math.round(state.volume * 100));
    }
  }

  function renderPlayState() {
    playButton.querySelector('.icon-play').classList.toggle('hidden', !video.paused);
    playButton.querySelector('.icon-pause').classList.toggle('hidden', video.paused);
    // The status bar shows the same state, and it is the only sign of the player left once the
    // panel is collapsed.
    vscode.postMessage({ type: 'playstate', playing: !video.paused });
  }

  function togglePlay() {
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
      // Nothing is awaited while paused; resuming into a stall brings the ring straight back.
      setLoading(false);
    }
  }

  playButton.addEventListener('click', togglePlay);
  closeButton.addEventListener('click', closeVideo);
  // The picture itself is a play/pause target too. Nothing loaded means the placeholder covers
  // it, so this only ever fires on a video that is actually there. A double click skips instead —
  // left half back, right half forward — so a single click waits out the double-click window
  // before it toggles, or two quick clicks would toggle twice and then skip.
  let clickTimer = 0;
  video.addEventListener('click', (event) => {
    clearTimeout(clickTimer);
    if (event.detail > 1) {
      return;
    }
    clickTimer = setTimeout(togglePlay, 250);
  });
  video.addEventListener('dblclick', (event) => {
    clearTimeout(clickTimer);
    const left = event.offsetX < video.clientWidth / 2;
    seekBy(left ? -SKIP_SECONDS : SKIP_SECONDS);
  });

  function seekBy(seconds) {
    if (!duration) {
      return;
    }
    seekTo(Math.min(duration, Math.max(0, video.currentTime + seconds)));
    showSkip(seconds < 0);
  }

  /**
   * Moves the playhead. Sound already decoded around the target is simply re-timed by 'seeked';
   * anything further afield — beyond what is kept behind, or the lead kept ahead — has the feed
   * restarted there, or the picture would carry on in silence.
   */
  function seekTo(time) {
    video.currentTime = time;
    if (audio.covers(time)) {
      return;
    }
    audio.clear();
    setLoading(true);
    vscode.postMessage({ type: 'seek', time: time });
  }

  let skipTimer = 0;
  function showSkip(back) {
    clearTimeout(skipTimer);
    // Restarting the animation from a stale badge needs it removed for a frame.
    skipBadge.classList.add('hidden');
    void skipBadge.offsetWidth;
    skipBadge.classList.toggle('back', back);
    skipBadge.classList.toggle('forward', !back);
    skipBadge.classList.remove('hidden');
    skipTimer = setTimeout(() => skipBadge.classList.add('hidden'), 700);
  }

  // The video element is the clock. Sound follows it: it goes quiet whenever the picture is not
  // advancing, and re-pins to it whenever it starts moving again — always replaying from audio
  // already decoded, never discarding it.
  video.addEventListener('play', () => {
    audio.start();
    audio.restart(video.currentTime);
    renderPlayState();
  });
  video.addEventListener('pause', () => {
    audio.silence();
    renderPlayState();
  });
  video.addEventListener('waiting', () => {
    audio.silence();
    setLoading(true);
  });
  video.addEventListener('seeking', () => setLoading(true));
  video.addEventListener('canplay', () => setLoading(false));
  video.addEventListener('playing', () => {
    setLoading(false);
    audio.restart(video.currentTime);
    // Picture is moving, so whatever was refused is behind us: a failure hours from now, when the
    // URL expires on its own, gets its own goes at a fresh one.
    videoRetries = 0;
    if (status.textContent.startsWith('Stream refused')) {
      setStatus('');
    }
  });
  video.addEventListener('loadedmetadata', () => {
    if (pendingResume) {
      video.currentTime = pendingResume;
      pendingResume = 0;
      // The notice has been read by the time the picture lands; leaving it would sit above the
      // results until the next search.
      setTimeout(() => {
        if (status.textContent.startsWith('Resuming')) {
          setStatus('');
        }
      }, 3000);
    }
  });
  // Landing in already-buffered picture may not announce itself with 'playing'; landing anywhere
  // else will, and starting the sound before then would only have it replayed from here.
  video.addEventListener('seeked', () => {
    if (video.readyState >= 3) {
      setLoading(false); // landed in buffered picture: 'canplay' may not come round again
    }
    if (moving()) {
      audio.restart(video.currentTime);
    }
  });
  video.addEventListener('error', () => {
    const failure = video.error;

    // A spent googlevideo URL answers 403 with a text/plain body, which the element cannot tell
    // from a corrupt file: it reports a format error. So a rejected source is worth one or two
    // goes at a fresh URL before it is believed. The src attribute is the discriminator —
    // requestPlay strips it before calling load(), and that rejection is not worth retrying.
    if (failure && failure.code === 4 && video.getAttribute('src') && videoRetries < VIDEO_RETRIES) {
      videoRetries++;
      setStatus('Stream refused — asking for a fresh URL…');
      vscode.postMessage({ type: 'refresh-video' });
      return;
    }

    setLoading(false);
    const kind =
      { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'source rejected' }[failure && failure.code] ||
      'unknown';
    setStatus(
      `Video failed — ${kind}${failure && failure.message ? `: ${failure.message}` : ''} (code ${
        failure ? failure.code : '?'
      })`
    );
  });
  video.addEventListener('timeupdate', () => {
    renderTime();
    audio.sync(video.currentTime, moving());
  });

  /** Whether the picture is actually advancing: playing, with frames in hand to keep going. */
  function moving() {
    return !video.paused && video.readyState >= 3;
  }

  // Tell the feed where playback is so it keeps just enough audio ahead of us.
  setInterval(() => {
    if (currentId && !video.paused) {
      vscode.postMessage({ type: 'progress', time: video.currentTime });
    }
  }, 1000);

  seek.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  seek.addEventListener('pointerup', () => {
    scrubbing = false;
  });
  seek.addEventListener('input', () => {
    renderTime((Number(seek.value) / 1000) * duration);
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    if (!duration) {
      return;
    }
    seekTo((Number(seek.value) / 1000) * duration);
  });

  volume.addEventListener('input', () => {
    state.volume = Number(volume.value) / 100;
    state.muted = state.volume === 0;
    applyVolume();
    renderVolume();
    save();
  });

  muteButton.addEventListener('click', () => {
    if (state.muted || state.volume === 0) {
      state.muted = false;
      if (state.volume === 0) {
        state.volume = 0.5;
      }
    } else {
      state.muted = true;
    }
    applyVolume();
    renderVolume();
    save();
  });

  // VS Code's webview iframe is usually denied the Fullscreen API, in which case the extension
  // host is asked to fill the screen with the workbench instead — same effect, different mechanism.
  document.getElementById('fullscreen').addEventListener('click', () => {
    if (!document.fullscreenEnabled) {
      vscode.postMessage({ type: 'fullscreen' });
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      playerPane.requestFullscreen().catch(() => vscode.postMessage({ type: 'fullscreen' }));
    }
  });

  document.getElementById('maximize').addEventListener('click', () => {
    vscode.postMessage({ type: 'maximize' });
  });

  // --- quality ---

  // Every height the current video offers, tallest first; empty until something is playing.
  let qualities = [];

  function renderQuality(height) {
    qualityButton.disabled = qualities.length === 0;
    const current = qualities.find((item) => item.height === height);
    // The gear carries no label, so the current choice lives in the tooltip and, once the menu is
    // open, in the tick beside the active row.
    qualityButton.title = current ? `Quality — ${current.label}` : 'Quality';

    qualityMenu.replaceChildren();
    for (const item of qualities) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = item.height === height ? 'active' : '';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.label;
      const codec = document.createElement('span');
      codec.className = 'codec';
      codec.textContent = item.codec;
      row.append(label, codec);
      row.addEventListener('click', () => {
        // Dropping focus closes the menu for a keyboard user, who opened it by tabbing to the gear;
        // with a pointer, hover keeps it open until the cursor leaves, which is what is wanted.
        row.blur();
        vscode.postMessage({ type: 'quality', height: item.height });
      });
      qualityMenu.appendChild(row);
    }
  }

  // --- sidebar visibility ---

  function renderSidebar() {
    sidebar.classList.toggle('hidden', state.sidebarHidden);
    splitter.classList.toggle('hidden', state.sidebarHidden);
    sidebarButton.classList.toggle('active', !state.sidebarHidden);
    sidebarButton.title = state.sidebarHidden ? 'Show search' : 'Hide search';
  }

  sidebarButton.addEventListener('click', () => {
    state.sidebarHidden = !state.sidebarHidden;
    renderSidebar();
    save();
    if (!state.sidebarHidden) {
      input.focus();
    }
  });

  // --- results ---

  // The sidebar shows either search results or one channel's videos. The search list is kept so
  // stepping back out of a channel does not have to run the query again.
  let searchResults = [];
  let channel = null;
  let historyItems = [];
  // Which list is in front. Results and channels are both reached from a search, so this only has
  // to say whether the history is covering them.
  let historyOpen = true;

  function renderResults(results, append) {
    if (!append) {
      resultsEl.replaceChildren();
    }
    for (const item of results) {
      const card = document.createElement('button');
      card.className = 'card';
      card.type = 'button';

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'thumb';
      const img = document.createElement('img');
      img.src = item.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      thumbWrap.appendChild(img);

      const badge = item.live ? 'LIVE' : item.duration;
      if (badge) {
        const badgeEl = document.createElement('span');
        badgeEl.className = item.live ? 'badge live' : 'badge';
        badgeEl.textContent = badge;
        thumbWrap.appendChild(badgeEl);
      }

      if (item.progress) {
        const bar = document.createElement('div');
        bar.className = 'progress';
        const fill = document.createElement('div');
        fill.style.width = `${Math.round(item.progress * 100)}%`;
        bar.appendChild(fill);
        thumbWrap.appendChild(bar);
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = item.title;
      const sub = document.createElement('div');
      sub.className = 'sub';
      if (item.channelId) {
        const link = document.createElement('span');
        link.className = 'channel-link';
        link.textContent = item.channel;
        link.title = `Open ${item.channel}`;
        link.addEventListener('click', (event) => {
          // The card itself plays the video; opening the channel must not do both.
          event.stopPropagation();
          openChannel(item.channelId, '');
        });
        sub.appendChild(link);
        const rest = [item.views, item.published].filter(Boolean).join(' · ');
        if (rest) {
          sub.appendChild(document.createTextNode(` · ${rest}`));
        }
      } else {
        // Inside a channel every row has the same owner, so naming it on each card is noise.
        const fields = channel
          ? [item.views, item.published]
          : [item.channel, item.views, item.published];
        sub.textContent = fields.filter(Boolean).join(' · ');
      }
      meta.append(title, sub);

      card.append(thumbWrap, meta);
      card.addEventListener('click', () => requestPlay(item.id));
      resultsEl.appendChild(card);
    }
  }

  // --- channel view ---

  /** `searched` marks a query that has just come back, so an empty one can say so. */
  function showSearch(searched) {
    // Nothing has been searched for yet — or a search came back empty — so the sidebar falls back
    // to what was watched before rather than standing empty.
    if (!searchResults.length) {
      showHistory();
      if (searched) {
        setStatus('No results.');
      }
      return;
    }
    channel = null;
    setHistoryOpen(false);
    channelBar.classList.add('hidden');
    filtersEl.classList.add('hidden');
    moreButton.classList.add('hidden');
    historyBar.classList.add('hidden');
    input.placeholder = 'Search or paste a link…';
    renderResults(searchResults);
    setStatus('');
  }

  function showHistory() {
    channel = null;
    setHistoryOpen(true);
    channelBar.classList.add('hidden');
    filtersEl.classList.add('hidden');
    moreButton.classList.add('hidden');
    historyBar.classList.toggle('hidden', historyItems.length === 0);
    input.placeholder = 'Search or paste a link…';
    renderResults(historyItems.map(toCard));
    setStatus(historyItems.length ? '' : 'Nothing watched yet.');
  }

  function setHistoryOpen(open) {
    historyOpen = open;
    historyButton.classList.toggle('active', open);
    // With results waiting behind it the button goes both ways, and says which way it is pointing.
    historyButton.title = open && searchResults.length ? 'Back to results' : 'Recently watched';
  }

  historyButton.addEventListener('click', () => {
    if (historyOpen && searchResults.length) {
      showSearch();
    } else {
      showHistory();
    }
  });

  /** A watched video wearing the same clothes as a search result, plus how far it got. */
  function toCard(entry) {
    return {
      id: entry.id,
      title: entry.title,
      channel: entry.channel,
      channelId: '',
      duration: entry.duration ? formatTime(entry.duration) : '',
      views: '',
      published: timeAgo(entry.at),
      // Derived rather than stored: the id is all a thumbnail URL needs.
      thumbnail: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg`,
      live: false,
      progress: entry.duration ? Math.min(entry.position / entry.duration, 1) : 0
    };
  }

  function timeAgo(at) {
    const seconds = Math.max(0, (Date.now() - at) / 1000);
    const scales = [
      [31536000, 'year'],
      [2592000, 'month'],
      [604800, 'week'],
      [86400, 'day'],
      [3600, 'hour'],
      [60, 'minute']
    ];
    for (const [size, name] of scales) {
      const count = Math.floor(seconds / size);
      if (count >= 1) {
        return `${count} ${name}${count > 1 ? 's' : ''} ago`;
      }
    }
    return 'just now';
  }

  historyClear.addEventListener('click', () => vscode.postMessage({ type: 'clear-history' }));

  function openChannel(id, filter) {
    channel = { id: id, filter: filter || '' };
    setStatus('Loading channel…');
    vscode.postMessage({ type: 'channel', id: id, filter: filter });
  }

  function showChannel(message) {
    channel = { id: channel ? channel.id : '', filter: message.filter };
    setHistoryOpen(false);
    historyBar.classList.add('hidden');
    channelBar.classList.remove('hidden');
    channelName.textContent = message.channel;
    input.placeholder = `Search in ${message.channel}…`;
    renderFilters(message.filters, message.filter);
    renderResults(message.videos, message.append);
    moreButton.classList.toggle('hidden', !message.hasMore);
    moreButton.disabled = false;
    setStatus(message.videos.length || message.append ? '' : 'No videos here.');
  }

  function renderFilters(filters, active) {
    filtersEl.replaceChildren();
    // A channel search answers with no filters at all; it is ranked by relevance instead.
    filtersEl.classList.toggle('hidden', !filters || filters.length < 2);
    for (const name of filters || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      button.className = name === active ? 'active' : '';
      button.addEventListener('click', () => openChannel(channel.id, name));
      filtersEl.appendChild(button);
    }
  }

  document.getElementById('channel-back').addEventListener('click', () => showSearch());

  moreButton.addEventListener('click', () => {
    moreButton.disabled = true;
    vscode.postMessage({ type: 'channel-more' });
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) {
      return;
    }
    setStatus(channel ? 'Searching channel…' : 'Searching…');
    vscode.postMessage({
      type: 'search',
      query: query,
      channelId: channel ? channel.id : undefined
    });
  });

  window.addEventListener('message', async function (event) {
    const message = event.data;
    if (!message) {
      return;
    }

    if (message.type === 'results') {
      searchResults = message.results;
      showSearch(true);
    } else if (message.type === 'history') {
      historyItems = message.items || [];
      // Only redraw where the history is what is on screen; a fresh watch must not throw away the
      // search results the viewer is still picking from.
      if (historyOpen) {
        showHistory();
      }
    } else if (message.type === 'toggle') {
      togglePlay();
    } else if (message.type === 'channel') {
      showChannel(message);
    } else if (message.type === 'play') {
      play(message);
    } else if (message.type === 'audio-head') {
      generation = message.generation;
      const head = unpackBytes(message.head);
      await audio.configure(head);
      if (generation !== message.generation) {
        return; // superseded while the decoder was starting up
      }
      // Pinned to the picture's clock only if the picture is moving. Otherwise — still buffering
      // after a seek, say — the decoded audio waits, and 'playing' pins it when the picture goes;
      // sound set going on its own here would only be pulled back to the start when it does.
      if (moving()) {
        audio.anchor(video.currentTime);
      }
    } else if (message.type === 'audio') {
      if (message.generation === generation) {
        audio.push(unpack(message.batch));
      }
    } else if (message.type === 'audio-end') {
      if (message.generation === generation) {
        audio.flush();
      }
    } else if (message.type === 'video-url') {
      // Reloading the picture always restarts its buffer; the sound is a separate stream and keeps
      // going, so a paused player must stay paused rather than being nudged back into playing.
      const at = video.currentTime;
      const wasPlaying = !video.paused;
      video.src = message.video;
      video.currentTime = at;
      if (wasPlaying) {
        video.play().catch(() => {});
      }
      renderQuality(message.quality);
    } else if (message.type === 'error') {
      moreButton.disabled = false;
      setLoading(false);
      setStatus(message.message);
    }
  });

  function unpackBytes(base64) {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
  }

  // --- splitter ---

  const stacked = window.matchMedia('(max-width: 700px)');

  function applySplit() {
    sidebar.style.flexBasis = `${stacked.matches ? state.sidebarHeight : state.sidebarWidth}px`;
  }

  stacked.addEventListener('change', applySplit);
  applySplit();
  renderSidebar();
  renderQuality(0);
  renderVolume();
  renderPlayState();
  renderTime();
  // Asked for rather than pushed: a message sent while this script was still loading would be lost.
  vscode.postMessage({ type: 'ready' });

  splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    const bounds = stage.getBoundingClientRect();

    const onMove = (move) => {
      const vertical = stacked.matches;
      // 8px is #stage's padding, i.e. the gap between the sidebar and the panel edge.
      const span = vertical ? bounds.bottom - 8 - move.clientY : bounds.right - 8 - move.clientX;
      const room = (vertical ? bounds.height : bounds.width) - 160;
      const size = Math.round(Math.max(140, Math.min(span, Math.max(140, room))));
      if (vertical) {
        state.sidebarHeight = size;
      } else {
        state.sidebarWidth = size;
      }
      applySplit();
    };

    const onUp = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', onMove);
      splitter.removeEventListener('pointerup', onUp);
      save();
    };

    splitter.addEventListener('pointermove', onMove);
    splitter.addEventListener('pointerup', onUp);
  });
})();
