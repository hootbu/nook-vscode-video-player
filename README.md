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

## How it works

- **Search** goes through the same public endpoint the YouTube web client uses, called from the
  extension host. No API key, no quota, no setup.
- **Playback** uses the official IFrame Player API against `youtube-nocookie.com`. Videos whose
  owners disabled embedding cannot play here; those fall back to opening in the browser.
- The view is registered with `retainContextWhenHidden`, so audio keeps playing while the panel
  is collapsed or another panel tab is focused.

## Known ceilings

These are properties of the platform, not missing features:

- **The full site cannot be embedded.** `youtube.com` sends `x-frame-options: SAMEORIGIN`; only
  `/embed/` is frameable.
- **Ads cannot be blocked.** The player runs in a cross-origin iframe, and VS Code gives
  extensions no request-interception API for webview traffic. Embedded playback does tend to
  carry fewer ads than the watch page.
- **The webview has its own storage partition**, so a browser sign-in — including Premium —
  does not carry over to the player.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `player.language` | `tr` | Search language (`hl`) |
| `player.region` | `TR` | Search region (`gl`) |
