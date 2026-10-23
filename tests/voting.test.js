/**
 * Arbitrage par le salon : contestation d'une réponse, majorité, et garanties
 * (pas d'auto-contestation, pas de double comptage, fin automatique du vote).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, PHASE, VOTE_DURATION_MS, REVEAL_DURATION_MS } from '../src/game/room.js';
import { makeVerdictKey, STATUS } from '../src/game/scoring.js';

function verdict(status, recognized) {
  return {
    status,
    recognized,
    groupKey: recognized.toLowerCase(),
    reason: '',
    confidence: 0.8,
    source: 'test',
  };
}

function setup(names = ['A', 'B', 'C']) {
  const clock = { t: 1_000_000 };
  const room = new Room({ code: 'VOTE', now: () => clock.t });
  const players = names.map((n) => room.addPlayer(n));
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
      verdicts.set(
        makeVerdictKey(playerId, categoryKey),
        verdict(statuses[`${playerId}::${categoryKey}`] ?? STATUS.VALID, raw),
      );
    }
  }
  room.closeByTimeout();
  room.applyVerdicts({ verdicts, source: 'test' });
}

function entry(room, categoryKey, playerId) {
  return room.round.results.categories
    .find((c) => c.key === categoryKey)
    .entries.find((e) => e.playerId === playerId);
}

test('après validation, le salon passe en phase de contestation', () => {
  const { room, players } = setup();
  const [a, b, c] = players;
  closeWith(room, {
    [a.id]: { ville: 'Marseille' },
    [b.id]: { ville: 'Metz' },
    [c.id]: { ville: 'Mulhouse' },
  });
  assert.equal(room.phase, PHASE.VOTING);
  assert.equal(room.round.scored, false, 'aucun point attribué avant le vote');
  assert.equal(room.players.get(a.id).score, 0);
});

test('en solo, il n\'y a pas de vote : les points sont appliqués directement', () => {
  const { room, players } = setup(['Solo']);
  closeWith(room, { [players[0].id]: { ville: 'Marseille' } });
  assert.equal(room.phase, PHASE.RESULTS);
  assert.equal(room.players.get(players[0].id).score, 2);
});

test('la majorité des autres joueurs refuse une réponse', () => {
  const { room, players } = setup();
  const [a, b, c] = players;
  closeWith(room, {
    [a.id]: { ville: 'Mordor' },
    [b.id]: { ville: 'Metz' },
    [c.id]: { ville: 'Mulhouse' },
  });
  assert.equal(room.requiredChallenges(a.id), 2, 'il faut 2 voix sur 2 autres joueurs');
  assert.equal(room.toggleChallenge(b.id, { targetPlayerId: a.id, categoryKey: 'ville' }).ok, true);
  room.markReady(a.id);
  room.markReady(b.id);
  room.markReady(c.id);
  assert.equal(room.phase, PHASE.RESULTS);
  assert.equal(entry(room, 'ville', a.id).points, 2, 'une seule voix ne suffit pas');
});

test('deux voix sur trois joueurs annulent la réponse', () => {
  const { room, players } = setup();
  const [a, b, c] = players;
  closeWith(room, {
    [a.id]: { ville: 'Mordor' },
    [b.id]: { ville: 'Metz' },
    [c.id]: { ville: 'Mulhouse' },
  });
  room.toggleChallenge(b.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  room.toggleChallenge(c.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  room.markReady(a.id);
  room.markReady(b.id);
  room.markReady(c.id);
  const refused = entry(room, 'ville', a.id);
  assert.equal(refused.points, 0);
  assert.equal(refused.status, STATUS.INVALID);
  assert.match(refused.reason, /Refusée par le salon \(2 contestations\)/);
  assert.equal(room.players.get(a.id).score, 0);
  assert.equal(room.players.get(b.id).score, 2, 'les autres gardent leurs points');
});

test('on ne peut pas contester sa propre réponse', () => {
  const { room, players } = setup();
  const [a] = players;
  closeWith(room, { [a.id]: { ville: 'Marseille' } });
  const result = room.toggleChallenge(a.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  assert.equal(result.ok, false);
  assert.match(result.error, /sa propre réponse/);
});

test('une réponse déjà à zéro ne peut pas être contestée', () => {
  const { room, players } = setup();
  const [a, b] = players;
  closeWith(
    room,
    { [a.id]: { ville: 'Paris' }, [b.id]: { ville: 'Metz' } },
    { [`${a.id}::ville`]: STATUS.INVALID },
  );
  const result = room.toggleChallenge(b.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  assert.equal(result.ok, false);
  assert.match(result.error, /aucun point/);
});

test('une contestation peut être retirée', () => {
  const { room, players } = setup();
  const [a, b, c] = players;
  closeWith(room, {
    [a.id]: { ville: 'Mordor' },
    [b.id]: { ville: 'Metz' },
    [c.id]: { ville: 'Mulhouse' },
  });
  room.toggleChallenge(b.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  room.toggleChallenge(c.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  room.toggleChallenge(c.id, { targetPlayerId: a.id, categoryKey: 'ville' }); // retrait
  room.markReady(a.id);
  room.markReady(b.id);
  room.markReady(c.id);
  assert.equal(entry(room, 'ville', a.id).points, 2);
});

test('le vote se termine seul à la fin du compte à rebours', () => {
  const { room, clock, players } = setup();
  const [a, b, c] = players;
  closeWith(room, {
    [a.id]: { ville: 'Mordor' },
    [b.id]: { ville: 'Metz' },
    [c.id]: { ville: 'Mulhouse' },
  });
  room.toggleChallenge(b.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  room.toggleChallenge(c.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  clock.t += VOTE_DURATION_MS;
  const effects = room.tick();
  assert.ok(effects.some((e) => e.type === 'vote-closed'));
  assert.equal(room.phase, PHASE.RESULTS);
  assert.equal(entry(room, 'ville', a.id).points, 0);
});

test('les points ne sont attribués qu\'une fois malgré plusieurs clôtures du vote', () => {
  const { room, clock, players } = setup();
  const [a, b, c] = players;
  closeWith(room, {
    [a.id]: { ville: 'Marseille' },
    [b.id]: { ville: 'Metz' },
    [c.id]: { ville: 'Mulhouse' },
  });
  room.markReady(a.id);
  room.markReady(b.id);
  room.markReady(c.id);
  const score = room.players.get(a.id).score;
  assert.equal(score, 2);
  room.finalizeRound();
  clock.t += VOTE_DURATION_MS;
  room.tick();
  assert.equal(room.players.get(a.id).score, score, 'aucun double comptage');
});

test('un joueur déconnecté ne bloque pas la fin du vote', () => {
  const { room, players } = setup();
  const [a, b, c] = players;
  closeWith(room, {
    [a.id]: { ville: 'Marseille' },
    [b.id]: { ville: 'Metz' },
    [c.id]: { ville: 'Mulhouse' },
  });
  room.setConnected(a.id, true);
  room.setConnected(b.id, true);
  room.setConnected(c.id, false); // C a fermé son onglet
  room.markReady(a.id);
  room.markReady(b.id);
  assert.equal(room.phase, PHASE.RESULTS, 'les joueurs présents suffisent');
});

test('le vote n\'est pas ouvert tant que la manche n\'est pas validée', () => {
  const { room, players } = setup();
  const [a, b] = players;
  room.saveAnswers(a.id, { ville: 'Marseille' });
  const result = room.toggleChallenge(b.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Aucun vote/);
});

test('la contestation vise bien la bonne rubrique du bon joueur', () => {
  const { room, players } = setup();
  const [a, b, c] = players;
  closeWith(room, {
    [a.id]: { ville: 'Mordor', animal: 'Marmotte' },
    [b.id]: { ville: 'Metz', animal: 'Mouton' },
    [c.id]: { ville: 'Mulhouse', animal: 'Merle' },
  });
  room.toggleChallenge(b.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  room.toggleChallenge(c.id, { targetPlayerId: a.id, categoryKey: 'ville' });
  room.markReady(a.id);
  room.markReady(b.id);
  room.markReady(c.id);
  assert.equal(entry(room, 'ville', a.id).points, 0, 'la ville contestée tombe');
  assert.equal(entry(room, 'animal', a.id).points, 2, "l'animal du même joueur est intact");
  assert.equal(entry(room, 'ville', b.id).points, 2, 'la ville des autres est intacte');
});
