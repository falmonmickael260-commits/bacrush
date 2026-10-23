import Anthropic from '@anthropic-ai/sdk';
import { VERDICT_TOOL, VERDICT_TOOL_NAME } from './schema.js';
import { SEARCH_SYSTEM_SUFFIX, SYSTEM_PROMPT, renderUserMessage } from './prompt.js';

// Tout appel à l'IA se fait ici, côté serveur. La clé d'API n'est jamais
// exposée au navigateur (voir src/server.js : aucune route ne la renvoie).

export const DEFAULT_MODEL = process.env.BACRUSH_AI_MODEL || 'claude-opus-5';
const EFFORT = process.env.BACRUSH_AI_EFFORT || 'medium';
const SEARCH_EFFORT = process.env.BACRUSH_AI_SEARCH_EFFORT || 'high';
const REQUEST_TIMEOUT_MS = Number(process.env.BACRUSH_AI_TIMEOUT_MS || 40_000);
const SEARCH_TIMEOUT_MS = Number(process.env.BACRUSH_AI_SEARCH_TIMEOUT_MS || 45_000);
const MAX_SEARCH_USES = Number(process.env.BACRUSH_AI_MAX_SEARCHES || 6);
const SEARCH_ENABLED = process.env.BACRUSH_AI_SEARCH !== 'off';

/** Les modèles récents acceptent la recherche web à filtrage dynamique. */
const MODERN_SEARCH_MODELS = [
  'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5',
];

function webSearchTool(model) {
  const modern = MODERN_SEARCH_MODELS.some((m) => model.startsWith(m));
  return {
    type: modern ? 'web_search_20260209' : 'web_search_20250305',
    name: 'web_search',
    max_uses: MAX_SEARCH_USES,
  };
}

export function hasCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ maxRetries: 1 });
  return client;
}

function extractVerdicts(message) {
  const out = [];
  for (const block of message?.content ?? []) {
    if (block.type === 'tool_use' && block.name === VERDICT_TOOL_NAME) {
      const payload = block.input;
      if (payload && Array.isArray(payload.verdicts)) out.push(...payload.verdicts);
    }
  }
  return out;
}

function usedSearch(message) {
  return (message?.content ?? []).some(
    (b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result',
  );
}

/** Premier examen : sortie structurée imposée, sans recherche web. */
export async function judgeBatch({ letter, items, model = DEFAULT_MODEL, signal }) {
  const response = await getClient().messages.create(
    {
      model,
      max_tokens: 16_000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: renderUserMessage({ letter, items }) }],
      tools: [VERDICT_TOOL],
      tool_choice: { type: 'tool', name: VERDICT_TOOL_NAME },
      output_config: { effort: EFFORT },
    },
    { timeout: REQUEST_TIMEOUT_MS, signal },
  );
  if (response.stop_reason === 'refusal') {
    throw new Error(`Requête refusée par le modèle (${response.stop_details?.category ?? 'sans motif'})`);
  }
  return { verdicts: extractVerdicts(response), usage: response.usage, model };
}

/**
 * Seconde passe : uniquement les réponses réellement incertaines, avec l'outil
 * de recherche web côté serveur Anthropic. On ne lance pas de recherche pour
 * chaque mot — seulement pour ceux que le premier examen n'a pas tranchés.
 */
export async function judgeWithSearch({ letter, items, model = DEFAULT_MODEL, signal }) {
  if (!SEARCH_ENABLED || items.length === 0) return { verdicts: [], searched: false };

  const messages = [
    { role: 'user', content: renderUserMessage({ letter, items }) },
  ];
  let searched = false;

  for (let turn = 0; turn < 4; turn++) {
    const response = await getClient().messages.create(
      {
        model,
        max_tokens: 16_000,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: SEARCH_SYSTEM_SUFFIX },
        ],
        messages,
        tools: [VERDICT_TOOL, webSearchTool(model)],
        tool_choice: { type: 'auto' },
        output_config: { effort: SEARCH_EFFORT },
      },
      { timeout: SEARCH_TIMEOUT_MS, signal },
    );

    if (response.stop_reason === 'refusal') {
      throw new Error('Vérification complémentaire refusée par le modèle');
    }
    searched = searched || usedSearch(response);

    const verdicts = extractVerdicts(response);
    if (verdicts.length > 0) {
      return { verdicts: verdicts.map((v) => ({ ...v, searched: true })), searched };
    }

    // pause_turn : la recherche serveur doit se poursuivre sur un nouveau tour.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    // Le modèle a répondu sans appeler l'outil : on le relance une fois.
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content:
        "Appelle maintenant l'outil « rendre_verdicts » avec un verdict pour chacune des réponses listées.",
    });
  }
  return { verdicts: [], searched };
}
