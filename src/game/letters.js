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
