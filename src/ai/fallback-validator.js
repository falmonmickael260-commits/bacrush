import { CATEGORY_BY_KEY, CATEGORY_KEYS } from '../shared/categories.js';
import { firstLetterOf, normalizeKey, sameWord, stripAccents } from '../shared/normalize.js';
import { STATUS } from '../game/scoring.js';
import { LEXICON_ENTRIES, METIER_SUFFIXES } from './lexicons.js';

// Mode secours : utilisé si l'IA est indisponible ou en erreur.
// Principe : on ne valide QUE ce qu'on reconnaît vraiment, on refuse ce qui est
// clairement d'une autre rubrique, et on marque le reste « à vérifier ».
// Jamais de validation globale par défaut.

const INDEX = Object.fromEntries(
  Object.entries(LEXICON_ENTRIES).map(([key, words]) => [
    key,
    new Map(words.map((w) => [normalizeKey(w), w])),
  ]),
);

/**
 * @param {boolean} exactOnly  Pour accuser une réponse d'appartenir à une AUTRE
 *   rubrique, on exige une correspondance exacte : un rapprochement approximatif
 *   suffirait à refuser « Mandoline » (objet) parce qu'il ressemble à
 *   « Mandarine » (fruit).
 */
function lookup(categoryKey, raw, { exactOnly = false } = {}) {
  const index = INDEX[categoryKey];
  if (!index) return null;
  const key = normalizeKey(raw);
  if (!key) return null;
  const exact = index.get(key);
  if (exact) return { word: exact, exact: true };
  if (exactOnly) return null;
  for (const [candidateKey, word] of index) {
    if (candidateKey[0] !== key[0]) continue; // jamais de correction de la 1re lettre
    if (sameWord(key, candidateKey)) return { word, exact: false };
  }
  return null;
}

function looksLikeMetier(raw) {
  const key = stripAccents(String(raw)).toLowerCase();
  return METIER_SUFFIXES.some((s) => key.endsWith(stripAccents(s).toLowerCase()));
}

/**
 * @param {object} args
 * @param {string} args.letter
 * @param {Array}  args.items [{ id, playerId, categoryKey, raw }]
 * @returns {Array} verdicts au format attendu par sanitizeVerdicts
 */
export function judgeOffline({ letter, items }) {
  const upperLetter = firstLetterOf(letter);
  return items.map((item) => {
    const label = CATEGORY_BY_KEY.get(item.categoryKey)?.label ?? item.categoryKey;
    const base = {
      id: item.id,
      recognized: item.raw.trim(),
      first_letter: firstLetterOf(item.raw),
      group_key: normalizeKey(item.raw),
      confidence: 0.4,
      needs_search: false,
    };

    // 1. Règle de la lettre, avant toute autre considération.
    if (firstLetterOf(item.raw) !== upperLetter) {
      return {
        ...base,
        status: STATUS.INVALID,
        reason: `Ne commence pas par la lettre ${upperLetter}`,
        confidence: 0.95,
      };
    }

    // 2. Reconnue dans la bonne rubrique.
    const hit = lookup(item.categoryKey, item.raw);
    if (hit) {
      return {
        ...base,
        recognized: hit.word,
        first_letter: firstLetterOf(hit.word),
        group_key: normalizeKey(hit.word),
        status: STATUS.VALID,
        reason: hit.exact
          ? `${label} reconnu(e)`
          : `Orthographe tolérée : reconnu comme « ${hit.word} »`,
        confidence: hit.exact ? 0.9 : 0.72,
      };
    }

    // 3. Reconnue… mais dans une AUTRE rubrique : hors catégorie.
    for (const otherKey of CATEGORY_KEYS) {
      if (otherKey === item.categoryKey) continue;
      const otherHit = lookup(otherKey, item.raw, { exactOnly: true });
      if (!otherHit) continue;
      const otherLabel = CATEGORY_BY_KEY.get(otherKey).label;
      return {
        ...base,
        recognized: otherHit.word,
        first_letter: firstLetterOf(otherHit.word),
        group_key: normalizeKey(otherHit.word),
        status: STATUS.INVALID,
        reason: `« ${otherHit.word} » relève de la rubrique ${otherLabel}, pas ${label}`,
        confidence: 0.8,
      };
    }

    // 4. Indice morphologique de métier : pressenti, pas accepté d'office.
    if (item.categoryKey === 'metier' && looksLikeMetier(item.raw)) {
      return {
        ...base,
        status: STATUS.UNCERTAIN,
        reason: 'Ressemble à un métier mais non confirmé (vérification IA indisponible)',
        confidence: 0.5,
        needs_search: true,
      };
    }

    // 5. Réellement indéterminée.
    return {
      ...base,
      status: STATUS.UNCERTAIN,
      reason: 'Non confirmée hors ligne (vérification IA indisponible)',
      confidence: 0.3,
      needs_search: true,
    };
  });
}
