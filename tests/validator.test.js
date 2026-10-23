import test from 'node:test';
import assert from 'node:assert/strict';
import { createValidator } from '../src/ai/validator.js';
import { judgeOffline } from '../src/ai/fallback-validator.js';
import { sanitizeVerdicts, toScoringMap } from '../src/ai/schema.js';
import { buildItems } from '../src/ai/prompt.js';
import { makeVerdictKey, STATUS } from '../src/game/scoring.js';

const PLAYERS = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }];
const offlineValidator = createValidator({ hasCredentials: () => false, logger: { warn() {} } });

function get(verdicts, playerId, categoryKey) {
  return verdicts.get(makeVerdictKey(playerId, categoryKey));
}

// ----------------------------------------------------- validateur de secours
test('secours : bonne rubrique acceptée, mauvaise rubrique refusée', async () => {
  const { verdicts, source } = await offlineValidator({
    letter: 'M',
    players: PLAYERS,
    answers: { p1: { animal: 'Mouton', metier: 'Mécanicien' }, p2: { metier: 'Mouton' } },
  });
  assert.equal(source, 'secours');
  assert.equal(get(verdicts, 'p1', 'animal').status, STATUS.VALID);
  assert.equal(get(verdicts, 'p1', 'metier').status, STATUS.VALID);
  assert.equal(get(verdicts, 'p2', 'metier').status, STATUS.INVALID);
  assert.match(get(verdicts, 'p2', 'metier').reason, /Animal/);
});

test('secours : mauvaise première lettre refusée avant tout autre contrôle', async () => {
  const { verdicts } = await offlineValidator({
    letter: 'M',
    players: PLAYERS,
    answers: { p1: { ville: 'Paris', animal: 'Lion' }, p2: {} },
  });
  assert.equal(get(verdicts, 'p1', 'ville').status, STATUS.INVALID);
  assert.match(get(verdicts, 'p1', 'ville').reason, /lettre M/);
  assert.equal(get(verdicts, 'p1', 'animal').status, STATUS.INVALID);
});

test('secours : faute mineure tolérée, mot reconnu normalisé séparément', async () => {
  const { verdicts } = await offlineValidator({
    letter: 'M',
    players: PLAYERS,
    answers: { p1: { ville: 'Marseile', animal: 'Moutonn' }, p2: { ville: 'Marseille' } },
  });
  const v1 = get(verdicts, 'p1', 'ville');
  assert.equal(v1.status, STATUS.VALID);
  assert.equal(v1.raw, 'Marseile', 'le texte original est conservé');
  assert.equal(v1.recognized, 'Marseille', 'le mot reconnu est enregistré séparément');
  assert.equal(v1.groupKey, get(verdicts, 'p2', 'ville').groupKey, 'même entité → même clé');
  assert.equal(get(verdicts, 'p1', 'animal').recognized, 'Mouton');
});

test('secours : deux entités différentes gardent des clés distinctes', async () => {
  const { verdicts } = await offlineValidator({
    letter: 'M',
    players: PLAYERS,
    answers: { p1: { ville: 'Marseille' }, p2: { ville: 'Montpellier' } },
  });
  assert.notEqual(get(verdicts, 'p1', 'ville').groupKey, get(verdicts, 'p2', 'ville').groupKey);
});

// §15.13 — une réponse rare n'est ni acceptée à l'aveugle ni refusée à tort
test('secours : une réponse rare est marquée « à vérifier », pas refusée', async () => {
  const { verdicts } = await offlineValidator({
    letter: 'M',
    players: PLAYERS,
    answers: { p1: { ville: 'Mazamet', animal: 'Marabout' }, p2: {} },
  });
  assert.equal(get(verdicts, 'p1', 'ville').status, STATUS.UNCERTAIN);
  assert.equal(get(verdicts, 'p1', 'ville').needsSearch, true);
  assert.equal(get(verdicts, 'p1', 'animal').status, STATUS.UNCERTAIN);
});

test('une réponse vide n\'est jamais envoyée à l\'IA', () => {
  const items = buildItems({
    players: PLAYERS,
    answers: { p1: { ville: 'Marseille', animal: '', metier: '   ' }, p2: {} },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].categoryKey, 'ville');
});

// ------------------------------------------------- contrôle de la sortie IA
test('les ids inventés par le modèle sont ignorés et les champs bornés', () => {
  const items = [{ id: 'r1', playerId: 'p1', categoryKey: 'ville', raw: 'Marseille' }];
  const { verdicts } = sanitizeVerdicts({
    items,
    letter: 'M',
    source: 'ia',
    rawVerdicts: [
      { id: 'r1', recognized: 'Marseille', status: 'valide', confidence: 42, group_key: 'marseille', reason: 'ok' },
      { id: 'inconnu', recognized: 'Triche', status: 'valide', confidence: 1 },
      { id: 'r1', recognized: 'Doublon', status: 'valide', confidence: 1 },
    ],
  });
  assert.equal(verdicts.size, 1);
  assert.equal(verdicts.get('r1').confidence, 1, 'confiance bornée à 1');
  assert.equal(verdicts.get('r1').recognized, 'Marseille', 'le doublon est ignoré');
});

test('un statut inconnu renvoyé par le modèle devient « à vérifier »', () => {
  const items = [{ id: 'r1', playerId: 'p1', categoryKey: 'ville', raw: 'Marseille' }];
  const { verdicts } = sanitizeVerdicts({
    items, letter: 'M', source: 'ia',
    rawVerdicts: [{ id: 'r1', recognized: 'Marseille', status: 'GÉNIAL', confidence: 0.9 }],
  });
  assert.equal(verdicts.get('r1').status, STATUS.UNCERTAIN);
});

test('toute réponse omise par le modèle obtient un verdict « à vérifier »', () => {
  const items = [
    { id: 'r1', playerId: 'p1', categoryKey: 'ville', raw: 'Marseille' },
    { id: 'r2', playerId: 'p2', categoryKey: 'animal', raw: 'Mouton' },
  ];
  const { verdicts, missingIds } = sanitizeVerdicts({
    items, letter: 'M', source: 'ia',
    rawVerdicts: [{ id: 'r1', recognized: 'Marseille', status: 'valide', confidence: 1 }],
  });
  assert.deepEqual(missingIds, ['r2']);
  assert.equal(verdicts.get('r2').status, STATUS.UNCERTAIN);
});

test('la réindexation associe correctement chaque joueur à sa rubrique', () => {
  const items = [
    { id: 'r1', playerId: 'p1', categoryKey: 'ville', raw: 'Marseille' },
    { id: 'r2', playerId: 'p2', categoryKey: 'ville', raw: 'Montpellier' },
  ];
  const { verdicts } = sanitizeVerdicts({
    items, letter: 'M', source: 'ia',
    rawVerdicts: items.map((it) => ({
      id: it.id, recognized: it.raw, status: 'valide', confidence: 1,
      group_key: it.raw.toLowerCase(), reason: '', needs_search: false,
    })),
  });
  const scoped = toScoringMap(verdicts);
  assert.equal(scoped.get(makeVerdictKey('p1', 'ville')).raw, 'Marseille');
  assert.equal(scoped.get(makeVerdictKey('p2', 'ville')).raw, 'Montpellier');
});

// §15.18 — les erreurs d'API ne bloquent pas la partie
test('une panne de l\'IA bascule sur le mode secours sans bloquer', async () => {
  const validator = createValidator({
    hasCredentials: () => true,
    judgeBatch: async () => { throw new Error('529 overloaded'); },
    logger: { warn() {} },
  });
  const { verdicts, source, error } = await validator({
    letter: 'M', players: PLAYERS, answers: { p1: { animal: 'Mouton' }, p2: {} },
  });
  assert.equal(source, 'secours');
  assert.match(error, /IA indisponible/);
  assert.equal(get(verdicts, 'p1', 'animal').status, STATUS.VALID);
});

test('une IA qui ne répond jamais est interrompue par l\'échéance', async () => {
  const validator = createValidator({
    hasCredentials: () => true,
    judgeBatch: () => new Promise(() => {}), // ne se résout jamais
    deadlineMs: 150,
    logger: { warn() {} },
  });
  const started = Date.now();
  const { source, error } = await validator({
    letter: 'M', players: PLAYERS, answers: { p1: { animal: 'Mouton' }, p2: {} },
  });
  assert.ok(Date.now() - started < 2000, 'la validation doit rendre la main rapidement');
  assert.equal(source, 'secours');
  assert.match(error, /Délai dépassé/);
});

test('l\'IA indisponible ne valide jamais tout en bloc', async () => {
  const validator = createValidator({
    hasCredentials: () => true,
    judgeBatch: async () => { throw new Error('panne'); },
    logger: { warn() {} },
  });
  const { verdicts } = await validator({
    letter: 'M',
    players: PLAYERS,
    answers: { p1: { objet: 'Paris', metier: 'Mouton', ville: 'Marseille' }, p2: {} },
  });
  assert.equal(get(verdicts, 'p1', 'objet').status, STATUS.INVALID);
  assert.equal(get(verdicts, 'p1', 'metier').status, STATUS.INVALID);
  assert.equal(get(verdicts, 'p1', 'ville').status, STATUS.VALID);
});

test('la seconde passe ne porte que sur les réponses incertaines', async () => {
  let searchedItems = null;
  const validator = createValidator({
    hasCredentials: () => true,
    judgeBatch: async ({ items }) => ({
      verdicts: items.map((it) => ({
        id: it.id,
        recognized: it.raw,
        status: it.raw === 'Mazamet' ? 'a_verifier' : 'valide',
        reason: '', confidence: 0.9, group_key: it.raw.toLowerCase(),
        needs_search: it.raw === 'Mazamet',
      })),
    }),
    judgeWithSearch: async ({ items }) => {
      searchedItems = items.map((it) => it.raw);
      return {
        verdicts: items.map((it) => ({
          id: it.id, recognized: it.raw, status: 'valide',
          reason: 'commune du Tarn confirmée', confidence: 0.93,
          group_key: it.raw.toLowerCase(), needs_search: false,
        })),
      };
    },
  });
  const { verdicts, source, searchedCount } = await validator({
    letter: 'M',
    players: PLAYERS,
    answers: { p1: { ville: 'Mazamet', animal: 'Mouton' }, p2: { ville: 'Marseille' } },
  });
  assert.deepEqual(searchedItems, ['Mazamet'], 'une seule recherche, pas une par mot');
  assert.equal(searchedCount, 1);
  assert.equal(source, 'ia+recherche');
  assert.equal(get(verdicts, 'p1', 'ville').status, STATUS.VALID);
  assert.equal(get(verdicts, 'p1', 'ville').searched, true);
});

test('une recherche infructueuse laisse la réponse « à vérifier » sans la refuser', async () => {
  const validator = createValidator({
    hasCredentials: () => true,
    judgeBatch: async ({ items }) => ({
      verdicts: items.map((it) => ({
        id: it.id, recognized: it.raw, status: 'a_verifier', reason: 'inconnue',
        confidence: 0.4, group_key: it.raw.toLowerCase(), needs_search: true,
      })),
    }),
    judgeWithSearch: async () => ({ verdicts: [] }), // rien trouvé
    logger: { warn() {} },
  });
  const { verdicts } = await validator({
    letter: 'M', players: PLAYERS, answers: { p1: { ville: 'Mzzzz' }, p2: {} },
  });
  assert.equal(get(verdicts, 'p1', 'ville').status, STATUS.UNCERTAIN);
});

test('sans aucune réponse soumise, la validation n\'appelle pas l\'IA', async () => {
  let called = false;
  const validator = createValidator({
    hasCredentials: () => true,
    judgeBatch: async () => { called = true; return { verdicts: [] }; },
  });
  const { source, verdicts } = await validator({ letter: 'M', players: PLAYERS, answers: {} });
  assert.equal(called, false);
  assert.equal(source, 'aucune-reponse');
  assert.equal(verdicts.size, 0);
});

test('le mode secours reste déterministe entre deux exécutions', () => {
  const items = buildItems({ players: PLAYERS, answers: { p1: { ville: 'Marseile' }, p2: {} } });
  const a = judgeOffline({ letter: 'M', items });
  const b = judgeOffline({ letter: 'M', items });
  assert.deepEqual(a, b);
});
