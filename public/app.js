/* Client BacRush. Le navigateur n'est qu'un afficheur : il ne calcule aucun
   score, ne choisit aucune lettre et ne décide d'aucune clôture. */

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'bacrush.session';

const ui = {
  screens: {
    home: $('screen-home'),
    lobby: $('screen-lobby'),
    round: $('screen-round'),
    validating: $('screen-validating'),
    voting: $('screen-voting'),
    results: $('screen-results'),
    final: $('screen-final'),
  },
};

let config = { categories: [], totalRounds: 15, roundDurationMs: 240_000, ai: {} };
let session = null; // { code, token, playerId, name }
let state = null;
let stream = null;
let clockOffset = 0;
let renderedRoundKey = null;
let lastRevealedLetter = null;
let finishPending = false;
let saveTimer = null;
let lastSentSnapshot = '';
let confettiRunning = false;

// -------------------------------------------------------------------- outils
function showScreen(name) {
  for (const [key, el] of Object.entries(ui.screens)) {
    el.classList.toggle('is-active', key === name);
  }
}

function toast(message, ms = 3200) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function serverNow() {
  return Date.now() + clockOffset;
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000)); // jamais négatif
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let data = {};
  try { data = await res.json(); } catch { /* réponse vide */ }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

/**
 * Deux niveaux de mémoire :
 *  - sessionStorage : propre à l'onglet, pour que deux joueurs puissent jouer
 *    depuis la même machine sans se marcher dessus ;
 *  - localStorage : propre à l'appareil, pour reprendre sa place après une
 *    fermeture d'onglet, un plantage du navigateur ou un départ volontaire.
 */
const DEVICE_KEY = (code) => `bacrush.device.${code}`;

function saveSession(s) {
  session = s;
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* indisponible */ }
  try {
    localStorage.setItem(DEVICE_KEY(s.code), JSON.stringify({ ...s, at: Date.now() }));
    localStorage.setItem('bacrush.lastRoom', s.code);
  } catch { /* indisponible */ }
}

function clearSession({ forgetDevice = false } = {}) {
  const code = session?.code;
  session = null;
  try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignoré */ }
  if (forgetDevice && code) {
    try {
      localStorage.removeItem(DEVICE_KEY(code));
      if (localStorage.getItem('bacrush.lastRoom') === code) {
        localStorage.removeItem('bacrush.lastRoom');
      }
    } catch { /* ignoré */ }
  }
}

function loadSession() {
  try {
    const own = sessionStorage.getItem(STORE_KEY);
    if (own) return JSON.parse(own);
  } catch { /* ignoré */ }
  // Cet onglet ne sait rien : on regarde si l'appareil a une place en réserve.
  try {
    const code = localStorage.getItem('bacrush.lastRoom');
    if (!code) return null;
    const saved = localStorage.getItem(DEVICE_KEY(code));
    return saved ? JSON.parse(saved) : null;
  } catch { return null; }
}

/** Demande au serveur de rendre sa place au porteur du jeton. */
async function reclaimSeat(code, token) {
  try {
    const data = await api(`/api/rooms/${code}/rejoin`, { token });
    saveSession({ code: data.code, token: data.token, playerId: data.playerId, name: data.name });
    return data;
  } catch {
    return null;
  }
}

function deviceSeat(code) {
  try {
    const saved = localStorage.getItem(DEVICE_KEY(code));
    return saved ? JSON.parse(saved) : null;
  } catch { return null; }
}

// --------------------------------------------------------------- connexion
function connect() {
  if (!session) return;
  stream?.close();
  const url = `/api/stream?room=${encodeURIComponent(session.code)}&token=${encodeURIComponent(session.token)}`;
  stream = new EventSource(url);

  stream.addEventListener('state', (event) => {
    const next = JSON.parse(event.data);
    clockOffset = next.serverNow - Date.now();
    state = next;
    render();
  });

  stream.addEventListener('sync', (event) => {
    const data = JSON.parse(event.data);
    clockOffset = data.serverNow - Date.now(); // resynchronisation périodique
  });

  stream.addEventListener('error', async () => {
    // EventSource se reconnecte seul. Si le jeton n'est plus reconnu, on tente
    // de reprendre la place avant d'abandonner.
    if (!session) return;
    const restored = await reclaimSeat(session.code, session.token);
    if (!restored) return;
  });
}

// ------------------------------------------------------------------ accueil
async function init() {
  config = await fetch('/api/config').then((r) => r.json());

  const ai = config.ai ?? {};
  const badge = $('ai-badge');
  if (ai.configured) {
    badge.innerHTML = `Arbitrage par IA : <b>actif</b> (${ai.model})`;
    badge.classList.remove('is-degraded');
  } else {
    badge.innerHTML = `Arbitrage par IA : <b>mode secours</b> — définis ANTHROPIC_API_KEY côté serveur`;
    badge.classList.add('is-degraded');
  }

  const saved = loadSession();
  if (saved?.code && saved?.token) {
    $('input-name').value = saved.name ?? '';
    // Le serveur confirme que la place existe encore avant d'ouvrir le flux.
    const restored = await reclaimSeat(saved.code, saved.token);
    if (restored) {
      connect();
      return;
    }
    session = null;
    try { localStorage.removeItem(DEVICE_KEY(saved.code)); } catch { /* ignoré */ }
    $('input-code').value = saved.code;
    homeError('Ta place dans ce salon a expiré. Rejoins-le de nouveau avec le code.');
  }
  showScreen('home');
}

function homeError(message) {
  const el = $('home-error');
  el.textContent = message;
  el.hidden = !message;
}

$('btn-create').addEventListener('click', async () => {
  homeError('');
  try {
    const data = await api('/api/rooms', { name: $('input-name').value });
    saveSession({ code: data.code, token: data.token, playerId: data.playerId, name: data.name });
    connect();
  } catch (err) { homeError(err.message); }
});

$('btn-join').addEventListener('click', async () => {
  homeError('');
  const code = $('input-code').value.trim().toUpperCase();
  if (code.length !== 4) return homeError('Le code comporte 4 caractères.');
  // Même appareil, même salon : on reprend sa place plutôt que d'en créer une.
  const seat = deviceSeat(code);
  if (seat?.token) {
    const restored = await reclaimSeat(code, seat.token);
    if (restored) {
      connect();
      toast(`Tu reprends ta place : ${restored.name}`);
      return;
    }
  }
  try {
    const data = await api(`/api/rooms/${code}/join`, { name: $('input-name').value });
    saveSession({ code: data.code, token: data.token, playerId: data.playerId, name: data.name });
    connect();
  } catch (err) { homeError(err.message); }
});

$('input-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
$('input-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create').click(); });

$('btn-start').addEventListener('click', async () => {
  try { await api(`/api/rooms/${session.code}/start`, { token: session.token }); }
  catch (err) { toast(err.message); }
});

async function setRoundCount(totalRounds) {
  try {
    await api(`/api/rooms/${session.code}/rounds`, { token: session.token, totalRounds });
  } catch (err) { toast(err.message); }
}

let quitArmed = null;

/** Deux temps : un premier appui demande confirmation, le second quitte. */
async function quitGame(event) {
  const button = event?.currentTarget;
  if (quitArmed !== button) {
    quitArmed = button;
    const label = button.textContent;
    button.textContent = 'Confirmer ?';
    button.classList.add('is-armed');
    clearTimeout(quitGame._t);
    quitGame._t = setTimeout(() => {
      if (quitArmed !== button) return;
      quitArmed = null;
      button.textContent = label;
      button.classList.remove('is-armed');
    }, 4000);
    return;
  }
  quitArmed = null;
  clearTimeout(quitGame._t);
  const code = session?.code;
  try {
    await api(`/api/rooms/${session.code}/leave`, { token: session.token });
  } catch { /* le salon a peut-être déjà disparu */ }
  stream?.close();
  stream = null;
  state = null;
  renderedRoundKey = null;
  // La place reste récupérable un quart d'heure : on garde le jeton sur
  // l'appareil et on pré-remplit le code pour revenir d'un geste.
  clearSession();
  if (code) $('input-code').value = code;
  showScreen('home');
  toast('Tu peux revenir avec le code depuis cet appareil.', 5000);
}

$('btn-quit-lobby').addEventListener('click', quitGame);
$('btn-quit-round').addEventListener('click', quitGame);

$('btn-close-corrections').addEventListener('click', async () => {
  $('btn-close-corrections').disabled = true;
  try {
    await api(`/api/rooms/${session.code}/closecorrections`, { token: session.token });
  } catch (err) { toast(err.message); }
  setTimeout(() => { $('btn-close-corrections').disabled = false; }, 800);
});

async function setArbitration(mode) {
  const refereeId = mode === 'referee'
    ? ($('referee-select').value || state?.you?.id)
    : undefined;
  try {
    await api(`/api/rooms/${session.code}/arbitration`, { token: session.token, mode, refereeId });
  } catch (err) { toast(err.message); }
}

$('mode-vote').addEventListener('click', () => setArbitration('vote'));
$('mode-referee').addEventListener('click', () => setArbitration('referee'));
$('mode-self').addEventListener('click', () => setArbitration('self'));
$('referee-select').addEventListener('change', () => setArbitration('referee'));

$('lobby-code').addEventListener('click', () => {
  navigator.clipboard?.writeText(state?.code ?? '').then(
    () => toast('Code copié'),
    () => {},
  );
});

$('btn-spin').addEventListener('click', async () => {
  $('btn-spin').disabled = true;
  try {
    await api(`/api/rooms/${session.code}/spin`, { token: session.token });
  } catch (err) { toast(err.message); }
  setTimeout(() => { $('btn-spin').disabled = false; }, 600);
});

$('btn-scores').addEventListener('click', () => { $('scores-panel').hidden = false; });
$('btn-close-scores').addEventListener('click', () => { $('scores-panel').hidden = true; });

$('btn-ready').addEventListener('click', async () => {
  $('btn-ready').disabled = true;
  try {
    await api(`/api/rooms/${session.code}/ready`, { token: session.token });
  } catch (err) { toast(err.message); }
  setTimeout(() => { $('btn-ready').disabled = false; }, 600);
});

async function selfScore(categoryKey, points) {
  try {
    await api(`/api/rooms/${session.code}/selfscore`, {
      token: session.token,
      categoryKey,
      points,
    });
  } catch (err) { toast(err.message); }
}

async function decide(targetPlayerId, categoryKey, accept) {
  try {
    await api(`/api/rooms/${session.code}/decide`, {
      token: session.token,
      targetPlayerId,
      categoryKey,
      accept,
    });
  } catch (err) { toast(err.message); }
}

async function toggleChallenge(targetPlayerId, categoryKey) {
  try {
    await api(`/api/rooms/${session.code}/challenge`, {
      token: session.token,
      targetPlayerId,
      categoryKey,
    });
  } catch (err) { toast(err.message); }
}

$('btn-next').addEventListener('click', async () => {
  $('btn-next').disabled = true;
  try {
    await api(`/api/rooms/${session.code}/next`, {
      token: session.token,
      fromRound: state?.results?.roundIndex,
    });
  } catch (err) { toast(err.message); }
  setTimeout(() => { $('btn-next').disabled = false; }, 1200);
});

$('btn-newgame').addEventListener('click', async () => {
  try { await api(`/api/rooms/${session.code}/newgame`, { token: session.token }); }
  catch (err) { toast(err.message); }
});

// -------------------------------------------------------------------- saisie
function buildForm() {
  const form = $('answers-form');
  form.innerHTML = '';
  for (const category of config.categories) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.key = category.key;
    cell.innerHTML = `
      <label for="in-${category.key}">
        <span class="icon">${category.icon}</span>${category.label}
      </label>
      <input id="in-${category.key}" type="text" maxlength="40" inputmode="text"
             autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="words"
             enterkeyhint="${category.key === 'objet' ? 'done' : 'next'}"
             placeholder="${category.placeholder}" />`;
    form.appendChild(cell);
  }

  form.querySelectorAll('input').forEach((input, index, inputs) => {
    input.addEventListener('input', () => {
      refreshFillState();
      scheduleSave();
    });
    input.addEventListener('blur', () => sendAnswers());
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = inputs[index + 1];
      if (next) next.focus();
      else if (!$('finish-dock').hidden) $('btn-finish').click();
    });
  });
}

function currentAnswers() {
  const out = {};
  for (const category of config.categories) {
    out[category.key] = $(`in-${category.key}`)?.value.trim() ?? '';
  }
  return out;
}

function filledCount(answers = currentAnswers()) {
  return config.categories.filter((c) => (answers[c.key] ?? '').trim() !== '').length;
}

function refreshFillState() {
  const answers = currentAnswers();
  const count = filledCount(answers);
  const complete = count === config.categories.length;
  const playing = state?.phase === 'playing' && !state?.round?.locked;

  for (const category of config.categories) {
    const cell = document.querySelector(`.cell[data-key="${category.key}"]`);
    cell?.classList.toggle('is-filled', (answers[category.key] ?? '') !== '');
  }

  $('fill-counter').textContent = `${count} / ${config.categories.length} rubriques remplies`;
  // Le bouton FIN reste invisible tant qu'une rubrique est vide.
  $('finish-dock').hidden = !(complete && playing);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(sendAnswers, 350);
}

async function sendAnswers() {
  if (!session || state?.phase !== 'playing' || state?.round?.locked) return;
  const answers = currentAnswers();
  const snapshot = JSON.stringify(answers);
  if (snapshot === lastSentSnapshot) return;
  lastSentSnapshot = snapshot;
  try {
    await api(`/api/rooms/${session.code}/answers`, { token: session.token, answers });
  } catch {
    lastSentSnapshot = ''; // on retentera à la prochaine frappe
  }
}

$('btn-finish').addEventListener('click', async () => {
  if (finishPending) return; // anti double-clic
  finishPending = true;
  const button = $('btn-finish');
  button.disabled = true;
  clearTimeout(saveTimer);
  try {
    await sendAnswers();
    const result = await api(`/api/rooms/${session.code}/finish`, { token: session.token });
    if (result.error && !result.ignored) toast(result.error);
  } catch (err) {
    toast(err.message);
  } finally {
    finishPending = false;
    button.disabled = false;
  }
});

// --------------------------------------------------------------- rendu
function render() {
  if (!state) return;
  $('room-pill').textContent = `Salle ${state.code}`;
  renderScores();

  switch (state.phase) {
    case 'lobby': renderLobby(); showScreen('lobby'); break;
    case 'reveal':
    case 'playing': renderRound(); showScreen('round'); break;
    case 'validating': renderValidating(); showScreen('validating'); break;
    case 'voting': renderVoting(); showScreen('voting'); break;
    case 'results': renderResults(); showScreen('results'); break;
    case 'finished': renderFinal(); showScreen('final'); break;
    default: showScreen('home');
  }
}

function renderLobby() {
  $('lobby-code').textContent = state.code;
  const list = $('lobby-players');
  list.innerHTML = '';
  for (const player of state.players) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot ${player.connected ? 'on' : ''}"></span>
      <span>${escapeHtml(player.name)}</span>
      ${player.isHost ? '<span class="tag">hôte</span>' : ''}`;
    list.appendChild(li);
  }
  renderLengthPicker();
  renderArbitrationPicker();
  const isHost = Boolean(state.you?.isHost);
  $('btn-start').hidden = !isHost;
  $('btn-start').disabled = state.players.length < 1;
  const capacity = state.maxPlayers ?? config.maxPlayers ?? 10;
  $('lobby-count').textContent = `${state.players.length} / ${capacity} joueurs`;
  $('lobby-hint').textContent = isHost
    ? `${state.totalRounds} manches de ${config.roundDurationMs / 1000} s · lance quand tout le monde est là`
    : "En attente du lancement par l'hôte…";
}

function renderLengthPicker() {
  const isHost = Boolean(state.you?.isHost);
  const options = state.roundOptions ?? config.roundOptions ?? [6, 12, 18];
  $('length-picker').hidden = !isHost;
  $('length-readonly').hidden = isHost;
  if (!isHost) {
    $('length-readonly').textContent = `Partie en ${state.totalRounds} manches`;
    return;
  }
  const container = $('length-options');
  if (container.dataset.options !== options.join(',')) {
    container.dataset.options = options.join(',');
    container.innerHTML = '';
    for (const count of options) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'length-option';
      option.dataset.count = String(count);
      option.innerHTML = `${count}<small>manches</small>`;
      option.addEventListener('click', () => setRoundCount(count));
      container.appendChild(option);
    }
  }
  for (const option of container.children) {
    option.classList.toggle('is-on', Number(option.dataset.count) === state.totalRounds);
  }
}

function renderArbitrationPicker() {
  const arbitration = state.arbitration ?? { mode: 'vote' };
  const isHost = Boolean(state.you?.isHost);
  const mode = arbitration.mode;

  $('mode-picker').hidden = !isHost;
  $('mode-readonly').hidden = isHost;
  if (!isHost) {
    $('mode-readonly').textContent = {
      referee: `Arbitrage : ${arbitration.refereeName ?? '—'} tranche les réponses`,
      self: 'Arbitrage : chacun se note lui-même',
      vote: 'Arbitrage : le salon vote',
    }[mode] ?? '';
    return;
  }

  $('mode-vote').classList.toggle('is-on', mode === 'vote');
  $('mode-referee').classList.toggle('is-on', mode === 'referee');
  $('mode-self').classList.toggle('is-on', mode === 'self');
  $('referee-field').hidden = mode !== 'referee';

  const select = $('referee-select');
  const wanted = arbitration.refereeId ?? state.you?.id;
  const signature = state.players.map((p) => `${p.id}:${p.name}`).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.innerHTML = state.players
      .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}${p.id === state.you?.id ? ' (toi)' : ''}</option>`)
      .join('');
  }
  if (wanted && select.value !== wanted) select.value = wanted;
}

function renderRound() {
  const round = state.round;
  const roundKey = `${state.gameNumber}-${round.index}`;
  const freshForm = roundKey !== renderedRoundKey;
  if (freshForm) {
    renderedRoundKey = roundKey;
    buildForm();
    lastSentSnapshot = '';
  }
  // L'animation de révélation attend que la roulette se soit arrêtée.
  if (round.letter && lastRevealedLetter !== `${roundKey}:${round.letter}`) {
    lastRevealedLetter = `${roundKey}:${round.letter}`;
    $('letter').classList.remove('is-revealing');
    void $('letter').offsetWidth; // relance l'animation
    $('letter').classList.add('is-revealing');
  }

  $('round-pill').textContent = `Manche ${state.roundNumber}/${state.totalRounds}`;
  renderRoulette();

  // Les réponses enregistrées ne sont réinjectées qu'au premier affichage de la
  // manche (ouverture, rechargement de page, reconnexion). Ensuite, le champ
  // appartient au joueur : sans cette distinction, chaque état reçu du serveur
  // réécrirait une valeur qu'il vient d'effacer, tant que l'enregistrement
  // différé n'est pas parti.
  if (freshForm) {
    const saved = state.you?.answers ?? {};
    for (const category of config.categories) {
      const input = $(`in-${category.key}`);
      if (!input || document.activeElement === input) continue;
      input.value = saved[category.key] ?? '';
    }
  }
  for (const category of config.categories) {
    const input = $(`in-${category.key}`);
    if (input) input.disabled = state.phase !== 'playing' || round.locked;
  }

  refreshFillState();
  tickTimer();
}

/**
 * Roulette : la lettre affichée se calcule à partir de l'horloge du serveur,
 * avec la même formule que lui. Tous les écrans défilent donc à l'identique,
 * et l'arrêt fige ce que chacun avait sous les yeux.
 */
function renderRoulette() {
  const round = state?.round;
  if (!round) return;
  const roulette = round.roulette;
  const letterEl = $('letter');
  const spinning = Boolean(roulette?.spinning);

  $('btn-spin').hidden = !roulette?.canStop;
  letterEl.classList.toggle('is-spinning', spinning);

  if (spinning) {
    const elapsed = Math.max(0, serverNow() - roulette.startedAt);
    const index = Math.floor(elapsed / roulette.spinMs) % roulette.wheel.length;
    letterEl.textContent = roulette.wheel[index];
    $('letter-pill').textContent = '…';
    $('letter-caption').textContent = roulette.canStop
      ? 'Appuie sur STOP pour fixer la lettre'
      : "L'hôte arrête la roulette…";
    return;
  }

  letterEl.textContent = round.letter ?? '';
  $('letter-pill').textContent = round.letter ?? '';
  $('letter-caption').textContent =
    state.phase === 'reveal'
      ? (roulette?.stoppedByName ? `Arrêtée par ${roulette.stoppedByName}` : 'La manche démarre…')
      : 'Lettre de la manche';
}
// 60 images par seconde pendant la roulette, sans toucher au reste.
setInterval(() => { if (state?.round?.roulette?.spinning) renderRoulette(); }, 55);

function tickTimer() {
  if (!state?.round) return;
  const round = state.round;
  const timer = $('timer');
  const bar = $('progress-bar');

  let remaining;
  if (state.phase === 'reveal') remaining = config.roundDurationMs;
  else if (round.locked) remaining = round.remainingMs;
  else remaining = Math.max(0, round.endsAt - serverNow());

  $('timer-text').textContent = formatClock(remaining);
  const ratio = Math.max(0, Math.min(1, remaining / config.roundDurationMs));
  bar.style.width = `${ratio * 100}%`;

  timer.classList.toggle('is-stopped', Boolean(round.locked));
  timer.classList.toggle('is-warning', !round.locked && remaining <= 60_000 && remaining > 30_000);
  timer.classList.toggle('is-critical', !round.locked && remaining <= 30_000);
  bar.classList.toggle('is-critical', remaining <= 30_000);
}
setInterval(() => { if (state?.phase === 'playing' || state?.phase === 'reveal') tickTimer(); }, 200);

function renderValidating() {
  const round = state.round;
  const who = round?.closeReason === 'timeout'
    ? 'Temps écoulé'
    : `${round?.closedByName ?? 'Un joueur'} a cliqué sur FIN`;
  $('validating-detail').textContent =
    `${who} — vérification de chaque réponse : rubrique, première lettre, orthographe, réponses identiques.`;
}

function renderVoting() {
  const vote = state.vote;
  if (!vote) return;
  const refereeMode = vote.mode === 'referee';
  const selfMode = vote.mode === 'self';
  $('vote-letter').textContent = state.round?.letter ?? '';

  const amReady = vote.readyIds.includes(state.you?.id);
  const button = $('btn-ready');

  if (refereeMode) {
    $('vote-eyebrow').innerHTML = `Arbitrage — lettre <b id="vote-letter">${escapeHtml(state.round?.letter ?? '')}</b>`;
    $('vote-title').textContent = vote.iAmReferee
      ? 'À toi de trancher'
      : `${vote.refereeName ?? "L'arbitre"} examine les réponses`;
    $('vote-intro').textContent = vote.iAmReferee
      ? 'Accepte ou refuse les réponses douteuses, puis valide la manche. Une réponse qui ne commence pas par la lettre reste refusée, même pour toi.'
      : 'Les décisions apparaissent en direct. Patiente, la manche se terminera dès que l\'arbitre aura validé.';
    $('vote-ready-count').textContent = vote.refereeName ? `Arbitre : ${vote.refereeName}` : '';
    button.hidden = !vote.iAmReferee;
    button.textContent = 'VALIDER LA MANCHE';
    button.classList.add('btn-primary');
    button.classList.remove('btn-ready-on');
    $('vote-hint').textContent = vote.iAmReferee
      ? 'Sans décision de ta part, le verdict automatique s\'applique.'
      : 'La manche se termine seule à la fin du compte à rebours.';
  } else if (selfMode) {
    $('vote-eyebrow').innerHTML = `Notation — lettre <b id="vote-letter">${escapeHtml(state.round?.letter ?? '')}</b>`;
    $('vote-title').textContent = 'Compte tes points';
    $('vote-intro').textContent =
      '2 si tu es le seul à avoir cette réponse, 1 si quelqu\'un d\'autre l\'a aussi, 0 si elle ne compte pas. Les réponses de tout le monde sont affichées pour te décider.';
    $('vote-ready-count').textContent = `${vote.readyCount} / ${vote.playerCount} prêts`;
    button.hidden = false;
    button.textContent = amReady ? 'EN ATTENTE DES AUTRES…' : 'J\'AI FINI';
    button.classList.toggle('btn-ready-on', amReady);
    button.classList.toggle('btn-primary', !amReady);
    $('vote-hint').textContent =
      'Sans choix de ta part, les points calculés automatiquement s\'appliquent.';
  } else {
    $('vote-eyebrow').innerHTML = `Contestation — lettre <b id="vote-letter">${escapeHtml(state.round?.letter ?? '')}</b>`;
    $('vote-title').textContent = 'Une réponse vous semble fausse ?';
    $('vote-intro').textContent =
      'Touchez « Contester ». Une réponse est refusée si la majorité des autres joueurs la conteste.';
    $('vote-ready-count').textContent = `${vote.readyCount} / ${vote.playerCount} prêts`;
    button.hidden = false;
    button.textContent = amReady ? 'EN ATTENTE DES AUTRES…' : 'PRÊT';
    button.classList.toggle('btn-ready-on', amReady);
    button.classList.toggle('btn-primary', !amReady);
    $('vote-hint').textContent = 'Le vote se termine seul à la fin du compte à rebours.';
  }

  // L'hôte peut enchaîner dès que les corrections sont réglées.
  $('btn-close-corrections').hidden = !state.canAdvance;

  const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? '—';
  const list = $('vote-list');
  list.innerHTML = '';

  for (const category of vote.categories) {
    // En mode vote, on masque les rubriques sans point en jeu : rien à contester.
    // En mode arbitre, il peut repêcher une réponse refusée : on montre tout.
    const hasSomething = category.entries.some((e) =>
      refereeMode || selfMode ? e.raw : e.counted,
    );
    if (!hasSomething) continue;
    const block = document.createElement('section');
    block.className = 'vote-cat';
    block.innerHTML = `<h3><span>${category.icon}</span>${escapeHtml(category.label)}</h3>`;

    for (const entry of category.entries) {
      if (!entry.raw) continue;
      const row = document.createElement('div');
      row.className = 'vote-row';
      row.classList.toggle('is-out', !entry.counted);
      row.classList.toggle('is-challenged', entry.challenges > 0);
      const corrected =
        entry.recognized && entry.recognized.toLowerCase() !== entry.raw.trim().toLowerCase()
          ? `<span class="res-corrected">→ ${escapeHtml(entry.recognized)}</span>`
          : '';
      row.innerHTML = `
        <span class="vote-who">${escapeHtml(nameOf(entry.playerId))}</span>
        <span class="vote-answer">${escapeHtml(entry.raw)}</span>
        ${corrected}
        ${entry.flagged ? '<span class="badge warn">à vérifier</span>' : ''}
        ${entry.counted ? '' : '<span class="badge bad">déjà refusée</span>'}
        <span class="vote-actions">
          ${entry.challenges > 0 ? `<span class="vote-count">${entry.challenges} / ${entry.required} voix</span>` : ''}
        </span>`;

      row.classList.toggle('is-mine', selfMode && entry.playerId === state.you?.id);
      row.classList.toggle('is-accepted', entry.decision === true);
      row.classList.toggle('is-challenged', entry.challenges > 0 || entry.decision === false);
      const actions = row.querySelector('.vote-actions');

      if (entry.canChallenge) {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = `btn btn-challenge${entry.challengedByMe ? ' is-on' : ''}`;
        action.textContent = entry.challengedByMe ? 'Contestée' : 'Contester';
        action.addEventListener('click', () => toggleChallenge(entry.playerId, category.key));
        actions.appendChild(action);
      }

      // Notation libre : tout le monde voit les points que les autres se sont
      // donnés, en gris et non cliquables, pour pouvoir vérifier.
      if (selfMode && !entry.canSelfScore && entry.raw) {
        const shown = document.createElement('span');
        const chosen = entry.selfPoints !== null;
        shown.className = `self-shown p${entry.shownPoints}${chosen ? ' is-chosen' : ''}`;
        shown.textContent = String(entry.shownPoints);
        shown.title = chosen
          ? `${nameOf(entry.playerId)} s'est attribué ${entry.shownPoints} point(s)`
          : 'Points calculés automatiquement, pas encore confirmés';
        actions.appendChild(shown);

        if (entry.divergesFromProposal) {
          const flag = document.createElement('span');
          flag.className = 'self-diverge';
          flag.textContent = `≠ ${entry.proposedPoints}`;
          flag.title = `Le calcul proposait ${entry.proposedPoints}`;
          actions.appendChild(flag);
        }
      }

      if (entry.canSelfScore) {
        const group = document.createElement('span');
        group.className = 'self-points';
        for (const points of [0, 1, 2]) {
          const chosen = entry.selfPoints === null
            ? entry.proposedPoints === points
            : entry.selfPoints === points;
          const option = document.createElement('button');
          option.type = 'button';
          option.dataset.points = String(points);
          option.className =
            `btn btn-point${entry.selfPoints === points ? ' is-on' : ''}` +
            (entry.selfPoints === null && chosen ? ' is-suggested' : '');
          option.textContent = String(points);
          option.addEventListener('click', () => selfScore(category.key, points));
          group.appendChild(option);
        }
        actions.appendChild(group);
        if (entry.selfPoints === null) {
          const hint = document.createElement('span');
          hint.className = 'self-hint';
          hint.textContent = 'proposé';
          actions.insertBefore(hint, group);
        }
      }

      if (entry.canDecide) {
        if (entry.canAccept) {
          const accept = document.createElement('button');
          accept.type = 'button';
          accept.className = `btn btn-decide btn-accept${entry.decision === true ? ' is-on' : ''}`;
          accept.textContent = '✓ Accepter';
          accept.addEventListener('click', () => decide(entry.playerId, category.key, true));
          actions.appendChild(accept);
        }
        const refuse = document.createElement('button');
        refuse.type = 'button';
        refuse.className = `btn btn-decide btn-refuse${entry.decision === false ? ' is-on' : ''}`;
        refuse.textContent = '✕ Refuser';
        refuse.addEventListener('click', () => decide(entry.playerId, category.key, false));
        actions.appendChild(refuse);
      } else if (vote.mode === 'referee' && entry.decision !== null) {
        const note = document.createElement('span');
        note.className = 'decision-note';
        note.textContent = entry.decision ? 'acceptée' : 'refusée';
        actions.appendChild(note);
      }
      block.appendChild(row);
    }
    list.appendChild(block);
  }

  if (!list.children.length) {
    list.innerHTML = '<p class="muted small">Aucune réponse à contester cette manche.</p>';
  }
  tickVoteTimer();
}

function tickVoteTimer() {
  if (state?.phase !== 'voting' || !state.vote?.endsAt) return;
  const remaining = Math.max(0, state.vote.endsAt - serverNow());
  const timer = $('vote-timer');
  timer.textContent = formatClock(remaining);
  timer.classList.toggle('is-critical', remaining <= 15_000);
}
setInterval(() => { if (state?.phase === 'voting') tickVoteTimer(); }, 300);

function statusBadge(entry) {
  if (entry.status === 'valide') return '<span class="badge ok">valide</span>';
  if (entry.status === 'a_verifier') return '<span class="badge warn">à vérifier</span>';
  if (entry.status === 'vide') return '<span class="badge search">vide</span>';
  return '<span class="badge bad">refusé</span>';
}

function renderResults() {
  const results = state.results;
  if (!results) return;
  $('results-eyebrow').textContent = `Résultats — manche ${results.roundIndex + 1}/${state.totalRounds}`;
  $('results-letter').textContent = results.letter;

  const source = state.round?.aiSource;
  const sourceLabel = {
    'ia': 'Réponses vérifiées par l\'IA',
    'ia+recherche': 'Réponses vérifiées par l\'IA, avec recherche documentaire sur les cas douteux',
    'secours': 'IA indisponible — vérification de secours (lexiques + règles)',
    'aucune-reponse': 'Aucune réponse soumise',
  }[source] ?? '';
  $('results-source').textContent = state.round?.aiError
    ? `${sourceLabel} · ${state.round.aiError}`
    : sourceLabel;

  const totals = $('round-totals');
  totals.innerHTML = '';
  for (const player of [...state.players].sort((a, b) => b.score - a.score)) {
    const delta = results.totals[player.id] ?? 0;
    const chip = document.createElement('div');
    chip.className = 'total-chip';
    chip.innerHTML = `<span class="name">${escapeHtml(player.name)}</span>
      <span class="delta">+${delta}</span>
      <span class="cumul">${player.score} pts</span>`;
    totals.appendChild(chip);
  }

  const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? '—';
  const list = $('results-list');
  list.innerHTML = '';

  results.categories.forEach((category, index) => {
    const block = document.createElement('section');
    block.className = 'res-cat';
    block.style.animationDelay = `${index * 45}ms`;

    const rows = category.entries.map((entry) => {
      const group = category.groups.find((g) => g.id === entry.groupId);
      const shared = group && group.playerIds.length > 1;
      const corrected =
        entry.recognized &&
        entry.recognized.toLowerCase() !== entry.raw.trim().toLowerCase()
          ? `<span class="res-corrected">→ ${escapeHtml(entry.recognized)}</span>`
          : '';
      const answerClass = entry.status === 'vide'
        ? 'is-empty'
        : entry.status === 'invalide' ? 'is-bad' : '';
      const reason = entry.reason
        ? `<p class="res-reason">${escapeHtml(entry.reason)}</p>`
        : '';
      return `
        <div class="res-row">
          <div class="res-main">
            <span class="res-player">${escapeHtml(nameOf(entry.playerId))}</span>
            <span class="res-answer ${answerClass}">${entry.raw ? escapeHtml(entry.raw) : '(vide)'}</span>
            ${corrected}
            ${statusBadge(entry)}
            ${shared ? `<span class="badge group">partagée ×${group.playerIds.length}</span>` : ''}
            ${entry.searched ? '<span class="badge search">vérifiée en ligne</span>' : ''}
            ${/^Refusée par le salon/.test(entry.reason) ? '<span class="badge bad">refusée au vote</span>' : ''}
            ${/arbitre$/.test(entry.reason) ? `<span class="badge ${entry.status === 'valide' ? 'ok' : 'bad'}">${entry.status === 'valide' ? "repêchée par l'arbitre" : "refusée par l'arbitre"}</span>` : ''}
          </div>
          <div class="res-badges">
            <span class="points p${entry.points} pop">${entry.points}</span>
          </div>
          ${reason}
        </div>`;
    }).join('');

    block.innerHTML = `<h3><span>${category.icon}</span>${escapeHtml(category.label)}</h3>
      <div class="res-rows">${rows}</div>`;
    list.appendChild(block);
  });

  $('btn-next').hidden = !state.canAdvance;
  $('next-hint').textContent = !state.canAdvance
    ? "En attente de l'hôte pour la manche suivante…"
    : results.isFinalRound
      ? 'Dernière manche — place au classement final'
      : `Prochaine lettre inutilisée · ${state.totalRounds - state.roundNumber} manche(s) restante(s)`;
  $('btn-next').textContent = results.isFinalRound ? 'VOIR LE CLASSEMENT' : 'MANCHE SUIVANTE';
}

function renderScores() {
  const list = $('scores-list');
  list.innerHTML = '';
  state.players.forEach((player, index) => {
    const li = document.createElement('li');
    if (player.id === state.you?.id) li.className = 'me';
    li.innerHTML = `<span class="rank">${index + 1}</span>
      <span class="dot ${player.connected ? 'on' : ''}"></span>
      <span>${escapeHtml(player.name)}</span>
      <span class="pscore">${player.score}</span>`;
    list.appendChild(li);
  });
  $('letters-used').textContent = state.lettersUsed?.length
    ? `Lettres déjà sorties : ${state.lettersUsed.join(' · ')}`
    : '';
}

function renderFinal() {
  const ranked = [...state.players].sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const tie = ranked.filter((p) => p.score === best?.score);
  $('final-winner').innerHTML = tie.length > 1
    ? `Égalité : <span>${tie.map((p) => escapeHtml(p.name)).join(' & ')}</span> — ${best.score} pts`
    : `<span>${escapeHtml(best?.name ?? '')}</span> remporte la partie — ${best?.score ?? 0} pts`;

  const medals = ['🥇', '🥈', '🥉'];
  const podium = $('podium');
  podium.innerHTML = '';
  ranked.forEach((player, index) => {
    const li = document.createElement('li');
    li.style.animationDelay = `${index * 80}ms`;
    li.innerHTML = `<span class="rank">${medals[index] ?? index + 1}</span>
      <span class="pname">${escapeHtml(player.name)}</span>
      <span class="pscore">${player.score}</span>`;
    podium.appendChild(li);
  });

  // Détail des points par manche.
  const table = $('final-table');
  const header = ['Joueur', ...Array.from({ length: state.totalRounds }, (_, i) => {
    const letter = state.lettersUsed[i] ?? i + 1;
    return `${i + 1}<br><small>${letter}</small>`;
  }), 'Total'];
  table.innerHTML = `<thead><tr>${header.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${ranked.map((player) => {
      const cells = Array.from({ length: state.totalRounds }, (_, i) => `<td>${player.roundScores[i] ?? '–'}</td>`).join('');
      return `<tr><td>${escapeHtml(player.name)}</td>${cells}<td class="tot">${player.score}</td></tr>`;
    }).join('')}</tbody>`;

  $('btn-newgame').hidden = !state.you?.isHost;
  startConfetti();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ------------------------------------------------------------------ confettis
function startConfetti() {
  if (confettiRunning) return;
  confettiRunning = true;
  const canvas = $('confetti');
  const ctx = canvas.getContext('2d');
  const resize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  resize();
  window.addEventListener('resize', resize);

  const colors = ['#7c5cff', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#ffffff'];
  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height,
    r: 4 + Math.random() * 6,
    vy: 1.6 + Math.random() * 3.1,
    vx: -1.1 + Math.random() * 2.2,
    rot: Math.random() * Math.PI,
    vr: -0.1 + Math.random() * 0.2,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const started = performance.now();
  function frame(now) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.y > canvas.height + 20) { p.y = -20; p.x = Math.random() * canvas.width; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      ctx.restore();
    }
    if (now - started < 7000) requestAnimationFrame(frame);
    else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      confettiRunning = false;
    }
  }
  requestAnimationFrame(frame);
}

window.addEventListener('beforeunload', () => stream?.close());
init().catch((err) => {
  showScreen('home');
  homeError(`Serveur injoignable : ${err.message}`);
});
