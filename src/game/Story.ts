/**
 * LAST SIGNAL — the story mode. An original four-chapter run through the quarantined district:
 * Kai, a rooftop courier, carries encrypted data shards to the relay on top of the Spire while
 * Mara, a dispatcher, talks them through it over the radio.
 *
 * Plain data + a small state machine; the game supplies positions and does the side effects
 * through `StoryHooks`, so the flow is testable without a renderer.
 */
export type Vec = { x: number; y: number; z: number };
export type Line = { who: 'MARA' | 'KAI'; text: string };

export interface StoryHooks {
  say(lines: Line[]): void;
  objective(text: string, target: Vec | null): void;
  give(item: 'katana' | 'pipe' | 'flares'): void;
  night(on: boolean): void;
  spawnClimber(): void;
  end(): void;
}
export interface StoryPlaces { stash: Vec; shards: Vec[]; supplies: Vec; spireTop: Vec }

export const CHAPTERS = ['Courier', 'Dead Drops', 'Nightfall', 'Last Signal'];
const HOLD = 60; // seconds the relay must broadcast

export class Story {
  chapter = 0; step = 0; t = 0; hold = 0; done = false;
  constructor(private places: StoryPlaces, private h: StoryHooks) {}

  /** begin (or resume) at the start of a chapter */
  start(chapter: number) {
    this.chapter = chapter; this.step = 0; this.t = 0; this.hold = 0; this.done = false;
    const P = this.places, h = this.h;
    switch (chapter) {
      case 0:
        h.night(false);
        h.say([
          { who: 'MARA', text: "Kai, you up? Good. The district's sealed as of this morning. Nobody in, nobody out." },
          { who: 'MARA', text: "Your stash is still on the roofs east of you. Get your gear before the streets fill up." },
          { who: 'KAI', text: 'On my way. Keep the channel open.' },
        ]);
        h.objective('Reach your stash', P.stash);
        break;
      case 1:
        h.night(false);
        h.say([
          { who: 'MARA', text: "The medical teams left encrypted drops before the lockdown. Three of them near you." },
          { who: 'MARA', text: 'Those shards are the evacuation plan. Without them nobody gets a pickup.' },
        ]);
        this.nextShard();
        break;
      case 2:
        h.night(true);
        h.say([
          { who: 'MARA', text: "Sun's down. They come out of the buildings at night. Stay high, keep moving." },
          { who: 'MARA', text: 'The Spire has the only working relay. Get the shards up there.' },
          { who: 'MARA', text: 'There should be a supply cache on the way: flares, and something heavier.' },
        ]);
        h.objective('Grab the supply cache', P.supplies);
        break;
      case 3:
        h.night(true);
        h.say([
          { who: 'KAI', text: "I'm at the relay. Plugging in the shards." },
          { who: 'MARA', text: "Upload's running. It needs a minute. They can hear it, Kai. They're climbing." },
        ]);
        h.objective(`Hold the relay: ${HOLD}s`, null);
        break;
    }
  }

  private nextShard() {
    this.h.objective(`Recover data shards (${this.step}/${this.places.shards.length})`, this.places.shards[this.step]);
  }

  /** call every frame with the runner's position; `alive` false while dead (timers pause) */
  update(dt: number, pos: Vec, alive: boolean) {
    if (this.done) return;
    this.t += dt;
    const near = (v: Vec, r: number) => Math.hypot(pos.x - v.x, pos.z - v.z) < r && Math.abs(pos.y - v.y) < 3;
    const P = this.places, h = this.h;
    switch (this.chapter) {
      case 0:
        if (near(P.stash, 3)) {
          h.give('katana');
          h.say([{ who: 'KAI', text: 'Got the blade. Still sharp.' }, { who: 'MARA', text: 'Good. You might need it before tonight is over.' }]);
          this.start(1);
        }
        break;
      case 1:
        if (near(P.shards[this.step], 2.2)) {
          this.step++;
          if (this.step < P.shards.length) { h.say([{ who: 'MARA', text: ['One down. Next drop is close.', "That's two. Last one, then we move."][this.step - 1] ?? 'Got it.' }]); this.nextShard(); }
          else { h.say([{ who: 'KAI', text: "All three. It's getting dark, Mara." }]); this.start(2); }
        }
        break;
      case 2:
        if (this.step === 0 && near(P.supplies, 3)) {
          this.step = 1;
          h.give('pipe'); h.give('flares');
          h.say([{ who: 'MARA', text: 'Flares draw them off. Throw one and run the other way.' }]);
          h.objective('Climb the Spire to the relay', P.spireTop);
        } else if (this.step === 1 && near(P.spireTop, 4)) this.start(3);
        break;
      case 3:
        if (!alive) break;
        this.hold += dt;
        // they keep coming over the edge: one climber every few seconds, faster near the end
        if (this.hold > 4 && Math.floor(this.hold / (this.hold > 40 ? 3 : 5)) !== Math.floor((this.hold - dt) / (this.hold > 40 ? 3 : 5))) h.spawnClimber();
        h.objective(`Hold the relay: ${Math.max(0, Math.ceil(HOLD - this.hold))}s`, null);
        if (this.hold >= HOLD) {
          this.done = true;
          h.say([
            { who: 'MARA', text: "Upload complete. The signal's out, Kai. They're sending the birds." },
            { who: 'KAI', text: 'Tell them to land on the roofs. Nothing good happens on the street.' },
          ]);
          h.end();
        }
        break;
    }
  }
}
