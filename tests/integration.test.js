import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { GameHub } from '../src/game/hub.js';
import { createValidator } from '../src/ai/validator.js';
import { TestClient, validAnswersFor } from './helpers/client.js';
import { TOTAL_ROUNDS } from '../src/game/letters.js';

/** Serveur réel + validation déterministe (mode secours, aucun appel réseau). */
async function startServer({ roundDurationMs = 2_000, revealDurationMs = 30 } = {}) {
  const hub = new GameHub({
    validate: createValidator({ hasCredentials: () => false, logger: { warn() {} } }),
    logger: { warn() {}, error() {} },
    roundDurationMs,
    revealDurationMs,
  });
  const { server } = createServer({ hub });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hub,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      hub.stop();
    },
  };
}

async function twoPlayers(ctx) {
  const alice = new TestClient(ctx.baseUrl);
  const bob = new TestClient(ctx.baseUrl);
  await alice.create('Alice');
  await bob.join(alice.code, 'Bob');
  await alice.openStream();
  await bob.openStream();
  return { alice, bob };
}

// §15.16
test('les deux joueurs reçoivent la même lettre, le même temps et les mêmes résultats', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.close());
  const { alice, bob } = await twoPlayers(ctx);

  await alice.start();
  await alice.waitFor((s) => s.phase === 'playing', { label: 'manche ouverte (Alice)' });
  await bob.waitFor((s) => s.phase === 'playing', { label: 'manche ouverte (Bob)' });

  assert.equal(alice.last.round.letter, bob.last.round.letter);
  assert.equal(alice.last.round.endsAt, bob.last.round.endsAt);
  assert.equal(alice.last.round.index, bob.last.round.index);
  assert.equal(alice.last.roundNumber, 1);

  const letter = alice.last.round.letter;
  await alice.sendAnswers(validAnswersFor(letter));
  await bob.sendAnswers(validAnswersFor(letter));
  await alice.finish();

  await alice.waitFor((s) => s.phase === 'results', { label: 'résultats (Alice)' });
  await bob.waitFor((s) => s.phase === 'results', { label: 'résultats (Bob)' });
  assert.deepEqual(alice.last.results.totals, bob.last.results.totals);
  assert.equal(alice.last.results.letter, bob.last.results.letter);

  alice.close();
  bob.close();
});

// §15.5 vu du réseau
test('le clic FIN d\'un joueur clôture la manche pour tout le monde', async (t) => {
  const ctx = await startServer({ roundDurationMs: 60_000 });
  t.after(() => ctx.close());
  const { alice, bob } = await twoPlayers(ctx);
  await alice.start();
  await alice.waitFor((s) => s.phase === 'playing');
  const letter = alice.last.round.letter;

  await alice.sendAnswers(validAnswersFor(letter));
  await bob.sendAnswers({ ville: 'Metz' }); // Bob n'a pas fini
  const response = await alice.finish();
  assert.equal(response.data.ok, true);

  await bob.waitFor((s) => s.phase !== 'playing', { label: 'Bob est clôturé aussi' });
  assert.ok(['validating', 'results'].includes(bob.last.phase));

  // Après la clôture, plus aucune réponse n'est acceptée.
  const late = await bob.sendAnswers({ ville: 'Marseille' });
  assert.equal(late.data.ok, false);
  await bob.waitFor((s) => s.phase === 'results');
  const bobVille = bob.last.results.categories
    .find((c) => c.key === 'ville')
    .entries.find((e) => e.playerId === bob.playerId);
  assert.equal(bobVille.raw, 'Metz', 'la réponse tardive n\'a pas été enregistrée');

  alice.close();
  bob.close();
});

test('deux clics FIN quasi simultanés : une seule clôture, un seul comptage', async (t) => {
  const ctx = await startServer({ roundDurationMs: 60_000 });
  t.after(() => ctx.close());
  const { alice, bob } = await twoPlayers(ctx);
  await alice.start();
  await alice.waitFor((s) => s.phase === 'playing');
  const letter = alice.last.round.letter;
  await alice.sendAnswers(validAnswersFor(letter));
  await bob.sendAnswers(validAnswersFor(letter));

  // Envoi simultané des deux clôtures.
  const [a, b] = await Promise.all([alice.finish(), bob.finish()]);
  const accepted = [a, b].filter((r) => r.data.ok === true);
  assert.equal(accepted.length, 1, 'une seule clôture acceptée');

  await alice.waitFor((s) => s.phase === 'results');
  const room = ctx.hub.getRoom(alice.code);
  assert.equal(room.history.filter(Boolean).length, 1, 'une seule manche enregistrée');
  // Réponses identiques des deux joueurs : 1 point par rubrique valide, pas de double comptage.
  const totals = alice.last.results.totals;
  assert.equal(totals[alice.playerId], totals[bob.playerId]);
  assert.ok(totals[alice.playerId] <= 8);

  alice.close();
  bob.close();
});

// §15.6 par le réseau, sans interaction
test('à 00:00 la manche se clôt seule, même sans clic', async (t) => {
  const ctx = await startServer({ roundDurationMs: 700 });
  t.after(() => ctx.close());
  const { alice, bob } = await twoPlayers(ctx);
  await alice.start();
  await alice.waitFor((s) => s.phase === 'playing');
  await alice.sendAnswers({ ville: validAnswersFor(alice.last.round.letter).ville });

  await alice.waitFor((s) => s.phase === 'results', { timeout: 6000, label: 'clôture automatique' });
  assert.equal(alice.last.round.closeReason, 'timeout');
  assert.deepEqual(alice.last.results.totals, bob.last.results.totals);

  alice.close();
  bob.close();
});

// §15.17
test('les scores ne peuvent pas être modifiés depuis le navigateur', async (t) => {
  const ctx = await startServer({ roundDurationMs: 60_000 });
  t.after(() => ctx.close());
  const { alice, bob } = await twoPlayers(ctx);
  await alice.start();
  await alice.waitFor((s) => s.phase === 'playing');

  // Tentatives d'injection via les routes existantes.
  const forged = await alice.post(`/api/rooms/${alice.code}/answers`, {
    token: alice.token,
    answers: { ville: 'Marseille' },
    score: 999,
    points: 999,
  });
  assert.equal(forged.data.ok, true);
  assert.equal(ctx.hub.getRoom(alice.code).players.get(alice.playerId).score, 0);

  // Jeton d'un autre joueur refusé / jeton inventé refusé.
  const noToken = await alice.post(`/api/rooms/${alice.code}/finish`, { token: 'faux-jeton' });
  assert.equal(noToken.status, 401);

  // Aucune route n'accepte d'écrire un score.
  for (const route of ['score', 'scores', 'results', 'verdicts', 'admin']) {
    const res = await alice.post(`/api/rooms/${alice.code}/${route}`, {
      token: alice.token, score: 999,
    });
    assert.equal(res.status, 404, `la route ${route} ne doit pas exister`);
  }

  // Un joueur ne peut pas lancer la partie à la place de l'hôte.
  const notHost = await bob.start();
  assert.equal(notHost.status, 403);

  alice.close();
  bob.close();
});

test('aucune clé d\'API n\'est exposée au navigateur', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.close());
  const config = await fetch(`${ctx.baseUrl}/api/config`).then((r) => r.json());
  const serialized = JSON.stringify(config);
  assert.ok(!/sk-ant|ANTHROPIC_API_KEY/i.test(serialized));
  assert.equal(typeof config.ai.configured, 'boolean');
  assert.equal(config.categories.length, 8);
  assert.equal(config.totalRounds, 15);
  assert.equal(config.roundDurationMs, 240_000, 'la durée officielle reste 240 s');
});

// §15.20 — partie complète
test('une partie complète enchaîne 15 manches avec 15 lettres distinctes puis le classement', async (t) => {
  const ctx = await startServer({ roundDurationMs: 60_000, revealDurationMs: 10 });
  t.after(() => ctx.close());
  const { alice, bob } = await twoPlayers(ctx);
  await alice.start();

  const lettersSeen = [];
  for (let round = 0; round < TOTAL_ROUNDS; round++) {
    await alice.waitFor((s) => s.phase === 'playing' && s.round.index === round, {
      label: `manche ${round + 1} ouverte`,
    });
    const letter = alice.last.round.letter;
    lettersSeen.push(letter);
    assert.equal(alice.last.roundNumber, round + 1);

    await alice.sendAnswers(validAnswersFor(letter));
    // Bob ne remplit qu'une rubrique : il ne peut pas clôturer.
    await bob.sendAnswers({ ville: validAnswersFor(letter).ville });
    const bobFinish = await bob.finish();
    assert.equal(bobFinish.data.ok, false, 'FIN refusé avec des rubriques vides');

    await alice.finish();
    await alice.waitFor((s) => s.phase === 'results' || s.phase === 'finished', {
      label: `résultats manche ${round + 1}`,
    });
    if (round < TOTAL_ROUNDS - 1) {
      await alice.next(round);
    }
  }

  assert.equal(new Set(lettersSeen).size, TOTAL_ROUNDS, 'aucune lettre répétée sur 15 manches');
  await alice.waitFor((s) => s.phase === 'finished', { label: 'classement final' });

  const final = alice.last;
  assert.equal(final.phase, 'finished');
  const winner = [...final.players].sort((x, y) => y.score - x.score)[0];
  assert.equal(winner.id, alice.playerId, 'Alice a répondu partout, elle gagne');
  assert.equal(winner.roundScores.filter((v) => typeof v === 'number').length, TOTAL_ROUNDS);
  assert.equal(
    winner.score,
    winner.roundScores.reduce((sum, v) => sum + v, 0),
    'le total correspond à la somme des manches',
  );
  assert.equal(final.lettersUsed.length, TOTAL_ROUNDS);

  // Une nouvelle partie repart sur un tirage indépendant, scores remis à zéro.
  await alice.post(`/api/rooms/${alice.code}/newgame`, { token: alice.token });
  await alice.waitFor((s) => s.phase === 'lobby');
  assert.equal(alice.last.players.every((p) => p.score === 0), true);

  alice.close();
  bob.close();
});
