import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ROUNDS, ELIGIBLE_LETTERS, ROUND_OPTIONS, drawLetters, isValidRoundCount,
} from '../src/game/letters.js';
import { Room, PHASE } from '../src/game/room.js';

// §15.1 et §15.2
test('la longueur d\'une partie se choisit parmi 6, 12 ou 18 manches', () => {
  assert.deepEqual(ROUND_OPTIONS, [6, 12, 18]);
  assert.equal(DEFAULT_ROUNDS, 12);
  assert.equal(drawLetters().length, DEFAULT_ROUNDS);
  for (const count of ROUND_OPTIONS) {
    assert.equal(isValidRoundCount(count), true);
    assert.equal(drawLetters(count).length, count);
  }
  for (const invalide of [0, 5, 7, 15, 21, -3]) {
    assert.equal(isValidRoundCount(invalide), false);
  }
});

test('les lettres d\'une partie sont toutes différentes, quelle que soit sa longueur', () => {
  for (const count of ROUND_OPTIONS) {
    for (let i = 0; i < 3_000; i++) {
      const letters = drawLetters(count);
      assert.equal(new Set(letters).size, count, 'doublon détecté dans le tirage');
      for (const letter of letters) assert.ok(ELIGIBLE_LETTERS.includes(letter));
    }
  }
});

test('le vivier de lettres éligibles couvre la partie la plus longue', () => {
  assert.ok(ELIGIBLE_LETTERS.length >= Math.max(...ROUND_OPTIONS));
  assert.equal(new Set(ELIGIBLE_LETTERS).size, ELIGIBLE_LETTERS.length);
});

test('aucune lettre ne se répète au fil des manches jouées (partie de 18)', () => {
  let clock = 0;
  const room = new Room({ code: 'AAAA', now: () => clock });
  room.addPlayer('Solo');
  room.setRoundCount(18);
  room.startGame();
  const seen = [];
  for (let i = 0; i < room.totalRounds; i++) {
    seen.push(room.round.letter);
    clock += 4000;
    room.tick(); // reveal -> playing
    room.closeByTimeout();
    room.applyVerdicts({ verdicts: new Map(), source: 'test' });
    if (i < room.totalRounds - 1) assert.equal(room.nextRound(i).ok, true);
  }
  assert.equal(seen.length, 18);
  assert.equal(new Set(seen).size, 18);
  assert.equal(room.phase, PHASE.FINISHED, 'la dernière manche termine la partie');
});

test('le tirage n\'est jamais réinitialisé entre deux manches', () => {
  let clock = 0;
  const room = new Room({ code: 'BBBB', now: () => clock });
  room.addPlayer('Solo');
  room.startGame();
  const planned = [...room.letters];
  clock += 4000;
  room.tick();
  room.closeByTimeout();
  room.applyVerdicts({ verdicts: new Map(), source: 'test' });
  room.nextRound(0);
  assert.deepEqual(room.letters, planned, 'le tirage initial doit rester intact');
  assert.equal(room.round.letter, planned[1]);
});

test('une nouvelle partie bénéficie d\'un tirage indépendant', () => {
  const room = new Room({ code: 'CCCC' });
  room.addPlayer('Solo');
  room.startGame();
  const first = [...room.letters];
  room.newGame();
  room.startGame();
  assert.equal(new Set(room.letters).size, room.totalRounds);
  assert.notEqual(first.join(''), room.letters.join('')); // ordre indépendant
});
