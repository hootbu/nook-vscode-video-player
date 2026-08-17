import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickQuality, VideoOption } from '../stream';

function option(height: number, codec = 'H.264'): VideoOption {
  return {
    height,
    label: `${height}p`,
    codec,
    mime: codec === 'H.264' ? 'video/mp4; codecs="avc1.4d401f"' : 'video/webm; codecs="vp9"',
    url: `https://example.test/${height}`
  };
}

// Tallest first, the order collectVideos hands them over in.
const offered = [option(1080), option(720), option(360), option(144)];

test('picks the tallest track the ceiling allows', () => {
  assert.equal(pickQuality(offered, 1080).height, 1080);
  assert.equal(pickQuality(offered, 720).height, 720);
  // Nothing is offered at exactly this height, so it steps down rather than up.
  assert.equal(pickQuality(offered, 480).height, 360);
});

test('a ceiling below everything offered still yields a picture', () => {
  assert.equal(pickQuality(offered, 100).height, 144);
});

test('a video offering one track hands it back whatever the ceiling', () => {
  assert.equal(pickQuality([option(240)], 1080).height, 240);
  assert.equal(pickQuality([option(240)], 144).height, 240);
});

test('a shorter H.264 track beats a taller one the element cannot decode', () => {
  // What YouTube often offers: the top heights in VP9 or AV1 only, H.264 further down. Taking the
  // tallest would leave the <video> element rejecting the source outright.
  const mixed = [option(1080, 'VP9'), option(720, 'AV1'), option(480), option(360)];

  assert.equal(pickQuality(mixed, 1080).height, 480);
  assert.equal(pickQuality(mixed, 720).height, 480);
  assert.equal(pickQuality(mixed, 400).height, 360);
});

test('a video with no H.264 at all still gets a picture', () => {
  const none = [option(1080, 'VP9'), option(720, 'AV1'), option(360, 'VP9')];

  // Nothing decodable is on offer, so the ceiling is all there is to go on and the menu is where
  // the viewer picks something else.
  assert.equal(pickQuality(none, 720).height, 720);
  assert.equal(pickQuality(none, 200).height, 360);
});
