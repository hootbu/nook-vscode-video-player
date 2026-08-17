const { PlayerServer } = require('./out/server.js');
(async () => {
  const s = new PlayerServer(); await s.start();
  const t0 = Date.now();
  const pb = await s.load(process.argv[2] || 'jNQXAC9IVRw');
  console.log('load', Date.now()-t0, 'ms', pb);
  const a = await fetch(pb.audio, { headers: { Range: 'bytes=0-99' } });
  const ab = Buffer.from(await a.arrayBuffer());
  console.log('audio', a.status, a.headers.get('content-range'), a.headers.get('content-length'), ab.subarray(0,4).toString(), ab.subarray(8,12).toString(), 'sr', ab.readUInt32LE(24), 'ch', ab.readUInt16LE(22));
  const v = await fetch(pb.video, { headers: { Range: 'bytes=0-1023' } });
  const vb = Buffer.from(await v.arrayBuffer());
  console.log('video', v.status, v.headers.get('content-type'), v.headers.get('content-range'), vb.length, vb.subarray(4,8).toString());
  // full audio, measure time & non-silence
  const t1 = Date.now();
  const full = await fetch(pb.audio); const fb = Buffer.from(await full.arrayBuffer());
  let nz = 0; for (let i = 44; i < fb.length; i += 2) if (fb.readInt16LE(i) !== 0) nz++;
  console.log('full audio', full.status, fb.length, 'bytes in', Date.now()-t1, 'ms; nonzero samples', nz, 'of', (fb.length-44)/2);
  require('fs').writeFileSync(process.env.OUT || '/dev/null', fb);
  s.dispose(); process.exit(0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
