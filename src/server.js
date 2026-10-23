import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameHub } from './game/hub.js';
import { CATEGORIES } from './shared/categories.js';
import { TOTAL_ROUNDS } from './game/letters.js';
import { ROUND_DURATION_MS, MAX_PLAYERS } from './game/room.js';
import { AI_MODE, UNCERTAIN_POLICY } from './ai/validator.js';
import { hasCredentials, DEFAULT_MODEL } from './ai/anthropic-validator.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');
const MAX_BODY = 8 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Corps de requête trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Garde-fou anti-flood, volontairement large : plusieurs joueurs d'un même
 * salon partagent souvent une seule adresse publique (box, 4G, école), et la
 * saisie envoie une requête par joueur toutes les 350 ms. La limite doit
 * arrêter un abus évident, jamais une partie normale à 8.
 *
 * Le seau est propre à chaque serveur (pas d'état de module partagé) et les
 * entrées inactives sont purgées.
 */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 600; // ~60 requêtes/seconde pour l'ensemble d'une adresse

function createRateLimiter() {
  const buckets = new Map();
  return function rateLimited(ip) {
    const now = Date.now();
    if (buckets.size > 500) {
      for (const [key, bucket] of buckets) {
        if (now > bucket.resetAt + 60_000) buckets.delete(key);
      }
    }
    const bucket = buckets.get(ip) ?? { count: 0, resetAt: now + RATE_WINDOW_MS };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + RATE_WINDOW_MS;
    }
    bucket.count++;
    buckets.set(ip, bucket);
    return bucket.count > RATE_MAX;
  };
}

export function createServer({ hub = new GameHub() } = {}) {
  hub.start();
  const rateLimited = createRateLimiter();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const ip = req.socket.remoteAddress ?? 'local';

    try {
      if (url.pathname === '/api/stream' && req.method === 'GET') {
        return handleStream(req, res, url, hub);
      }

      if (url.pathname.startsWith('/api/')) {
        if (rateLimited(ip)) return sendJSON(res, 429, { error: 'Trop de requêtes' });
        return await handleApi(req, res, url, hub);
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        return serveStatic(url.pathname, res);
      }
      return sendJSON(res, 405, { error: 'Méthode non autorisée' });
    } catch (err) {
      return sendJSON(res, 400, { error: err?.message ?? 'Requête invalide' });
    }
  });

  server.on('close', () => hub.stop());
  return { server, hub };
}

// ------------------------------------------------------------------- statique
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    return sendJSON(res, 403, { error: 'Interdit' });
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

// ------------------------------------------------------------------------ SSE
function handleStream(req, res, url, hub) {
  const room = hub.getRoom(url.searchParams.get('room'));
  if (!room) return sendJSON(res, 404, { error: 'Salle inconnue' });
  const player = room.playerByToken(url.searchParams.get('token'));
  if (!player) return sendJSON(res, 401, { error: 'Jeton invalide' });

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connecté\n\n');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const unsubscribe = hub.subscribe(room, player.id, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// ------------------------------------------------------------------- routes
async function handleApi(req, res, url, hub) {
  const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (segments[1] === 'health' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, rooms: hub.rooms.size });
  }

  // Aucune clé d'API n'est jamais exposée : seul l'état de configuration l'est.
  if (segments[1] === 'config' && req.method === 'GET') {
    return sendJSON(res, 200, {
      categories: CATEGORIES.map(({ key, label, icon, placeholder }) => ({
        key,
        label,
        icon,
        placeholder,
      })),
      totalRounds: TOTAL_ROUNDS,
      roundDurationMs: ROUND_DURATION_MS,
      maxPlayers: MAX_PLAYERS,
      ai: {
        mode: AI_MODE,
        configured: hasCredentials(),
        model: hasCredentials() ? DEFAULT_MODEL : null,
        uncertainPolicy: UNCERTAIN_POLICY,
      },
    });
  }

  if (segments[1] === 'rooms' && req.method === 'POST' && segments.length === 2) {
    const body = await readBody(req);
    const room = hub.createRoom();
    const player = room.addPlayer(body.name);
    return sendJSON(res, 201, {
      code: room.code,
      playerId: player.id,
      token: player.token,
      name: player.name,
    });
  }

  if (segments[1] === 'rooms' && segments.length >= 4) {
    const room = hub.getRoom(segments[2]);
    if (!room) return sendJSON(res, 404, { error: 'Salle inconnue' });
    const action = segments[3];
    const body = req.method === 'POST' ? await readBody(req) : {};

    if (action === 'join' && req.method === 'POST') {
      if (room.isFull) {
        return sendJSON(res, 409, {
          error: `Salon complet (${MAX_PLAYERS} joueurs maximum)`,
        });
      }
      if (room.phase !== 'lobby') {
        return sendJSON(res, 409, { error: 'La partie a déjà commencé' });
      }
      const player = room.addPlayer(body.name);
      hub.broadcast(room);
      return sendJSON(res, 201, {
        code: room.code,
        playerId: player.id,
        token: player.token,
        name: player.name,
      });
    }

    // Toutes les actions suivantes exigent un jeton de joueur valide.
    const player = room.playerByToken(body.token);
    if (!player) return sendJSON(res, 401, { error: 'Jeton invalide' });

    switch (action) {
      case 'start': {
        if (player.id !== room.hostId) {
          return sendJSON(res, 403, { error: "Seul l'hôte peut lancer la partie" });
        }
        const result = room.startGame();
        hub.pump(room);
        return sendJSON(res, result.ok ? 200 : 409, result);
      }
      case 'answers': {
        const result = room.saveAnswers(player.id, body.answers ?? {});
        hub.broadcast(room);
        return sendJSON(res, result.ok ? 200 : 409, result);
      }
      case 'finish': {
        const result = room.requestFinish(player.id);
        hub.pump(room); // lance la validation immédiatement
        return sendJSON(res, result.ok || result.ignored ? 200 : 409, result);
      }
      case 'challenge': {
        const result = room.toggleChallenge(player.id, {
          targetPlayerId: String(body.targetPlayerId ?? ''),
          categoryKey: String(body.categoryKey ?? ''),
        });
        hub.broadcast(room);
        return sendJSON(res, result.ok ? 200 : 409, result);
      }
      case 'ready': {
        const result = room.markReady(player.id);
        hub.pump(room);
        return sendJSON(res, 200, result);
      }
      case 'next': {
        const result = room.nextRound(
          Number.isInteger(body.fromRound) ? body.fromRound : undefined,
        );
        hub.pump(room);
        return sendJSON(res, 200, result);
      }
      case 'newgame': {
        if (player.id !== room.hostId) {
          return sendJSON(res, 403, { error: "Seul l'hôte peut relancer une partie" });
        }
        const result = room.newGame();
        hub.broadcast(room);
        return sendJSON(res, 200, result);
      }
      case 'leave': {
        room.removePlayer(player.id);
        hub.broadcast(room);
        return sendJSON(res, 200, { ok: true });
      }
      default:
        return sendJSON(res, 404, { error: 'Action inconnue' });
    }
  }

  return sendJSON(res, 404, { error: 'Route inconnue' });
}

// ------------------------------------------------------------------ démarrage
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  const { server } = createServer();
  // Écoute sur toutes les interfaces : les téléphones du même réseau Wi-Fi
  // peuvent ouvrir l'adresse affichée ci-dessous.
  server.listen(port, () => {
    const aiState = hasCredentials()
      ? `IA active (${DEFAULT_MODEL})`
      : "IA inactive — ANTHROPIC_API_KEY absente, mode secours";
    console.log(`\nBacRush — ${TOTAL_ROUNDS} manches · ${ROUND_DURATION_MS / 1000} s par manche`);
    console.log(`  ${aiState}`);
    console.log(`  Sur cet ordinateur : http://localhost:${port}`);
    for (const [name, infos] of Object.entries(os.networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family !== 'IPv4' || info.internal) continue;
        console.log(`  Depuis un téléphone (${name}) : http://${info.address}:${port}`);
      }
    }
    console.log('');
  });
}
