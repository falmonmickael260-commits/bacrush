/**
 * Vérifie la forme exacte de la requête construite pour l'API Anthropic, en
 * faisant dialoguer le vrai SDK avec un serveur factice.
 *
 * Ce test ne remplace pas un appel réel au modèle (voir tests/ai-live.test.js,
 * qui exige une clé) : il garantit que les paramètres envoyés sont ceux voulus
 * et que la réponse est correctement décodée.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const captured = [];
let nextResponses = [];

const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    captured.push({
      path: req.url,
      headers: req.headers,
      body: JSON.parse(body || '{}'),
    });
    const payload = nextResponses.shift() ?? { content: [], stop_reason: 'end_turn' };
    const response = {
      id: `msg_${captured.length}`,
      type: 'message',
      role: 'assistant',
      model: payload.model ?? 'claude-opus-5',
      content: payload.content,
      stop_reason: payload.stop_reason,
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 80 },
      ...(payload.stop_details ? { stop_details: payload.stop_details } : {}),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
});

const ITEMS = [
  { id: 'r1', playerId: 'p1', categoryKey: 'ville', raw: 'Marseile' },
  { id: 'r2', playerId: 'p2', categoryKey: 'metier', raw: 'Mouton' },
];

function verdictBlock(verdicts) {
  return {
    content: [{ type: 'tool_use', id: 'tu_1', name: 'rendre_verdicts', input: { verdicts } }],
    stop_reason: 'tool_use',
  };
}

let ai;
test.before(async () => {
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-factice-pour-test';
  ai = await import('../src/ai/anthropic-validator.js');
});

test.after(() => new Promise((resolve) => stub.close(resolve)));

test('la première passe impose la sortie structurée et n\'active pas la recherche', async () => {
  captured.length = 0;
  nextResponses = [verdictBlock([
    { id: 'r1', recognized: 'Marseille', first_letter: 'M', group_key: 'marseille',
      status: 'valide', reason: 'ville réelle', confidence: 0.96, needs_search: false },
    { id: 'r2', recognized: 'Mouton', first_letter: 'M', group_key: 'mouton',
      status: 'invalide', reason: 'un mouton est un animal', confidence: 0.98, needs_search: false },
  ])];

  const result = await ai.judgeBatch({ letter: 'M', items: ITEMS });

  assert.equal(captured.length, 1);
  const { body, headers, path } = captured[0];
  assert.equal(path, '/v1/messages');
  // Le SDK transporte la clé lui-même (Authorization: Bearer) : elle reste côté serveur.
  assert.equal(headers.authorization, 'Bearer sk-ant-factice-pour-test');
  assert.equal(headers['x-stainless-timeout'], '40', 'échéance de requête appliquée');
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.max_tokens, 16_000);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'rendre_verdicts' });
  assert.equal(body.tools.length, 1, 'aucun outil de recherche à la première passe');
  assert.equal(body.tools[0].name, 'rendre_verdicts');
  assert.equal(body.tools[0].strict, true);
  assert.equal(body.tools[0].input_schema.additionalProperties, false);
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.system[0].cache_control.type, 'ephemeral');
  assert.match(body.system[0].text, /arbitre officiel d'une partie de Petit Bac/);
  assert.match(body.messages[0].content, /LETTRE IMPOSÉE DE LA MANCHE : M/);
  assert.match(body.messages[0].content, /id: r1 \| rubrique: Ville/);
  assert.ok(!/p1|p2/.test(body.messages[0].content), 'aucune identité de joueur transmise');

  assert.equal(result.verdicts.length, 2);
  assert.equal(result.verdicts[0].recognized, 'Marseille');
  assert.equal(result.verdicts[1].status, 'invalide');
});

test('la seconde passe déclare l\'outil de recherche web côté serveur', async () => {
  captured.length = 0;
  nextResponses = [verdictBlock([
    { id: 'r1', recognized: 'Mazamet', first_letter: 'M', group_key: 'mazamet',
      status: 'valide', reason: 'commune du Tarn', confidence: 0.9, needs_search: false },
  ])];

  const { verdicts } = await ai.judgeWithSearch({
    letter: 'M',
    items: [{ id: 'r1', playerId: 'p1', categoryKey: 'ville', raw: 'Mazamet' }],
  });

  const { body } = captured[0];
  const searchTool = body.tools.find((t) => t.name === 'web_search');
  assert.ok(searchTool, 'l\'outil web_search doit être déclaré');
  assert.equal(searchTool.type, 'web_search_20260209');
  assert.equal(searchTool.max_uses, 6);
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.equal(body.output_config.effort, 'high');
  assert.match(body.system[1].text, /Vérification documentaire/);
  assert.equal(verdicts[0].searched, true);
});

test('un pause_turn de la recherche serveur est poursuivi puis décodé', async () => {
  captured.length = 0;
  nextResponses = [
    {
      content: [
        { type: 'server_tool_use', id: 'st_1', name: 'web_search', input: { query: 'Mazamet commune' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'st_1',
          content: [{ type: 'web_search_result', title: 'Mazamet', url: 'https://example.org/mazamet' }],
        },
      ],
      stop_reason: 'pause_turn',
    },
    verdictBlock([
      { id: 'r1', recognized: 'Mazamet', first_letter: 'M', group_key: 'mazamet',
        status: 'valide', reason: 'commune du Tarn confirmée', confidence: 0.94, needs_search: false },
    ]),
  ];

  const { verdicts, searched } = await ai.judgeWithSearch({
    letter: 'M',
    items: [{ id: 'r1', playerId: 'p1', categoryKey: 'ville', raw: 'Mazamet' }],
  });

  assert.equal(captured.length, 2, 'la conversation est relancée après pause_turn');
  assert.equal(captured[1].body.messages.length, 2);
  assert.equal(captured[1].body.messages[1].role, 'assistant');
  assert.equal(searched, true);
  assert.equal(verdicts[0].status, 'valide');
});

test('un refus du modèle lève une erreur explicite (pas de validation silencieuse)', async () => {
  captured.length = 0;
  nextResponses = [{
    content: [{ type: 'text', text: '' }],
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'autre' },
  }];
  await assert.rejects(
    () => ai.judgeBatch({ letter: 'M', items: ITEMS }),
    /refusée par le modèle/,
  );
});

test('une réponse sans appel d\'outil ne fabrique aucun verdict', async () => {
  captured.length = 0;
  nextResponses = [
    { content: [{ type: 'text', text: 'Je ne sais pas trancher.' }], stop_reason: 'end_turn' },
    { content: [{ type: 'text', text: 'Toujours pas.' }], stop_reason: 'end_turn' },
    { content: [{ type: 'text', text: 'Non.' }], stop_reason: 'end_turn' },
    { content: [{ type: 'text', text: 'Non.' }], stop_reason: 'end_turn' },
  ];
  const { verdicts } = await ai.judgeWithSearch({
    letter: 'M',
    items: [{ id: 'r1', playerId: 'p1', categoryKey: 'ville', raw: 'Mazamet' }],
  });
  assert.deepEqual(verdicts, [], 'aucun verdict inventé : le statut d\'origine est conservé');
});

test('une erreur HTTP de l\'API remonte comme une exception', async () => {
  captured.length = 0;
  const failing = http.createServer((req, res) => {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  });
  await new Promise((resolve) => failing.listen(0, '127.0.0.1', resolve));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${failing.address().port}`;
  const fresh = await import(`../src/ai/anthropic-validator.js?reload=${Date.now()}`);
  await assert.rejects(() => fresh.judgeBatch({ letter: 'M', items: ITEMS }));
  await new Promise((resolve) => failing.close(resolve));
});
