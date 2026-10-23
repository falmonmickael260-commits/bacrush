import { CATEGORY_BY_KEY } from '../shared/categories.js';
import { firstLetterOf } from '../shared/normalize.js';
import { STATUS, makeVerdictKey } from '../game/scoring.js';

export const VERDICT_TOOL_NAME = 'rendre_verdicts';

/** Schéma imposé à l'IA (forced tool use + strict) : un verdict par réponse. */
export const VERDICT_TOOL = {
  name: VERDICT_TOOL_NAME,
  description:
    "Rend un verdict pour CHAQUE réponse soumise, dans le même ordre que la liste fournie. " +
    "Ne calcule jamais de points : tu valides les réponses et tu identifies les réponses équivalentes.",
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        description: 'Un objet par réponse à évaluer, identifié par son id.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: "id exact de la réponse évaluée" },
            recognized: {
              type: 'string',
              description:
                "Mot ou nom réellement voulu par le joueur, correctement orthographié. " +
                "Si aucune correction n'est évidente, reprendre la réponse telle quelle.",
            },
            first_letter: {
              type: 'string',
              description: 'Première lettre du mot reconnu, en majuscule.',
            },
            group_key: {
              type: 'string',
              description:
                "Clé canonique de l'entité désignée, en minuscules sans accents " +
                "(ex. « marseille » pour Marseille et Marseile). Deux réponses ne " +
                'partagent cette clé que si elles désignent vraiment la même chose.',
            },
            status: {
              type: 'string',
              enum: ['valide', 'invalide', 'a_verifier'],
              description:
                "valide = correspond vraiment à la rubrique et commence par la lettre ; " +
                "invalide = hors rubrique, inexistant ou mauvaise lettre ; " +
                "a_verifier = réellement indéterminé après vérification.",
            },
            reason: {
              type: 'string',
              description: 'Motif court et compréhensible par un joueur (une phrase).',
            },
            confidence: {
              type: 'number',
              description: 'Niveau de confiance entre 0 et 1.',
            },
            needs_search: {
              type: 'boolean',
              description:
                'true si une vérification documentaire complémentaire est nécessaire ' +
                'pour trancher (réponse rare, régionale ou ambiguë).',
            },
          },
          required: [
            'id',
            'recognized',
            'first_letter',
            'group_key',
            'status',
            'reason',
            'confidence',
            'needs_search',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['verdicts'],
    additionalProperties: false,
  },
};

const ALLOWED = new Set([STATUS.VALID, STATUS.INVALID, STATUS.UNCERTAIN]);

/**
 * Contrôle serveur de la sortie de l'IA (§10) : on ne fait jamais confiance
 * aveuglément au modèle. Les ids inconnus sont ignorés, les champs sont
 * typés/bornés, et chaque réponse demandée obtient un verdict.
 *
 * @param {Array} items    [{ id, playerId, categoryKey, raw }]
 * @param {Array} rawVerdicts sortie brute du modèle
 * @param {string} letter  lettre imposée
 * @param {string} source  étiquette de provenance ('ia', 'ia+recherche', 'secours'...)
 */
export function sanitizeVerdicts({ items, rawVerdicts, letter, source }) {
  const byId = new Map(items.map((it) => [it.id, it]));
  const out = new Map();
  const upperLetter = firstLetterOf(letter);

  for (const v of Array.isArray(rawVerdicts) ? rawVerdicts : []) {
    const id = String(v?.id ?? '');
    const item = byId.get(id);
    if (!item) continue; // id inventé ou dupliqué hors liste : ignoré
    if (out.has(id)) continue; // un seul verdict par réponse

    const category = CATEGORY_BY_KEY.get(item.categoryKey);
    if (!category) continue;

    const recognized = String(v?.recognized ?? '').trim().slice(0, 60) || item.raw.trim();
    let status = String(v?.status ?? '').trim();
    if (!ALLOWED.has(status)) status = STATUS.UNCERTAIN;

    const confidenceRaw = Number(v?.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.5;

    const verdict = {
      id,
      playerId: item.playerId,
      categoryKey: item.categoryKey,
      raw: item.raw,
      recognized,
      recognizedFirstLetter: firstLetterOf(recognized),
      letter: upperLetter,
      status,
      reason: String(v?.reason ?? '').trim().slice(0, 240),
      confidence,
      groupKey: String(v?.groupKey ?? v?.group_key ?? '').trim().slice(0, 60) || recognized,
      needsSearch: Boolean(v?.needs_search ?? v?.needsSearch),
      searched: Boolean(v?.searched),
      source,
    };
    out.set(id, verdict);
  }

  // Toute réponse sans verdict exploitable devient « à vérifier » : elle ne peut
  // ni rapporter 2 points par erreur, ni bloquer la partie.
  const missing = [];
  for (const item of items) {
    if (out.has(item.id)) continue;
    missing.push(item.id);
    out.set(item.id, {
      id: item.id,
      playerId: item.playerId,
      categoryKey: item.categoryKey,
      raw: item.raw,
      recognized: item.raw.trim(),
      recognizedFirstLetter: firstLetterOf(item.raw),
      letter: upperLetter,
      status: STATUS.UNCERTAIN,
      reason: "Réponse non évaluée par l'IA",
      confidence: 0,
      groupKey: item.raw.trim(),
      needsSearch: true,
      searched: false,
      source: `${source}:manquant`,
    });
  }

  return { verdicts: out, missingIds: missing };
}

/**
 * Réindexe les verdicts par « playerId::rubrique », forme attendue par le
 * barème. Les passes IA travaillent sur des ids opaques (anonymat des
 * joueurs) ; cette conversion rétablit l'association exacte joueur/rubrique
 * et refuse tout verdict dont l'association serait incomplète (§10).
 */
export function toScoringMap(verdictsById) {
  const out = new Map();
  for (const verdict of verdictsById.values()) {
    if (!verdict.playerId || !verdict.categoryKey) continue;
    out.set(makeVerdictKey(verdict.playerId, verdict.categoryKey), verdict);
  }
  return out;
}
