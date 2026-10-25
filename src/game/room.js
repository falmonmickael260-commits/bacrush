import { randomUUID, randomBytes } from 'node:crypto';
import { CATEGORY_KEYS } from '../shared/categories.js';
import { firstLetterOf, isBlank } from '../shared/normalize.js';
import { drawLetters, TOTAL_ROUNDS } from './letters.js';
import { scoreRound } from './scoring.js';

export const ROUND_DURATION_MS = 240_000; // 4 minutes — durée officielle d'une manche
export const REVEAL_DURATION_MS = 3_200; // animation de révélation de la lettre
export const VALIDATION_TIMEOUT_MS = 90_000; // garde-fou si l'IA ne répond jamais
export const MAX_PLAYERS = 8; // capacité d'un salon
export const VOTE_DURATION_MS = 60_000; // temps de contestation après la validation
export const REFEREE_DURATION_MS = 120_000; // l'arbitre relit toutes les réponses : plus de temps

export const ARBITRATION = Object.freeze({
  VOTE: 'vote', // le salon conteste, la majorité tranche
  REFEREE: 'referee', // un arbitre désigné accepte ou refuse
});

export const PHASE = Object.freeze({
  LOBBY: 'lobby',
  REVEAL: 'reveal',
  PLAYING: 'playing',
  VALIDATING: 'validating',
  VOTING: 'voting',
  RESULTS: 'results',
  FINISHED: 'finished',
});

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function makeRoomCode(rng = Math.random) {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_ALPHABET[Math.floor(rng() * ROOM_ALPHABET.length)];
  }
  return code;
}

/**
 * Une salle = une partie. Toute la vérité du jeu vit ici, côté serveur :
 * le tirage des 15 lettres, le chronomètre, les réponses, la clôture et les
 * scores. Le navigateur ne fait qu'afficher et envoyer des intentions.
 */
export class Room {
  constructor({
    code,
    now = () => Date.now(),
    rng = Math.random,
    // Durées injectables : seuls les tests s'en écartent, le jeu utilise 240 s.
    roundDurationMs = ROUND_DURATION_MS,
    revealDurationMs = REVEAL_DURATION_MS,
  } = {}) {
    this.code = code ?? makeRoomCode(rng);
    this.now = now;
    this.rng = rng;
    this.roundDurationMs = roundDurationMs;
    this.revealDurationMs = revealDurationMs;
    this.createdAt = this.now();
    this.players = new Map(); // playerId -> player
    this.tokens = new Map(); // token -> playerId
    this.hostId = null;
    this.arbitrationMode = ARBITRATION.VOTE;
    this.refereeId = null;
    this.phase = PHASE.LOBBY;
    this.letters = [];
    this.roundIndex = -1;
    this.round = null;
    this.history = [];
    this.gameNumber = 0;
    this.version = 0;
  }

  touch() {
    this.version++;
  }

  // ---------------------------------------------------------------- joueurs
  addPlayer(name) {
    const clean = String(name ?? '').trim().slice(0, 18) || `Joueur ${this.players.size + 1}`;
    const id = randomUUID();
    const token = randomBytes(24).toString('base64url');
    const player = {
      id,
      name: clean,
      token,
      score: 0,
      roundScores: [],
      connected: false,
      joinedAt: this.now(),
      lastSeen: this.now(),
    };
    this.players.set(id, player);
    this.tokens.set(token, id);
    if (!this.hostId) this.hostId = id;
    this.touch();
    return player;
  }

  playerByToken(token) {
    const id = this.tokens.get(String(token ?? ''));
    return id ? this.players.get(id) ?? null : null;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);
    this.tokens.delete(player.token);
    if (this.hostId === playerId) {
      this.hostId = this.players.keys().next().value ?? null;
    }
    this.ensureRefereeStillHere();
    this.touch();
  }

  setConnected(playerId, connected) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.connected = connected;
    player.lastSeen = this.now();
    this.touch();
  }

  get playerList() {
    return [...this.players.values()];
  }

  get isFull() {
    return this.players.size >= MAX_PLAYERS;
  }

  get referee() {
    return this.refereeId ? this.players.get(this.refereeId) ?? null : null;
  }

  /**
   * Choix du mode d'arbitrage, dans le salon uniquement : vote de tous, ou un
   * arbitre désigné qui accepte ou refuse les réponses.
   */
  setArbitration({ mode, refereeId }) {
    if (this.phase !== PHASE.LOBBY) {
      return { ok: false, error: 'La partie est déjà lancée' };
    }
    if (mode !== ARBITRATION.VOTE && mode !== ARBITRATION.REFEREE) {
      return { ok: false, error: 'Mode inconnu' };
    }
    if (mode === ARBITRATION.REFEREE) {
      const target = refereeId ?? this.refereeId ?? this.hostId;
      if (!this.players.has(target)) return { ok: false, error: 'Arbitre inconnu' };
      this.refereeId = target;
    } else {
      this.refereeId = null;
    }
    this.arbitrationMode = mode;
    this.touch();
    return { ok: true, mode: this.arbitrationMode, refereeId: this.refereeId };
  }

  /** L'arbitre a-t-il quitté la partie ? On repasse alors au vote du salon. */
  ensureRefereeStillHere() {
    if (this.arbitrationMode !== ARBITRATION.REFEREE) return;
    if (this.refereeId && this.players.has(this.refereeId)) return;
    this.arbitrationMode = ARBITRATION.VOTE;
    this.refereeId = null;
    this.touch();
  }

  // ------------------------------------------------------------ cycle de jeu
  /** Démarre une partie : UN tirage de 15 lettres distinctes pour toute la partie. */
  startGame() {
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.FINISHED) {
      return { ok: false, error: 'Partie déjà en cours' };
    }
    if (this.players.size === 0) return { ok: false, error: 'Aucun joueur' };
    this.gameNumber++;
    this.letters = drawLetters(TOTAL_ROUNDS, this.rng);
    this.roundIndex = -1;
    this.history = [];
    for (const player of this.players.values()) {
      player.score = 0;
      player.roundScores = [];
    }
    this.beginRound(0);
    return { ok: true };
  }

  beginRound(index) {
    this.roundIndex = index;
    const startedAt = this.now();
    this.round = {
      index,
      letter: this.letters[index],
      phaseStartedAt: startedAt,
      revealEndsAt: startedAt + this.revealDurationMs,
      startedAt: null,
      endsAt: null,
      answers: new Map(), // playerId -> { categoryKey: raw }
      locked: false,
      closing: false,
      closedBy: null,
      closeReason: null,
      closedAt: null,
      validationStarted: false,
      validationStartedAt: null,
      verdicts: null,
      verdictsApplied: false,
      uncertainPolicy: 'lenient',
      provisional: null, // résultats avant le vote du salon
      challenges: new Map(), // "joueur::rubrique" -> Set de contestataires (mode vote)
      decisions: new Map(), // "joueur::rubrique" -> true (accepté) | false (refusé) par l'arbitre
      ready: new Set(),
      voteEndsAt: null,
      results: null,
      scored: false,
      aiSource: null,
      aiError: null,
    };
    this.phase = PHASE.REVEAL;
    this.touch();
  }

  /** Fin de l'animation de révélation : le chronomètre de 240 s démarre. */
  openRound() {
    if (this.phase !== PHASE.REVEAL || !this.round) return;
    const t = this.now();
    this.round.startedAt = t;
    this.round.endsAt = t + this.roundDurationMs;
    this.phase = PHASE.PLAYING;
    this.touch();
  }

  remainingMs() {
    if (!this.round) return 0;
    if (this.phase === PHASE.REVEAL) return this.roundDurationMs;
    if (!this.round.endsAt) return this.roundDurationMs;
    if (this.round.locked) {
      const stoppedAt = this.round.closedAt ?? this.now();
      return Math.max(0, this.round.endsAt - stoppedAt);
    }
    return Math.max(0, this.round.endsAt - this.now()); // jamais négatif
  }

  // ------------------------------------------------------------- réponses
  /**
   * Enregistre les réponses d'un joueur. Refusé après la clôture : plus aucune
   * modification n'est possible une fois la manche verrouillée.
   */
  saveAnswers(playerId, incoming) {
    if (!this.players.has(playerId)) return { ok: false, error: 'Joueur inconnu' };
    if (this.phase !== PHASE.PLAYING) return { ok: false, error: 'Manche non ouverte' };
    if (this.round.locked) return { ok: false, error: 'Manche clôturée' };
    const current = this.round.answers.get(playerId) ?? {};
    for (const key of CATEGORY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(incoming ?? {}, key)) continue;
      const value = String(incoming[key] ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      current[key] = value;
    }
    this.round.answers.set(playerId, current);
    this.touch();
    return { ok: true, filled: this.filledCount(playerId) };
  }

  answersOf(playerId) {
    return this.round?.answers.get(playerId) ?? {};
  }

  filledCount(playerId) {
    const answers = this.answersOf(playerId);
    return CATEGORY_KEYS.filter((k) => !isBlank(answers[k])).length;
  }

  hasAllAnswers(playerId) {
    return this.filledCount(playerId) === CATEGORY_KEYS.length;
  }

  // -------------------------------------------------------------- clôture
  /**
   * Clôture anticipée par un joueur (bouton FIN).
   * Le serveur revérifie les 8 réponses, puis la manche se termine pour TOUT
   * le monde. Une seule clôture est acceptée, même si plusieurs clics
   * arrivent quasi simultanément.
   */
  requestFinish(playerId) {
    if (this.phase !== PHASE.PLAYING || !this.round) {
      return { ok: false, error: 'Manche non ouverte', ignored: true };
    }
    if (this.round.closing || this.round.locked) {
      return { ok: false, error: 'Manche déjà clôturée', ignored: true };
    }
    if (!this.players.has(playerId)) return { ok: false, error: 'Joueur inconnu' };
    if (!this.hasAllAnswers(playerId)) {
      return { ok: false, error: 'Les 8 rubriques doivent être remplies' };
    }
    this.close({ by: playerId, reason: 'player' });
    return { ok: true };
  }

  /** Fin automatique à 00:00 — fonctionne même si personne n'a la page ouverte. */
  closeByTimeout() {
    if (this.phase !== PHASE.PLAYING || !this.round) return false;
    if (this.round.closing || this.round.locked) return false;
    this.close({ by: null, reason: 'timeout' });
    return true;
  }

  close({ by, reason }) {
    this.round.closing = true;
    this.round.locked = true; // verrouillage immédiat des réponses
    this.round.closedBy = by;
    this.round.closeReason = reason;
    this.round.closedAt = this.now();
    this.phase = PHASE.VALIDATING;
    this.touch();
  }

  /** Marque le début de la validation IA : une seule fois par manche. */
  claimValidation() {
    if (!this.round || this.round.validationStarted) return false;
    this.round.validationStarted = true;
    this.round.validationStartedAt = this.now();
    this.touch();
    return true;
  }

  // -------------------------------------------------------------- résultats
  /**
   * Applique le barème et cumule les scores. Idempotent : les points d'une
   * manche ne peuvent jamais être attribués deux fois.
   */
  /**
   * Enregistre les verdicts et calcule un résultat PROVISOIRE. Les points ne
   * sont pas encore attribués : le salon peut d'abord contester (§ vote).
   * Idempotent : les verdicts ne sont appliqués qu'une fois.
   */
  applyVerdicts({ verdicts, source, error = null, uncertainPolicy = 'lenient' }) {
    if (!this.round) return { ok: false, error: 'Aucune manche' };
    if (this.round.verdictsApplied || this.round.scored) return { ok: true, already: true };

    this.round.verdicts = verdicts;
    this.round.uncertainPolicy = uncertainPolicy;
    this.round.aiSource = source;
    this.round.aiError = error;
    this.round.verdictsApplied = true;
    this.round.provisional = this.computeResults(verdicts);

    // Seul un salon de plusieurs joueurs peut voter ; en solo on tranche tout de suite.
    if (this.players.size >= 2) {
      this.ensureRefereeStillHere();
      this.phase = PHASE.VOTING;
      this.round.voteEndsAt =
        this.now() +
        (this.arbitrationMode === ARBITRATION.REFEREE ? REFEREE_DURATION_MS : VOTE_DURATION_MS);
      this.touch();
      return { ok: true, voting: true };
    }
    return this.finalizeRound();
  }

  computeResults(verdicts) {
    return scoreRound({
      letter: this.round.letter,
      players: this.playerList.map((p) => ({ id: p.id, name: p.name })),
      answers: this.round.answers,
      verdicts,
      uncertainPolicy: this.round.uncertainPolicy,
    });
  }

  // ----------------------------------------------------------------- vote
  static challengeKey(targetPlayerId, categoryKey) {
    return `${targetPlayerId}::${categoryKey}`;
  }

  /** Nombre de voix nécessaires pour refuser la réponse d'un joueur. */
  requiredChallenges(targetPlayerId) {
    const voters = Math.max(0, this.players.size - (this.players.has(targetPlayerId) ? 1 : 0));
    return Math.floor(voters / 2) + 1; // majorité stricte des autres joueurs
  }

  /**
   * Un joueur conteste (ou retire sa contestation sur) la réponse d'un autre.
   * On ne peut contester ni sa propre réponse, ni une réponse déjà sans point.
   */
  toggleChallenge(playerId, { targetPlayerId, categoryKey }) {
    if (this.phase !== PHASE.VOTING || !this.round) {
      return { ok: false, error: 'Aucun vote en cours' };
    }
    if (this.arbitrationMode !== ARBITRATION.VOTE) {
      return { ok: false, error: "Cette partie est arbitrée par un joueur" };
    }
    if (!this.players.has(playerId) || !this.players.has(targetPlayerId)) {
      return { ok: false, error: 'Joueur inconnu' };
    }
    if (playerId === targetPlayerId) {
      return { ok: false, error: 'On ne conteste pas sa propre réponse' };
    }
    if (!CATEGORY_KEYS.includes(categoryKey)) {
      return { ok: false, error: 'Rubrique inconnue' };
    }
    const entry = this.round.provisional?.categories
      .find((c) => c.key === categoryKey)
      ?.entries.find((e) => e.playerId === targetPlayerId);
    if (!entry || !entry.counted) {
      return { ok: false, error: 'Cette réponse ne rapporte déjà aucun point' };
    }

    const key = Room.challengeKey(targetPlayerId, categoryKey);
    const voters = this.round.challenges.get(key) ?? new Set();
    if (voters.has(playerId)) voters.delete(playerId);
    else voters.add(playerId);
    if (voters.size === 0) this.round.challenges.delete(key);
    else this.round.challenges.set(key, voters);
    this.round.ready.delete(playerId); // un nouveau vote relance sa décision
    this.touch();
    return { ok: true, challenges: voters.size };
  }

  /**
   * Une réponse peut-elle être repêchée par l'arbitre ?
   * Jamais si elle ne commence pas par la lettre imposée : cette règle est
   * absolue et n'appartient à personne, pas même à l'arbitre.
   */
  canRefereeAccept(entry) {
    if (!entry || isBlank(entry.raw)) return false;
    return firstLetterOf(entry.raw) === firstLetterOf(this.round.letter);
  }

  /**
   * L'arbitre accepte ou refuse une réponse. Rappeler avec la même valeur
   * annule la décision et rend la main au verdict automatique.
   */
  refereeDecide(playerId, { targetPlayerId, categoryKey, accept }) {
    if (this.phase !== PHASE.VOTING || !this.round) {
      return { ok: false, error: "Aucun arbitrage en cours" };
    }
    if (this.arbitrationMode !== ARBITRATION.REFEREE) {
      return { ok: false, error: 'Cette partie se joue au vote du salon' };
    }
    if (playerId !== this.refereeId) {
      return { ok: false, error: "Seul l'arbitre décide" };
    }
    if (!this.players.has(targetPlayerId) || !CATEGORY_KEYS.includes(categoryKey)) {
      return { ok: false, error: 'Réponse inconnue' };
    }
    const entry = this.round.provisional?.categories
      .find((c) => c.key === categoryKey)
      ?.entries.find((e) => e.playerId === targetPlayerId);
    if (!entry || isBlank(entry.raw)) {
      return { ok: false, error: 'Aucune réponse à juger' };
    }
    if (accept && !this.canRefereeAccept(entry)) {
      return {
        ok: false,
        error: `Impossible : le mot ne commence pas par ${firstLetterOf(this.round.letter)}`,
      };
    }

    const key = Room.challengeKey(targetPlayerId, categoryKey);
    const current = this.round.decisions.get(key);
    if (current === accept) this.round.decisions.delete(key);
    else this.round.decisions.set(key, Boolean(accept));
    this.touch();
    return { ok: true, decision: this.round.decisions.get(key) ?? null };
  }

  /** « Prêt » : quand tous les joueurs connectés le sont, on tranche. */
  markReady(playerId) {
    if (this.phase !== PHASE.VOTING || !this.round) {
      return { ok: false, ignored: true, error: 'Aucun vote en cours' };
    }
    if (!this.players.has(playerId)) return { ok: false, error: 'Joueur inconnu' };
    this.round.ready.add(playerId);
    this.touch();
    // En mode arbitre, c'est lui seul qui clôt la manche.
    if (this.arbitrationMode === ARBITRATION.REFEREE) {
      if (playerId === this.refereeId) return this.finalizeRound();
      return { ok: true, waiting: true };
    }
    if (this.everyoneReady()) return this.finalizeRound();
    return { ok: true, waiting: true };
  }

  everyoneReady() {
    const present = this.playerList.filter((p) => p.connected);
    const expected = present.length > 0 ? present : this.playerList;
    return expected.every((p) => this.round.ready.has(p.id));
  }

  /**
   * Applique les contestations retenues aux verdicts, puis le barème.
   * Les points ne sont attribués qu'ici, une seule fois.
   */
  finalizeRound() {
    if (!this.round) return { ok: false, error: 'Aucune manche' };
    if (this.round.scored) return { ok: true, already: true };

    const adjusted = new Map(this.round.verdicts ?? []);
    const refused = [];

    // Mode arbitre : ses décisions priment sur le verdict automatique.
    for (const [key, accepted] of this.round.decisions) {
      const verdict = adjusted.get(key);
      const [targetPlayerId, categoryKey] = key.split('::');
      if (accepted) {
        adjusted.set(key, {
          ...(verdict ?? {}),
          status: 'valide',
          recognized: verdict?.recognized || verdict?.raw || '',
          groupKey: verdict?.groupKey || verdict?.recognized || '',
          decidedBy: 'arbitre',
          reason: "Acceptée par l'arbitre",
        });
      } else if (verdict) {
        adjusted.set(key, {
          ...verdict,
          status: 'invalide',
          decidedBy: 'arbitre',
          reason: "Refusée par l'arbitre",
        });
        refused.push({ targetPlayerId, categoryKey, byReferee: true });
      }
    }

    for (const [key, voters] of this.round.challenges) {
      const [targetPlayerId, categoryKey] = key.split('::');
      const needed = this.requiredChallenges(targetPlayerId);
      if (voters.size < needed) continue;
      const verdict = adjusted.get(key);
      if (!verdict) continue;
      adjusted.set(key, {
        ...verdict,
        status: 'invalide',
        challenged: voters.size,
        reason: `Refusée par le salon (${voters.size} contestation${voters.size > 1 ? 's' : ''})`,
      });
      refused.push({ targetPlayerId, categoryKey, votes: voters.size });
    }

    const results = this.computeResults(adjusted);
    this.round.results = results;
    this.round.refused = refused;
    this.round.scored = true;

    for (const player of this.players.values()) {
      const gained = results.totals[player.id] ?? 0;
      player.roundScores[this.round.index] = gained;
      player.score += gained;
    }

    this.history[this.round.index] = {
      index: this.round.index,
      letter: this.round.letter,
      closeReason: this.round.closeReason,
      closedBy: this.round.closedBy,
      source: this.round.aiSource,
      error: this.round.aiError,
      totals: results.totals,
      categories: results.categories,
      refused,
    };

    this.phase = this.round.index >= TOTAL_ROUNDS - 1 ? PHASE.FINISHED : PHASE.RESULTS;
    this.touch();
    return { ok: true };
  }

  /** Passage à la manche suivante : initialisé une seule fois, lettre inutilisée. */
  nextRound(fromIndex) {
    if (this.phase !== PHASE.RESULTS) return { ok: false, ignored: true, error: 'Pas en résultats' };
    if (Number.isInteger(fromIndex) && fromIndex !== this.roundIndex) {
      return { ok: false, ignored: true, error: 'Manche déjà passée' };
    }
    if (this.roundIndex >= TOTAL_ROUNDS - 1) {
      this.phase = PHASE.FINISHED;
      this.touch();
      return { ok: false, error: 'Partie terminée' };
    }
    this.beginRound(this.roundIndex + 1);
    return { ok: true };
  }

  /** Nouvelle partie : nouveau tirage indépendant, scores remis à zéro. */
  newGame() {
    this.phase = PHASE.LOBBY;
    this.round = null;
    this.roundIndex = -1;
    this.letters = [];
    this.history = [];
    for (const player of this.players.values()) {
      player.score = 0;
      player.roundScores = [];
    }
    this.touch();
    return { ok: true };
  }

  // ------------------------------------------------------------------ temps
  /**
   * Avance l'horloge de la salle. Renvoie les effets de bord à traiter par
   * l'appelant (le serveur déclenche alors la validation IA).
   * Appelé par un balayage périodique : la fin automatique ne dépend donc
   * d'aucun navigateur ouvert.
   */
  tick() {
    const effects = [];
    const t = this.now();
    if (this.phase === PHASE.REVEAL && this.round && t >= this.round.revealEndsAt) {
      this.openRound();
      effects.push({ type: 'round-open' });
    }
    if (this.phase === PHASE.PLAYING && this.round?.endsAt && t >= this.round.endsAt) {
      if (this.closeByTimeout()) effects.push({ type: 'round-closed', reason: 'timeout' });
    }
    if (this.phase === PHASE.VALIDATING && this.round && !this.round.validationStarted) {
      effects.push({ type: 'needs-validation' });
    }
    if (
      this.phase === PHASE.VALIDATING &&
      this.round?.validationStarted &&
      !this.round.scored &&
      t - this.round.validationStartedAt > VALIDATION_TIMEOUT_MS
    ) {
      effects.push({ type: 'validation-stalled' });
    }
    // Fin du temps de contestation : le salon a tranché, on applique le barème.
    if (this.phase === PHASE.VOTING && this.round?.voteEndsAt && t >= this.round.voteEndsAt) {
      this.finalizeRound();
      effects.push({ type: 'vote-closed' });
    }
    return effects;
  }

  // ------------------------------------------------------------------- vue
  /** Vue envoyée au navigateur. Les réponses des autres restent cachées pendant le jeu. */
  publicState(forPlayerId = null) {
    const t = this.now();
    const standings = this.playerList
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        roundScores: p.roundScores,
        connected: p.connected,
        isHost: p.id === this.hostId,
        filled: this.round && !this.round.locked ? this.filledCount(p.id) : null,
        submitted: this.round ? this.filledCount(p.id) : 0,
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const state = {
      code: this.code,
      phase: this.phase,
      serverNow: t,
      version: this.version,
      totalRounds: TOTAL_ROUNDS,
      maxPlayers: MAX_PLAYERS,
      roundNumber: this.roundIndex + 1,
      gameNumber: this.gameNumber,
      lettersUsed: this.letters.slice(0, Math.max(0, this.roundIndex + 1)),
      arbitration: {
        mode: this.arbitrationMode,
        refereeId: this.refereeId,
        refereeName: this.referee?.name ?? null,
      },
      players: standings,
      you: null,
      round: null,
      results: null,
      history: this.history.map((h) => h && { index: h.index, letter: h.letter, totals: h.totals }),
    };

    if (forPlayerId && this.players.has(forPlayerId)) {
      const me = this.players.get(forPlayerId);
      state.you = {
        id: me.id,
        name: me.name,
        isHost: me.id === this.hostId,
        score: me.score,
        answers: this.answersOf(me.id),
        filled: this.filledCount(me.id),
        canFinish:
          this.phase === PHASE.PLAYING && !this.round.locked && this.hasAllAnswers(me.id),
      };
    }

    if (this.round) {
      state.round = {
        index: this.round.index,
        letter: this.round.letter,
        revealEndsAt: this.round.revealEndsAt,
        startedAt: this.round.startedAt,
        endsAt: this.round.endsAt,
        remainingMs: this.remainingMs(),
        durationMs: this.roundDurationMs,
        locked: this.round.locked,
        closeReason: this.round.closeReason,
        closedByName: this.round.closedBy
          ? this.players.get(this.round.closedBy)?.name ?? null
          : null,
        aiSource: this.round.aiSource,
        aiError: this.round.aiError,
      };
      if (this.phase === PHASE.VOTING && this.round.provisional) {
        const mine = forPlayerId;
        const isReferee = Boolean(mine && mine === this.refereeId);
        state.vote = {
          mode: this.arbitrationMode,
          refereeId: this.refereeId,
          refereeName: this.referee?.name ?? null,
          iAmReferee: isReferee,
          endsAt: this.round.voteEndsAt,
          remainingMs: Math.max(0, (this.round.voteEndsAt ?? t) - t),
          readyIds: [...this.round.ready],
          readyCount: this.round.ready.size,
          playerCount: this.players.size,
          categories: this.round.provisional.categories.map((category) => ({
            key: category.key,
            label: category.label,
            icon: category.icon,
            entries: category.entries.map((entry) => {
              const key = Room.challengeKey(entry.playerId, category.key);
              const voters = this.round.challenges.get(key);
              const decision = this.round.decisions.get(key);
              const refereeMode = this.arbitrationMode === ARBITRATION.REFEREE;
              return {
                playerId: entry.playerId,
                raw: entry.raw,
                recognized: entry.recognized,
                status: entry.status,
                reason: entry.reason,
                counted: entry.counted,
                flagged: entry.flagged,
                challenges: voters?.size ?? 0,
                required: this.requiredChallenges(entry.playerId),
                challengedByMe: Boolean(mine && voters?.has(mine)),
                canChallenge: Boolean(
                  !refereeMode && mine && entry.counted && entry.playerId !== mine,
                ),
                decision: decision === undefined ? null : decision,
                canDecide: Boolean(refereeMode && isReferee && entry.raw),
                canAccept: refereeMode ? this.canRefereeAccept(entry) : false,
              };
            }),
          })),
        };
      }

      if (this.round.results) {
        state.results = {
          letter: this.round.results.letter,
          categories: this.round.results.categories,
          totals: this.round.results.totals,
          flaggedCount: this.round.results.flaggedCount,
          refused: this.round.refused ?? [],
          roundIndex: this.round.index,
          isFinalRound: this.round.index >= TOTAL_ROUNDS - 1,
        };
      }
    }
    return state;
  }
}
