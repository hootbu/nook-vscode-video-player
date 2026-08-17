(function () {
  const vscode = acquireVsCodeApi();

  const form = document.getElementById('search-form');
  const input = document.getElementById('search-input');
  const status = document.getElementById('status');
  const resultsEl = document.getElementById('results');
  const placeholder = document.getElementById('placeholder');
  const video = document.getElementById('video');
  const stage = document.getElementById('stage');
  const sidebar = document.getElementById('sidebar');
  const splitter = document.getElementById('splitter');
  const playerPane = document.getElementById('player-pane');
  const playButton = document.getElementById('play');
  const muteButton = document.getElementById('mute');
  const seek = document.getElementById('seek');
  const volume = document.getElementById('volume');
  const timeLabel = document.getElementById('time');

  const state = Object.assign(
    { volume: 1, muted: false, sidebarWidth: 320, sidebarHeight: 200 },
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
  // Which feed the sound currently belongs to; packets from an older one are ignored.
  let generation = -1;

  function requestPlay(id) {
    setStatus('Loading…');
    currentId = id;
    // Go quiet immediately: resolving the new streams takes a moment, and the old video should
    // not keep playing underneath it.
    video.pause();
    video.removeAttribute('src');
    video.load();
    audio.clear();
    duration = 0;
    renderTime();
    vscode.postMessage({ type: 'play', id: id });
  }

  function play(message) {
    placeholder.classList.add('hidden');
    currentId = message.id || currentId;
    duration = message.duration || 0;
    audio.clear();
    audio.start();
    video.src = message.video;
    video.play().catch(() => {});
    seek.value = '0';
    renderTime();
    setStatus('');
  }

  function setStatus(text) {
    status.textContent = text || '';
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
  }

  playButton.addEventListener('click', () => {
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  });

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
  video.addEventListener('waiting', () => audio.silence());
  video.addEventListener('playing', () => audio.restart(video.currentTime));
  video.addEventListener('seeked', () => {
    if (!video.paused) {
      audio.restart(video.currentTime);
    }
  });
  video.addEventListener('error', () => {
    const failure = video.error;
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
    audio.sync(video.currentTime, !video.paused && video.readyState >= 3);
  });

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
    const time = (Number(seek.value) / 1000) * duration;
    video.currentTime = time;
    audio.clear();
    vscode.postMessage({ type: 'seek', time: time });
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

  document.getElementById('fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      playerPane.requestFullscreen().catch(() => setStatus('Fullscreen is unavailable here.'));
    }
  });

  document.getElementById('maximize').addEventListener('click', () => {
    vscode.postMessage({ type: 'maximize' });
  });

  // --- results ---

  function renderResults(results) {
    resultsEl.replaceChildren();
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

      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = item.title;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = [item.channel, item.views, item.published].filter(Boolean).join(' · ');
      meta.append(title, sub);

      card.append(thumbWrap, meta);
      card.addEventListener('click', () => requestPlay(item.id));
      resultsEl.appendChild(card);
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) {
      return;
    }
    setStatus('Searching…');
    vscode.postMessage({ type: 'search', query: query });
  });

  window.addEventListener('message', async function (event) {
    const message = event.data;
    if (!message) {
      return;
    }

    if (message.type === 'results') {
      setStatus(message.results.length ? '' : 'No results.');
      renderResults(message.results);
    } else if (message.type === 'play') {
      play(message);
    } else if (message.type === 'audio-head') {
      generation = message.generation;
      const head = unpackBytes(message.head);
      await audio.configure(head);
      if (generation !== message.generation) {
        return; // superseded while the decoder was starting up
      }
      audio.anchor(message.reset || 0);
    } else if (message.type === 'audio') {
      if (message.generation === generation) {
        audio.push(unpack(message.batch));
      }
    } else if (message.type === 'audio-end') {
      if (message.generation === generation) {
        audio.flush();
      }
    } else if (message.type === 'video-url') {
      const at = video.currentTime;
      video.src = message.video;
      video.currentTime = at;
      video.play().catch(() => {});
    } else if (message.type === 'error') {
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
  renderVolume();
  renderPlayState();
  renderTime();

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
