/**
 * Test de l'IA RÉELLE. Exécuté uniquement si une clé est présente :
 *   ANTHROPIC_API_KEY=sk-ant-... npm run test:ai
 * Sans clé, les cas sont ignorés (et non silencieusement « réussis »).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createValidator } from '../src/ai/validator.js';
import { hasCredentials } from '../src/ai/anthropic-validator.js';
import { makeVerdictKey, STATUS } from '../src/game/scoring.js';

const skip = hasCredentials() ? false : "ANTHROPIC_API_KEY absente : test de l'IA réelle ignoré";
const validate = createValidator();
const PLAYERS = [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }];
const get = (verdicts, pid, cat) => verdicts.get(makeVerdictKey(pid, cat));

test('IA réelle : chaque mot est jugé dans sa rubrique', { skip, timeout: 180_000 }, async () => {
  const { verdicts, source } = await validate({
    letter: 'M',
    players: PLAYERS,
    answers: {
      p1: {
        ville: 'Marseille',      // valide
        metier: 'Mouton',        // hors rubrique (animal)
        animal: 'Moutonn',       // faute mineure tolérable
        prenom_fille: 'Marie',
        objet: 'Paris',          // hors rubrique ET mauvaise lettre
        fruit_legume: 'Melon',
      },
      p2: {
        ville: 'Marseile',       // même entité que Marseille
        prenom_fille: 'Maria',   // prénom différent de Marie
        pays: 'Mexique',
        objet: 'Marteau',
      },
    },
  });

  assert.ok(['ia', 'ia+recherche'].includes(source), `source inattendue : ${source}`);
  assert.equal(get(verdicts, 'p1', 'ville').status, STATUS.VALID);
  assert.equal(get(verdicts, 'p1', 'metier').status, STATUS.INVALID);
  assert.equal(get(verdicts, 'p1', 'objet').status, STATUS.INVALID);
  assert.equal(get(verdicts, 'p1', 'fruit_legume').status, STATUS.VALID);
  assert.equal(get(verdicts, 'p2', 'pays').status, STATUS.VALID);
  assert.equal(get(verdicts, 'p2', 'objet').status, STATUS.VALID);

  // Orthographe tolérante : le mot reconnu est corrigé, le texte original conservé.
  const moutonn = get(verdicts, 'p1', 'animal');
  assert.equal(moutonn.status, STATUS.VALID);
  assert.equal(moutonn.raw, 'Moutonn');
  assert.match(moutonn.recognized, /^Mouton$/i);

  // Deux écritures d'une même ville partagent la clé canonique…
  const marseille = get(verdicts, 'p1', 'ville');
  const marseile = get(verdicts, 'p2', 'ville');
  assert.equal(marseile.status, STATUS.VALID);
  assert.equal(
    marseille.groupKey.toLowerCase(),
    marseile.groupKey.toLowerCase(),
    'Marseille et Marseile doivent partager la même clé',
  );

  // … tandis que deux prénoms distincts ne sont pas confondus.
  assert.notEqual(
    get(verdicts, 'p1', 'prenom_fille').groupKey.toLowerCase(),
    get(verdicts, 'p2', 'prenom_fille').groupKey.toLowerCase(),
    'Marie et Maria sont deux prénoms différents',
  );
});

test('IA réelle : une réponse rare est vérifiée, pas refusée d\'office', { skip, timeout: 180_000 }, async () => {
  const { verdicts } = await validate({
    letter: 'M',
    players: [PLAYERS[0]],
    answers: { p1: { ville: 'Mazamet', animal: 'Marabout', metier: 'Mareyeur' } },
  });
  for (const category of ['ville', 'animal', 'metier']) {
    const verdict = get(verdicts, 'p1', category);
    assert.notEqual(verdict.status, STATUS.INVALID, `${category} ne doit pas être refusé : ${verdict.reason}`);
  }
});

test('IA réelle : le barème s\'applique au résultat renvoyé', { skip, timeout: 180_000 }, async () => {
  const { scoreRound } = await import('../src/game/scoring.js');
  const answers = {
    p1: { ville: 'Marseille', animal: 'Mouton' },
    p2: { ville: 'Marseile', animal: 'Marmotte' },
  };
  const { verdicts } = await validate({ letter: 'M', players: PLAYERS, answers });
  const result = scoreRound({ letter: 'M', players: PLAYERS, answers, verdicts });
  const points = (cat, pid) =>
    result.categories.find((c) => c.key === cat).entries.find((e) => e.playerId === pid).points;
  assert.equal(points('ville', 'p1'), 1, 'même ville → 1 point chacun');
  assert.equal(points('ville', 'p2'), 1);
  assert.equal(points('animal', 'p1'), 2, 'animaux différents → 2 points chacun');
  assert.equal(points('animal', 'p2'), 2);
});
