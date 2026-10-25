// Tirage des lettres d'une partie : 15 lettres TOUTES différentes.
// Les lettres trop difficiles en français (K, Q, W, X, Y, Z) sont écartées,
// ce qui laisse 20 lettres éligibles pour 15 manches — jamais moins de manches.

export const ELIGIBLE_LETTERS = Object.freeze([
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
  'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'U', 'V',
]);

/** Longueurs de partie proposées à l'hôte. */
export const ROUND_OPTIONS = Object.freeze([6, 12, 18]);
export const DEFAULT_ROUNDS = 12;
export const TOTAL_ROUNDS = DEFAULT_ROUNDS; // valeur par défaut d'une partie

export function isValidRoundCount(count) {
  return ROUND_OPTIONS.includes(count);
}

/**
 * Mélange de Fisher-Yates puis découpe : le tirage est fait UNE fois par partie.
 * Chaque manche consomme ensuite letters[roundIndex] — aucune réinitialisation
 * entre deux manches, aucune lettre ne peut sortir deux fois.
 */
export function drawLetters(count = TOTAL_ROUNDS, rng = Math.random) {
  if (count > ELIGIBLE_LETTERS.length) {
    throw new Error(
      `Impossible de tirer ${count} lettres distinctes parmi ${ELIGIBLE_LETTERS.length}`,
    );
  }
  const pool = [...ELIGIBLE_LETTERS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

/** Cadence de défilement de la roulette : une lettre toutes les 110 ms. */
export const SPIN_MS = 110;

/** Lettres encore disponibles pour la partie en cours. */
export function remainingLetters(used = []) {
  const taken = new Set(used.filter(Boolean));
  return ELIGIBLE_LETTERS.filter((letter) => !taken.has(letter));
}

/**
 * Lettre affichée par la roulette à un instant donné. La formule est partagée
 * par le serveur et les navigateurs : tout le monde voit défiler exactement la
 * même lettre au même moment, et l'arrêt fige ce que chacun avait sous les yeux.
 */
export function letterAtSpin(wheel, elapsedMs, spinMs = SPIN_MS) {
  if (!Array.isArray(wheel) || wheel.length === 0) return null;
  const steps = Math.floor(Math.max(0, elapsedMs) / spinMs);
  return wheel[steps % wheel.length];
}

/** Ordre de défilement, mélangé à chaque manche pour éviter l'alphabet. */
export function makeWheel(used = [], rng = Math.random) {
  const wheel = remainingLetters(used);
  for (let i = wheel.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [wheel[i], wheel[j]] = [wheel[j], wheel[i]];
  }
  return wheel;
}
