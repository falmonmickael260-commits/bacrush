/**
 * Partie à 8 joueurs : capacité du salon, diffusion simultanée, barème et
 * clôture quand huit connexions distinctes jouent la même manche.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { GameHub } from '../src/game/hub.js';
import { createValidator } from '../src/ai/validator.js';
import { MAX_PLAYERS } from '../src/game/room.js';
import { TestClient, passVote } from './helpers/client.js';

async function startServer() {
  const hub = new GameHub({
    validate: createValidator({ hasCredentials: () => false, logger: { warn() {} } }),
    logger: { warn() {}, error() {} },
    roundDurationMs: 60_000,
    revealDurationMs: 30,
  });
  const { server } = createServer({ hub });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    hub,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
      hub.stop();
    }),
  };
}

test('un salon accueille 8 joueurs et refuse le neuvième', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.close());

  assert.equal(MAX_PLAYERS, 8);
  const host = new TestClient(ctx.baseUrl);
  await host.create('Joueur 1');
  const others = [];
  for (let i = 2; i <= MAX_PLAYERS; i++) {
    const client = new TestClient(ctx.baseUrl);
    const joined = await client.join(host.code, `Joueur ${i}`);
    assert.equal(joined.code, host.code);
    others.push(client);
  }

  const ninth = new TestClient(ctx.baseUrl);
  const refused = await ninth.post(`/api/rooms/${host.code}/join`, { name: 'Joueur 9' });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /complet/i);
  assert.equal(ctx.hub.getRoom(host.code).players.size, 8);
});

test('les 8 joueurs jouent la même manche et reçoivent les mêmes résultats', async (t) => {
  const ctx = await startServer();
  t.after(() => ctx.close());

  const host = new TestClient(ctx.baseUrl);
  await host.create('Joueur 1');
  const clients = [host];
  for (let i = 2; i <= MAX_PLAYERS; i++) {
    const client = new TestClient(ctx.baseUrl);
    await client.join(host.code, `Joueur ${i}`);
    clients.push(client);
  }
  // Huit connexions temps réel distinctes, ouvertes en parallèle.
  await Promise.all(clients.map((c) => c.openStream()));
  assert.equal(host.last.players.length, 8);
  assert.equal(host.last.maxPlayers, 8);

  await host.start();
  await Promise.all(
    clients.map((c) => c.waitFor((s) => s.phase === 'playing', { label: `manche ouverte (${c.name})` })),
  );

  // Tous voient la même lettre et la même échéance.
  const letters = new Set(clients.map((c) => c.last.round.letter));
  const deadlines = new Set(clients.map((c) => c.last.round.endsAt));
  assert.equal(letters.size, 1, 'une seule lettre pour tout le salon');
  assert.equal(deadlines.size, 1, 'un seul chronomètre pour tout le salon');

  // Quatre joueurs donnent la même ville, quatre en donnent une différente.
  const letter = host.last.round.letter;
  const commune = `${letter}ville`;
  await Promise.all(
    clients.map((c, index) =>
      c.sendAnswers({ ville: index < 4 ? commune : `${commune}${index}` }),
    ),
  );
  await Promise.all(
    clients.map((c) => c.waitFor((s) => s.you.filled === 1, { label: 'réponse enregistrée' })),
  );

  // Les huit cliquent FIN quasi simultanément (aucun n'a rempli les 8 rubriques).
  const responses = await Promise.all(clients.map((c) => c.finish()));
  assert.equal(responses.filter((r) => r.data.ok).length, 0, 'FIN refusé si 8 rubriques non remplies');

  // Le premier joueur complète ses 8 rubriques puis clôture.
  const full = {};
  for (const key of ['prenom_fille', 'prenom_garcon', 'ville', 'pays', 'metier', 'animal', 'fruit_legume', 'objet']) {
    full[key] = key === 'ville' ? commune : `${letter}${key}`;
  }
  await host.sendAnswers(full);
  const closing = await Promise.all(clients.map((c) => c.finish()));
  assert.equal(closing.filter((r) => r.data.ok).length, 1, 'une seule clôture acceptée');

  await Promise.all(
    clients.map((c) => c.waitFor((s) => s.phase === 'voting', { label: `vote (${c.name})` })),
  );
  await passVote(clients);
  await Promise.all(
    clients.map((c) => c.waitFor((s) => s.phase === 'results', { label: `résultats (${c.name})` })),
  );

  // Résultats identiques pour les huit.
  const reference = JSON.stringify(host.last.results.totals);
  for (const client of clients) {
    assert.equal(JSON.stringify(client.last.results.totals), reference);
  }

  // Barème : 4 joueurs sur la même ville -> 1 point ; les 4 autres -> 2 points.
  const ville = host.last.results.categories.find((c) => c.key === 'ville');
  const shared = ville.groups.find((g) => g.playerIds.length === 4);
  assert.ok(shared, 'les 4 réponses identiques forment un seul groupe');
  assert.equal(shared.points, 1);
  assert.equal(ville.groups.filter((g) => g.playerIds.length === 1).length, 4);
  for (const entry of ville.entries) {
    assert.equal(entry.points, entry.groupId === shared.id ? 1 : 2);
  }

  clients.forEach((c) => c.close());
});
