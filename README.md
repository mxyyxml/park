# Skyline Runner

A first-person freerunning game for the browser: momentum-driven parkour across a procedurally generated rooftop district of white concrete, glass and red steel. It's built with Three.js and TypeScript, using procedural generation plus CC0 photoscans from Poly Haven (see Assets).

## Play it (no install, no npm)

**`play.html`** in this repo is the whole game in one file. It plays with no internet, needs no admin rights, and doesn't install anything.

1. On GitHub, open **`play.html`**. Make sure you're on the branch that has it: use the branch dropdown at the top left of the file list.
2. Click the **Download raw file** button (the ⬇ icon, top right of the file view). Or click **Code → Download ZIP** on the repo page, extract it, and use `play.html` from inside.
3. Double-click the downloaded `play.html`, or drag it into a Chrome or Edge tab.
4. Wait 10–30 seconds for it to load, click **Free Run**, then click the game to capture the mouse.

It works on Windows, Macs and Chromebooks. Chrome or Edge is best. On a slow laptop it starts on Low quality by itself. A red banner means the browser isn't using the graphics card; it tells you how to fix that.

Don't open `index.html`: that's the developer page and only works through npm.

## Developing

```bash
npm install
npm run dev        # http://localhost:5173
npm run build:play     # rebuild play.html (the one-file offline game)
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
5. **Mantle jump:** press **Space** again while you're climbing over a ledge or vaulting an obstacle to launch off the top with extra speed.
6. **Ctrl** (or **C**) is "down": slide under things at speed, and press it just before a big landing to **roll** and keep your speed.
7. In time trials, follow the red beam and the marker to each checkpoint. Your best run becomes a red **ghost** to race next time. **R** restarts instantly.

Tips: zip lines (red posts with a cable) run from high roofs down across streets and from the top of the Spire: jump at the cable from beside the start post to grab it, press Space or Ctrl to let go early; hit walls at a shallow angle to wall-run; red objects (pipes, ladders, beams, crates) are climbable routes; hold W while falling toward a ledge to grab it; on balance beams, steer with A/D to stay upright.

## Controls

| Action | Keyboard / mouse | Gamepad |
| --- | --- | --- |
| Move | W A S D | Left stick |
| Sprint (builds momentum) | Shift | L3 / RT / full stick |
| Walk | X / Alt | light stick |
| **Up**: jump, wall-run, wall-climb, grab, vault, pull up | Space / LMB | A / LB |
| **Down**: crouch, slide, roll (press just before landing), drop | Ctrl / C / RMB | B / LT / RB |
| Quick turn (and jump during a wall-climb to spin off) | Q | X |
| Kick (a dropkick when running, sliding or airborne) | F | Y |
| Grapple to a red ring on a tall roof edge (it lights up in range) | E / middle mouse | R3 |
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
- Street furniture from photoscans: fire hydrants, trash cans, concrete road barriers, barrel clusters on industrial roofs and potted plants in the garden and atrium. Brick facades mix in with concrete ones.
- `Terrain.ts`: a sculpted landscape around the city. Ridged-noise mountain ranges rise to the north-west with snow above ~800 m, rolling hills sit in between, and the south-east falls through a beach to an animated sea. It blends aerial grass, rock and sand scans by slope and height. It is scenery only, outside the playable district.
- `Dynamic.ts`: drones, a passing maglev train, street traffic, bird flocks that scatter when you approach, steam vents, spinning fans, blinking beacons, cycling ad screens, waving rooftop flags, wind-swayed foliage and drifting dust.

### Rendering (`src/render/`)
- PBR materials with procedural albedo, normal and roughness maps. Textures include formwork concrete with tie holes and rain streaks, gravel, roofing membrane, brushed metal, wood, grass, asphalt, tiles, solar cells, cloth weave, and an ad atlas.
- A custom **facade shader** has four architectural styles: curtain wall, ribbon windows, punched windows, and fins. Its **interior-mapped rooms** show parallax floors, ceilings, walls, furniture bands and lamp-lit offices behind reflective glass. It antialiases by screen-space footprint.
- Lighting:
  - a photographed HDR sky (baked to a 4K panorama by `tools/bake_sky.py`) that slowly drifts, with the sun direction and fog colour taken from it;
  - god rays (screen-space light shafts) on Medium and above;
  - aerial perspective that fades distant mountains into the haze;
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
- **Night Run** (`Infected.ts`): the city at night, with infected roaming the streets and some rooftops. They notice you on their own level, chase, wind up and strike, and steer around rooftop props. They can't jump gaps or climb, so parkour is the escape. A kick staggers them; a running, sliding or airborne dropkick floors them; one knocked off a roof stays down. You have health that regenerates after 4 s without a hit, and the HUD shows your survival time and takedowns. The dead rise again later, out of sight. The infected and their groans are an original design.
- **Challenges**: *Shard Rush* (three minutes, every shard back in the city) and *Floor is Lava* (one life, street level kills, score is banked flow points). Best scores are saved.
- **Flow combos** (`Combo.ts`): vaults, wall-runs, wall-jumps, rolls, ziplines, grapples, kicks and takedowns chained without stopping build points and a multiplier; repeats are worth less. The chain banks when you stop or go 2.5 s without a move, and is lost if you die.
- **Grappling hook**: red rings on the edges of tall roofs. Aim at one within 42 m and press E to reel yourself up; you let go near the ring with a hop over the edge, or early with jump.
- **Race a friend's ghost**: *Share* on a trial copies a code with your best run; *Race a friend's ghost* takes a pasted code. Codes are checked before use.
- **Weather and time**: Night and Rain settings. Rain falls around you, roofs turn dark and glossy, fog thickens and slides run further.
- **Feel**: speed lines at high speed, slow motion over big drops and on takedowns (never in time trials), and a generated soundtrack whose layers (pad, drums, bass, lead) come in as you speed up, with a darker progression at Night Run.
- Settings: quality, FOV, sensitivity, invert Y, camera motion, wall-jump assist, volume, music volume, night, rain, slow motion, HUD toggles. They're saved locally along with times, ghosts, shards and challenge bests.

## Assets

Sculpted character assets are built in Blender from `tools/blender/sculpt_assets.py` (run with the `bpy` module: `pip install bpy`), then converted for the web with `tools/embed_gltf.py`:

- **hand**: skin-modifier fingers fused with a sculpted palm (voxel remesh + smoothing), knuckle bumps, joint creases, tendons and nails; fingerless glove pieces shrink-wrapped onto the surface; 16-bone rig (wrist, 3 per finger, 3 thumb) with distance-based skin weights. The game drives the finger bones from the grip system.
- **sleeves**: tapered tubes with fabric folds bunched at the elbow and wrist and a ribbed cuff.
- **body**: hooded jacket torso (zipper, chest and shoulder-blade planes, ribbed hem), belted pelvis, cargo-pocket thighs with knee wrinkles, shins with a ribbed ankle cuff, and a head (remeshed face, hair with grooves and tie) that also casts your shadow in first person.
- **shoe**: lofted upper with toe spring, heel collar, midsole, red outsole with cut tread, laces and eyelets.

Photoscanned assets are from [Poly Haven](https://polyhaven.com), all CC0 (public domain, no attribution required; credited here anyway):
- **textures** (fetched by `tools/fetch_assets.py`, 1K, shrunk where noted): concrete_wall_001/006/008, bicolour_gravel, asphalt_02, metal_plate, concrete_pavement, wood_planks_grey, leafy_grass, terrazzo_tiles, factory_brick; terrain aerials aerial_grass_rock, aerial_rocks_02, aerial_beach_01.
- **models**: exterior_aircon_unit, plus Barrel_01, potted_plant_02, concrete_road_barrier, fire_hydrant and metal_trash_can. `tools/blender/optimize_models.py` decimates these to 1.4–3.5k triangles and 512 px textures.
- **sky**: kloofendal_48d_partly_cloudy_puresky HDRI, via `tools/bake_sky.py`.

If any asset fails to load, the game falls back to its procedural version.

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

The character is Blender-sculpted by script, not by an artist's hand. Lighting uses image-based environment lighting, shadow maps and screen-space AO rather than true global illumination, and reflections use the captured environment map, not ray tracing. The infected are simple capsule-built bodies animated in code, not sculpted or motion-captured, and they only move on the level they stand on. Rain has no splashes or puddle reflections. There are no slopes to power-slide down, because the collision world is made of boxes. Clouds come from the sky photo (drifting slowly); they are not volumetric 3D clouds. The terrain is scenery and lies outside the playable district, which stays flat. Audio was not changed in the world overhaul. There's no occlusion culling or mesh LOD beyond decimating the imported models. Performance has only been measured in a software (SwiftShader) renderer here. Expect much higher frame rates on a real GPU; use the quality presets to scale.

## Playing offline

`npm run build:offline` writes `dist-offline/skyline-runner-offline.html` (about 16 MB). Code, styles and every texture and model are embedded in that one file, so it runs from your device with no network: open it in Chrome, Edge, Firefox or Safari. Progress (times, ghosts, shards) is saved in that browser.


### On a school or low-end PC

- Copy the offline file onto the PC (USB stick, or download it), then double-click it or drag it into a Chrome/Edge tab. It doesn't install anything and needs no admin rights or internet.
- On first launch the game checks the graphics chip. On integrated graphics (Intel UHD/Iris, Chromebooks, phones) it starts on **Low**. If play stays under 24 fps for 4 s, it lowers the quality again and tells you. Choosing a quality yourself in Settings turns this off.
- A red banner means the browser is drawing 3D on the CPU: hardware acceleration is off or the graphics driver is blocked. The game will be a slideshow until that's fixed: Chrome/Edge → Settings → System → *Use graphics acceleration when available* → relaunch. `chrome://gpu` should then say *WebGL2: Hardware accelerated*. On managed school computers IT may lock this setting.
- If WebGL 2 isn't available at all, the loading screen says so instead of hanging.
