# Player

A video player that lives in the VS Code bottom panel, next to the terminal.

## Running it

```bash
npm install
npm run compile
```

Then press <kbd>F5</kbd> (or run `code --extensionDevelopmentPath="$PWD"`). In the new window,
open the panel and pick the **Player** tab.

Type a search term, or paste a link — `watch?v=`, `youtu.be/`, `/shorts/`, `/live/` and
`/embed/` forms are all recognised and play immediately.

`npm test` compiles and runs the unit tests over the demuxer and the YouTube parsers.

## How it works

The obvious approach — embedding YouTube's own player — cannot make a sound here. VS Code's
Electron ships a trimmed ffmpeg with no Opus or AAC decoder, so every embedded video fails with
the same silent error. So the extension fetches the raw adaptive streams itself and splits the
two tracks down separate paths:

- **Picture.** A video-only H.264 track, which this build does decode. Its URL goes straight to
  a `<video>` element in the webview, which seeks and buffers it natively.
- **Sound.** A separate Opus track. The extension host streams it, pulls the Opus packets out of
  the WebM container (`webm.ts`), and posts them to the webview, where a WebAssembly libopus
  decodes them and WebAudio plays the PCM. The `<video>` element stays the clock; the sound
  re-pins itself to it whenever the two drift apart.
- **Search and channels** go through the same public endpoint the YouTube web client uses. No API
  key, no quota, no setup.

Nothing is written to disk, and nothing is fetched further ahead than what is being watched — the
feed keeps about fifteen seconds of audio in front of the playhead and then waits. Pause the video
and it stops pulling within seconds.

The view is registered with `retainContextWhenHidden`, so audio keeps playing while the panel is
collapsed or another panel tab is focused. While something is playing, the status bar carries its
title and doubles as a play/pause button — reachable from the palette too, as **Player: Play /
Pause**.

The sidebar remembers the last 50 videos watched and how far each got, so a half-watched video
picks up where it was left. That list lives in the extension's `globalState`, is a few kilobytes
all told, and **Clear** empties it.

## Known ceilings

These are properties of the platform, not missing features:

- **Live streams are not supported.** They are served as segmented DASH, which this single-URL,
  byte-range reader does not speak.
- **No sign-in**, so members-only videos, purchases and anything else tied to an account are out
  of reach. Age-restricted videos usually are too.
- **Streams needing deciphering are refused** rather than played. The extension asks YouTube as
  the `ANDROID_VR` client, which still hands out directly fetchable URLs; when that stops being
  true, evaluating YouTube's signature JavaScript would be the only way on.
- **1080p is the ceiling**, and H.264 is preferred over VP9 and AV1 wherever both are offered —
  it is the one codec this build is certain to decode.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `player.language` | `tr` | Search language (`hl`) |
| `player.region` | `TR` | Search region (`gl`) |
