// Normalisation tolérante. Le texte original du joueur n'est JAMAIS modifié :
// ces fonctions ne servent qu'à produire des clés de comparaison.

export function stripAccents(str) {
  return String(str).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** minuscules, sans accents, espaces/tirets normalisés, ponctuation retirée */
export function normalizeLoose(str) {
  return stripAccents(String(str ?? ''))
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** clé de comparaison stricte : uniquement [a-z0-9] */
export function normalizeKey(str) {
  return normalizeLoose(str).replace(/[^a-z0-9]/g, '');
}

/** Première lettre alphabétique réelle, en majuscule, accents retirés. '' si aucune. */
export function firstLetterOf(str) {
  const m = stripAccents(String(str ?? '')).match(/[A-Za-z]/);
  return m ? m[0].toUpperCase() : '';
}

export function isBlank(str) {
  return String(str ?? '').trim() === '';
}

/** Distance de Levenshtein (itérative, O(n*m) mémoire O(m)). */
export function levenshtein(a, b) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let cur = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[t.length];
}

/**
 * Tolérance d'orthographe admise pour un mot de longueur donnée.
 * Volontairement serrée : deux mots distincts ne doivent pas fusionner.
 */
export function editTolerance(len) {
  if (len <= 4) return 0;
  if (len <= 6) return 1;
  if (len <= 9) return 2;
  return 3;
}

/**
 * Deux écritures désignent-elles vraisemblablement le même mot ?
 *
 * Usage : UNIQUEMENT la recherche dans les lexiques du validateur de secours.
 * Le regroupement des réponses pour les points n'utilise jamais cette fonction
 * (il s'appuie sur la clé canonique de l'IA et sur l'égalité exacte), afin que
 * deux mots simplement ressemblants ne soient jamais fusionnés.
 *
 * Deux garde-fous : on n'accepte pas une correction qui change la première
 * lettre (sinon l'orthographe tolérante contournerait la règle de la lettre),
 * et les deux premiers caractères doivent coïncider.
 */
export function sameWord(a, b) {
  const ka = normalizeKey(a);
  const kb = normalizeKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka[0] !== kb[0]) return false;
  if (ka.slice(0, 2) !== kb.slice(0, 2)) return false;
  const tol = editTolerance(Math.min(ka.length, kb.length));
  if (Math.abs(ka.length - kb.length) > tol) return false;
  return levenshtein(ka, kb) <= tol;
}

/**
 * Deux réponses non reconnues désignent-elles vraisemblablement le même mot ?
 *
 * Filet de sécurité du mode secours UNIQUEMENT : quand aucun des deux mots
 * n'a pu être identifié, une faute de frappe ne doit pas valoir 2 points à
 * chacun. Volontairement très conservateur — mots longs, trois premières
 * lettres identiques, une seule faute — pour ne jamais fusionner deux mots
 * réellement différents.
 */
export function likelySameAnswer(a, b) {
  const ka = normalizeKey(a);
  const kb = normalizeKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (Math.min(ka.length, kb.length) < 7) return false;
  if (ka.slice(0, 3) !== kb.slice(0, 3)) return false;
  if (Math.abs(ka.length - kb.length) > 1) return false;
  return levenshtein(ka, kb) <= 1;
}
