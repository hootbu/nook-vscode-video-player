import type { Innertube, Player } from 'youtubei.js' with { 'resolution-mode': 'import' };

let client: Promise<Innertube> | undefined;
let player: Promise<Player> | undefined;

/**
 * One session for the whole extension. YouTube issues a visitor id per session and a locally
 * generated one trips its bot check, so the session is left to fetch a real one — and asking for
 * several sessions only makes that check more likely, not less.
 *
 * The player script is skipped: the primary client's stream URLs need no signature or n-parameter
 * transform, so it is only fetched if the fallback is ever needed (see `withPlayer`).
 */
export function innertube(): Promise<Innertube> {
  client ??= import('youtubei.js').then(({ Innertube, Log }) => {
    Log.setLevel(Log.Level.NONE);
    return Innertube.create({ retrieve_player: false });
  });
  return client;
}

/**
 * The same session with YouTube's player script attached, which the fallback client needs: its
 * URLs come signed, and `getInfo` sends the script's timestamp along so the signatures match.
 * The script is fetched once, on first use, and the deciphering functions youtubei.js extracts
 * from it are run directly — they arrive as a plain function body.
 */
export async function withPlayer(): Promise<Innertube> {
  const yt = await innertube();
  player ??= import('youtubei.js').then(({ Platform, Player }) => {
    Platform.shim.eval = (data) => new Function(data.output)();
    return Player.create(undefined);
  });
  yt.session.player = await player;
  return yt;
}
