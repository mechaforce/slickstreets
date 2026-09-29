# Slick Streets

A top-down driving game. You have a car, a city, and an unreasonable number of
zombies and skeletons who all want to be where you are.

**[Play the standalone build](dist/slick-streets.html)** — one file, no server,
open it in a browser.

## The idea

The horde is not an obstacle course, it is a fluid. It flows around the car,
piles up on the leading edge, and drags you down. Everything in the game comes
out of that:

- **Density slows you.** The more of them are pressed against the car, the more
  drag they apply and the lower your top speed gets. A thick enough crowd is a
  wall.
- **Stopping kills you.** Below a certain speed you stop running them over and
  they start pulling you out of the car. You have a handful of seconds.
- **Two gears, and the choice matters.**
  - `HIGH` — 125 km/h and long legs, but almost no torque off the line. It is
    the gear you cover ground in, and the gear that gets you killed if a crowd
    brings you to a halt.
  - `LOW` — tops out early, but pulls hard from a standstill. It is the only
    thing that will drag you out of a swarm that has already stopped you.
- **The gore stays.** Bodies burst into chunks that live on the road as real
  objects. Drive through a pile and you shove it aside, which leaves a cleared
  channel through the mess — the trail you carved is visible behind you, and it
  is the map of where you have already been.
- **And the blood is wet.** What comes out of them is simulated as a fluid: it
  pools, it flows, it gets dragged along by your tyres and thrown by a spinning
  wheel. It is also *slippery*. Kill enough of them in one place and the road
  stops gripping — the nose comes round while the car keeps going the way it
  was already going. Your tyres pick the blood up and trail it away behind you
  until they run clean.
- **Burnouts.** Throttle and brake together (`W`+`S`, or hold the gear button
  on touch) holds the car on the brakes and lights the tyres up. In a pool of
  blood that throws a rooster tail of it across the street and paints the road
  where you sat.

Zombies are slow, heavy and clog the car. Skeletons are quick and brittle: they
die at lower speed but they reach you first and claw harder.

## Upgrades

Crates sit out on the road all over the city — roughly 320 of them, marked on
the minimap in their own colour. Drive over one and it bolts on for about 25
seconds, then falls off again. Collecting one puts a replacement somewhere far
away, so the map never runs dry and there is always somewhere to be going.

| | |
|---|---|
| **Barbed wire** | Anything touching the bodywork tears itself open on it — a chance per second of being shredded, whatever your speed. Also halves what the ones still clinging on can do to you, which makes it the upgrade that saves you when you have already been stopped. |
| **Big wheels** | Widens the crushing footprint to 1.75× without widening the car, so you clear a much broader path through the horde and still fit down the same streets. |
| **Flamethrower** | Every 3–5 seconds it sprays a cone off the nose and burns everything in it, whatever your speed. What it kills leaves charred remains and black scorch marks instead of blood, so you can read where you have used it. |

## Controls

### Touch

The controls appear by themselves on anything with a touchscreen, and hide
again the moment you touch a key.

- **Joystick, anywhere in the lower third.** It plants itself wherever your
  thumb lands rather than sitting in a fixed spot you have to find. Push where
  you want the car to go and it steers itself there; how far you push is how
  much throttle. Pull back to brake, and keep pulling to reverse — once you are
  actually rolling backwards the steering mirrors, so the tail follows the
  stick.
- **Gear button, bottom right.** Shows the gear you are in, in that gear's
  colour. Tap to change.
- **Pause, top centre.**

On a touchscreen the HUD rearranges around your thumbs: the minimap moves to
the top right and the speedometer to the bottom centre, so both bottom corners
are free. Everything scales down on a small screen without shrinking the
buttons below a comfortable target.

### Keyboard

| Key | |
|---|---|
| `W` / `↑` | throttle |
| `S` / `↓` | brake, then reverse |
| `A` `D` / `←` `→` | steer |
| `Space` or `Shift` | change gear |
| `P` | pause |
| `M` | mute |
| `Enter` | start, or restart after dying |
| `R` | restart mid-run |

## Running it

The standalone build in `dist/` opens straight from disk. To run from source
(ES modules need a server, not `file://`):

```sh
python3 -m http.server 8000    # then open http://localhost:8000
```

Rebuild the standalone file after changing anything under `js/`:

```sh
node tools/build-standalone.mjs
```

## Tests

```sh
npm test
```

The simulation is deliberately free of any DOM or canvas reference, so the
whole game can be played headlessly. The suite drives it that way: it asserts
the gearbox actually behaves the way the design claims (low gear escapes a
full swarm, high gear bogs down in one), that a crowd is lethal but escapable
rather than instantly fatal, that the car shoves gore aside instead of driving
through it, and that a scripted bot can survive and rack up kills. It also
holds the sim to a frame budget with a couple of thousand enemies alive.

The upgrades are covered the same way: that crates are spread across the whole
map and never buried in a building, that driving over one arms it and restocks
the map, that the wire both shreds and blunts, that the big wheels crush
something the bare car misses while the car itself stays the same size, and
that the flamethrower burns a cone off the nose — and nothing behind it,
beside it, or out of range — on a 3-5 second cadence.

The joystick's mapping from stick deflection to throttle and steering is a
pure function too, so the tests cover the deadzone, proportional steering,
braking, the mirrored steering while reversing, and that holding the stick in
a direction really does bring the car round to that heading.

The blood gets the same treatment: that the fluid carries blood the way it is
pushed and not evenly in all directions, that a clean road is free and a pool
dries up, that only the bloody part of the grid is woken, that the scrolling
window keeps blood at the world position it was spilt at, that a slick road
makes the car slide where a dry one does not, that low gear can break traction
on blood where high gear cannot, and that a burnout spins the car on the spot
while throwing blood and laying rubber.

## Layout

```
js/
  util.js          maths, seeded RNG
  spatialhash.js   uniform grid behind every neighbour query
  city.js          procedural city, collision
  car.js           pure arcade physics and the gearbox
  enemies.js       the horde: pooling, steering, separation, spawning
  gore.js          pushable chunks
  fluid.js         the wet blood: a small stable-fluid solver
  pickups.js       upgrade crates scattered over the map
  game.js          owns the world, steps it, emits events
  sprites.js       every sprite drawn once into an offscreen canvas
  render.js        camera, pseudo-3D city, decal-baked blood, HUD
  input.js         keyboard
  touch.js         joystick and buttons, with a pure stick-to-controls map
  audio.js         procedural sound, no asset files
  main.js          boot and the fixed-timestep loop
tools/
  build-standalone.mjs   bundles the modules into dist/
test/
  sim.test.mjs     headless simulation tests
  bot.mjs          scripted driver used by the tests
```

`game.js` and everything it imports never touch the DOM. The renderer reads the
simulation; the simulation never calls the renderer. That split is what makes
the tests above possible.

## The blood

There are two separate layers of it, doing different jobs.

**Wet blood** is a light 2D fluid — semi-Lagrangian advection with a few
Gauss-Seidel pressure iterations, in the style of Stam's stable fluids. It runs
on a 128×128 grid that scrolls with the car, covering about 2300px of city, at
half the simulation rate. The pressure solve is what gives a smear its swirl
rather than making it a blur. This layer is the one the car interacts with: the
tyres drag it, pick it up and throw it, and its depth under the car is what
decides how much grip you have.

Cost is kept off the clock by only simulating the part of the grid that has
blood in it: a clean road costs nothing measurable, a normal trail about 0.1ms
per step, and the worst case — the whole window slick — about 2ms at 30Hz.

**Dried blood** is the permanent record, baked into half-resolution decal
tiles: splatter where they burst, and tyre marks laid at a fixed spacing along
the ground while your tyres are still carrying blood. Wet blood that scrolls
out of the fluid window is already written there, so the trail survives even
though the simulation has long since forgotten it.

## Performance notes

Roughly 2,600 enemies can be alive at once, so the hot paths are written for it:
pooled objects with no per-frame allocation, a spatial hash rebuilt each frame,
capped neighbour scans, and a cheap update tier for anything far off screen.
Gore chunks park themselves once they stop moving and are skipped entirely until
something disturbs them again. Blood is baked into half-resolution decal tiles
so the trail survives long after the chunks that made it have been recycled.
The simulation costs about 3ms per frame with 2,000 enemies on screen.
