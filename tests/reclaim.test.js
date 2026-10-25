/**
 * Reprise de place : un joueur qui plante, ferme son onglet ou quitte peut
 * revenir avec le code depuis le même appareil et retrouver son score.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, RECLAIM_WINDOW_MS, MAX_PLAYERS } from '../src/game/room.js';
import { createServer } from '../src/server.js';
import { GameHub } from '../src/game/hub.js';
import { createValidator } from '../src/ai/validator.js';
import { TestClient } from './helpers/client.js';

test('un joueur qui quitte retrouve sa place et son score', () => {
  let clock = 1_000;
  const room = new Room({ code: 'RCLM', now: () => clock });
  const alice = room.addPlayer('Alice');
  room.addPlayer('Bob');
  alice.score = 14;
  alice.roundScores = [8, 6];

  room.removePlayer(alice.id);
  assert.equal(room.players.size, 1);
  assert.equal(room.playerByToken(alice.token), null, 'son jeton ne répond plus');

  clock += 60_000;
  const back = room.reclaim(alice.token);
  assert.equal(back.ok, true);
  assert.equal(back.restored, true);
  assert.equal(back.player.name, 'Alice');
  assert.equal(back.player.score, 14, 'le score est conservé');
  assert.deepEqual(back.player.roundScores, [8, 6]);
  assert.equal(room.players.size, 2);
  assert.equal(room.playerByToken(alice.token).id, alice.id, 'même identité qu\'avant');
});

test('une place encore occupée se reprend sans rien casser', () => {
  const room = new Room({ code: 'RCL2' });
  const alice = room.addPlayer('Alice');
  const back = room.reclaim(alice.token);
  assert.equal(back.ok, true);
  assert.equal(back.already, true);
  assert.equal(room.players.size, 1, 'aucun doublon créé');
});

test('la place expire au bout du délai', () => {
  let clock = 0;
  const room = new Room({ code: 'RCL3', now: () => clock });
  const alice = room.addPlayer('Alice');
  room.addPlayer('Bob');
  room.removePlayer(alice.id);
  clock += RECLAIM_WINDOW_MS + 1;
  const back = room.reclaim(alice.token);
  assert.equal(back.ok, false);
  assert.match(back.error, /expirée/);
});

test('un jeton inconnu ne donne droit à rien', () => {
  const room = new Room({ code: 'RCL4' });
  room.addPlayer('Alice');
  assert.equal(room.reclaim('jeton-invente').ok, false);
  assert.equal(room.reclaim(undefined).ok, false);
  assert.equal(room.players.size, 1);
});

test('on ne reprend pas une place dans un salon devenu complet', () => {
  const room = new Room({ code: 'RCL5' });
  const alice = room.addPlayer('Alice');
  room.removePlayer(alice.id);
  for (let i = 0; i < MAX_PLAYERS; i++) room.addPlayer(`Joueur ${i}`);
  const back = room.reclaim(alice.token);
  assert.equal(back.ok, false);
  assert.match(back.error, /complet/i);
});

test('si tout le monde est parti, le revenant redevient hôte', () => {
  const room = new Room({ code: 'RCL6' });
  const alice = room.addPlayer('Alice');
  room.removePlayer(alice.id);
  assert.equal(room.hostId, null);
  const back = room.reclaim(alice.token);
  assert.equal(back.ok, true);
  assert.equal(room.hostId, alice.id);
});

test('par le réseau : fermer puis revenir avec le même jeton', async (t) => {
  const hub = new GameHub({
    validate: createValidator({ hasCredentials: () => false, logger: { warn() {} } }),
    logger: { warn() {}, error() {} },
    revealDurationMs: 20,
  });
  const { server } = createServer({ hub });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
    hub.stop();
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const alice = new TestClient(baseUrl);
  const bob = new TestClient(baseUrl);
  await alice.create('Alice');
  await bob.join(alice.code, 'Bob');
  await alice.openStream();

  // Alice quitte (onglet fermé, plantage, peu importe).
  await alice.post(`/api/rooms/${alice.code}/leave`, { token: alice.token });
  alice.close();
  assert.equal(hub.getRoom(alice.code).players.size, 1);

  // Elle revient avec le jeton gardé par son appareil.
  const back = await alice.post(`/api/rooms/${alice.code}/rejoin`, { token: alice.token });
  assert.equal(back.status, 200);
  assert.equal(back.data.playerId, alice.playerId, 'même identité');
  assert.equal(back.data.name, 'Alice');
  assert.equal(back.data.restored, true);
  assert.equal(hub.getRoom(alice.code).players.size, 2);

  // Et un jeton bidon ne donne rien.
  const faux = await alice.post(`/api/rooms/${alice.code}/rejoin`, { token: 'faux' });
  assert.equal(faux.status, 404);

  bob.close();
});
