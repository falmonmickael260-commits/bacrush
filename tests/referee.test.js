/**
 * Mode « un arbitre » : un joueur désigné accepte ou refuse les réponses.
 * Il joue aussi et peut juger les siennes ; il ne peut pas repêcher une
 * réponse qui ne commence pas par la lettre imposée.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Room, PHASE, ARBITRATION, REFEREE_DURATION_MS, VOTE_DURATION_MS, REVEAL_DURATION_MS,
} from '../src/game/room.js';
import { makeVerdictKey, STATUS } from '../src/game/scoring.js';

function verdict(status, recognized, reason = '') {
  return { status, recognized, groupKey: recognized.toLowerCase(), reason, confidence: 0.6 };
}

function setup({ names = ['Alice', 'Bob', 'Chloé'], refereeIndex = 1 } = {}) {
  const clock = { t: 1_000_000 };
  const room = new Room({ code: 'ARBI', now: () => clock.t });
  const players = names.map((n) => room.addPlayer(n));
  room.setArbitration({ mode: ARBITRATION.REFEREE, refereeId: players[refereeIndex].id });
  room.startGame();
  room.letters[room.roundIndex] = 'M';
  room.round.letter = 'M';
  clock.t += REVEAL_DURATION_MS + 1;
  room.tick();
  return { room, clock, players, referee: players[refereeIndex] };
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

test('le mode d\'arbitrage se choisit dans le salon, pas en cours de partie', () => {
  const room = new Room({ code: 'AAAA' });
  const a = room.addPlayer('A');
  const b = room.addPlayer('B');
  assert.equal(room.arbitrationMode, ARBITRATION.VOTE, 'le vote reste le mode par défaut');
  assert.equal(room.setArbitration({ mode: ARBITRATION.REFEREE, refereeId: b.id }).ok, true);
  assert.equal(room.refereeId, b.id);
  room.startGame();
  const late = room.setArbitration({ mode: ARBITRATION.VOTE });
  assert.equal(late.ok, false);
  assert.match(late.error, /déjà lancée/);
  assert.equal(room.refereeId, b.id, 'le choix tient pour toute la partie');
  assert.ok(a);
});

test('l\'arbitre doit être un joueur du salon', () => {
  const room = new Room({ code: 'BBBB' });
  room.addPlayer('A');
  const bad = room.setArbitration({ mode: ARBITRATION.REFEREE, refereeId: 'fantome' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Arbitre inconnu/);
});

test('l\'arbitre dispose de plus de temps que le vote du salon', () => {
  const { room, clock } = setup();
  const [a] = room.playerList;
  closeWith(room, { [a.id]: { ville: 'Marseille' } });
  assert.equal(room.phase, PHASE.VOTING);
  assert.equal(room.round.voteEndsAt - clock.t, REFEREE_DURATION_MS);
  assert.ok(REFEREE_DURATION_MS > VOTE_DURATION_MS);
});

test('seul l\'arbitre décide, et la contestation est désactivée', () => {
  const { room, players, referee } = setup();
  const [alice, , chloe] = players;
  closeWith(room, {
    [alice.id]: { ville: 'Marseille' },
    [referee.id]: { ville: 'Metz' },
    [chloe.id]: { ville: 'Mulhouse' },
  });
  const notReferee = room.refereeDecide(alice.id, {
    targetPlayerId: chloe.id, categoryKey: 'ville', accept: false,
  });
  assert.equal(notReferee.ok, false);
  assert.match(notReferee.error, /Seul l'arbitre/);

  const challenge = room.toggleChallenge(alice.id, {
    targetPlayerId: chloe.id, categoryKey: 'ville',
  });
  assert.equal(challenge.ok, false);
  assert.match(challenge.error, /arbitrée par un joueur/);
});

test('l\'arbitre refuse une réponse : elle tombe à zéro', () => {
  const { room, players, referee } = setup();
  const [alice, , chloe] = players;
  closeWith(room, {
    [alice.id]: { ville: 'Mordor' },
    [referee.id]: { ville: 'Metz' },
    [chloe.id]: { ville: 'Mulhouse' },
  });
  assert.equal(room.refereeDecide(referee.id, {
    targetPlayerId: alice.id, categoryKey: 'ville', accept: false,
  }).ok, true);
  room.markReady(referee.id);
  assert.equal(room.phase, PHASE.RESULTS);
  const refused = entry(room, 'ville', alice.id);
  assert.equal(refused.points, 0);
  assert.equal(refused.reason, "Refusée par l'arbitre");
  assert.equal(entry(room, 'ville', chloe.id).points, 2, 'les autres gardent leurs points');
});

test('l\'arbitre repêche une réponse que la machine n\'a pas su trancher', () => {
  const { room, players, referee } = setup();
  const [alice] = players;
  closeWith(
    room,
    { [alice.id]: { ville: 'Mazamet' } },
    { [makeVerdictKey(alice.id, 'ville')]: STATUS.INVALID },
  );
  assert.equal(room.refereeDecide(referee.id, {
    targetPlayerId: alice.id, categoryKey: 'ville', accept: true,
  }).ok, true);
  room.markReady(referee.id);
  const rescued = entry(room, 'ville', alice.id);
  assert.equal(rescued.points, 2);
  assert.equal(rescued.status, STATUS.VALID);
  assert.equal(rescued.reason, "Acceptée par l'arbitre");
});

test('l\'arbitre ne peut pas repêcher une réponse à la mauvaise lettre', () => {
  const { room, players, referee } = setup();
  const [alice] = players;
  closeWith(
    room,
    { [alice.id]: { ville: 'Paris' } },
    { [makeVerdictKey(alice.id, 'ville')]: STATUS.INVALID },
  );
  const refused = room.refereeDecide(referee.id, {
    targetPlayerId: alice.id, categoryKey: 'ville', accept: true,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /ne commence pas par M/);
  room.markReady(referee.id);
  assert.equal(entry(room, 'ville', alice.id).points, 0);
});

test('l\'arbitre juge aussi ses propres réponses', () => {
  const { room, players, referee } = setup();
  const [alice] = players;
  closeWith(
    room,
    { [alice.id]: { ville: 'Metz' }, [referee.id]: { ville: 'Mazamet' } },
    { [makeVerdictKey(referee.id, 'ville')]: STATUS.INVALID },
  );
  assert.equal(room.refereeDecide(referee.id, {
    targetPlayerId: referee.id, categoryKey: 'ville', accept: true,
  }).ok, true);
  room.markReady(referee.id);
  assert.equal(entry(room, 'ville', referee.id).points, 2);
});

test('une décision peut être annulée : le verdict automatique reprend la main', () => {
  const { room, players, referee } = setup();
  const [alice] = players;
  closeWith(room, { [alice.id]: { ville: 'Marseille' } });
  room.refereeDecide(referee.id, { targetPlayerId: alice.id, categoryKey: 'ville', accept: false });
  room.refereeDecide(referee.id, { targetPlayerId: alice.id, categoryKey: 'ville', accept: false });
  room.markReady(referee.id);
  assert.equal(entry(room, 'ville', alice.id).points, 2);
});

test('les autres joueurs ne clôturent pas la manche à la place de l\'arbitre', () => {
  const { room, players, referee } = setup();
  const [alice, , chloe] = players;
  closeWith(room, { [alice.id]: { ville: 'Marseille' }, [chloe.id]: { ville: 'Metz' } });
  room.markReady(alice.id);
  room.markReady(chloe.id);
  assert.equal(room.phase, PHASE.VOTING, 'seul l\'arbitre peut valider');
  room.markReady(referee.id);
  assert.equal(room.phase, PHASE.RESULTS);
});

test('sans décision de l\'arbitre, le compte à rebours applique les verdicts automatiques', () => {
  const { room, clock, players } = setup();
  const [alice] = players;
  closeWith(room, { [alice.id]: { ville: 'Marseille' } });
  clock.t += REFEREE_DURATION_MS;
  room.tick();
  assert.equal(room.phase, PHASE.RESULTS);
  assert.equal(entry(room, 'ville', alice.id).points, 2);
});

test('si l\'arbitre quitte le salon, la partie repasse au vote', () => {
  const room = new Room({ code: 'CCCC' });
  const a = room.addPlayer('A');
  const b = room.addPlayer('B');
  room.setArbitration({ mode: ARBITRATION.REFEREE, refereeId: b.id });
  room.removePlayer(b.id);
  assert.equal(room.arbitrationMode, ARBITRATION.VOTE);
  assert.equal(room.refereeId, null);
  assert.ok(a);
});
