/**
 * Mode « chacun se note » : chaque joueur s'attribue 0, 1 ou 2 points sur ses
 * propres réponses. Le calcul automatique sert de proposition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, PHASE, ARBITRATION, SELF_DURATION_MS, REVEAL_DURATION_MS } from '../src/game/room.js';
import { makeVerdictKey, STATUS } from '../src/game/scoring.js';

function verdict(status, recognized) {
  return { status, recognized, groupKey: recognized.toLowerCase(), reason: '', confidence: 0.9 };
}

function setup(names = ['Alice', 'Bob']) {
  const clock = { t: 1_000_000 };
  const room = new Room({ code: 'SELF', now: () => clock.t });
  const players = names.map((n) => room.addPlayer(n));
  room.setArbitration({ mode: ARBITRATION.SELF });
  room.startGame();
  room.letters[room.roundIndex] = 'M';
  room.round.letter = 'M';
  clock.t += REVEAL_DURATION_MS + 1;
  room.tick();
  return { room, clock, players };
}

function closeWith(room, answersByPlayer, statuses = {}) {
  const verdicts = new Map();
  for (const [playerId, answers] of Object.entries(answersByPlayer)) {
    room.saveAnswers(playerId, answers);
    for (const [categoryKey, raw] of Object.entries(answers)) {
      if (!raw) continue;
      const key = makeVerdictKey(playerId, categoryKey);
      verdicts.set(key, verdict(statuses[key] ?? STATUS.VALID, raw));
    }
  }
  room.closeByTimeout();
  room.applyVerdicts({ verdicts, source: 'test' });
}

const entry = (room, cat, pid) =>
  room.round.results.categories.find((c) => c.key === cat).entries.find((e) => e.playerId === pid);

test('chacun se note : le mode se choisit dans le salon', () => {
  const room = new Room({ code: 'AAAA' });
  room.addPlayer('A');
  assert.equal(room.setArbitration({ mode: ARBITRATION.SELF }).ok, true);
  assert.equal(room.arbitrationMode, ARBITRATION.SELF);
  assert.equal(room.refereeId, null, 'aucun arbitre à désigner');
});

test('le joueur s\'attribue 0, 1 ou 2 et son choix remplace le calcul', () => {
  const { room, players } = setup();
  const [alice, bob] = players;
  // Réponse identique : le calcul propose 1 à chacun.
  closeWith(room, { [alice.id]: { ville: 'Marseille' }, [bob.id]: { ville: 'Marseille' } });
  assert.equal(room.phase, PHASE.VOTING);
  assert.equal(room.round.provisional.categories.find((c) => c.key === 'ville')
    .entries.find((e) => e.playerId === alice.id).points, 1, 'proposition automatique');

  assert.equal(room.selfScore(alice.id, { categoryKey: 'ville', points: 2 }).ok, true);
  room.markReady(alice.id);
  room.markReady(bob.id);

  assert.equal(entry(room, 'ville', alice.id).points, 2, 'le choix du joueur prime');
  assert.equal(entry(room, 'ville', alice.id).selfScored, true);
  assert.equal(entry(room, 'ville', bob.id).points, 1, 'sans choix, le calcul s\'applique');
  assert.equal(room.players.get(alice.id).score, 2);
  assert.equal(room.players.get(bob.id).score, 1);
});

test('un joueur peut se donner zéro', () => {
  const { room, players } = setup();
  const [alice] = players;
  closeWith(room, { [alice.id]: { ville: 'Marseille', animal: 'Mouton' } });
  room.selfScore(alice.id, { categoryKey: 'animal', points: 0 });
  room.markReady(alice.id);
  room.markReady(players[1].id);
  assert.equal(entry(room, 'animal', alice.id).points, 0);
  assert.equal(entry(room, 'ville', alice.id).points, 2);
  assert.equal(room.players.get(alice.id).score, 2);
});

test('on ne note que ses propres réponses', () => {
  const { room, players } = setup();
  const [alice, bob] = players;
  closeWith(room, { [alice.id]: { ville: 'Marseille' }, [bob.id]: { ville: 'Metz' } });
  // Alice n'a rien écrit en « pays » : rien à noter de ce côté non plus.
  const vide = room.selfScore(alice.id, { categoryKey: 'pays', points: 2 });
  assert.equal(vide.ok, false);
  assert.match(vide.error, /Aucune réponse/);

  // Le barème d'un autre joueur ne bouge pas.
  room.selfScore(alice.id, { categoryKey: 'ville', points: 0 });
  room.markReady(alice.id);
  room.markReady(bob.id);
  assert.equal(entry(room, 'ville', alice.id).points, 0);
  assert.equal(entry(room, 'ville', bob.id).points, 2, 'Bob garde ses points');
});

test('seuls 0, 1 et 2 sont acceptés', () => {
  const { room, players } = setup();
  const [alice] = players;
  closeWith(room, { [alice.id]: { ville: 'Marseille' } });
  for (const points of [3, -1, 1.5, 10, Number.NaN]) {
    const result = room.selfScore(alice.id, { categoryKey: 'ville', points });
    assert.equal(result.ok, false, `${points} ne doit pas être accepté`);
  }
  assert.equal(room.selfScore(alice.id, { categoryKey: 'ville', points: 1 }).ok, true);
});

test('la notation dispose de son propre temps et se clôt seule', () => {
  const { room, clock, players } = setup();
  const [alice] = players;
  closeWith(room, { [alice.id]: { ville: 'Marseille' } });
  assert.equal(room.round.voteEndsAt - clock.t, SELF_DURATION_MS);
  clock.t += SELF_DURATION_MS;
  room.tick();
  assert.equal(room.phase, PHASE.RESULTS);
  assert.equal(entry(room, 'ville', alice.id).points, 2, 'les points proposés s\'appliquent');
});

test('contester ou arbitrer n\'a pas de sens dans ce mode', () => {
  const { room, players } = setup();
  const [alice, bob] = players;
  closeWith(room, { [alice.id]: { ville: 'Marseille' }, [bob.id]: { ville: 'Metz' } });
  assert.equal(room.toggleChallenge(bob.id, {
    targetPlayerId: alice.id, categoryKey: 'ville',
  }).ok, false);
  assert.equal(room.refereeDecide(bob.id, {
    targetPlayerId: alice.id, categoryKey: 'ville', accept: false,
  }).ok, false);

  // Et l'interface ne doit proposer aucun bouton de contestation.
  const vue = room.publicState(bob.id).vote;
  const lignes = vue.categories.flatMap((c) => c.entries);
  assert.ok(lignes.every((e) => e.canChallenge === false), 'aucune contestation possible');
  assert.ok(
    lignes.filter((e) => e.playerId === bob.id && e.raw).every((e) => e.canSelfScore),
    'ses propres réponses sont notables',
  );
  assert.ok(
    lignes.filter((e) => e.playerId !== bob.id).every((e) => !e.canSelfScore),
    'celles des autres ne le sont pas',
  );
});

test('les notes repartent de zéro à la manche suivante', () => {
  const { room, clock, players } = setup();
  const [alice, bob] = players;
  closeWith(room, { [alice.id]: { ville: 'Marseille' } });
  room.selfScore(alice.id, { categoryKey: 'ville', points: 0 });
  room.markReady(alice.id);
  room.markReady(bob.id);
  assert.equal(room.players.get(alice.id).score, 0);

  assert.equal(room.nextRound(0).ok, true);
  room.letters[room.roundIndex] = 'M';
  room.round.letter = 'M';
  clock.t += REVEAL_DURATION_MS + 1;
  room.tick();
  assert.equal(room.round.selfScores.size, 0);

  closeWith(room, { [alice.id]: { ville: 'Metz' } });
  room.markReady(alice.id);
  room.markReady(bob.id);
  assert.equal(entry(room, 'ville', alice.id).points, 2, 'plus aucune note de la manche d\'avant');
  assert.equal(room.players.get(alice.id).score, 2);
});
