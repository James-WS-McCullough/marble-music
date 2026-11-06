# Marble Music

Procedurally generated marble-run music videos. Two marbles
bounce diagonally across a big painted wall (clouds, pipes, pixel-art sprites) off chunky
keys, bars, drums and cymbals, and every hit lands exactly on a note. A close follow camera
keeps the shot sparse: only a handful of pads are on screen at once. The first marble plays the melody (with any other notes as chords);
the second plays either the harmony/bass or the percussion. Every sound you hear has an object
you can see. At the bottom the marbles roll into gutters, ride lifts back up, and it loops.

## Sounds

All sounds are synthesised in `src/audio.js` (no samples). There are no sound fonts: **each
object has its own voice**, so what you hear always matches what the marble hits: keys and
wooden bars are a marimba, arcade buttons blip, metal tubes ring like tubular bells, bamboo
knocks, bottles ping, neon tubes buzz, handbells chime, e-piano keys and vinyl records play a
warm Rhodes-style electric piano, and drums are an acoustic kit or woodblocks & cowbells.
Open `test/audio-check.html` to audition every voice on a short phrase.

## Lofi

**Lofi (from seed)** composes a laid-back lofi tune: jazzy 7th/9th chord progressions with
smooth voice leading on vinyl records (the back marble), a swung pentatonic melody on e-piano
keys that repeats with small variations (the front marble), and a dusty boom-bap beat in the
background. The structure is played by **switch blocks** on the melody track — levers the
marble flips as it passes: the intro is muffled behind a closed low-pass filter with vinyl
crackle, a switch drops the beat in and opens the filter, another closes it for a dip and
reopens it, and the outro takes the beat out and muffles it again (so the loop's ends match).
The picture goes soft and warm while the filter is closed. Pick the **Lofi bedroom** theme
(dusky wallpaper, framed pictures, potted plants, twinkling fairy lights).

**Endless lofi ∞** keeps going: while one song plays, the next is composed and planned in a
background worker, and it takes over exactly at a loop seam (`src/timeline.js` keeps the
songs on one clock). If the next one isn't ready in time, the current song simply loops again.

## Settings

Under **Settings**: camera zoom (the seam shot stays fixed so the loop stays seamless),
brightness, glow (bloom), decoration density, volume, and whether the lofi switch effects
(filter, crackle) apply.

## Run

```sh
npm start          # serves on http://localhost:8080 (no-cache python server)
npm test           # the full test suite (~2.5 min)
npm run test:quick # music, MIDI, physics and audio only (seconds)
```

Choose what each marble plays on — **Melody plays on** and **Harmony / bass plays on**:
keys (melody) or wooden bars (harmony), **arcade buttons** (flash, electric blip), **metal
chime tubes** (shimmer, tubular bell), **bamboo tubes** sticking out of the wall (hollow
knock), **glass bottles** with coloured water (sloshes, glassy ping), **neon light tubes**
(glow and flare, buzzy synth) or **handbells** (swing, bright bell) — or *Mix by song
section*, which changes instrument with the song's structure (a repeated tune comes back on
the same instrument). **Drums play on** the drum kit, **woodblocks & cowbells**, or both by
section. Each object's sound follows what you see.

Pick a **theme** (Sky, Spooky — a moonlit purple stone wall with ghosts, bats, pumpkins
and flickering candles — Lab, a grey-panelled test lab with light panels, hazard plates
and indicator lights that blink on the beat — or Lofi bedroom). Courses are planned in a background worker
with a progress spinner, so the page never freezes.

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
5. **Seamless loop**: the first marble rolls out of a short pipe stub at the start and into
   an identical stub at the end. Both stubs sit in reserved "seam frames" (a sign with the
   song title behind, the same rails in and out, nothing else), and the camera is a pure
   function of loop time (`src/camera.js`) that frames both from exactly the same offset —
   so the last frame matches the first and it looks like the marble passed through one
   short pipe. The second marble is tucked into its own stub before the loop point.
6. **Rendering & audio** (`src/main.js`, `src/audio.js`). Three.js draws the wall, lanes and
   decorations (pixel sprites bob on the beat); the Web Audio synth schedules every note on
   the AudioContext clock, which also drives the
   animation, so sound and visuals stay locked.

## Tests

`npm test` runs everything with Node's built-in test runner:

- `test/music.test.js` — note names, the song notation, built-in, procedural and lofi songs
  (structure, switch blocks), grouping notes into hits, splitting a song between the marbles.
- `test/timeline.test.js` — endless play: songs hand over exactly at a loop seam, every event
  is scheduled once, the beat only plays while switched on.
- `test/midi.test.js` — MIDI parsing from hand-built files (tempo changes, running status,
  note-offs, several tracks).
- `test/physics.test.js` — track paths, flights, rolling, switchbacks, dropping onto a rail.
- `test/audio.test.js` — every object's voice rendered offline (`node-web-audio-api`): it
  sounds, nothing is NaN or clipping, notes are in tune; the lofi beat, filter and crackle.
- `test/camera.test.js` — the camera: the loop's first and last shots are identical (at any
  screen shape), the seam shot stays inside its sign, and the camera never jumps.
- `test/course.test.js` — the course contract for built-in, procedural and awkward
  MIDI-shaped stress songs (`test/stress-songs.js`): every note played once at its moment,
  continuous looping path, real head-on bounces, no launches, the speed cap, no clipping,
  tubes only where a ramp loops back, the marbles together, no compromises, the seamless
  loop (marbles hidden at the seam, identical seam frames), the worker hand-off, determinism,
  other paces, and a planning-time guard.

"Export JSON" downloads the full course (pads, normals, times, notes, ramp paths), e.g. to
rebuild it in Blender for an offline high-quality render.
