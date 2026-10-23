import { CATEGORY_KEYS } from '../../src/shared/categories.js';

/** Client de test : un joueur = une connexion SSE + des appels REST. */
export class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.states = [];
    this.controller = null;
  }

  get last() {
    return this.states.at(-1) ?? null;
  }

  async post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async create(name) {
    const { data } = await this.post('/api/rooms', { name });
    Object.assign(this, data);
    return data;
  }

  async join(code, name) {
    const { data } = await this.post(`/api/rooms/${code}/join`, { name });
    Object.assign(this, data);
    return data;
  }

  /** Ouvre le flux SSE et accumule les états reçus. */
  async openStream() {
    this.controller = new AbortController();
    const res = await fetch(
      `${this.baseUrl}/api/stream?room=${this.code}&token=${encodeURIComponent(this.token)}`,
      { signal: this.controller.signal, headers: { accept: 'text/event-stream' } },
    );
    if (!res.ok) throw new Error(`SSE refusé : ${res.status}`);
    this.reading = (async () => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const eventLine = chunk.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (!eventLine || !dataLine) continue;
            const payload = JSON.parse(dataLine.slice(6));
            if (eventLine.slice(7).trim() === 'state') this.states.push(payload);
          }
        }
      } catch { /* flux fermé */ }
    })();
    await this.waitFor(() => this.last !== null);
  }

  close() {
    this.controller?.abort();
  }

  /** Attend qu'une condition sur l'état reçu devienne vraie. */
  async waitFor(predicate, { timeout = 5000, label = 'condition' } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (predicate(this.last)) return this.last;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`Délai dépassé en attendant : ${label}`);
  }

  answers(values) {
    const out = {};
    for (const key of CATEGORY_KEYS) out[key] = values[key] ?? '';
    return out;
  }

  sendAnswers(values) {
    return this.post(`/api/rooms/${this.code}/answers`, {
      token: this.token,
      answers: this.answers(values),
    });
  }

  finish() {
    return this.post(`/api/rooms/${this.code}/finish`, { token: this.token });
  }

  start() {
    return this.post(`/api/rooms/${this.code}/start`, { token: this.token });
  }

  next(fromRound) {
    return this.post(`/api/rooms/${this.code}/next`, { token: this.token, fromRound });
  }
}

/** Jeu de 8 réponses valides pour une lettre donnée (mode secours déterministe). */
export const ANSWERS_BY_LETTER = {
  M: {
    prenom_fille: 'Marie', prenom_garcon: 'Marc', ville: 'Marseille', pays: 'Maroc',
    metier: 'Mécanicien', animal: 'Mouton', fruit_legume: 'Melon', objet: 'Marteau',
  },
  P: {
    prenom_fille: 'Pauline', prenom_garcon: 'Paul', ville: 'Paris', pays: 'Portugal',
    metier: 'Plombier', animal: 'Pigeon', fruit_legume: 'Pomme', objet: 'Pelle',
  },
};

export function validAnswersFor(letter) {
  if (ANSWERS_BY_LETTER[letter]) return ANSWERS_BY_LETTER[letter];
  // Repli : réponses commençant par la bonne lettre (statut « à vérifier » hors ligne).
  const out = {};
  for (const key of CATEGORY_KEYS) out[key] = `${letter}test`;
  return out;
}
