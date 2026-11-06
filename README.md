# Marble Music

Procedurally generated marble-run music videos with a retro chiptune sound. Two marbles
bounce diagonally across a big painted wall (clouds, pipes, pixel-art sprites) off chunky
keys, bars, drums and cymbals, and every hit lands exactly on a note. A close follow camera
keeps the shot sparse: only a handful of pads are on screen at once. The first marble plays the melody (with any other notes as chords);
the second plays either the harmony/bass or the percussion. Every sound you hear has an object
you can see. At the bottom the marbles roll into gutters, ride lifts back up, and it loops.

## Sound fonts

All sounds are synthesised in `src/audio.js` — no samples ripped from games. Each font
imitates a console's sound *hardware*:

- **NES (2A03-style)** — 12.5/25/50% pulse waves with a 2-frame "bite" on each attack,
  4-bit stepped triangle bass, LFSR noise + triangle-drop drums, 60 Hz stepped envelopes with
  short releases, delayed vibrato, a hand-made-style pulse echo, chords played as fast
  2-frame arpeggios, and the console's gentle output filtering.
- **SNES (SPC700-style)** — 32 kHz looped sampled instruments (reedy flute lead chorused
  left/right, string pad, picked bass, harp chords), click-free loop points, hardware-style
  exponential ADSR, soft Gaussian-ish top end and a stereo ping-pong echo.
- **Genesis (YM2612-style FM)** — 2-operator FM brass lead, slap bass, FM e-piano, crunchy
  low-bit PCM drums.
- **Marimba / Glockenspiel / Vibraphone (original)** — every note on one acoustic mallet
  instrument built from decaying sine partials, with acoustic drums.
- **Acoustic ensemble** — marimba lead with vibraphone harmony.

Load any MIDI file to remix it in these styles. Open `test/audio-check.html` to audition the
fonts on a short phrase.

## Run

```sh
npm start          # serves on http://localhost:8080 (no-cache python server)
npm test           # the full test suite (~1.5 min)
npm run test:quick # music, MIDI, physics and audio only (seconds)
```

Click to start (browsers need a click before playing audio). Pick a built-in song, roll a
procedural one with 🎲, or load your own `.mid` file. `Space` pauses, `H` hides the panel.
Preview URLs: `?song=ode&cam=overview&t=12` freezes the scene at loop time 12s.

## How it works

The trick is to work **backwards from the music** instead of simulating forwards and hoping:

1. **Notes → parts → hits** (`src/music.js`). The song is split into two marbles: the melody
   (a lone piano part is split into tune + accompaniment) and harmony or percussion. Notes that are (nearly) simultaneous within a part merge into one hit (a chord
   becomes several narrow keys side by side).
2. **Hits → course** (`src/planner.js`). A **beam search**: at every note, the best ~10
   candidate courses so far are each extended by their few best next steps, and the best
   10 survive. Every candidate step must pass the **hard rules** (no clipping, no launch,
   the speed cap, a real head-on hit); costs only express taste (follow the route, spacing,
   bounce style). A candidate heading into a dead end simply loses to one that turned
   earlier. Steps all candidates agree on are committed once they're 16 notes back. If every
   candidate dies, the search backs up a few notes and searches that stretch with a wider
   beam (up to the whole open window); only if that fails is a compromise allowed (and
   marked). A marble whose plan still needs one is planned again with small variations.
   Between two hits a marble either:
   - **bounces**: we try a grid of places for the next pad (along the route, zig-zagging
     across it, or dropping nearly straight down) and many drop heights, and solve
     `v = (Δp + ½·g·dt²·ŷ) / dt` for the launch velocity that arrives exactly `dt` later.
   - **speed limit**: the marble never moves faster than the chosen pace (Calm 2.3 m/s by
     default, Lively 3, Fast 4) so the eye can follow it. Gravity is scaled to 6 m/s², like
     filming a bigger-scale model: motion stays consistent but calmer. Long gaps use short
     ramps instead of big falls, and very quick notes get closer pads (a quick double-tap).
     A slower pace means pads sit closer together; a faster one spreads them out.
   - **momentum**: a pad never sends the marble off more than 15% faster than it arrived
     (losing speed looks like a natural bounce; gaining it looks like a launch).
   - Pads may also face sideways (to catch up by bouncing left-right down a chain) or, rarely,
     downward (bouncing off the underside of a note) to escape tight spots.
   - **rolls**, for long gaps or to let a marble that has fallen behind catch up: the pad kicks
     the marble so it drops onto an open rail at a natural angle (~20–30°): on impact it keeps
     most of its speed along the rail and loses most of it into the rail, settling with a
     couple of small hops before rolling under gravity with rolling drag; then it drops off
     the end onto the next note. (The end gutter catches the marble the same way.) Straight
     ramps are open rails; the U-bends of a ramp that loops back are inside a clear **glass
     tube** — the marble either flies cleanly into its mouth, or drops onto an open rail
     first and rolls into the tube before the first bend. The ramp length is chosen so the
     timing is exact.
   - **no clipping**: pads, tubes, rails and the support brackets that run back to the wall
     (through the lane behind) must never overlap, and a marble never passes through anything
     it isn't touching, and no pad is put on a spot an earlier flight passes through.
     `test/clip-check.js` verifies the finished course independently of the planner.
   The first marble follows a **route** that sweeps diagonally down the wall (left, then
   right, ...). The route's speed follows how busy the music is right now, so pads are
   roughly evenly spaced and the route nearly waits during rests. The second marble
   **chases the first marble** (its smoothed path, a little below it) rather than the
   route, so the two stay together. A marble that falls behind catches up by bouncing
   left-right down a chain of angled pads (and long rests can use steeper or compact
   switchback ramps). In fast runs the pads shrink, like a glockenspiel. A part that
   starts later leaves its lift part-way down. The camera frames only marbles that are
   playing, so one resting through a long gap doesn't drag the shot away.
3. **Pad orientation**: each pad's normal is `normalize(v_out − v_in)` — the mirror that
   reflects the incoming velocity into the required outgoing one.
4. **Two looks**: the front marble's course is silver chrome with dark slate pads and a
   silver marble; the back marble's is brass with warm wood pads and a gold marble.
5. **Rendering & audio** (`src/main.js`, `src/audio.js`). Three.js draws the wall, lanes and
   decorations (pixel sprites bob on the beat); the Web Audio synth schedules every note on
   the AudioContext clock, which also drives the
   animation, so sound and visuals stay locked.

## Tests

`npm test` runs everything with Node's built-in test runner:

- `test/music.test.js` — note names, the song notation, built-in and procedural songs,
  grouping notes into hits, splitting a song between the two marbles.
- `test/midi.test.js` — MIDI parsing from hand-built files (tempo changes, running status,
  note-offs, several tracks).
- `test/physics.test.js` — track paths, flights, rolling, switchbacks, dropping onto a rail.
- `test/audio.test.js` — every sound font rendered offline (`node-web-audio-api`): every voice
  sounds, nothing is NaN or clipping, notes are in tune.
- `test/course.test.js` — the course contract for built-in, procedural and awkward
  MIDI-shaped stress songs (`test/stress-songs.js`): every note played once at its moment,
  continuous looping path, real head-on bounces, no launches, the speed cap, no clipping,
  tubes only where a ramp loops back, the marbles together, no compromises, determinism,
  other paces, and a planning-time guard.

"Export JSON" downloads the full course (pads, normals, times, notes, ramp paths), e.g. to
rebuild it in Blender for an offline high-quality render.
