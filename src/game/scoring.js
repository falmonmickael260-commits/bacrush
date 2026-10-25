import { CATEGORIES } from '../shared/categories.js';
import { firstLetterOf, isBlank, likelySameAnswer, normalizeKey } from '../shared/normalize.js';

// Barème FIXE, appliqué par le code du serveur après validation des réponses.
// L'IA ne calcule jamais les points : elle valide et identifie les équivalences.
export const POINTS = Object.freeze({ UNIQUE: 2, SHARED: 1, ZERO: 0 });

export const STATUS = Object.freeze({
  VALID: 'valide',
  INVALID: 'invalide',
  UNCERTAIN: 'a_verifier',
  EMPTY: 'vide',
});

/**
 * Politique de décision pour les réponses réellement indéterminées,
 * afin qu'un cas incertain ne bloque jamais la partie :
 *  - 'lenient' (défaut) : comptée comme valide, signalée « À vérifier »
 *  - 'strict'           : comptée comme invalide
 */
/**
 * Rubriques où un rapprochement « à une faute près » est acceptable entre deux
 * mots inconnus. Les prénoms en sont exclus : Marie et Maria, Mathilde et
 * Mathilda sont de vrais prénoms distincts, séparés par une seule lettre.
 */
const FUZZY_GROUPING_CATEGORIES = new Set([
  'ville', 'pays', 'metier', 'animal', 'fruit_legume', 'objet',
]);

export function uncertainCountsAsValid(policy = 'lenient') {
  return policy !== 'strict';
}

function makeVerdictKey(playerId, categoryKey) {
  return `${playerId}::${categoryKey}`;
}
export { makeVerdictKey };

/**
 * Applique le barème à une manche.
 *
 * @param {object}   args
 * @param {string}   args.letter            lettre imposée de la manche
 * @param {Array}    args.players           [{ id, name }]
 * @param {Map|object} args.answers         playerId -> { categoryKey: texte brut }
 * @param {Map|object} args.verdicts        "playerId::categoryKey" -> verdict IA
 * @param {string}   [args.uncertainPolicy] 'lenient' | 'strict'
 * @returns {{ letter, categories, totals, flaggedCount }}
 */
export function scoreRound({ letter, players, answers, verdicts, uncertainPolicy = 'lenient' }) {
  const upperLetter = firstLetterOf(letter);
  const getAnswers = (pid) => {
    const a = answers instanceof Map ? answers.get(pid) : answers?.[pid];
    return a ?? {};
  };
  const getVerdict = (pid, cat) => {
    const k = makeVerdictKey(pid, cat);
    return verdicts instanceof Map ? verdicts.get(k) : verdicts?.[k];
  };

  const totals = Object.fromEntries(players.map((p) => [p.id, 0]));
  const categories = [];
  let flaggedCount = 0;

  for (const category of CATEGORIES) {
    const entries = [];

    for (const player of players) {
      const raw = getAnswers(player.id)[category.key] ?? '';
      const verdict = getVerdict(player.id, category.key);
      const entry = {
        playerId: player.id,
        raw: String(raw),
        recognized: null,
        recognizedFirstLetter: '',
        status: STATUS.EMPTY,
        reason: '',
        confidence: 0,
        searched: false,
        source: verdict?.source ?? 'none',
        groupId: null,
        points: POINTS.ZERO,
        counted: false,
        flagged: false,
      };

      if (isBlank(raw)) {
        entry.reason = 'Aucune réponse saisie';
        entries.push(entry);
        continue;
      }

      if (!verdict) {
        // Filet de sécurité : une réponse non évaluée ne peut pas rapporter de points.
        entry.status = STATUS.INVALID;
        entry.reason = "Réponse non évaluée (validation indisponible)";
        entries.push(entry);
        continue;
      }

      entry.recognized = verdict.recognized || String(raw).trim();
      // Un rapprochement approximatif n'est permis que si la réponse n'a pas été
      // identifiée : dès que l'IA a nommé l'entité, c'est son verdict qui tranche.
      entry.fuzzyGroupable =
        verdict.status === STATUS.UNCERTAIN ||
        String(verdict.source ?? '').startsWith('secours');
      entry.reason = verdict.reason || '';
      entry.confidence = Number.isFinite(verdict.confidence) ? verdict.confidence : 0;
      entry.searched = Boolean(verdict.searched);
      entry.status = verdict.status;

      // --- Contrôle serveur de la règle de la première lettre -----------------
      // On vérifie la lettre du mot RECONNU : une correction orthographique ne
      // doit jamais permettre de contourner la règle de la lettre imposée.
      entry.recognizedFirstLetter = firstLetterOf(entry.recognized);
      const rawFirstLetter = firstLetterOf(entry.raw);
      if (entry.status !== STATUS.INVALID) {
        if (entry.recognizedFirstLetter !== upperLetter || rawFirstLetter !== upperLetter) {
          entry.status = STATUS.INVALID;
          entry.reason = `Ne commence pas par la lettre ${upperLetter} (mot retenu : ${entry.recognized})`;
        }
      }

      if (entry.status === STATUS.VALID) {
        entry.counted = true;
      } else if (entry.status === STATUS.UNCERTAIN) {
        entry.counted = uncertainCountsAsValid(uncertainPolicy);
        entry.flagged = true;
        if (!entry.reason) entry.reason = 'Cas incertain, à vérifier';
      }
      if (entry.flagged) flaggedCount++;
      entries.push(entry);
    }

    // --- Regroupement des réponses identiques -------------------------------
    // Uniquement entre réponses retenues, dans la même rubrique, pour la même
    // manche. On regroupe sur l'entité réellement désignée (clé canonique de
    // l'IA) et, à défaut, sur l'égalité exacte du mot reconnu ou du texte saisi.
    // Aucune fusion « par ressemblance » : deux mots proches restent distincts.
    const groups = [];
    const indexBySignature = new Map();

    for (const entry of entries) {
      if (!entry.counted) continue;
      const signatures = [];
      const canonical = normalizeKey(
        getVerdict(entry.playerId, category.key)?.groupKey || '',
      );
      if (canonical) signatures.push(`g:${canonical}`);
      const rec = normalizeKey(entry.recognized);
      if (rec) signatures.push(`r:${rec}`);
      const raw = normalizeKey(entry.raw);
      if (raw) signatures.push(`w:${raw}`);

      let group = null;
      for (const sig of signatures) {
        const found = indexBySignature.get(sig);
        if (found !== undefined) {
          group = groups[found];
          break;
        }
      }
      if (!group) {
        group = {
          id: `${category.key}-g${groups.length + 1}`,
          label: entry.recognized || entry.raw,
          playerIds: [],
          points: POINTS.ZERO,
        };
        groups.push(group);
      }
      const groupIndex = groups.indexOf(group);
      for (const sig of signatures) {
        if (!indexBySignature.has(sig)) indexBySignature.set(sig, groupIndex);
      }
      group.playerIds.push(entry.playerId);
      entry.groupId = group.id;
    }

    // --- Rapprochement des mots non identifiés -------------------------------
    // Sans cette passe, une faute de frappe sur un mot inconnu du serveur
    // vaudrait 2 points à chacun des deux joueurs au lieu de 1.
    if (FUZZY_GROUPING_CATEGORIES.has(category.key)) {
      for (let i = 0; i < groups.length; i++) {
        const target = groups[i];
        if (!target) continue;
        for (let j = i + 1; j < groups.length; j++) {
          const other = groups[j];
          if (!other) continue;
          const mergeable = [...target.playerIds, ...other.playerIds].every((pid) =>
            entries.find((e) => e.playerId === pid)?.fuzzyGroupable,
          );
          if (!mergeable || !likelySameAnswer(target.label, other.label)) continue;
          target.playerIds.push(...other.playerIds);
          for (const entry of entries) {
            if (entry.groupId === other.id) entry.groupId = target.id;
          }
          groups[j] = null;
        }
      }
      for (let i = groups.length - 1; i >= 0; i--) {
        if (!groups[i]) groups.splice(i, 1);
      }
    }

    // --- Barème --------------------------------------------------------------
    for (const group of groups) {
      group.points = group.playerIds.length === 1 ? POINTS.UNIQUE : POINTS.SHARED;
    }
    for (const entry of entries) {
      if (!entry.counted || !entry.groupId) continue;
      const group = groups.find((g) => g.id === entry.groupId);
      entry.points = group.points;
      totals[entry.playerId] += entry.points;
    }

    categories.push({
      key: category.key,
      label: category.label,
      icon: category.icon,
      entries,
      groups,
    });
  }

  return { letter: upperLetter, categories, totals, flaggedCount };
}
