/**
 * Options de partie : longueur (6, 12, 18), départ d'un joueur, durée minimale
 * des corrections, et commandes réservées à l'hôte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Room, PHASE, ARBITRATION, REVEAL_DURATION_MS,
  VOTE_DURATION_MS, SELF_DURATION_MS, REFEREE_DURATION_MS,
} from '../src/game/room.js';
import { ROUND_OPTIONS } from '../src/game/letters.js';
import { makeVerdictKey } from '../src/game/scoring.js';

function setup({ names = ['Hôte', 'Bob', 'Chloé'], rounds, mode } = {}) {
  const clock = { t: 1_000_000 };
  const room = new Room({ code: 'OPTS', now: () => clock.t });
  const players = names.map((n) => room.addPlayer(n));
  for (const p of players) room.setConnected(p.id, true);
  if (rounds) room.setRoundCount(rounds);
  if (mode) room.setArbitration({ mode, refereeId: players[1].id });
  room.startGame();
  room.letters[room.roundIndex] = 'M';
  room.round.letter = 'M';
  clock.t += REVEAL_DURATION_MS + 1;
  room.tick();
  return { room, clock, players };
}

function closeRound(room, answersByPlayer) {
  const verdicts = new Map();
  for (const [playerId, answers] of Object.entries(answersByPlayer)) {
    room.saveAnswers(playerId, answers);
    for (const [categoryKey, raw] of Object.entries(answers)) {
      if (!raw) continue;
      verdicts.set(makeVerdictKey(playerId, categoryKey), {
        status: 'valide', recognized: raw, groupKey: raw.toLowerCase(), reason: '', confidence: 1,
      });
    }
  }
  room.closeByTimeout();
  room.applyVerdicts({ verdicts, source: 'test' });
}

// --- longueur de la partie -------------------------------------------------
test('l\'hôte choisit 6, 12 ou 18 manches', () => {
  for (const count of ROUND_OPTIONS) {
    const room = new Room({ code: 'LEN' });
    room.addPlayer('Hôte');
    assert.equal(room.setRoundCount(count).ok, true);
    room.startGame();
    assert.equal(room.totalRounds, count);
    assert.equal(room.publicState().totalRounds, count);
    assert.ok(room.round.wheel.length >= count, 'assez de lettres pour toute la partie');
  }
});

test('une longueur hors liste est refusée', () => {
  const room = new Room({ code: 'LEN2' });
  room.addPlayer('Hôte');
  for (const invalide of [0, 5, 15, 20, 'douze', null]) {
    const result = room.setRoundCount(invalide);
    assert.equal(result.ok, false, `${invalide} ne doit pas être accepté`);
  }
  assert.equal(room.totalRounds, 12, 'la valeur par défaut est conservée');
});

test('la longueur ne change plus une fois la partie lancée', () => {
  const { room } = setup({ rounds: 6 });
  const late = room.setRoundCount(18);
  assert.equal(late.ok, false);
  assert.equal(room.totalRounds, 6);
});

test('une partie de 6 manches se termine à la sixième', () => {
  const { room, players } = setup({ rounds: 6 });
  const [host] = players;
  for (let i = 0; i < 6; i++) {
    closeRound(room, { [host.id]: { ville: `M${i}ville` } });
    room.closeArbitration(host.id);
    if (i < 5) assert.equal(room.nextRound(i, host.id).ok, true);
  }
  assert.equal(room.phase, PHASE.FINISHED);
  assert.equal(room.history.filter(Boolean).length, 6);
});

// --- durée des corrections -------------------------------------------------
test('les corrections durent au moins deux minutes dans les trois modes', () => {
  assert.ok(VOTE_DURATION_MS >= 120_000, 'vote du salon');
  assert.ok(SELF_DURATION_MS >= 120_000, 'chacun se note');
  assert.ok(REFEREE_DURATION_MS >= 120_000, 'arbitre');
});

test('le compte à rebours des corrections correspond au mode choisi', () => {
  for (const [mode, duree] of [
    [ARBITRATION.VOTE, VOTE_DURATION_MS],
    [ARBITRATION.SELF, SELF_DURATION_MS],
    [ARBITRATION.REFEREE, REFEREE_DURATION_MS],
  ]) {
    const { room, clock, players } = setup({ mode });
    closeRound(room, { [players[0].id]: { ville: 'Marseille' } });
    assert.equal(room.phase, PHASE.VOTING);
    assert.equal(room.round.voteEndsAt - clock.t, duree, `mode ${mode}`);
  }
});

// --- l'hôte enchaîne -------------------------------------------------------
test('l\'hôte clôt les corrections sans attendre le compte à rebours', () => {
  const { room, players } = setup();
  const [host, bob] = players;
  closeRound(room, { [host.id]: { ville: 'Marseille' }, [bob.id]: { ville: 'Metz' } });
  assert.equal(room.closeArbitration(bob.id).ok, false, 'un joueur ne clôt pas');
  assert.equal(room.phase, PHASE.VOTING);
  assert.equal(room.closeArbitration(host.id).ok, true);
  assert.equal(room.phase, PHASE.RESULTS);
  assert.equal(room.players.get(host.id).score, 2, 'les points sont bien appliqués');
});

test('l\'hôte seul lance la manche suivante', () => {
  const { room, players } = setup();
  const [host, bob] = players;
  closeRound(room, { [host.id]: { ville: 'Marseille' } });
  room.closeArbitration(host.id);
  const refus = room.nextRound(0, bob.id);
  assert.equal(refus.ok, false);
  assert.match(refus.error, /hôte/);
  assert.equal(room.nextRound(0, host.id).ok, true);
});

test('si l\'hôte a fermé son onglet, les autres peuvent enchaîner', () => {
  const { room, players } = setup();
  const [host, bob] = players;
  closeRound(room, { [host.id]: { ville: 'Marseille' } });
  room.closeArbitration(host.id);
  room.setConnected(host.id, false);
  assert.equal(room.hostUnavailable(), true);
  assert.equal(room.nextRound(0, bob.id).ok, true, 'la partie ne reste pas bloquée');
});

// --- quitter une partie ----------------------------------------------------
test('un joueur peut quitter : il disparaît du salon et des scores', () => {
  const { room, players } = setup();
  const [host, bob, chloe] = players;
  closeRound(room, {
    [host.id]: { ville: 'Marseille' },
    [bob.id]: { ville: 'Metz' },
    [chloe.id]: { ville: 'Mulhouse' },
  });
  room.closeArbitration(host.id);
  assert.equal(room.players.size, 3);

  room.removePlayer(bob.id);
  assert.equal(room.players.size, 2);
  assert.equal(room.playerByToken(bob.token), null, 'son jeton ne vaut plus rien');
  const state = room.publicState(host.id);
  assert.equal(state.players.length, 2);
  assert.ok(!state.players.some((p) => p.id === bob.id));
});

test('si l\'hôte quitte, un autre joueur devient hôte', () => {
  const { room, players } = setup();
  const [host, bob] = players;
  room.removePlayer(host.id);
  assert.notEqual(room.hostId, host.id);
  assert.ok(room.players.has(room.hostId));
  assert.equal(room.publicState(bob.id).canAdvance, true, 'le nouvel hôte peut enchaîner');
});

test('le départ d\'un joueur ne bloque pas les corrections en cours', () => {
  const { room, players } = setup();
  const [host, bob, chloe] = players;
  closeRound(room, {
    [host.id]: { ville: 'Marseille' },
    [bob.id]: { ville: 'Metz' },
    [chloe.id]: { ville: 'Mulhouse' },
  });
  room.markReady(host.id);
  room.markReady(chloe.id);
  assert.equal(room.phase, PHASE.VOTING, 'on attend encore Bob');
  room.removePlayer(bob.id);
  room.markReady(host.id); // relance la vérification
  assert.equal(room.phase, PHASE.RESULTS, 'les joueurs restants suffisent');
});

test('quitter pendant une manche ne casse pas le barème des autres', () => {
  const { room, players } = setup();
  const [host, bob, chloe] = players;
  room.saveAnswers(bob.id, { ville: 'Marseille' }); // Bob avait la même réponse que l'hôte
  room.removePlayer(bob.id); // puis il s'en va avant la clôture
  closeRound(room, { [host.id]: { ville: 'Marseille' }, [chloe.id]: { ville: 'Metz' } });
  room.closeArbitration(host.id);
  const ville = room.round.results.categories.find((c) => c.key === 'ville');
  assert.equal(ville.entries.length, 2, 'seuls les joueurs présents sont notés');
  assert.equal(
    ville.entries.find((e) => e.playerId === host.id).points,
    2,
    'la réponse de Bob, parti, ne partage plus les points',
  );
});
