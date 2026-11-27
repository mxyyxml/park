/**
 * LAST SIGNAL — story mode. An original six-chapter story told mostly over the radio and the
 * district's loudspeakers while you run, with short pauses only for the turns that matter.
 *
 * Meridian is sealed after "the Bloom". Kai, an ex-courier haunted by the fall that took their
 * brother Theo, is pulled back onto the roofs by Mara, a dispatcher, to carry the encrypted shards
 * that prove Halden Life Sciences released the Bloom on purpose. Vesper, Kai's old crew leader,
 * wants the shards too. Mara is not who she says she is. At the top of the Spire, Kai chooses.
 *
 * Plain data + a small state machine; the game does the side effects through `StoryHooks`, so the
 * whole flow is testable without a renderer.
 */
export type Vec = { x: number; y: number; z: number };
export type Who = 'MARA' | 'KAI' | 'VESPER' | 'HALE' | 'THEO';
export type Line = { who: Who; text: string };
export type Ending = 'broadcast' | 'deal';

export interface StoryHooks {
  say(lines: Line[]): void;
  objective(text: string, target: Vec | null, timer?: number | null): void;
  give(item: 'katana' | 'pipe' | 'flares'): void;
  night(on: boolean): void;
  /** a rival runner (Vesper) on a route: 'chase' starts ahead of you, 'race' starts beside you */
  rival(mode: 'chase' | 'race' | null): void;
  spawnClimber(): void;
  fail(why: string): void;
  choose(prompt: string, options: [string, string]): void;
  end(ending: Ending): void;
}
export interface StoryPlaces { stash: Vec; shards: Vec[]; supplies: Vec; spireTop: Vec; raceFinish: Vec }

export const CHAPTERS = ['Courier', 'Tail', 'Dead Drops', 'The Line', 'Nightfall', 'Last Signal'];
const ESCAPE_TIME = 90, HOLD = 60;

export class Story {
  chapter = 0; step = 0; t = 0; hold = 0; done = false; ending: Ending | null = null;
  constructor(private places: StoryPlaces, private h: StoryHooks) {}

  /** begin (or retry / resume) at the start of a chapter */
  start(chapter: number) {
    this.chapter = chapter; this.step = 0; this.t = 0; this.hold = 0; this.done = false;
    const P = this.places, h = this.h;
    h.rival(null);
    switch (chapter) {
      case 0:
        h.night(false);
        h.say([
          { who: 'MARA', text: "Kai. Don't talk, run. Halden drones sweep that roof in ninety seconds." },
          { who: 'KAI', text: 'Who is this?' },
          { who: 'MARA', text: "Someone who knows about your stash on the east roofs. And about Theo. Move." },
        ]);
        h.objective('Reach your stash before the sweep', P.stash, ESCAPE_TIME);
        break;
      case 1:
        h.night(false);
        h.say([
          { who: 'MARA', text: "You've got company. A runner just lifted the shard I had you carrying." },
          { who: 'KAI', text: "I know that silhouette. That's Vesper. That's my old crew." },
          { who: 'VESPER', text: "Still slow on the take-off, Kai. Catch me and we'll talk." },
        ]);
        h.rival('chase');
        h.objective('Catch Vesper', null);
        break;
      case 2:
        h.night(false);
        h.say([
          { who: 'VESPER', text: "Fine. Take it. But ask your new friend who pays her. Ask her why she knows your brother's name." },
          { who: 'MARA', text: "Ignore her. There are three more drops nearby. Medical teams hid them before the seal." },
          { who: 'HALE', text: 'Residents of Meridian, this is Director Hale. A courier is carrying stolen Halden property. Report rooftop movement.' },
        ]);
        this.nextShard();
        break;
      case 3:
        h.night(false);
        h.say([
          { who: 'VESPER', text: "Hale just put your face on every screen in the district. You can't get to the Spire alone." },
          { who: 'VESPER', text: "Race me to the far edge. Beat me and the Lanterns run with you. Lose and you're on your own." },
        ]);
        h.rival('race');
        h.objective('Beat Vesper to the far edge', P.raceFinish);
        break;
      case 4:
        h.night(true);
        h.say([
          { who: 'VESPER', text: "You won. Now listen. Mara Quell is Halden security. She's been steering you to them all day." },
          { who: 'MARA', text: "Kai, she's lying. Come to the supply cache, I'll get you out—" },
          { who: 'HALE', text: 'Thank you, Ms. Quell. We have the courier\'s position. Release the night shift.' },
          { who: 'VESPER', text: "That's her done. Cache first, then the Spire. They come out of the buildings after dark. Stay high." },
        ]);
        h.objective('Grab the supply cache', P.supplies);
        break;
      case 5:
        h.night(true);
        h.say([
          { who: 'KAI', text: "I'm at the relay. Uploading the shards." },
          { who: 'VESPER', text: "It needs a minute to push the proof to every screen in the city. They can hear it. They're climbing." },
        ]);
        h.objective(`Hold the relay: ${HOLD}s`, null);
        break;
    }
  }

  private nextShard() {
    this.h.objective(`Recover the medical drops (${this.step}/${this.places.shards.length})`, this.places.shards[this.step]);
  }

  /** the player picked an option at the final choice */
  choose(i: 0 | 1) {
    if (this.chapter !== 5 || this.done || this.hold < HOLD) return;
    this.done = true;
    this.ending = i === 0 ? 'broadcast' : 'deal';
    this.h.say(i === 0 ? [
      { who: 'KAI', text: 'Send it. All of it.' },
      { who: 'HALE', text: "You've just told a sealed city that its jailers made the plague. Do you know what happens next?" },
      { who: 'VESPER', text: "They open the gates. That's what happens next." },
    ] : [
      { who: 'KAI', text: 'Hale. You said Theo is alive. Bring him to the roof and the shards are yours.' },
      { who: 'HALE', text: 'A sensible trade. Your brother has been very patient.' },
      { who: 'VESPER', text: "Kai... the city stays sealed. You know that, right?" },
    ]);
    this.h.end(this.ending);
  }

  /** call every frame; `alive` false while dead (timers pause). `rival` is Vesper's position when on a route. */
  update(dt: number, pos: Vec, alive: boolean, rival: (Vec & { finished: boolean }) | null = null) {
    if (this.done) return;
    this.t += dt;
    const near = (v: Vec, r: number) => Math.hypot(pos.x - v.x, pos.z - v.z) < r && Math.abs(pos.y - v.y) < 3;
    const P = this.places, h = this.h;
    switch (this.chapter) {
      case 0:
        if (near(P.stash, 3)) {
          h.give('katana');
          h.say([{ who: 'KAI', text: "Theo's blade. I haven't touched it since." }, { who: 'MARA', text: 'Keep it close. Something just pinged your shard.' }]);
          this.start(1);
        } else if (this.t > ESCAPE_TIME) h.fail('The drones swept the roof.');
        else h.objective('Reach your stash before the sweep', P.stash, ESCAPE_TIME - this.t);
        break;
      case 1:
        if (!rival) break;
        if (Math.hypot(pos.x - rival.x, pos.z - rival.z) < 3.5 && Math.abs(pos.y - rival.y) < 2.5) { h.rival(null); this.start(2); }
        else if (rival.finished || Math.hypot(pos.x - rival.x, pos.z - rival.z) > 90) h.fail('Vesper got away.');
        else h.objective(`Catch Vesper: ${Math.round(Math.hypot(pos.x - rival.x, pos.z - rival.z))} m`, rival);
        break;
      case 2:
        if (near(P.shards[this.step], 2.2)) {
          this.step++;
          if (this.step < P.shards.length) {
            const beats: Line[] = [{ who: 'THEO', text: '[recorded] If you find this, Kai: I didn\'t fall. Someone cut the line.' }, { who: 'MARA', text: 'One left. Hurry.' }];
            h.say([beats[this.step - 1]]);
            this.nextShard();
          } else { h.say([{ who: 'KAI', text: "Theo's voice was on that drop. Mara, how did you know about Theo?" }, { who: 'MARA', text: '...Get moving. It\'s getting dark.' }]); this.start(3); }
        }
        break;
      case 3:
        if (near(P.raceFinish, 4)) { h.rival(null); this.start(4); }
        else if (rival?.finished) h.fail('Vesper got there first.');
        break;
      case 4:
        if (this.step === 0 && near(P.supplies, 3)) {
          this.step = 1;
          h.give('pipe'); h.give('flares');
          h.say([{ who: 'VESPER', text: "Flares draw them off. Throw one and run the other way. Spire's straight ahead. Climb." }]);
          h.objective('Climb the Spire to the relay', P.spireTop);
        } else if (this.step === 1 && near(P.spireTop, 4)) this.start(5);
        break;
      case 5:
        if (!alive) break;
        if (this.hold < HOLD) {
          this.hold += dt;
          // they keep coming over the edge: one climber every few seconds, faster near the end
          const every = this.hold > 40 ? 3 : 5;
          if (this.hold > 4 && Math.floor(this.hold / every) !== Math.floor((this.hold - dt) / every)) h.spawnClimber();
          h.objective(`Hold the relay: ${Math.max(0, Math.ceil(HOLD - this.hold))}s`, null);
          if (this.hold >= HOLD) {
            h.say([
              { who: 'HALE', text: "Kai. Before you press that. Your brother is alive. He's in the ward under your feet." },
              { who: 'THEO', text: '...Kai? Is that you?' },
              { who: 'HALE', text: 'Give me the shards and he walks out with you. Send them and he stays where he is.' },
            ]);
            h.objective('Choose', null);
            h.choose('The upload is ready. Hale has Theo.', ['Broadcast the proof to the city', 'Trade the shards for Theo']);
          }
        }
        break;
    }
  }
}

/** Voice logs: the data shards around the city (free run and story) tell the story behind the story. */
export const VOICE_LOGS: Line[] = [
  { who: 'THEO', text: 'Day 3. Kai says the Spire run is impossible. Kai says that about everything I want to do.' },
  { who: 'HALE', text: '[Halden memo] Field trial B is approved for the Meridian district. Containment staff to be briefed after release.' },
  { who: 'VESPER', text: "[Lantern channel] Nobody runs the east roofs till we know who cut Theo's line. Nobody." },
  { who: 'MARA', text: '[Halden security, Q. Mara] Asset K remains unaware. Recommend continued handling via the brother.' },
  { who: 'THEO', text: "They brought me somewhere white. They keep asking how far I can fall. I don't think I fell." },
  { who: 'HALE', text: '[Halden memo] Subjects exposed to B at height show slower onset. Continue rooftop observation.' },
  { who: 'VESPER', text: "[Lantern channel] Kai blames themself. Let them. It's safer than the truth until we can prove it." },
  { who: 'MARA', text: "[personal, unsent] I picked the courier because they'd do anything for the brother. I'm sorry, Kai." },
  { who: 'THEO', text: "If the Spire relay ever goes live, everyone will hear this. Hi, everyone. Get off the streets." },
  { who: 'HALE', text: '[Halden memo] The quarantine will hold as long as the story holds.' },
];
