import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, PHASE, ROUND_DURATION_MS, REVEAL_DURATION_MS } from '../src/game/room.js';
import { CATEGORY_KEYS } from '../src/shared/categories.js';

/**
 * Force la lettre de la manche en cours sans casser l'unicité du tirage :
 * la lettre voulue est échangée avec celle de la position courante.
 */
function forceLetter(room, letter) {
  const current = room.roundIndex;
  const index = room.letters.indexOf(letter);
  if (index === -1) {
    room.letters[current] = letter; // la lettre n'était pas tirée : pas de doublon créé
  } else {
    [room.letters[current], room.letters[index]] = [room.letters[index], room.letters[current]];
  }
  room.round.letter = room.letters[current];
  assert.equal(new Set(room.letters).size, room.letters.length);
}

function setup({ players = ['Alice', 'Bob'], letter = 'M' } = {}) {
  const clock = { t: 1_000_000 };
  const room = new Room({ code: 'ROOM', now: () => clock.t });
  const created = players.map((name) => room.addPlayer(name));
  room.startGame();
  forceLetter(room, letter);
  clock.t += REVEAL_DURATION_MS + 1;
  room.tick(); // fin de la révélation : le chronomètre démarre
  return { room, clock, players: created, forceLetter };
}

/** Passe la phase de contestation : tout le monde se déclare prêt. */
function settle(room) {
  for (const player of room.playerList) room.markReady(player.id);
}

function fullAnswers(letter) {
  const out = {};
  for (const key of CATEGORY_KEYS) out[key] = `${letter}ot`;
  return out;
}

// §15.3
test('le chronomètre démarre à 240 secondes', () => {
  const { room } = setup();
  assert.equal(room.phase, PHASE.PLAYING);
  assert.equal(ROUND_DURATION_MS, 240_000);
  assert.equal(room.remainingMs(), 240_000);
  assert.equal(room.round.endsAt - room.round.startedAt, 240_000);
});

test('le temps restant décroît et ne devient jamais négatif', () => {
  const { room, clock } = setup();
  clock.t += 100_000;
  assert.equal(room.remainingMs(), 140_000);
  clock.t += 500_000; // bien au-delà de la fin
  assert.equal(room.remainingMs(), 0);
});

// §15.4
test('FIN est refusé tant que les 8 rubriques ne sont pas remplies', () => {
  const { room, players } = setup();
  const [alice] = players;
  for (const [index, key] of CATEGORY_KEYS.entries()) {
    if (index === CATEGORY_KEYS.length - 1) break;
    room.saveAnswers(alice.id, { [key]: 'Mot' });
    assert.equal(room.hasAllAnswers(alice.id), false);
    assert.equal(room.requestFinish(alice.id).ok, false);
  }
  room.saveAnswers(alice.id, { [CATEGORY_KEYS.at(-1)]: 'Mot' });
  assert.equal(room.filledCount(alice.id), 8);
  assert.equal(room.requestFinish(alice.id).ok, true);
});

test('une rubrique remplie d\'espaces ne compte pas comme remplie', () => {
  const { room, players } = setup();
  const [alice] = players;
  room.saveAnswers(alice.id, fullAnswers(room.round.letter));
  room.saveAnswers(alice.id, { ville: '   ' });
  assert.equal(room.filledCount(alice.id), 7);
  assert.equal(room.requestFinish(alice.id).ok, false);
});

test('effacer une réponse la retire vraiment et referme le bouton FIN', () => {
  const { room, players } = setup();
  const [alice] = players;
  room.saveAnswers(alice.id, fullAnswers(room.round.letter));
  assert.equal(room.hasAllAnswers(alice.id), true);

  // Le joueur vide une rubrique : l'effacement doit être enregistré tel quel.
  room.saveAnswers(alice.id, { ville: '' });
  assert.equal(room.answersOf(alice.id).ville, '');
  assert.equal(room.filledCount(alice.id), 7);
  assert.equal(room.requestFinish(alice.id).ok, false, 'FIN redevient impossible');
  assert.equal(room.publicState(alice.id).you.canFinish, false);

  // Et il peut la remplir de nouveau.
  room.saveAnswers(alice.id, { ville: 'Marseille' });
  assert.equal(room.filledCount(alice.id), 8);
  assert.equal(room.publicState(alice.id).you.canFinish, true);
});

// §15.5
test('FIN arrête le chronomètre pour tous et verrouille les réponses', () => {
  const { room, clock, players } = setup();
  const [alice, bob] = players;
  room.saveAnswers(alice.id, fullAnswers(room.round.letter));
  room.saveAnswers(bob.id, { ville: 'Marseille' });
  clock.t += 30_000;
  assert.equal(room.requestFinish(alice.id).ok, true);
  const frozen = room.remainingMs();
  assert.equal(frozen, 210_000);
  clock.t += 60_000;
  assert.equal(room.remainingMs(), frozen, 'le temps est figé pour tout le monde');
  assert.equal(room.round.locked, true);
  assert.equal(room.saveAnswers(bob.id, { ville: 'Metz' }).ok, false);
  assert.equal(room.answersOf(bob.id).ville, 'Marseille', 'réponse inchangée après clôture');
});

test('deux clics FIN quasi simultanés ne produisent qu\'une seule clôture', () => {
  const { room, players } = setup();
  const [alice, bob] = players;
  room.saveAnswers(alice.id, fullAnswers(room.round.letter));
  room.saveAnswers(bob.id, fullAnswers(room.round.letter));
  const first = room.requestFinish(alice.id);
  const second = room.requestFinish(bob.id);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.ignored, true);
  assert.equal(room.round.closedBy, alice.id);
  assert.equal(room.round.closeReason, 'player');
  assert.equal(room.claimValidation(), true);
  assert.equal(room.claimValidation(), false, 'la validation ne démarre qu\'une fois');
});

// §15.6
test('à 00:00 la manche se termine automatiquement, réponses partielles conservées', () => {
  const { room, clock, players } = setup();
  const [alice, bob] = players;
  room.saveAnswers(alice.id, { ville: 'Marseille', animal: 'Mouton' });
  clock.t += ROUND_DURATION_MS;
  const effects = room.tick(); // aucun navigateur n'est nécessaire
  assert.ok(effects.some((e) => e.type === 'round-closed'));
  assert.equal(room.phase, PHASE.VALIDATING);
  assert.equal(room.round.closeReason, 'timeout');
  assert.equal(room.remainingMs(), 0);
  assert.equal(room.answersOf(alice.id).ville, 'Marseille');
  assert.deepEqual(room.answersOf(bob.id), {}, 'aucune réponse pour Bob');
});

test('les points d\'une manche ne peuvent pas être attribués deux fois', () => {
  const { room, players } = setup();
  const [alice] = players;
  room.saveAnswers(alice.id, { ville: 'Marseille' });
  room.closeByTimeout();
  const verdicts = new Map([
    [`${alice.id}::ville`, {
      status: 'valide', recognized: 'Marseille', groupKey: 'marseille',
      reason: 'ok', confidence: 1, source: 'test',
    }],
  ]);
  room.applyVerdicts({ verdicts, source: 'test' });
  assert.equal(room.phase, PHASE.VOTING, 'le salon peut contester avant le comptage');
  settle(room);
  const afterFirst = room.players.get(alice.id).score;
  assert.equal(afterFirst, 2);
  const again = room.applyVerdicts({ verdicts, source: 'test' });
  assert.equal(again.already, true);
  assert.equal(room.players.get(alice.id).score, afterFirst);
});

// §15.19
test('une reconnexion ne réinitialise pas le chronomètre', () => {
  const { room, clock, players } = setup();
  const [alice] = players;
  clock.t += 90_000;
  room.setConnected(alice.id, false); // déconnexion
  clock.t += 20_000;
  room.setConnected(alice.id, true); // reconnexion
  const state = room.publicState(alice.id);
  assert.equal(state.round.remainingMs, 130_000);
  assert.equal(state.round.endsAt, room.round.startedAt + ROUND_DURATION_MS);
});

test('les réponses déjà saisies sont restituées après rechargement', () => {
  const { room, players } = setup();
  const [alice] = players;
  room.saveAnswers(alice.id, { ville: 'Marseille', metier: 'Mécanicien' });
  const state = room.publicState(alice.id);
  assert.equal(state.you.answers.ville, 'Marseille');
  assert.equal(state.you.filled, 2);
});

test('les réponses des autres joueurs restent cachées pendant la manche', () => {
  const { room, players } = setup();
  const [alice, bob] = players;
  room.saveAnswers(bob.id, { ville: 'Metz' });
  const state = room.publicState(alice.id);
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('Metz'), 'aucune réponse adverse ne doit fuiter');
  assert.equal(state.players.find((p) => p.id === bob.id).filled, 1);
});

test('la manche suivante repart à 240 s, champs vidés, scores conservés', () => {
  const { room, clock, players } = setup();
  const [alice] = players;
  room.saveAnswers(alice.id, { ville: 'Marseille' });
  clock.t += 50_000;
  room.closeByTimeout();
  room.applyVerdicts({
    verdicts: new Map([[`${alice.id}::ville`, {
      status: 'valide', recognized: 'Marseille', groupKey: 'marseille', reason: '', confidence: 1,
    }]]),
    source: 'test',
  });
  settle(room);
  assert.equal(room.players.get(alice.id).score, 2);
  assert.equal(room.nextRound(0).ok, true);
  clock.t += REVEAL_DURATION_MS + 1;
  room.tick();
  assert.equal(room.remainingMs(), 240_000);
  assert.deepEqual(room.answersOf(alice.id), {}, 'les 8 champs sont réinitialisés');
  assert.equal(room.players.get(alice.id).score, 2, 'le score cumulé est conservé');
});

test('MANCHE SUIVANTE n\'initialise la manche qu\'une seule fois', () => {
  const { room } = setup();
  room.closeByTimeout();
  room.applyVerdicts({ verdicts: new Map(), source: 'test' });
  settle(room);
  assert.equal(room.nextRound(0).ok, true);
  const letterAfter = room.round.letter;
  const second = room.nextRound(0); // second clic, même manche d'origine
  assert.equal(second.ok, false);
  assert.equal(second.ignored, true);
  assert.equal(room.round.letter, letterAfter);
  assert.equal(room.roundIndex, 1);
});
