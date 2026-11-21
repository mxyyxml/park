# Skyline Runner

A first-person freerunning game for the browser: momentum-driven parkour across a procedurally generated rooftop district of white concrete, glass and red steel. It's built with Three.js and TypeScript, with no external assets. Every texture, model, animation and sound is generated in code at startup.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # movement physics, camera, level generation, trial validation
npm run build      # type-check + production build into dist/
```

Click to capture the mouse. Esc pauses. The game also supports a gamepad (standard mapping).

## How to play

**Goal:** run across the rooftops without falling. Speed is everything: the longer you sprint in a straight line, the faster you go and the further you jump. Falling to the street (or landing from too high without rolling) sends you back to your last checkpoint.

1. Open the game and click **Free Run** to explore, or **Time Trials** to race a route.
2. Click the game view so it captures the mouse. Press **Esc** to pause.
3. Hold **Shift + W** to sprint and build speed. Press **Space** at a roof edge to jump the gap.
4. **Space** is "up": it jumps, runs along a wall if you jump at it from the side, climbs a wall you run straight at, grabs and pulls up ledges, and vaults low obstacles.
5. **Ctrl** (or **C**) is "down": slide under things at speed, and press it just before a big landing to **roll** and keep your speed.
6. In time trials, follow the red beam and the marker to each checkpoint. Your best run becomes a red **ghost** to race next time. **R** restarts instantly.

Tips: hit walls at a shallow angle to wall-run; red objects (pipes, ladders, beams, crates) are climbable routes; hold W while falling toward a ledge to grab it; on balance beams, steer with A/D to stay upright.

## Controls

| Action | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Move | W A S D | Left stick |
| Sprint (builds momentum) | Shift | L3 / RT / full stick |
| Walk | X / Alt | light stick |
| **Up**: jump, wall-run, wall-climb, grab, vault, pull up | Space / LMB | A / LB |
| **Down**: crouch, slide, roll (press just before landing), drop | Ctrl / C / RMB | B / LT / RB |
| Quick turn (and jump during a wall-climb to spin off) | Q | X |
| Restart trial | R | Back |
| Debug overlay | F3 | |

## What's in the game

### Movement (`src/player/PlayerController.ts`)
The controller is a fixed-step (120 Hz) kinematic simulation with one shared velocity vector, so momentum carries between every state:

- **Ground:** walk, jog, and sprint with *flow*: top speed builds over about 1.5 s of straight running. Acceleration tapers as speed rises, turn rate drops with speed (carving costs speed), reversing at speed skids, surfaces have different friction (glass is slippery, gravel grippy), and it steps over curbs.
- **Jumps:** speed feeds jump distance, with a small boost for jumping from the lip of an edge. Coyote time and input buffering are included. Holding the button gives a slightly fuller arc. Air control can steer but never adds speed.
- **Landings:** impact is computed from vertical speed:
  - soft landing,
  - speed-loss landing,
  - a hard landing that makes you stumble,
  - a roll if Down was pressed within the window (keeps your speed, can be steered and jumped out of),
  - a fatal fall.
- **Wall-run:** needs entry speed, a shallow angle, a tall enough surface and runnable length ahead. Duration depends on entry speed *and* available wall. It rises then sags, and you can wall-jump off with an optional view assist.
- **Wall-climb:** run at a wall head-on and press Up; the height reached scales with approach speed. It flows into a ledge grab or mantle, and pressing Up again does the 180° wall-climb turn-jump.
- **Ledges:** automatic ledge grab and cat leap, hang, shimmy along the ledge, pull up, drop, or jump off backwards. Low ledges become a quick mantle.
- **Vaults:** speed vault and kong vault keep your momentum, and deep obstacles become a step-up or mantle. Auto-vaults never throw you over a railing into a drop.
- **Other:** slides (conserve speed, fit under 1 m obstacles), crouching, pipes and ladders (including mounting the top), zip lines (gravity-driven speed), balance beams (sway you correct with strafe), and a quick 180° turn.

Collision is a vertical cylinder against axis-aligned boxes in a spatial hash, with sub-stepped sweeps so nothing tunnels at speed (`src/physics/collision.ts`).

### Body and camera
- `src/player/Body.ts` is a procedurally modelled full body: jacket sleeves with red cuffs, gloved hands with articulated fingers, cargo pants, and detailed sneakers. It's animated with two-bone IK. Hands reach for the real contact points (ledges, vault obstacles, the wall beside you while wall-running, pipes, zip lines). Feet follow the simulation's stride phase, so visible steps, footstep sounds and head bob stay in sync. Look down to see your legs and torso.
- `src/player/CameraRig.ts` drives the camera from the body:
  - eye height follows posture through stable sub-stepped springs;
  - landings compress the spine in proportion to impact; jumps get an anticipation dip;
  - gait bob and sway, speed-dependent FOV, and strafe lean;
  - wall-run head roll, a full somersault during rolls, and pitch on vaults and pull-ups;
  - trauma-based shake for hard hits only.

  Every amplitude scales with the *Camera motion* comfort setting.

### City (`src/world/`)
- `city.ts` deterministically generates a 4×3-block district:
  - Blocks are split into lots separated by alleys from 0 to 7 m wide.
  - Edges facing the street get parapets or glass railings; alley edges stay open for jumps.
  - Crossing points include sky-bridges with glass rails, zip lines, steel I-beams, wall-run billboards over wide alleys, ladders, red springboard crates and climbable drain pipes.
  - The roof run-up lanes stay clear of props.
- Set pieces:
  - **the Spire**, a 78 m tower climbed by a switchback of cantilevered platforms;
  - **the Glass Office**, a gutted interior floor with desks to vault, a duct to slide under, a glass partition to wall-run and a stairwell to the roof;
  - **a construction site** with a tower crane whose jib is a balance walk across the street;
  - **a rooftop garden** block, **industrial** blocks, and a **glass campus**.
- Rooftop props (`props.ts`): AC units with fan grilles and louvres, vent stacks, stair housings with doors and lamps, water tanks on legs, skylights, solar arrays, duct runs, pipe racks, antennas with guy wires and beacons, satellite dishes, planters and trees, benches, cooling fans, chimneys and helipads.
- Beyond the district, a skyline of hundreds of towers with setbacks and a downtown cluster, streets with sidewalks, lamps and trees, and an elevated maglev viaduct.
- `Dynamic.ts`: drones, a passing maglev train, street traffic, bird flocks that scatter when you approach, steam vents, spinning fans, blinking beacons, cycling ad screens, and drifting clouds.

### Rendering (`src/render/`)
- PBR materials with procedural albedo, normal and roughness maps. Textures include formwork concrete with tie holes and rain streaks, gravel, roofing membrane, brushed metal, wood, grass, asphalt, tiles, solar cells, cloth weave, and an ad atlas.
- A custom **facade shader** has four architectural styles: curtain wall, ribbon windows, punched windows, and fins. Its **interior-mapped rooms** show parallax floors, ceilings, walls, furniture bands and lamp-lit offices behind reflective glass. It antialiases by screen-space footprint.
- Lighting:
  - atmospheric sky and sun;
  - image-based lighting captured from the generated city;
  - a stable texel-snapped shadow map that follows the player;
  - height-dependent fog with sun in-scattering;
  - GTAO ambient occlusion, bloom, colour grading (split toning, contrast, vignette, speed-scaled edge fringe), ACES tone mapping and SMAA.
- Quality presets run from Low to Ultra.

### Audio (`src/audio/AudioEngine.ts`)
Everything is synthesized at startup:
- per-surface footsteps (concrete, gravel, metal, glass, wood, grass, rubber) that change with speed, plus cloth rustle;
- breathing driven by exertion;
- wind that rises with speed and altitude;
- landings scaled by impact, slide scrape, hand plants and grabs, zip-line whine;
- layered city ambience with traffic passes, distant horns and birds;
- spatial (HRTF) sources for drones, the train, steam and fans.

### Game (`src/game/`)
- **Free Run** across the whole district, with 12+ hidden **data shards** to collect.
- **Time Trials**: six routes generated over the level's traversal graph (First Light, Crosstown, Spire Ascent, Crane Line, Pipeworks, Glass Office). They have checkpoints, a countdown, splits against your personal best, gold/silver/bronze medals, and a **ghost** of your best run to race. You can instantly restart or respawn at a checkpoint.
- **Replays** of any run or PB, with cinematic chase, tracking and fixed cameras, played back at 0.25×, 1× or 2×. The main menu shows an attract mode: the autopilot runs the trials while cinematic cameras follow it.
- Settings: quality, FOV, sensitivity, invert Y, camera motion, wall-jump assist, volume, HUD toggles. They're saved locally along with times, ghosts and shards.

## Assets

Sculpted character assets are built in Blender from `tools/blender/sculpt_assets.py` (run with the `bpy` module: `pip install bpy`), then converted for the web with `tools/embed_gltf.py`:

- **hand**: skin-modifier fingers fused with a sculpted palm (voxel remesh + smoothing), knuckle bumps, joint creases, tendons and nails; fingerless glove pieces shrink-wrapped onto the surface; 16-bone rig (wrist, 3 per finger, 3 thumb) with distance-based skin weights. The game drives the finger bones from the grip system.
- **sleeves**: tapered tubes with fabric folds bunched at the elbow and wrist and a ribbed cuff.
- **shoe**: lofted upper with toe spring, heel collar, midsole, red outsole with cut tread, laces and eyelets.

Photoscanned assets are from [Poly Haven](https://polyhaven.com) (CC0), fetched by `tools/fetch_assets.py`: textures concrete_wall_001/006/008, bicolour_gravel and asphalt_02, and the exterior_aircon_unit model (two per rooftop AC plinth). If any asset fails to load, the game falls back to its procedural version.

`npm run build:page` produces the single-page build in `dist-artifact/` used for the shareable link; the files in `public/assets` are published next to it.

## How the levels are validated

`src/game/Bot.ts` is an autopilot that drives the **real** controller using only stick and button inputs. `tests/trials.test.ts` runs it through every time trial and asserts it reaches every checkpoint without dying. The game uses the same bot run (cached) to calibrate medal times. Making this pass exposed and fixed real gameplay bugs, including:
- roof lips killing jump momentum;
- auto-vaults over bridge railings;
- buffered jumps throwing you off pipes;
- a gap at the top of a staircase;
- wall-climbing thin poles;
- ledge probes hitting pipes instead of walls.

`tests/movement.test.ts` checks the movement model itself:
- sprint-jumps clear 5 m gaps but jogs don't;
- rolls survive drops that would otherwise stumble you;
- wall-runs carry you across a 10 m gap;
- vaults keep momentum, slides go under bars, pipes and zip lines work;
- there's no tunnelling at 40 m/s.

## Scope notes

The character's hands, sleeves and shoes are Blender-sculpted by script, not by an artist's hand; the head, torso and legs are still procedural meshes. Lighting uses image-based environment lighting, shadow maps and screen-space AO rather than true global illumination, and reflections use the captured environment map, not ray tracing. Performance has only been measured in a software (SwiftShader) renderer here. Expect much higher frame rates on a real GPU; use the quality presets to scale.
