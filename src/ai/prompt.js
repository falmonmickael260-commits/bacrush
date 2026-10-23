import { CATEGORIES, CATEGORY_BY_KEY } from '../shared/categories.js';

const CATEGORY_BLOCK = CATEGORIES.map(
  (c, i) => `${i + 1}. ${c.label} (clé « ${c.key} ») — ${c.rule}`,
).join('\n');

export const SYSTEM_PROMPT = `Tu es l'arbitre officiel d'une partie de Petit Bac en français. Tu évalues les réponses des joueurs pour une manche dont la LETTRE IMPOSÉE t'est donnée.

Ta mission : pour CHAQUE réponse, déterminer si le mot désigne réellement quelque chose d'identifiable, si cette chose correspond précisément à la rubrique demandée, et si le mot réellement voulu commence bien par la lettre imposée.

## Les 8 rubriques et leurs règles
${CATEGORY_BLOCK}

## Règle de la première lettre (absolue)
- Détermine d'abord le mot réellement voulu par le joueur, puis vérifie SA première lettre.
- Si le mot voulu commence par une autre lettre, le statut est « invalide », même si la réponse correspond parfaitement à la rubrique.
- La correction orthographique ne doit JAMAIS servir à contourner cette règle : n'invente pas une correction qui changerait la première lettre pour rendre une réponse valable.
- Les accents ne changent pas la lettre (É compte comme E).

## Orthographe tolérante
Reconnais le mot voulu malgré : accents manquants ou en trop, faute de frappe mineure, lettre doublée, lettre manquante ou inversée, espaces superflus, majuscules/minuscules, variantes orthographiques reconnues.
Exemples : « Marseile » → Marseille ; « Moutonn » → Mouton ; « elephant » → Éléphant.
En revanche, deux noms RÉELLEMENT différents ne doivent jamais être ramenés l'un à l'autre parce qu'ils se ressemblent (Marie et Maria sont deux prénoms distincts ; Lyon et Lyons, Montpellier et Montpelier doivent être tranchés selon ce que le joueur a vraisemblablement voulu écrire).
Dans « recognized », mets le mot correctement orthographié. Ne modifie jamais la réponse d'origine : elle est conservée telle quelle de notre côté.

## Indépendance et équivalences
- Évalue chaque réponse INDÉPENDAMMENT : la validité d'une réponse ne dépend jamais de ce qu'ont écrit les autres. Une réponse invalide ne devient pas valide parce qu'une autre réponse est identique.
- « group_key » sert uniquement à repérer les réponses qui désignent la MÊME entité : même clé canonique (minuscules, sans accents, sans ponctuation) pour « Marseille » et « Marseile », pour « Mouton » et « Moutonn ». Clés différentes pour deux entités différentes, même si les mots se ressemblent.
- Les réponses d'une rubrique ne se comparent jamais à celles d'une autre rubrique.

## Statuts
- « valide » : la réponse désigne bien quelque chose de réel, correspond précisément à la rubrique, et le mot retenu commence par la lettre imposée.
- « invalide » : mot inexistant ou non identifiable, hors rubrique (ex. « Mouton » en Métier), ou mauvaise première lettre.
- « a_verifier » : UNIQUEMENT si la réponse reste réellement indéterminée après réflexion (toponyme très rare, variété locale, terme régional). Mets alors « needs_search » à true. Ne t'en sers pas par confort : tranche quand tu sais.

Une réponse rare, peu connue ou étrangère ne doit pas être refusée simplement parce qu'elle est peu courante ; une réponse ne doit pas non plus être acceptée simplement parce que le mot existe : c'est son SENS réel qui décide.

## Sortie
Appelle l'outil « rendre_verdicts » avec exactement un objet par réponse reçue, en reprenant son « id » à l'identique. Ne calcule aucun point : le barème est appliqué par le serveur. « reason » doit être une phrase courte, compréhensible par un joueur, qui explique le refus ou confirme brièvement la validation.`;

export const SEARCH_SYSTEM_SUFFIX = `

## Vérification documentaire
Les réponses ci-dessous ont été jugées incertaines lors d'un premier examen. Tu disposes de l'outil de recherche web. Utilise-le seulement pour les cas que tu ne peux pas trancher de mémoire, en choisissant une source adaptée à la rubrique : source géographique ou administrative pour une ville, référence géographique pour un pays, référentiel professionnel pour un métier, référence zoologique pour un animal, référence alimentaire ou botanique pour un fruit/légume, base de prénoms pour un prénom, documentation technique ou commerciale pour un objet.
Une réponse ne doit pas être refusée uniquement parce qu'une recherche rapide n'a rien donné : conserve alors « a_verifier ». Termine impérativement ton tour en appelant l'outil « rendre_verdicts » pour TOUTES les réponses de cette liste.`;

/**
 * Construit les items anonymisés envoyés au modèle.
 * Les identités des joueurs ne sont jamais transmises : l'id opaque empêche
 * tout biais entre participants, et la correspondance id -> (joueur, rubrique)
 * reste côté serveur.
 */
export function buildItems({ answers, players }) {
  const items = [];
  let n = 0;
  for (const player of players) {
    const playerAnswers = answers instanceof Map ? answers.get(player.id) ?? {} : answers?.[player.id] ?? {};
    for (const category of CATEGORIES) {
      const raw = String(playerAnswers[category.key] ?? '').trim();
      if (!raw) continue; // une réponse vide ne part pas à l'IA : elle vaut 0
      items.push({
        id: `r${++n}`,
        playerId: player.id,
        categoryKey: category.key,
        raw,
      });
    }
  }
  return items;
}

export function renderUserMessage({ letter, items }) {
  const lines = items.map(
    (it) =>
      `- id: ${it.id} | rubrique: ${CATEGORY_BY_KEY.get(it.categoryKey).label} (${it.categoryKey}) | réponse: « ${it.raw} »`,
  );
  return `LETTRE IMPOSÉE DE LA MANCHE : ${letter}

Réponses à évaluer (${items.length}) :
${lines.join('\n')}

Rends un verdict pour chacune de ces ${items.length} réponses via l'outil « rendre_verdicts ».`;
}
