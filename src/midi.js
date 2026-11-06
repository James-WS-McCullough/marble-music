// Minimal Standard MIDI File parser -> [{ t, midi, vel, ch }]. Handles format 0/1,
// running status and tempo changes. (SMPTE time division isn't supported.)

export function parseMidi(buffer) {
  const d = new DataView(buffer);
  let p = 0;
  const u8 = () => d.getUint8(p++);
  const u16 = () => { const v = d.getUint16(p); p += 2; return v; };
  const u32 = () => { const v = d.getUint32(p); p += 4; return v; };
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8()); return s; };
  const vlq = () => { let v = 0, b; do { b = u8(); v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };

  if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = u32();
  u16(); // format
  const ntracks = u16();
  const division = u16();
  p = 8 + hlen;
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');

  const events = [];
  let seq = 0;
  for (let tr = 0; tr < ntracks && p < d.byteLength; tr++) {
    const id = str(4);
    const tlen = u32();
    const end = p + tlen;
    if (id !== 'MTrk') { p = end; continue; }
    let tick = 0, running = 0;
    while (p < end) {
      tick += vlq();
      let st = d.getUint8(p);
      if (st & 0x80) p++;
      else st = running;
      if (st === 0xff) {
        const type = u8();
        const l = vlq();
        if (type === 0x51 && l === 3) {
          const tempo = (d.getUint8(p) << 16) | (d.getUint8(p + 1) << 8) | d.getUint8(p + 2);
          events.push({ tick, tempo, seq: seq++ });
        }
        p += l;
      } else if (st === 0xf0 || st === 0xf7) {
        p += vlq();
      } else {
        running = st;
        const hi = st & 0xf0, ch = st & 0x0f;
        const a = u8();
        const b = hi === 0xc0 || hi === 0xd0 ? 0 : u8();
        if (hi === 0x90 && b > 0) events.push({ tick, note: a, vel: b / 127, ch, seq: seq++ });
        else if (hi === 0x80 || (hi === 0x90 && b === 0)) events.push({ tick, off: true, note: a, ch, seq: seq++ });
      }
    }
    p = end;
  }

  // Tempo events first at equal ticks, then convert ticks -> seconds through the tempo map.
  events.sort((x, y) => x.tick - y.tick || (y.tempo !== undefined) - (x.tempo !== undefined) || x.seq - y.seq);
  let tempo = 500000, lastTick = 0, sec = 0;
  const notes = [];
  const open = new Map(); // "ch:note" -> note waiting for its note-off
  for (const e of events) {
    sec += ((e.tick - lastTick) * tempo) / 1e6 / division;
    lastTick = e.tick;
    if (e.tempo !== undefined) tempo = e.tempo;
    else if (e.off) {
      const n = open.get(`${e.ch}:${e.note}`);
      if (n) { n.dur = Math.max(0.03, sec - n.t); open.delete(`${e.ch}:${e.note}`); }
    } else {
      const n = { t: sec, dur: 0.25, midi: e.note, vel: e.vel, ch: e.ch };
      open.set(`${e.ch}:${e.note}`, n);
      notes.push(n);
    }
  }
  return notes;
}
