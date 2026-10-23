import { Room, PHASE, makeRoomCode } from './room.js';
import { judgeOffline } from '../ai/fallback-validator.js';
import { sanitizeVerdicts, toScoringMap } from '../ai/schema.js';
import { buildItems } from '../ai/prompt.js';
import { validateRound as defaultValidate, UNCERTAIN_POLICY } from '../ai/validator.js';

const SWEEP_MS = 250;
const SYNC_MS = 10_000;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Orchestre les salles : horloge serveur, clôtures, appel unique à l'IA,
 * application du barème et diffusion de l'état aux navigateurs.
 */
export class GameHub {
  constructor({
    validate = defaultValidate,
    now = () => Date.now(),
    rng = Math.random,
    uncertainPolicy = UNCERTAIN_POLICY,
    logger = console,
    roundDurationMs,
    revealDurationMs,
  } = {}) {
    this.rooms = new Map();
    this.subscribers = new Map(); // roomCode -> Set<{ playerId, send }>
    this.broadcastVersions = new Map();
    this.lastSyncAt = 0;
    this.validate = validate;
    this.now = now;
    this.rng = rng;
    this.uncertainPolicy = uncertainPolicy;
    this.logger = logger;
    this.roundDurationMs = roundDurationMs;
    this.revealDurationMs = revealDurationMs;
    this.timer = null;
  }

  // ------------------------------------------------------------------ salles
  createRoom() {
    let code = makeRoomCode(this.rng);
    while (this.rooms.has(code)) code = makeRoomCode(this.rng);
    const room = new Room({
      code,
      now: this.now,
      rng: this.rng,
      ...(this.roundDurationMs ? { roundDurationMs: this.roundDurationMs } : {}),
      ...(this.revealDurationMs ? { revealDurationMs: this.revealDurationMs } : {}),
    });
    this.rooms.set(code, room);
    this.subscribers.set(code, new Set());
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code ?? '').toUpperCase()) ?? null;
  }

  dropRoom(code) {
    this.rooms.delete(code);
    this.subscribers.delete(code);
    this.broadcastVersions.delete(code);
  }

  // -------------------------------------------------------------- diffusion
  subscribe(room, playerId, send) {
    const set = this.subscribers.get(room.code);
    const entry = { playerId, send };
    set.add(entry);
    room.setConnected(playerId, true);
    send('state', room.publicState(playerId));
    this.broadcast(room);
    return () => {
      set.delete(entry);
      const stillHere = [...set].some((s) => s.playerId === playerId);
      if (!stillHere) room.setConnected(playerId, false);
      this.broadcast(room);
    };
  }

  broadcast(room) {
    const set = this.subscribers.get(room.code);
    if (!set) return;
    this.broadcastVersions.set(room.code, room.version);
    for (const sub of set) {
      try {
        sub.send('state', room.publicState(sub.playerId));
      } catch {
        set.delete(sub);
      }
    }
  }

  // -------------------------------------------------------------- validation
  /**
   * Validation IA d'une manche, déclenchée une seule fois (claimValidation).
   * Toute erreur aboutit à un résultat exploitable : la partie ne reste
   * jamais bloquée en attente de l'IA.
   */
  async runValidation(room) {
    if (!room.claimValidation()) return;
    this.broadcast(room);
    const round = room.round;
    const players = room.playerList.map((p) => ({ id: p.id, name: p.name }));
    try {
      const { verdicts, source, error } = await this.validate({
        letter: round.letter,
        players,
        answers: round.answers,
      });
      room.applyVerdicts({ verdicts, source, error, uncertainPolicy: this.uncertainPolicy });
    } catch (err) {
      this.logger.error?.(`[validation] erreur inattendue : ${err?.message}`);
      room.applyVerdicts({
        ...this.offlineVerdicts(room, round),
        error: `Validation dégradée (${err?.message ?? 'erreur inconnue'})`,
        uncertainPolicy: this.uncertainPolicy,
      });
    }
    this.broadcast(room);
  }

  offlineVerdicts(room, round) {
    const players = room.playerList.map((p) => ({ id: p.id, name: p.name }));
    const items = buildItems({ answers: round.answers, players });
    const { verdicts } = sanitizeVerdicts({
      items,
      rawVerdicts: judgeOffline({ letter: round.letter, items }),
      letter: round.letter,
      source: 'secours',
    });
    return { verdicts: toScoringMap(verdicts), source: 'secours' };
  }

  // ------------------------------------------------------------------ horloge
  /**
   * Traite les effets d'une salle (ouverture de manche, clôture, validation).
   * Appelée par le balayage ET directement par les routes, pour qu'un clic sur
   * FIN déclenche la validation sans attendre le prochain balayage.
   */
  pump(room) {
    const effects = room.tick();
    for (const effect of effects) {
      if (effect.type === 'needs-validation') {
        this.runValidation(room).catch((err) =>
          this.logger.error?.(`[validation] ${err?.message}`),
        );
      }
      if (effect.type === 'validation-stalled' && room.round && !room.round.scored) {
        this.logger.warn?.(`[validation] trop longue, résultats de secours (${room.code})`);
        room.applyVerdicts({
          ...this.offlineVerdicts(room, room.round),
          error: 'IA trop lente — validation de secours appliquée',
          uncertainPolicy: this.uncertainPolicy,
        });
      }
    }
    if (this.broadcastVersions.get(room.code) !== room.version) this.broadcast(room);
    return effects;
  }

  /** Un seul balayage pour toutes les salles : indépendant des navigateurs. */
  tick() {
    const t = this.now();
    const sync = t - this.lastSyncAt >= SYNC_MS;
    if (sync) this.lastSyncAt = t;

    for (const room of [...this.rooms.values()]) {
      this.pump(room);

      const subs = this.subscribers.get(room.code);
      if (!subs) continue;
      if (sync && subs.size > 0) {
        for (const sub of subs) {
          try {
            sub.send('sync', {
              serverNow: t,
              remainingMs: room.remainingMs(),
              phase: room.phase,
            });
          } catch {
            subs.delete(sub);
          }
        }
      }

      const idle = subs.size === 0 && t - room.createdAt > ROOM_TTL_MS;
      if (idle) this.dropRoom(room.code);
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        this.logger.error?.(`[hub] ${err?.message}`);
      }
    }, SWEEP_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export { PHASE };
