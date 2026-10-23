import test from 'node:test';
import assert from 'node:assert/strict';
import { drawLetters, ELIGIBLE_LETTERS, TOTAL_ROUNDS } from '../src/game/letters.js';
import { Room, PHASE } from '../src/game/room.js';

// §15.1 et §15.2
test('une partie comporte exactement 15 manches', () => {
  assert.equal(TOTAL_ROUNDS, 15);
  assert.equal(drawLetters().length, 15);
});

test('les 15 lettres d\'une partie sont toutes différentes (10 000 tirages)', () => {
  for (let i = 0; i < 10_000; i++) {
    const letters = drawLetters();
    assert.equal(new Set(letters).size, 15, 'doublon détecté dans le tirage');
    for (const letter of letters) assert.ok(ELIGIBLE_LETTERS.includes(letter));
  }
});

test('le vivier de lettres éligibles permet 15 lettres distinctes', () => {
  assert.ok(ELIGIBLE_LETTERS.length >= TOTAL_ROUNDS);
  assert.equal(new Set(ELIGIBLE_LETTERS).size, ELIGIBLE_LETTERS.length);
});

test('aucune lettre ne se répète au fil des 15 manches jouées', () => {
  let clock = 0;
  const room = new Room({ code: 'AAAA', now: () => clock });
  room.addPlayer('Solo');
  room.startGame();
  const seen = [];
  for (let i = 0; i < TOTAL_ROUNDS; i++) {
    seen.push(room.round.letter);
    clock += 4000;
    room.tick(); // reveal -> playing
    room.closeByTimeout();
    room.applyVerdicts({ verdicts: new Map(), source: 'test' });
    if (i < TOTAL_ROUNDS - 1) assert.equal(room.nextRound(i).ok, true);
  }
  assert.equal(seen.length, 15);
  assert.equal(new Set(seen).size, 15);
  assert.equal(room.phase, PHASE.FINISHED, 'la 15e manche termine la partie');
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
  assert.equal(new Set(room.letters).size, 15);
  assert.notEqual(first.join(''), room.letters.join('')); // ordre indépendant
});
