/**
 * Roulette des lettres : elle défile pour tout le monde à l'identique, l'hôte
 * l'arrête, et la lettre retenue est celle qui passait à cet instant.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, PHASE, ROULETTE_MAX_MS } from '../src/game/room.js';
import { ELIGIBLE_LETTERS, SPIN_MS, letterAtSpin, makeWheel, remainingLetters } from '../src/game/letters.js';

function setup({ connected = true } = {}) {
  const clock = { t: 1_000_000 };
  const room = new Room({ code: 'ROUE', now: () => clock.t });
  const host = room.addPlayer('Hôte');
  const bob = room.addPlayer('Bob');
  if (connected) {
    room.setConnected(host.id, true);
    room.setConnected(bob.id, true);
  }
  room.setRoundCount(6);
  room.startGame();
  return { room, clock, host, bob };
}

test('la partie démarre sans lettre : c\'est la roulette qui décide', () => {
  const { room } = setup();
  assert.equal(room.phase, PHASE.REVEAL);
  assert.equal(room.round.letter, null);
  assert.deepEqual(room.letters, []);
  assert.equal(room.round.wheel.length, ELIGIBLE_LETTERS.length);
});

test('tout le monde voit la même lettre défiler au même instant', () => {
  const { room, clock, host, bob } = setup();
  for (const avance of [0, 55, 110, 337, 1_204]) {
    clock.t += avance;
    const vueHote = room.publicState(host.id).round.roulette;
    const vueBob = room.publicState(bob.id).round.roulette;
    assert.deepEqual(vueHote.wheel, vueBob.wheel, 'même ordre de défilement');
    assert.equal(vueHote.startedAt, vueBob.startedAt, 'même point de départ');
    // La formule est publique : chacun peut recalculer ce qui s'affiche.
    const elapsed = clock.t - vueHote.startedAt;
    assert.equal(
      letterAtSpin(vueHote.wheel, elapsed, vueHote.spinMs),
      vueHote.wheel[Math.floor(elapsed / SPIN_MS) % vueHote.wheel.length],
    );
  }
});

test('seul l\'hôte peut arrêter la roulette', () => {
  const { room, clock, host, bob } = setup();
  assert.equal(room.publicState(host.id).round.roulette.canStop, true);
  assert.equal(room.publicState(bob.id).round.roulette.canStop, false);

  const refus = room.stopRoulette(bob.id);
  assert.equal(refus.ok, false);
  assert.match(refus.error, /hôte/);
  assert.equal(room.round.letter, null);

  clock.t += 400;
  assert.equal(room.stopRoulette(host.id).ok, true);
  assert.ok(room.round.letter);
});

test('la lettre retenue est bien celle qui défilait à l\'instant de l\'arrêt', () => {
  const { room, clock, host } = setup();
  const { wheel, rouletteStartedAt, spinMs } = room.round;
  clock.t += 733;
  const attendue = letterAtSpin(wheel, clock.t - rouletteStartedAt, spinMs);
  const result = room.stopRoulette(host.id);
  assert.equal(result.letter, attendue, 'aucune surprise entre l\'écran et le serveur');
  assert.equal(room.round.letter, attendue);
  assert.equal(room.letters[0], attendue);
});

test('un deuxième appui ne change pas la lettre', () => {
  const { room, clock, host } = setup();
  clock.t += 300;
  const premiere = room.stopRoulette(host.id).letter;
  clock.t += 900;
  const second = room.stopRoulette(host.id);
  assert.equal(second.ok, false);
  assert.equal(second.ignored, true);
  assert.equal(room.round.letter, premiere);
});

test('sans appui, la roulette s\'arrête d\'elle-même et la manche s\'ouvre', () => {
  const { room, clock } = setup();
  clock.t += ROULETTE_MAX_MS + 1;
  const effects = room.tick();
  assert.ok(effects.some((e) => e.type === 'roulette-stopped'));
  assert.ok(effects.some((e) => e.type === 'round-open'));
  assert.equal(room.phase, PHASE.PLAYING);
  assert.ok(room.round.letter);
  assert.equal(room.remainingMs(), 240_000, 'le chronomètre part après la lettre');
});

test('le chronomètre ne tourne pas pendant que la roulette défile', () => {
  const { room, clock } = setup();
  clock.t += 2_000;
  assert.equal(room.phase, PHASE.REVEAL);
  assert.equal(room.remainingMs(), 240_000, 'rien n\'est entamé');
  assert.equal(room.round.startedAt, null);
});

test('une lettre sortie disparaît des roulettes suivantes', () => {
  const { room, clock, host, bob } = setup();
  const sorties = [];
  for (let i = 0; i < 6; i++) {
    clock.t += 250;
    const avant = room.round.wheel.length;
    assert.equal(avant, ELIGIBLE_LETTERS.length - sorties.length, 'la roue rétrécit');
    for (const dejaSortie of sorties) {
      assert.ok(!room.round.wheel.includes(dejaSortie), `${dejaSortie} ne doit plus revenir`);
    }
    room.stopRoulette(host.id);
    sorties.push(room.round.letter);
    clock.t += 2_000;
    room.tick();
    room.closeByTimeout();
    room.applyVerdicts({ verdicts: new Map(), source: 'test' });
    room.markReady(host.id);
    room.markReady(bob.id);
    if (i < 5) room.nextRound(i, host.id);
  }
  assert.equal(new Set(sorties).size, 6, 'six lettres toutes différentes');
  assert.deepEqual(room.letters, sorties);
  assert.equal(room.phase, PHASE.FINISHED);
});

test('si l\'hôte a fermé son onglet, un autre joueur peut arrêter', () => {
  const { room, clock, host, bob } = setup();
  room.setConnected(host.id, false);
  clock.t += 300;
  assert.equal(room.publicState(bob.id).round.roulette.canStop, true);
  assert.equal(room.stopRoulette(bob.id).ok, true);
  assert.ok(room.round.letter);
});

test('la roulette ne propose que des lettres jouables', () => {
  const wheel = makeWheel(['M', 'A']);
  assert.equal(wheel.length, ELIGIBLE_LETTERS.length - 2);
  assert.deepEqual([...wheel].sort(), remainingLetters(['M', 'A']).sort());
  for (const difficile of ['K', 'Q', 'W', 'X', 'Y', 'Z']) {
    assert.ok(!wheel.includes(difficile), `${difficile} reste écartée`);
  }
});
