import type { Innertube } from 'youtubei.js' with { 'resolution-mode': 'import' };

let client: Promise<Innertube> | undefined;

/**
 * One session for the whole extension. YouTube issues a visitor id per session and a locally
 * generated one trips its bot check, so the session is left to fetch a real one — and asking for
 * several sessions only makes that check more likely, not less.
 *
 * The player script is skipped: ANDROID_VR stream URLs need no signature or n-parameter transform,
 * and deciphering would require a JS evaluator.
 */
export function innertube(): Promise<Innertube> {
  client ??= import('youtubei.js').then(({ Innertube, Log }) => {
    Log.setLevel(Log.Level.NONE);
    return Innertube.create({ retrieve_player: false });
  });
  return client;
}
