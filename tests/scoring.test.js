import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRound, STATUS, makeVerdictKey } from '../src/game/scoring.js';

const PLAYERS = [{ id: 'p1', name: 'Joueur 1' }, { id: 'p2', name: 'Joueur 2' }];

function verdict(status, recognized, groupKey, extra = {}) {
  return {
    status, recognized, groupKey, reason: extra.reason ?? '',
    confidence: extra.confidence ?? 0.95, source: 'test', ...extra,
  };
}

function run({ answers, verdicts, letter = 'M', uncertainPolicy }) {
  const map = new Map(Object.entries(verdicts).map(([k, v]) => [k, v]));
  return scoreRound({ letter, players: PLAYERS, answers, verdicts: map, uncertainPolicy });
}

function pointsOf(result, categoryKey, playerId) {
  const category = result.categories.find((c) => c.key === categoryKey);
  return category.entries.find((e) => e.playerId === playerId).points;
}
function entryOf(result, categoryKey, playerId) {
  return result.categories
    .find((c) => c.key === categoryKey)
    .entries.find((e) => e.playerId === playerId);
}

// §9 — le tableau d'exemple du cahier des charges, à l'identique
test('le barème reproduit exactement le tableau de référence (lettre M)', () => {
  const result = run({
    answers: {
      p1: { prenom_fille: 'Marie', ville: 'Marseille', animal: 'Moutonn', metier: 'Mécanicien', objet: 'Paris' },
      p2: { prenom_fille: 'Marie', ville: 'Montpellier', animal: 'Mouton', metier: '', objet: 'Paris' },
    },
    verdicts: {
      [makeVerdictKey('p1', 'prenom_fille')]: verdict(STATUS.VALID, 'Marie', 'marie'),
      [makeVerdictKey('p2', 'prenom_fille')]: verdict(STATUS.VALID, 'Marie', 'marie'),
      [makeVerdictKey('p1', 'ville')]: verdict(STATUS.VALID, 'Marseille', 'marseille'),
      [makeVerdictKey('p2', 'ville')]: verdict(STATUS.VALID, 'Montpellier', 'montpellier'),
      [makeVerdictKey('p1', 'animal')]: verdict(STATUS.VALID, 'Mouton', 'mouton'),
      [makeVerdictKey('p2', 'animal')]: verdict(STATUS.VALID, 'Mouton', 'mouton'),
      [makeVerdictKey('p1', 'metier')]: verdict(STATUS.VALID, 'Mécanicien', 'mecanicien'),
      [makeVerdictKey('p1', 'objet')]: verdict(STATUS.INVALID, 'Paris', 'paris', { reason: 'Paris est une ville' }),
      [makeVerdictKey('p2', 'objet')]: verdict(STATUS.INVALID, 'Paris', 'paris', { reason: 'Paris est une ville' }),
    },
  });

  assert.equal(pointsOf(result, 'prenom_fille', 'p1'), 1);
  assert.equal(pointsOf(result, 'prenom_fille', 'p2'), 1);
  assert.equal(pointsOf(result, 'ville', 'p1'), 2);
  assert.equal(pointsOf(result, 'ville', 'p2'), 2);
  assert.equal(pointsOf(result, 'animal', 'p1'), 1);
  assert.equal(pointsOf(result, 'animal', 'p2'), 1);
  assert.equal(pointsOf(result, 'metier', 'p1'), 2);
  assert.equal(pointsOf(result, 'metier', 'p2'), 0);
  assert.equal(pointsOf(result, 'objet', 'p1'), 0);
  assert.equal(pointsOf(result, 'objet', 'p2'), 0);
  assert.deepEqual(result.totals, { p1: 6, p2: 4 });
});

// §15.7 / §15.8
test('une réponse valide dans la bonne rubrique est acceptée, refusée dans la mauvaise', () => {
  const result = run({
    answers: { p1: { animal: 'Mouton' }, p2: { metier: 'Mouton' } },
    verdicts: {
      [makeVerdictKey('p1', 'animal')]: verdict(STATUS.VALID, 'Mouton', 'mouton'),
      [makeVerdictKey('p2', 'metier')]: verdict(STATUS.INVALID, 'Mouton', 'mouton', {
        reason: "Mouton est un animal, pas un métier",
      }),
    },
  });
  assert.equal(pointsOf(result, 'animal', 'p1'), 2);
  assert.equal(pointsOf(result, 'metier', 'p2'), 0);
  assert.match(entryOf(result, 'metier', 'p2').reason, /animal/);
});

// §15.9 — contrôle serveur, même si l'IA se trompait
test('une mauvaise première lettre est refusée par le serveur même si l\'IA valide', () => {
  const result = run({
    answers: { p1: { ville: 'Paris' }, p2: { ville: 'Lyon' } },
    verdicts: {
      // l'IA valide à tort : le serveur doit refuser
      [makeVerdictKey('p1', 'ville')]: verdict(STATUS.VALID, 'Paris', 'paris'),
      [makeVerdictKey('p2', 'ville')]: verdict(STATUS.VALID, 'Lyon', 'lyon'),
    },
  });
  assert.equal(pointsOf(result, 'ville', 'p1'), 0);
  assert.equal(pointsOf(result, 'ville', 'p2'), 0);
  assert.match(entryOf(result, 'ville', 'p1').reason, /lettre M/);
});

test('une correction orthographique ne peut pas contourner la règle de la lettre', () => {
  const result = run({
    // l'IA « corrige » Paris en Marseille : le serveur vérifie aussi le texte saisi
    answers: { p1: { ville: 'Paris' } },
    verdicts: {
      [makeVerdictKey('p1', 'ville')]: verdict(STATUS.VALID, 'Marseille', 'marseille'),
    },
  });
  assert.equal(pointsOf(result, 'ville', 'p1'), 0);
  assert.equal(entryOf(result, 'ville', 'p1').status, STATUS.INVALID);
});

// §15.10 / §15.11
test('une faute mineure est tolérée et regroupée avec l\'orthographe exacte', () => {
  const result = run({
    answers: { p1: { ville: 'Marseile' }, p2: { ville: 'Marseille' } },
    verdicts: {
      [makeVerdictKey('p1', 'ville')]: verdict(STATUS.VALID, 'Marseille', 'marseille'),
      [makeVerdictKey('p2', 'ville')]: verdict(STATUS.VALID, 'Marseille', 'marseille'),
    },
  });
  assert.equal(pointsOf(result, 'ville', 'p1'), 1);
  assert.equal(pointsOf(result, 'ville', 'p2'), 1);
  const category = result.categories.find((c) => c.key === 'ville');
  assert.equal(category.groups.length, 1);
  assert.equal(category.groups[0].playerIds.length, 2);
  assert.equal(entryOf(result, 'ville', 'p1').raw, 'Marseile', 'le texte original est conservé');
  assert.equal(entryOf(result, 'ville', 'p1').recognized, 'Marseille');
});

// §15.12
test('deux réponses différentes mais ressemblantes ne sont pas regroupées', () => {
  const result = run({
    answers: { p1: { prenom_fille: 'Marie' }, p2: { prenom_fille: 'Maria' } },
    verdicts: {
      [makeVerdictKey('p1', 'prenom_fille')]: verdict(STATUS.VALID, 'Marie', 'marie'),
      [makeVerdictKey('p2', 'prenom_fille')]: verdict(STATUS.VALID, 'Maria', 'maria'),
    },
  });
  assert.equal(pointsOf(result, 'prenom_fille', 'p1'), 2);
  assert.equal(pointsOf(result, 'prenom_fille', 'p2'), 2);
  assert.equal(result.categories.find((c) => c.key === 'prenom_fille').groups.length, 2);
});

test('une réponse identique dans une autre rubrique ne crée pas de groupe', () => {
  const result = run({
    answers: { p1: { animal: 'Mouton' }, p2: { objet: 'Mouton' } },
    verdicts: {
      [makeVerdictKey('p1', 'animal')]: verdict(STATUS.VALID, 'Mouton', 'mouton'),
      [makeVerdictKey('p2', 'objet')]: verdict(STATUS.VALID, 'Mouton', 'mouton'),
    },
  });
  // Chacun est seul dans sa rubrique : 2 points chacun, aucune comparaison croisée.
  assert.equal(pointsOf(result, 'animal', 'p1'), 2);
  assert.equal(pointsOf(result, 'objet', 'p2'), 2);
});

test('une réponse invalide ne devient pas valide parce qu\'un autre joueur l\'a écrite', () => {
  const result = run({
    answers: { p1: { objet: 'Paris' }, p2: { objet: 'Paris' } },
    verdicts: {
      [makeVerdictKey('p1', 'objet')]: verdict(STATUS.INVALID, 'Paris', 'paris', { reason: 'ville' }),
      [makeVerdictKey('p2', 'objet')]: verdict(STATUS.INVALID, 'Paris', 'paris', { reason: 'ville' }),
    },
  });
  assert.equal(pointsOf(result, 'objet', 'p1'), 0);
  assert.equal(pointsOf(result, 'objet', 'p2'), 0);
  assert.equal(result.categories.find((c) => c.key === 'objet').groups.length, 0);
});

// §15.14
test('une réponse vide rapporte zéro point et n\'entre dans aucun groupe', () => {
  const result = run({
    answers: { p1: { ville: '' }, p2: { ville: '   ' } },
    verdicts: {},
  });
  assert.equal(pointsOf(result, 'ville', 'p1'), 0);
  assert.equal(pointsOf(result, 'ville', 'p2'), 0);
  assert.equal(entryOf(result, 'ville', 'p1').status, STATUS.EMPTY);
  assert.equal(result.categories.find((c) => c.key === 'ville').groups.length, 0);
});

test('une réponse sans verdict exploitable ne rapporte jamais de points', () => {
  const result = run({
    answers: { p1: { ville: 'Marseille' } },
    verdicts: {}, // validation indisponible
  });
  assert.equal(pointsOf(result, 'ville', 'p1'), 0);
  assert.equal(entryOf(result, 'ville', 'p1').status, STATUS.INVALID);
});

// §7 — politique des cas incertains
test('un cas « à vérifier » est compté mais signalé (politique tolérante)', () => {
  const result = run({
    answers: { p1: { ville: 'Mazamet' } },
    verdicts: {
      [makeVerdictKey('p1', 'ville')]: verdict(STATUS.UNCERTAIN, 'Mazamet', 'mazamet', {
        reason: 'commune peu connue', confidence: 0.45,
      }),
    },
  });
  assert.equal(pointsOf(result, 'ville', 'p1'), 2);
  assert.equal(entryOf(result, 'ville', 'p1').flagged, true);
  assert.equal(result.flaggedCount, 1);
});

test('la politique stricte refuse les cas incertains', () => {
  const result = run({
    answers: { p1: { ville: 'Mazamet' } },
    verdicts: {
      [makeVerdictKey('p1', 'ville')]: verdict(STATUS.UNCERTAIN, 'Mazamet', 'mazamet'),
    },
    uncertainPolicy: 'strict',
  });
  assert.equal(pointsOf(result, 'ville', 'p1'), 0);
});

// §15.15
test('trois joueurs : unique = 2, partagée = 1 pour chacun', () => {
  const players = [...PLAYERS, { id: 'p3', name: 'Joueur 3' }];
  const result = scoreRound({
    letter: 'M',
    players,
    answers: { p1: { animal: 'Mouton' }, p2: { animal: 'Moutonn' }, p3: { animal: 'Marmotte' } },
    verdicts: new Map([
      [makeVerdictKey('p1', 'animal'), verdict(STATUS.VALID, 'Mouton', 'mouton')],
      [makeVerdictKey('p2', 'animal'), verdict(STATUS.VALID, 'Mouton', 'mouton')],
      [makeVerdictKey('p3', 'animal'), verdict(STATUS.VALID, 'Marmotte', 'marmotte')],
    ]),
  });
  assert.equal(pointsOf(result, 'animal', 'p1'), 1);
  assert.equal(pointsOf(result, 'animal', 'p2'), 1);
  assert.equal(pointsOf(result, 'animal', 'p3'), 2);
  assert.deepEqual(result.totals, { p1: 1, p2: 1, p3: 2 });
});

test('le score maximal d\'une manche est de 16 points (8 rubriques × 2)', () => {
  const answers = { p1: {}, p2: {} };
  const verdicts = {};
  const words = {
    prenom_fille: 'Marie', prenom_garcon: 'Marc', ville: 'Marseille', pays: 'Maroc',
    metier: 'Maçon', animal: 'Mouton', fruit_legume: 'Melon', objet: 'Marteau',
  };
  for (const [key, word] of Object.entries(words)) {
    answers.p1[key] = word;
    verdicts[makeVerdictKey('p1', key)] = verdict(STATUS.VALID, word, word.toLowerCase());
  }
  const result = run({ answers, verdicts });
  assert.equal(result.totals.p1, 16);
  assert.equal(result.totals.p2, 0);
});

// --- Rapprochement des mots que le serveur n'a pas identifiés ---------------
import { createValidator } from '../src/ai/validator.js';

const offline = createValidator({ hasCredentials: () => false, logger: { warn() {} } });

async function offlineRound(categoryKey, a, b, letter = 'M') {
  const players = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }];
  const answers = { p1: { [categoryKey]: a }, p2: { [categoryKey]: b } };
  const { verdicts } = await offline({ letter, players, answers });
  const result = scoreRound({ letter, players, answers, verdicts });
  const category = result.categories.find((c) => c.key === categoryKey);
  return {
    groupes: category.groups.length,
    points: category.entries.map((e) => e.points),
    statuts: category.entries.map((e) => e.status),
  };
}

test('une faute de frappe sur un mot inconnu vaut une seule réponse', async () => {
  const ville = await offlineRound('ville', 'Mazamet', 'Mazamett');
  assert.equal(ville.groupes, 1, 'les deux écritures désignent la même commune');
  assert.deepEqual(ville.points, [1, 1]);

  const metier = await offlineRound('metier', 'Mareyeur', 'Mareyeure');
  assert.deepEqual(metier.points, [1, 1]);
});

test('deux mots inconnus réellement différents restent séparés', async () => {
  const villes = await offlineRound('ville', 'Marseille', 'Montpellier');
  assert.equal(villes.groupes, 2);
  assert.deepEqual(villes.points, [2, 2]);

  const courts = await offlineRound('ville', 'Melun', 'Mimizan');
  assert.equal(courts.groupes, 2, 'deux communes inconnues restent distinctes');

  // Les mots de moins de 7 lettres ne sont jamais rapprochés, même à une faute.
  const tresCourts = await offlineRound('ville', 'Meung', 'Meaux');
  assert.equal(tresCourts.groupes, 2);
});

test('les prénoms ne sont jamais rapprochés à une faute près', async () => {
  const { groupes, points } = await offlineRound('prenom_fille', 'Maryline', 'Marylise');
  assert.equal(groupes, 2, 'deux prénoms distincts séparés par une lettre');
  assert.deepEqual(points, [2, 2]);
});

test('une réponse n\'est pas refusée pour ressembler à un mot d\'une autre rubrique', async () => {
  // « Mandoline » (objet) ressemble à « Mandarine » (fruit) : ce n'est pas un motif de refus.
  const { statuts, points } = await offlineRound('objet', 'Mandoline', 'Mandolines');
  assert.ok(!statuts.includes(STATUS.INVALID), `statuts obtenus : ${statuts.join(', ')}`);
  assert.deepEqual(points, [1, 1]);
});

test('un mot appartenant exactement à une autre rubrique reste refusé', async () => {
  const { statuts, points } = await offlineRound('metier', 'Mouton', 'Maçon');
  assert.equal(statuts[0], STATUS.INVALID, 'Mouton est un animal, pas un métier');
  assert.equal(points[0], 0);
  assert.equal(points[1], 2);
});
