import { buildItems } from './prompt.js';
import { sanitizeVerdicts, toScoringMap } from './schema.js';
import { judgeOffline } from './fallback-validator.js';
import { STATUS } from '../game/scoring.js';
import * as realAI from './anthropic-validator.js';

export const AI_MODE = process.env.BACRUSH_AI || 'auto'; // auto | off
export const UNCERTAIN_POLICY = process.env.BACRUSH_UNCERTAIN_POLICY || 'lenient';
const GLOBAL_DEADLINE_MS = Number(process.env.BACRUSH_AI_DEADLINE_MS || 75_000);

function withDeadline(promise, ms, controller) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new Error(`Délai dépassé (${ms} ms)`));
    }, ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Fabrique le validateur de manche. Les dépendances sont injectables pour les
 * tests (IA simulée) ; le serveur utilise le câblage réel par défaut.
 */
export function createValidator({
  judgeBatch = realAI.judgeBatch,
  judgeWithSearch = realAI.judgeWithSearch,
  offline = judgeOffline,
  hasCredentials = realAI.hasCredentials,
  mode = AI_MODE,
  deadlineMs = GLOBAL_DEADLINE_MS,
  logger = console,
} = {}) {
  /**
   * @returns {{ verdicts: Map, source: string, error: string|null, items: Array, searchedCount: number }}
   */
  return async function validateRound({ letter, players, answers }) {
    const items = buildItems({ answers, players });
    if (items.length === 0) {
      return { verdicts: new Map(), source: 'aucune-reponse', error: null, items, searchedCount: 0 };
    }

    const useAI = mode !== 'off' && hasCredentials();
    if (!useAI) {
      const { verdicts } = sanitizeVerdicts({
        items,
        rawVerdicts: offline({ letter, items }),
        letter,
        source: 'secours',
      });
      return {
        verdicts: toScoringMap(verdicts),
        source: 'secours',
        error: mode === 'off' ? null : "Clé d'API absente : mode secours",
        items,
        searchedCount: 0,
      };
    }

    const controller = new AbortController();
    let verdicts;
    let source = 'ia';
    let error = null;

    // --- Passe 1 : examen de chaque réponse, sortie structurée imposée -------
    try {
      const result = await withDeadline(
        judgeBatch({ letter, items, signal: controller.signal }),
        deadlineMs,
        controller,
      );
      verdicts = sanitizeVerdicts({
        items,
        rawVerdicts: result.verdicts,
        letter,
        source: 'ia',
      }).verdicts;
    } catch (err) {
      logger.warn?.(`[IA] échec de la validation principale : ${err.message}`);
      const fallback = sanitizeVerdicts({
        items,
        rawVerdicts: offline({ letter, items }),
        letter,
        source: 'secours',
      });
      return {
        verdicts: toScoringMap(fallback.verdicts),
        source: 'secours',
        error: `IA indisponible (${err.message}) — validation de secours appliquée`,
        items,
        searchedCount: 0,
      };
    }

    // --- Passe 2 : recherche documentaire pour les seuls cas incertains ------
    const toVerify = items.filter((item) => {
      const v = verdicts.get(item.id);
      return v && (v.status === STATUS.UNCERTAIN || v.needsSearch);
    });

    let searchedCount = 0;
    if (toVerify.length > 0) {
      try {
        const searchResult = await withDeadline(
          judgeWithSearch({ letter, items: toVerify, signal: controller.signal }),
          deadlineMs,
          controller,
        );
        const refined = sanitizeVerdicts({
          items: toVerify,
          rawVerdicts: searchResult.verdicts,
          letter,
          source: 'ia+recherche',
        }).verdicts;
        for (const [id, verdict] of refined) {
          // Les réponses que la recherche n'a pas tranchées gardent leur statut
          // d'origine : une recherche infructueuse ne refuse pas une réponse.
          if (verdict.source === 'ia+recherche:manquant') continue;
          verdicts.set(id, { ...verdict, searched: true });
          searchedCount++;
        }
        if (searchedCount > 0) source = 'ia+recherche';
      } catch (err) {
        logger.warn?.(`[IA] vérification complémentaire indisponible : ${err.message}`);
        error = `Vérification complémentaire indisponible (${err.message})`;
      }
    }

    return { verdicts: toScoringMap(verdicts), source, error, items, searchedCount };
  };
}

export const validateRound = createValidator();
