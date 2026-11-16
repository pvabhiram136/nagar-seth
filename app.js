'use strict';
/* Browser client. The server owns all the rules; this file only draws state and sends intents.
   Shared parts (connection, home screen, room box, chat, sound, dice cube) plus the RupeeRush board.
   The other games live in race.js (shared), snakes.js and ludo.js and register themselves in GAMES. */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => (n < 0 ? '-' : '') + '₹' + Math.abs(Math.floor(n)).toLocaleString('en-US');
const short = inr;
const store = kind => ({
  get(k) { try { return window[kind].getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window[kind].setItem(k, v); } catch (e) { /* private mode */ } },
});
const LS = store('localStorage'), SS = store('sessionStorage');
const EXTRA_COLORS = { rail: '#aab4c3', util: '#c6d24a' };
const SETTING_LABELS = [
  ['doubleRent', 'Double rent on full sets', 'Own every city of a state to charge 2× base rent'],
  ['vacationCash', 'Goa holiday pot', 'Taxes and fines pile up in Goa — land there to take it all'],
  ['auction', 'Auctions', 'A property nobody buys is auctioned to all players'],
  ['noRentInJail', 'No rent from jail', "Owners sitting in jail can't collect rent"],
  ['mortgage', 'Mortgages', 'Mortgage a property to the bank for half its price'],
  ['evenBuild', 'Even building', 'Houses must be spread evenly across a set'],
  ['randomOrder', 'Random turn order', 'Shuffle who goes first'],
];

let ws = null, B = null, S = null, me = null, code = null, quitting = false;
let game = 'rupeerush';     // which game this room is playing (the server tells us when we join)
const GAMES = {};           // other games register here: { enter(), leave(), render(), onError() }
let myName = LS.get('ns_name') || '';
let modal = null;           // {kind, arg}
let draft = null;           // new-trade form state
let boardBuilt = false;
let animating = false, rolling = false, lastRollSeq = -1, lastCardSeq = -1, cardTimer = null, rollTimer = null, pendingCard = null;
let prev = null;            // last seen cash / owners, to spot changes worth animating
const pendingFx = [];
const TICK = 160, ROLL_MS = 1000;
let auctionEnd = 0, auctionSpan = 1;
let seenTrades = new Set();
const tok = {};             // player id -> {el, pos, seq, queue, wait}

/* ------------------------------------------------------------------ connection */
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
const act = (a, extra) => send(Object.assign({ t: 'action', a }, extra || {}));

function joinMsg() {
  const st = SS.get('ns_tok_' + code), lt = LS.get('ns_tok_' + code);
  return { t: 'join', code, name: myName, token: st || lt, strong: !!st };
}

function connect(firstMsg) {
  quitting = false;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  const sock = ws;
  sock.onopen = () => { $('#conn').hidden = true; sock.send(JSON.stringify(firstMsg())); };
  sock.onmessage = e => onMsg(JSON.parse(e.data));
  sock.onclose = () => {
    if (sock !== ws || quitting) return;
    if (code) { $('#conn').hidden = false; setTimeout(() => connect(joinMsg), 1500); }
    else toast('Could not reach the game server');
  };
}

function goHome(msg) {
  if (GAMES[game]) GAMES[game].leave();
  quitting = true; code = null; S = null; me = null;
  if (ws) ws.close();
  history.replaceState(null, '', location.pathname);
  $('#room').hidden = true; $('#home').hidden = false; $('#conn').hidden = true;
  $('#homeInvite').hidden = true; $('#homeMain').hidden = false;
  closeModal();
  if (msg) toast(msg);
}

function onMsg(m) {
  if (m.t === 'joined') {
    code = m.code; me = m.you; B = m.board; game = m.game || 'rupeerush';
    if (m.token) { SS.set('ns_tok_' + code, m.token); LS.set('ns_tok_' + code, m.token); }
    history.replaceState(null, '', '?room=' + code);
    $('#home').hidden = true; $('#room').hidden = false;
    const other = GAMES[game];
    $('#board').hidden = !!other; $('#gwrap').hidden = !other;
    if (other) other.enter(); else if (!boardBuilt) buildBoard();
  } else if (m.t === 'state') {
    S = m; render();
  } else if (m.t === 'error') {
    if (m.fatal) goHome(m.m); else { toast(m.m); if (GAMES[game]) GAMES[game].onError(); }
  } else if (m.t === 'kicked') {
    goHome('The host removed you from the room');
  } else if (m.t === 'replaced') {
    goHome('This game was opened in another tab');
  }
}

/* ------------------------------------------------------------------ helpers */
const P = id => S.players.find(p => p.id === id);
const mine = () => P(me);
const isHost = () => S.hostId === me;
const T = i => B.tiles[i];
const ownable = i => ['city', 'station', 'utility'].includes(T(i).type);
const gcolor = i => (B.groups[T(i).group] || {}).color || EXTRA_COLORS[T(i).group] || '#888';
const groupTiles = g => B.tiles.map((t, i) => t.group === g ? i : -1).filter(i => i >= 0);
const ownsGroup = (pid, g) => groupTiles(g).every(i => S.g.owner[i] === pid);
const tilesOf = pid => S.g ? S.g.owner.map((o, i) => o === pid ? i : -1).filter(i => i >= 0) : [];
const tradable = pid => tilesOf(pid).filter(i => groupTiles(T(i).group).every(j => !S.g.houses[j]));
function setHTML(el, html) { if (el._h !== html) { el._h = html; el.innerHTML = html; return true; } return false; }

function toast(text, ok) {
  const d = document.createElement('div');
  d.className = 'toast' + (ok ? ' ok' : '');
  d.textContent = text;
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), 3500);
}

/* ------------------------------------------------------------------ board */
function gridPos(i) {
  if (i <= 10) return [1, i + 1];
  if (i <= 20) return [i - 9, 11];
  if (i <= 30) return [11, 31 - i];
  return [41 - i, 1];
}
const U = 100 / 12.2, C = 1.6 * U;
const axis = k => k === 1 ? C / 2 : k === 11 ? 100 - C / 2 : C + (k - 1.5) * U;
function center(i) { const [r, c] = gridPos(i); return [axis(c), axis(r)]; }

function buildBoard() {
  boardBuilt = true;
  const board = $('#board');
  B.tiles.forEach((t, i) => {
    const [r, c] = gridPos(i);
    const side = i % 10 === 0 ? 'corner' : i < 10 ? 'top' : i < 20 ? 'right' : i < 30 ? 'bottom' : 'left';
    const d = document.createElement('div');
    d.className = `tile ${side} t-${t.type}`;
    d.style.gridRow = r; d.style.gridColumn = c;
    d.dataset.tile = i;
    let h = '';
    if (t.type === 'city') h = `<div class="band" style="background:${gcolor(i)}"></div><div class="body"><div class="tname ${t.name.length > 8 ? 'long' : ''}">${esc(t.name)}</div><div class="tprice">${short(t.price)}</div></div>`;
    else if (t.type === 'station') h = `<div class="body"><div class="ticon">🚂</div><div class="tname long">${t.short}</div><div class="tprice">${short(t.price)}</div></div>`;
    else if (t.type === 'utility') h = `<div class="body"><div class="ticon">${t.icon}</div><div class="tname long">${t.short}</div><div class="tprice">${short(t.price)}</div></div>`;
    else if (t.type === 'card') h = `<div class="body"><div class="ticon">${t.deck === 'luck' ? '🍀' : '💎'}</div><div class="tname">${t.name}</div></div>`;
    else if (t.type === 'tax') h = `<div class="body"><div class="ticon">🧾</div><div class="tname">${t.kind === 'income' ? 'Tax 10%' : 'GST'}</div></div>`;
    else if (t.type === 'start') h = `<div class="body"><div class="ticon">🏁</div><div class="tname">Start</div><div class="tprice">+${short(B.salary)}</div></div>`;
    else if (t.type === 'jail') h = `<div class="body"><div class="ticon">⛓️</div><div class="tname">Jail</div></div>`;
    else if (t.type === 'vacation') h = `<div class="body"><div class="ticon">🏖️</div><div class="tname">Goa</div><div class="tprice"></div></div>`;
    else if (t.type === 'gotojail') h = `<div class="body"><div class="ticon">🚔</div><div class="tname">Go to Jail</div></div>`;
    d.innerHTML = h;
    board.insertBefore(d, $('#tokens'));
  });
  setDice([1, 1]);
}

function renderTiles() {
  const g = S.g;
  document.querySelectorAll('.tile').forEach(el => {
    const i = +el.dataset.tile, t = T(i);
    if (ownable(i)) {
      const o = g && g.owner[i] ? P(g.owner[i]) : null;
      el.classList.toggle('owned', !!o);
      el.classList.toggle('mort', !!(g && g.mortgaged[i]));
      if (o) el.style.setProperty('--own', o.color); else el.style.removeProperty('--own');
      $('.tprice', el).textContent = o ? o.avatar : short(t.price);
      if (t.type === 'city') {
        const h = g ? g.houses[i] : 0;
        setHTML($('.band', el), h === 5 ? '<i class="ht"></i>' : '<i class="hs"></i>'.repeat(h));
      }
    } else if (t.type === 'vacation') {
      $('.tprice', el).textContent = g && g.pot ? short(g.pot) : '';
    }
  });
}

/* ------------------------------------------------------------------ sound */
let audio = null, muted = LS.get('rr_mute') === '1';
function tone(freq, dur, type, vol, when, slide) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t0 = audio.currentTime + (when || 0), o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    o.connect(g); g.connect(audio.destination); o.start(t0); o.stop(t0 + dur + .02);
  } catch (e) { /* no sound on this device */ }
}
const SFX = {
  dice() { for (let k = 0; k < 8; k++) tone(170 + Math.random() * 280, .05, 'square', .05, k * .11); },
  step(n) { tone(500 + Math.min(n, 12) * 30, .07, 'triangle', .06); },
  land() { tone(260, .18, 'sine', .1, 0, 120); },
  coin() { tone(988, .09, 'square', .05); tone(1319, .24, 'square', .05, .09); },
  pay() { tone(330, .12, 'sawtooth', .04, 0, 210); tone(220, .2, 'sawtooth', .04, .12, 150); },
  buy() { [523, 659, 784].forEach((f, k) => tone(f, .16, 'triangle', .07, k * .08)); },
  card() { tone(700, .25, 'sine', .06, 0, 1300); },
  turn() { tone(660, .12, 'sine', .08); tone(880, .22, 'sine', .08, .13); },
  win() { [523, 659, 784, 1047, 1319].forEach((f, k) => tone(f, .28, 'triangle', .08, k * .13)); },
};

/* ------------------------------------------------------------------ dice */
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const FACE_ROT = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };   // cube turn that brings each face to the front
const spin = { d1: [0, 0], d2: [0, 0] };
function setDie(id, n, turns) {
  const el = $('#' + id), sp = spin[id];
  if (!el.firstChild) {
    el.innerHTML = '<div class="cube">' + [1, 2, 3, 4, 5, 6].map(f => `<div class="face f${f}">${Array.from({ length: 9 }, (_, k) => `<span class="${PIPS[f].includes(k) ? 'on' : ''}"></span>`).join('')}</div>`).join('') + '</div>';
  }
  if (turns) { sp[0] += 360 * turns[0]; sp[1] += 360 * turns[1]; }
  const [x, y] = FACE_ROT[n];
  el.firstChild.style.transform = `translateZ(calc(var(--ds) / -2)) rotateX(${x + sp[0]}deg) rotateY(${y + sp[1]}deg)`;
}
function setDice(d, roll) { setDie('d1', d[0], roll && [2, 1]); setDie('d2', d[1], roll && [1, 2]); }
function showSum(d) {
  const el = $('#diceSum');
  el.className = d ? 'show' + (d[0] === d[1] ? ' dbl' : '') : '';
  if (d) el.innerHTML = `${d[0] + d[1]}${d[0] === d[1] ? '<small>Doubles!</small>' : ''}`;
}

function syncDice() {
  const g = S.g;
  if (!g) { lastRollSeq = -1; showSum(null); return; }
  if (g.rollSeq === lastRollSeq) return;
  const animate = lastRollSeq !== -1 && g.rollSeq > 0;
  lastRollSeq = g.rollSeq;
  if (!animate) { setDice(g.dice); showSum(g.rollSeq > 0 ? g.dice : null); return; }
  rolling = true; animating = true;
  const row = $('#diceRow');
  row.classList.remove('rolling'); void row.offsetWidth; row.classList.add('rolling');   // restart the toss
  showSum(null);
  setDice(g.dice, true);
  SFX.dice();
  clearTimeout(rollTimer);
  rollTimer = setTimeout(() => {
    rolling = false; row.classList.remove('rolling');
    if (S && S.g) showSum(S.g.dice);
  }, ROLL_MS);
}

/* ------------------------------------------------------------------ tokens */
const unjump = v => v < 0 ? -1 - v : v;     // a jump (no walking) is queued as a negative number

function syncTokens() {
  const layer = $('#tokens');
  const ids = new Set(S.players.map(p => p.id));
  for (const id of Object.keys(tok)) if (!ids.has(id)) { tok[id].el.remove(); delete tok[id]; }
  for (const p of S.players) {
    let t = tok[p.id];
    if (!t) {
      const el = document.createElement('div');
      el.className = 'token';
      el.innerHTML = '<div class="tk"></div>';
      layer.appendChild(el);
      t = tok[p.id] = { el, tk: el.firstChild, pos: p.pos, seq: p.mv.seq, queue: [], wait: 0, hold: 0, hops: 0 };
    }
    t.color = p.color;
    t.el.style.setProperty('--c', p.color);
    t.tk.textContent = p.avatar;
    t.el.hidden = p.bankrupt;
    t.el.classList.toggle('jailed', p.inJail);
    t.el.classList.toggle('turn', !!S.g && S.phase === 'playing' && S.g.turn === p.id);
    if (p.mv.seq !== t.seq) {
      t.seq = p.mv.seq;
      let cur = t.queue.length ? unjump(t.queue[t.queue.length - 1]) : t.pos;
      for (const st of p.mv.steps) {
        if (st.kind === 'jump') { t.queue.push(-1 - st.to); cur = st.to; continue; }
        const step = st.kind === 'back' ? 39 : 1;
        let guard = 0;
        while (cur !== st.to && guard++ < 40) { cur = (cur + step) % 40; t.queue.push(cur); }
      }
      if (t.queue.length) { t.wait = rolling ? Math.ceil(ROLL_MS / TICK) : 0; animating = true; }
    } else if (!t.queue.length && !t.hold && t.pos !== p.pos) {
      t.pos = p.pos;
    }
  }
  layoutTokens();
}

function layoutTokens() {
  const at = {};
  for (const id in tok) if (!tok[id].el.hidden) (at[tok[id].pos] = at[tok[id].pos] || []).push(tok[id]);
  for (const pos in at) {
    const list = at[pos], [x, y] = center(+pos), n = list.length;
    list.forEach((t, k) => {
      const r = n > 1 ? 1.9 : 0, a = (k / n) * Math.PI * 2 - Math.PI / 2;
      t.el.style.left = (x + r * Math.cos(a)) + '%';
      t.el.style.top = (y + r * Math.sin(a)) + '%';
    });
  }
}

function hop(t) {
  if (t.tk.animate) t.tk.animate([{ transform: 'translateY(0) scale(1)' }, { transform: 'translateY(-.6em) scale(1.3)' }, { transform: 'translateY(0) scale(1)' }], { duration: TICK, easing: 'ease-out' });
}
function flashTile(i) {
  const el = $(`.tile[data-tile="${i}"]`);
  if (!el) return;
  el.classList.remove('step'); void el.offsetWidth; el.classList.add('step');
}
function ring(pos, color) {
  const [x, y] = center(pos), r = document.createElement('i');
  r.className = 'ring'; r.style.left = x + '%'; r.style.top = y + '%'; r.style.setProperty('--c', color);
  $('#tokens').appendChild(r);
  setTimeout(() => r.remove(), 700);
}
function arrive(t) {
  t.el.classList.remove('moving', 'fly');
  t.hops = 0;
  if (t.tk.animate) t.tk.animate([{ transform: 'scale(1.35, .7)' }, { transform: 'scale(.9, 1.15)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
  ring(t.pos, t.color);
  flashTile(t.pos);
  SFX.land();
}

setInterval(() => {
  let moved = false, busy = rolling;
  for (const id in tok) {
    const t = tok[id];
    if (!t.queue.length) {
      if (t.hold > 0) { busy = true; if (!--t.hold) arrive(t); }
      continue;
    }
    busy = true;
    if (t.wait > 0) { t.wait--; continue; }
    let nx = t.queue.shift();
    const jump = nx < 0;
    nx = unjump(nx);
    t.el.classList.add('moving');
    t.el.classList.toggle('fly', jump);
    t.pos = nx; moved = true;
    if (jump) { t.wait = 3; SFX.card(); } else { hop(t); flashTile(nx); SFX.step(++t.hops); }
    if (!t.queue.length) t.hold = jump ? 4 : 1;
  }
  if (moved) layoutTokens();
  if (animating && !busy) { animating = false; if (S) { renderCenter(); flushFx(); } }
}, TICK);

/* ------------------------------------------------------------------ little celebrations */
function detectFx() {
  const g = S.g;
  if (!g || S.phase === 'lobby') { prev = null; pendingFx.length = 0; return; }
  const now = { cash: {}, owner: g.owner.slice(), houses: g.houses.slice(), phase: S.phase, turn: g.turn };
  for (const p of S.players) now.cash[p.id] = p.cash;
  if (prev) {
    for (const p of S.players) {
      const d = p.id in prev.cash ? p.cash - prev.cash[p.id] : 0;
      if (d && !p.bankrupt) pendingFx.push({ k: 'cash', id: p.id, d });
    }
    now.owner.forEach((o, i) => { if (o && o !== prev.owner[i]) pendingFx.push({ k: 'own', i, id: o }); });
    now.houses.forEach((h, i) => { if (h > prev.houses[i]) pendingFx.push({ k: 'own', i, id: now.owner[i] }); });
    if (now.phase === 'ended' && prev.phase === 'playing') pendingFx.push({ k: 'win' });
    if (now.phase === 'playing' && now.turn === me && prev.turn !== me) pendingFx.push({ k: 'turn' });
  }
  prev = now;
}

const floatSlots = {};       // tile -> how many floating amounts are showing there, so they stack instead of overlapping
function floatText(id, text, cls) {
  const t = tok[id];
  if (!t || t.el.hidden) return;
  const slot = floatSlots[t.pos] = (floatSlots[t.pos] || 0) + 1;
  const f = document.createElement('div');
  f.className = 'float ' + cls; f.textContent = text;
  f.style.left = t.el.style.left; f.style.top = t.el.style.top;
  f.style.animationDelay = (slot - 1) * 380 + 'ms';
  $('#tokens').appendChild(f);
  const pos = t.pos;
  setTimeout(() => { f.remove(); floatSlots[pos]--; }, 1800 + (slot - 1) * 380);
}

function confetti() {
  const box = document.createElement('div');
  box.className = 'confetti';
  for (let k = 0; k < 80; k++) {
    const i = document.createElement('i');
    i.style.cssText = `left:${Math.random() * 100}%;background:${B.colors[k % B.colors.length]};animation-delay:${Math.random() * .9}s;animation-duration:${2 + Math.random() * 1.6}s`;
    box.appendChild(i);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5000);
}

function flushFx() {
  if (animating) return;
  if (pendingCard) { showCard(pendingCard); pendingCard = null; }
  let mineUp = 0, bought = false;
  for (const f of pendingFx.splice(0)) {
    if (f.k === 'cash') {
      floatText(f.id, (f.d > 0 ? '+' : '−') + inr(Math.abs(f.d)), f.d > 0 ? 'up' : 'down');
      const c = $(`.prow[data-id="${f.id}"] .cash`);
      if (c && c.animate) c.animate([{ transform: 'scale(1.4)', color: f.d > 0 ? '#9dffc6' : '#ff8a8a' }, { transform: 'scale(1)' }], { duration: 700, easing: 'ease-out' });
      if (f.id === me) mineUp += f.d;
    } else if (f.k === 'own') {
      const el = $(`.tile[data-tile="${f.i}"]`), p = P(f.id);
      if (el && el.animate) {
        el.style.zIndex = 4;
        el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.28) rotate(-3deg)' }, { transform: 'scale(1)' }], { duration: 520, easing: 'ease-out' }).onfinish = () => { el.style.zIndex = ''; };
      }
      if (p) ring(f.i, p.color);
      bought = true;
    } else if (f.k === 'win') { confetti(); SFX.win(); }
    else if (f.k === 'turn') SFX.turn();
  }
  if (bought) SFX.buy(); else if (mineUp > 0) SFX.coin(); else if (mineUp < 0) SFX.pay();
}

/* ------------------------------------------------------------------ left column */
function renderRoomBox() {
  const n = S.players.length;
  setHTML($('#roomBox'), `
    <div class="codeRow"><div><h3>Room code</h3><div class="code">${esc(S.code)}</div></div>
    <button class="btn small primary" data-act="copy">Copy invite link</button></div>
    <div class="hint">${S.phase === 'lobby' ? `Share the link — ${n}/${S.settings.maxPlayers} joined` : me ? 'Game in progress' : 'You are watching this game'}
    · <a href="#" data-act="leave" style="color:inherit">Leave</a> · <a href="#" data-act="mute" style="color:inherit">${muted ? '🔇 Sound off' : '🔊 Sound on'}</a></div>`);
}

function renderPlayers() {
  const g = S.g;
  const rows = S.players.map(p => {
    const tags = [p.id === me ? 'you' : '', p.id === S.hostId ? '👑' : '', p.bot ? '🤖' : '', !p.connected && !p.bot ? '⚠ offline' : '',
      p.inJail ? '⛓️' : '', p.jailCards ? '🎟️' : ''].filter(Boolean).join(' ');
    const turn = g && S.phase === 'playing' && g.turn === p.id;
    return `<div class="prow ${turn ? 'turn' : ''} ${p.bankrupt ? 'out' : ''}" data-act="player" data-id="${p.id}">
      <span class="chip" style="--c:${p.color}">${p.avatar}</span>
      <span class="nm">${esc(p.name)}<small>${tags}</small></span>
      ${S.phase === 'lobby' ? (isHost() && p.id !== me ? `<button class="x" data-act="kick" data-id="${p.id}" title="Remove">✕</button>` : '')
        : `<span class="cash ${p.cash < 0 ? 'neg' : ''}">${p.bankrupt ? 'bankrupt' : inr(p.cash)}</span>`}
    </div>`;
  }).join('');
  setHTML($('#playersBox'), `<h3>Players</h3>${rows}`);
}

function renderChat() {
  const el = $('#chatLog');
  const html = S.chat.map(c => { const p = P(c.p); return `<div><b style="color:${p ? p.color : '#aaa'}">${esc(c.n)}</b>${esc(c.m)}</div>`; }).join('')
    || '<div class="muted">No messages yet. Say hello 👋</div>';
  if (setHTML(el, html)) el.scrollTop = el.scrollHeight;
}

/* ------------------------------------------------------------------ right column */
function renderRight() {
  const el = $('#right');
  if (S.phase === 'lobby') return setHTML(el, lobbyHTML());
  const g = S.g, m = mine();
  let h = '';
  if (!m) h += `<div class="panel"><h3>Spectating</h3><p class="muted">This game started before you joined. You can watch, and join the next round from the lobby.</p></div>`;
  const trades = g.trades.map(t => {
    const a = P(t.from), b = P(t.to), forme = t.to === me;
    return `<div class="trow ${forme ? 'forme' : ''}" data-act="viewTrade" data-id="${t.id}">
      <span class="chip" style="--c:${a.color};width:22px;height:22px;font-size:12px">${a.avatar}</span>→
      <span class="chip" style="--c:${b.color};width:22px;height:22px;font-size:12px">${b.avatar}</span>
      <span>${forme ? `<b>${esc(a.name)}</b> sent you an offer` : `${esc(a.name)} → ${esc(b.name)}`}</span></div>`;
  }).join('');
  h += `<div class="panel"><h3>Trades</h3>${trades || '<p class="muted">No open offers.</p>'}
    ${m && !m.bankrupt && S.phase === 'playing' ? '<button class="btn small" data-act="newTrade" style="width:100%">＋ Propose a trade</button>' : ''}</div>`;
  if (m) {
    const props = tilesOf(me).map(i => propRow(i)).join('');
    h += `<div class="panel"><h3>My properties</h3>${props || '<p class="muted">Nothing yet — land on a city and buy it.</p>'}</div>`;
    if (!m.bankrupt && S.phase === 'playing') h += `<button class="btn danger small" data-act="bankrupt">Declare bankruptcy</button>`;
  }
  const on = SETTING_LABELS.filter(([k]) => S.settings[k]).map(([, l]) => l).join(' · ');
  h += `<div class="panel"><h3>Room rules</h3><p class="muted" style="font-size:12px;margin:0">Start ${inr(S.settings.startingCash)} · Salary ${inr(B.salary)}${on ? ' · ' + on : ''}</p></div>`;
  setHTML(el, h);
}

function propRow(i) {
  const g = S.g, t = T(i), h = g.houses[i];
  const extra = g.mortgaged[i] ? 'mortgaged' : h === 5 ? '🏨' : h ? '🏠'.repeat(h) : '';
  return `<div class="prop ${g.mortgaged[i] ? 'mort' : ''}" data-tile="${i}"><i style="background:${gcolor(i)}"></i><span>${esc(t.name)}</span><span class="r">${extra}</span></div>`;
}

function lobbyHTML() {
  const m = mine(), host = isHost(), s = S.settings;
  if (!m) return '<div class="panel"><p class="muted">Joining…</p></div>';
  const taken = new Set(S.players.filter(p => p.id !== me).map(p => p.color));
  const sw = B.colors.map(c => `<button class="sw ${c === m.color ? 'on' : ''} ${taken.has(c) ? 'taken' : ''}" style="--c:${c}" data-act="color" data-v="${c}" ${taken.has(c) ? 'disabled' : ''}></button>`).join('');
  const av = B.avatars.map(a => `<button class="av ${a === m.avatar ? 'on' : ''}" data-act="avatar" data-v="${a}">${a}</button>`).join('');
  const dis = host ? '' : 'disabled';
  const toggles = SETTING_LABELS.map(([k, l, d]) => `<label class="setRow"><span>${l}<small>${d}</small></span><input type="checkbox" class="sw-t" data-set="${k}" ${s[k] ? 'checked' : ''} ${dis}></label>`).join('');
  return `
    <div class="panel"><h3>Your token</h3><div class="swatches">${sw}</div><div class="avatars">${av}</div></div>
    <div class="panel"><h3>Game settings ${host ? '' : '<span style="text-transform:none;letter-spacing:0">(host decides)</span>'}</h3>
      <label class="setRow"><span>Starting cash</span><select data-set="startingCash" ${dis}>${B.startingCashOptions.map(v => `<option value="${v}" ${v === s.startingCash ? 'selected' : ''}>${inr(v)}</option>`).join('')}</select></label>
      <label class="setRow"><span>Max players</span><select data-set="maxPlayers" ${dis}>${[2, 3, 4, 5, 6, 7, 8].map(v => `<option ${v === s.maxPlayers ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${toggles}
    </div>
    ${host ? `<div class="stack"><button class="btn" data-act="addBot" ${S.players.length >= s.maxPlayers ? 'disabled' : ''}>🤖 Add a bot</button>
      <button class="btn green big" data-act="start" ${S.players.length < 2 ? 'disabled' : ''}>Start game</button></div>` : ''}`;
}

/* ------------------------------------------------------------------ centre of the board */
function renderCenter() {
  const g = S.g, m = mine();
  const st = $('#status'), ac = $('#actions'), au = $('#auctionBox');
  document.querySelectorAll('.tile.here').forEach(e => e.classList.remove('here'));
  const canRoll = S.phase === 'playing' && !animating && !g.auction && !!m && g.turn === me && g.turnPhase === 'roll' && m.cash >= 0;
  $('#diceRow').classList.toggle('canRoll', canRoll);     // the dice themselves can be tapped to roll
  if (S.phase === 'lobby') {
    au.hidden = true;
    setHTML(st, `Waiting for players… <small>${S.players.length} in the room · share the invite link</small>`);
    setHTML(ac, isHost() ? `<button class="btn green" data-act="start" ${S.players.length < 2 ? 'disabled' : ''}>Start game</button>` : '<span class="muted">The host will start the game</span>');
    return renderFeed();
  }
  if (S.phase === 'ended') {
    au.hidden = true;
    const w = P(g.winner);
    setHTML(st, `<span class="winner">🏆 ${w ? esc(w.name) : 'Nobody'} wins!</span>`);
    setHTML(ac, isHost() ? '<button class="btn green" data-act="toLobby">Play again</button>' : '<span class="muted">Waiting for the host to start a new round</span>');
    return renderFeed();
  }
  const cur = P(g.turn), myTurn = g.turn === me;
  setHTML(st, myTurn ? `<span class="myturn">Your turn, ${esc(cur.name)}!</span>` : `${esc(cur.name)}'s turn${cur.bot ? ' 🤖' : ''}`);

  // auction
  if (g.auction) {
    const a = g.auction, t = T(a.tile), b = a.bidder ? P(a.bidder) : null;
    const can = m && !m.bankrupt;
    const btn = inc => `<button class="btn ${inc === 10 ? 'primary' : ''}" data-act="bid" data-v="${a.bid + inc}" ${can && m.cash >= a.bid + inc ? '' : 'disabled'}>+${short(inc)}</button>`;
    au.hidden = false;
    setHTML(au, `🔨 Auction — <b>${esc(t.name)}</b> <span class="muted">(list price ${inr(t.price)})</span>
      <div class="bidline">${b ? `${inr(a.bid)} <span style="color:${b.color}">${esc(b.name)}${a.bidder === me ? ' (you)' : ''}</span>` : 'No bids yet'}</div>
      <div class="bar"><i id="aucBar"></i></div>
      ${can ? `<div class="bids">${btn(2)}${btn(10)}${btn(50)}</div>` : ''}`);
    setHTML(ac, '');
    return renderFeed();
  }
  au.hidden = true;

  let h = '';
  if (animating) h = '';
  else if (myTurn && m) {
    if (m.cash < 0) h += `<div class="note">You owe ${inr(-m.cash)}. Sell buildings, mortgage or trade to clear it — or declare bankruptcy.</div>`;
    if (g.turnPhase === 'roll') {
      if (m.inJail) {
        h += `<button class="btn primary" data-act="roll" ${m.cash < 0 ? 'disabled' : ''}>🎲 Roll for doubles</button>
          <button class="btn" data-act="payJail" ${m.cash < B.jailFine ? 'disabled' : ''}>Pay bail ${inr(B.jailFine)}</button>
          ${m.jailCards ? '<button class="btn" data-act="useJailCard">Use Bail Card 🎟️</button>' : ''}`;
      } else h += `<button class="btn primary" data-act="roll" ${m.cash < 0 ? 'disabled' : ''}>🎲 ${g.again ? 'Roll again' : 'Roll dice'}</button>`;
    } else if (g.turnPhase === 'buy') {
      const t = T(m.pos);
      h += `<div class="offer" data-tile="${m.pos}"><b>${esc(t.name)}</b> is for sale — <u>view card</u></div>
        <button class="btn green" data-act="buy" ${m.cash < t.price ? 'disabled' : ''}>Buy for ${inr(t.price)}</button>
        <button class="btn" data-act="decline">${S.settings.auction ? '🔨 Auction it' : 'Skip'}</button>`;
    } else {
      h += `<button class="btn primary" data-act="endTurn" ${m.cash < 0 ? 'disabled' : ''}>End turn ➜</button>`;
    }
    if (m.cash < 0) h += `<button class="btn danger" data-act="bankrupt">Declare bankruptcy</button>`;
  } else if (g.turnPhase === 'buy') {
    h = `<span class="muted">${esc(cur.name)} is deciding on ${esc(T(cur.pos).name)}…</span>`;
  }
  setHTML(ac, h);
  if (!animating) { const el = $(`.tile[data-tile="${cur.pos}"]`); if (el) el.classList.add('here'); }
  renderFeed();
}

function renderFeed() {
  const el = $('#feed');
  const html = '<div class="in">' + S.log.slice(-30).map(l => { const p = l.p && P(l.p); return `<div class="ln"><i class="dot" style="--c:${p ? p.color : '#666'}"></i><span>${esc(l.m)}</span></div>`; }).join('') + '</div>';
  if (setHTML(el, html)) el.scrollTop = el.scrollHeight;
}

function syncCard() {
  const g = S.g;
  if (!g || !g.card) { lastCardSeq = g ? 0 : -1; return; }
  if (g.card.seq === lastCardSeq) return;
  const first = lastCardSeq === -1;
  lastCardSeq = g.card.seq;
  if (first) return;
  pendingCard = g.card;
}

function showCard(c) {
  const el = $('#cardView'), p = P(c.p);
  clearTimeout(cardTimer);
  el.hidden = true; void el.offsetWidth;
  el.className = c.deck;
  el.innerHTML = `<h5>${c.deck === 'luck' ? '🍀 Lucky Card' : '💎 Treasure'} · ${esc(p ? p.name : '')}</h5><p>${esc(c.text)}</p><small>tap to close</small>`;
  el.hidden = false;
  SFX.card();
  cardTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

function syncAuction() {
  const a = S.g && S.g.auction;
  if (a) { auctionEnd = Date.now() + a.endsIn; auctionSpan = a.bidder ? 7000 : 10000; }
}
(function auctionTick() {
  const bar = $('#aucBar');
  if (bar) bar.style.width = Math.max(0, Math.min(100, (auctionEnd - Date.now()) / auctionSpan * 100)) + '%';
  requestAnimationFrame(auctionTick);
})();

function notifyTrades() {
  const g = S.g;
  if (!g) { seenTrades = new Set(); return; }
  for (const t of g.trades) {
    if (!seenTrades.has(t.id)) {
      seenTrades.add(t.id);
      if (t.to === me) toast(`🤝 ${P(t.from).name} sent you a trade offer`, true);
    }
  }
}

/* ------------------------------------------------------------------ modals */
function openModal(kind, arg) { modal = { kind, arg }; $('#modal').hidden = false; renderModal(true); }
function closeModal() { modal = null; draft = null; $('#modal').hidden = true; const c = $('#modalCard'); c._h = null; c.innerHTML = ''; }

function renderModal(force) {
  if (!modal || !S) return;
  const card = $('#modalCard');
  let h = '';
  if (modal.kind === 'tile') h = tileModal(modal.arg);
  else if (modal.kind === 'trade') {
    const t = S.g && S.g.trades.find(x => x.id === modal.arg);
    if (!t) return closeModal();
    h = tradeViewModal(t);
  } else if (modal.kind === 'player') {
    if (!P(modal.arg)) return closeModal();
    h = playerModal(modal.arg);
  } else if (modal.kind === 'newTrade') {
    if (!force) return;               // keep the form stable while state updates stream in
    h = newTradeModal();
  }
  card.classList.toggle('wide', modal.kind === 'newTrade' || modal.kind === 'trade');
  setHTML(card, h);
  if (modal.kind === 'newTrade') updateTradeSum();
}

const mhead = title => `<div class="mhead"><h2>${title}</h2><button class="x" data-act="close">×</button></div>`;
const kv = (k, v, hl) => `<div class="kv ${hl ? 'hl' : ''}"><span>${k}</span><b>${v}</b></div>`;

function tileModal(i) {
  const t = T(i), g = S.g;
  if (!ownable(i)) {
    const info = {
      start: `Collect ${inr(B.salary)} salary every time you pass or land here.`,
      card: t.deck === 'luck' ? 'Draw a Lucky Card — luck can take you anywhere on the board.' : 'Draw a Treasure card — usually money in, sometimes money out.',
      tax: t.kind === 'income' ? 'Pay 10% of the cash in your hand.' : `Pay ${inr(B.gst)} GST.`,
      jail: `Just visiting — unless you were sent here. To get out: roll doubles, pay ${inr(B.jailFine)} bail, or use a Bail Card. After 3 failed rolls you pay bail automatically.`,
      vacation: S.settings.vacationCash ? `Every tax and fine lands in the Goa pot. Stop here to collect it all.${g ? ' Pot right now: ' + inr(g.pot) + '.' : ''}` : 'A quiet beach. Nothing happens here.',
      gotojail: 'Go straight to jail. No salary on the way.',
    }[t.type];
    return mhead(esc(t.name)) + `<p>${info}</p>`;
  }
  const owner = g && g.owner[i] ? P(g.owner[i]) : null;
  const h = g ? g.houses[i] : 0, mort = !!(g && g.mortgaged[i]);
  const grp = B.groups[t.group], sibs = groupTiles(t.group);
  const have = owner ? sibs.filter(j => g.owner[j] === owner.id).length : 0;
  const bar = (v, max) => `<span class="rbar"><i style="width:${Math.max(5, Math.sqrt(v / max) * 100)}%"></i></span>`;
  const setChips = sibs.map(j => {
    const o = g && g.owner[j] ? P(g.owner[j]) : null;
    return `<button class="sib ${j === i ? 'on' : ''}" data-tile="${j}"><span class="chip mini" style="--c:${o ? o.color : '#0000'}">${o ? o.avatar : ''}</span>${esc(T(j).short || T(j).name)}</button>`;
  }).join('');
  let ladder = '', note = '';
  if (t.type === 'city') {
    const full = !!owner && have === sibs.length && S.settings.doubleRent;
    const cur = owner && !mort ? h : -1;
    const pv = modal.pv != null ? modal.pv : Math.max(cur, 0);
    const names = ['Base rent', '1 house', '2 houses', '3 houses', '4 houses', 'Hotel'];
    const val = k => k === 0 && full ? t.rents[0] * 2 : t.rents[k];
    ladder = t.rents.map((r, k) => `<button class="rent ${cur === k ? 'cur' : ''} ${pv === k ? 'sel' : ''}" data-act="rentPv" data-v="${k}"><span class="lbl">${k === 5 ? '🏨' : k ? '🏠' : '🏙️'} ${names[k]}${k === 0 && full ? ' ×2' : ''}</span>${bar(val(k), t.rents[5])}<b>${inr(val(k))}</b></button>`).join('');
    const spent = t.price + pv * t.houseCost, visits = Math.ceil(spent / val(pv));
    note = `<div class="pvNote"><b>${names[pv]}:</b> each visitor pays <b>${inr(val(pv))}</b>. Buying the city${pv ? ' and building this far' : ''} costs ${inr(spent)} in total, earned back after <b>${visits}</b> visit${visits > 1 ? 's' : ''}. <span class="muted">Tap a row to compare.</span></div>`;
  } else if (t.type === 'station') {
    ladder = B.stationRent.map((r, k) => `<div class="rent ${!mort && have === k + 1 ? 'cur' : ''}"><span class="lbl">${'🚂'.repeat(k + 1)}</span>${bar(r, B.stationRent[3])}<b>${inr(r)}</b></div>`).join('');
    note = '<div class="pvNote">Rent doubles with every extra station the same player owns.</div>';
  } else {
    const d = modal.dice || 7;
    ladder = `<div class="rent ${!mort && have === 1 ? 'cur' : ''}"><span class="lbl">One board</span><span class="rbar"><i id="ub1" style="width:${d * 4 / 1.2}%"></i></span><b id="u1">${inr(d * 4)}</b></div>
      <div class="rent ${!mort && have === 2 ? 'cur' : ''}"><span class="lbl">Both boards</span><span class="rbar"><i id="ub2" style="width:${d * 10 / 1.2}%"></i></span><b id="u2">${inr(d * 10)}</b></div>`;
    note = `<div class="pvNote">Rent depends on the visitor's dice (×₹4 with one board, ×₹10 with both). Try a roll: <b id="ud">${d}</b>
      <input type="range" class="slider" min="2" max="12" value="${d}" data-utildice></div>`;
  }
  let acts = '';
  if (owner && owner.id === me && S.phase === 'playing') {
    const myTurn = g.turn === me, m = mine();
    if (t.type === 'city') {
      const full = ownsGroup(me, t.group);
      acts += `<button class="btn green" data-act="build" data-v="${i}" ${full && myTurn && h < 5 && !mort && m.cash >= t.houseCost ? '' : 'disabled'}>＋ Build ${h === 4 ? 'hotel' : 'house'} −${short(t.houseCost)}</button>
        <button class="btn" data-act="sellHouse" data-v="${i}" ${h ? '' : 'disabled'}>－ Sell building +${short(t.houseCost / 2)}</button>`;
    }
    if (S.settings.mortgage || mort) {
      acts += mort ? `<button class="btn primary" data-act="unmortgage" data-v="${i}" ${myTurn ? '' : 'disabled'}>Clear mortgage −${inr(Math.floor(t.price * 55 / 100))}</button>`
        : `<button class="btn" data-act="mortgage" data-v="${i}">Mortgage +${short(t.price / 2)}</button>`;
    }
    if (t.type === 'city' && !ownsGroup(me, t.group)) acts += `<p class="muted" style="width:100%;margin:0;font-size:12px">Own all of ${esc(grp.name)} to start building.</p>`;
    else if (g.turn !== me) acts += `<p class="muted" style="width:100%;margin:0;font-size:12px">Building happens on your own turn.</p>`;
  }
  const stat = (k, v) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`;
  return `<div class="deedHead" style="background:${gcolor(i)}"><button class="x" data-act="close">×</button>
      <small>${grp ? esc(grp.name) : t.type === 'station' ? 'Railway station' : 'Utility'}</small>${esc(t.name)}
      ${t.type === 'city' && h ? `<div class="hrow">${h === 5 ? '🏨' : '🏠'.repeat(h)}</div>` : ''}</div>
    <div class="sibs">${setChips}</div>
    <div class="stats">${stat('Price', inr(t.price))}${t.type === 'city' ? stat('House / hotel', inr(t.houseCost)) : ''}${stat('Mortgage', inr(t.price / 2))}</div>
    <div class="ownerRow">${owner ? `<span class="chip mini" style="--c:${owner.color}">${owner.avatar}</span> Owned by <b style="color:${owner.color}">${esc(owner.name)}</b>${mort ? ' · mortgaged, no rent' : ''}${sibs.length > 1 ? ` · ${have}/${sibs.length} of the set` : ''}` : '🏷️ For sale'}</div>
    <div class="ladder">${ladder}</div>${note}
    <div class="mact">${acts}</div>`;
}

function playerModal(pid) {
  const p = P(pid);
  const props = tilesOf(pid).map(propRow).join('');
  let acts = '';
  if (S.phase === 'playing' && pid !== me && mine() && !mine().bankrupt && !p.bankrupt) acts += `<button class="btn primary" data-act="newTrade" data-id="${pid}">🤝 Trade with ${esc(p.name)}</button>`;
  if (S.phase === 'playing' && isHost() && pid !== me && !p.bankrupt) acts += `<button class="btn danger" data-act="kick" data-id="${pid}">Remove from game</button>`;
  return mhead(`<span class="chip" style="--c:${p.color};display:inline-grid;vertical-align:middle;margin-right:8px">${p.avatar}</span>${esc(p.name)}`)
    + (S.g ? kv('Cash', p.bankrupt ? 'bankrupt' : inr(p.cash)) : '')
    + `<h3 style="margin-top:12px">Properties</h3>${props || '<p class="muted">None yet.</p>'}<div class="mact">${acts}</div>`;
}

function sideHTML(s) {
  const parts = [];
  if (s.cash) parts.push(`<div class="prop"><span>💵 ${inr(s.cash)}</span></div>`);
  for (const i of s.tiles) parts.push(propRow(i));
  return parts.join('') || '<p class="muted">Nothing</p>';
}

const sideValue = s => s.cash + s.tiles.reduce((a, i) => a + T(i).price, 0);
function balanceHTML(a, b, ca, cb, la, lb) {
  const tot = a + b;
  const verdict = !tot ? 'Add cash or properties' : a > b * 1.15 ? `${la} more` : b > a * 1.15 ? `${lb} more` : 'Looks even';
  return `<div class="tbal"><i style="width:${tot ? a / tot * 100 : 50}%;background:${ca}"></i><i style="background:${cb}"></i></div>
    <div class="tbalTxt"><span><b>${inr(a)}</b></span><span>${verdict}</span><span><b>${inr(b)}</b></span></div>`;
}

function tradeViewModal(t) {
  const a = P(t.from), b = P(t.to);
  let acts = '';
  if (t.to === me) acts = `<button class="btn green" data-act="tradeAccept" data-v="${t.id}">✓ Accept</button>
    <button class="btn primary" data-act="counter" data-v="${t.id}">⇄ Negotiate</button>
    <button class="btn danger" data-act="tradeDecline" data-v="${t.id}">✕ Decline</button>`;
  else if (t.from === me) acts = `<button class="btn primary" data-act="counter" data-v="${t.id}">✎ Change offer</button>
    <button class="btn danger" data-act="tradeCancel" data-v="${t.id}">Withdraw offer</button>`;
  return mhead(`Trade: ${esc(a.name)} → ${esc(b.name)}`) + `<div class="tcols">
    <div class="tcol"><h4 style="color:${a.color}"><span class="chip mini" style="--c:${a.color}">${a.avatar}</span> ${esc(a.name)} gives</h4>${sideHTML(t.give)}</div>
    <div class="tcol"><h4 style="color:${b.color}"><span class="chip mini" style="--c:${b.color}">${b.avatar}</span> ${esc(b.name)} gives</h4>${sideHTML(t.get)}</div></div>
    ${balanceHTML(sideValue(t.give), sideValue(t.get), a.color, b.color, esc(a.name) + ' gives', esc(b.name) + ' gives')}
    <p class="muted" style="font-size:12px;margin-top:8px">Values use list prices, just as a guide.</p>
    <div class="mact">${acts}</div>`;
}

function newTradeModal() {
  const others = S.players.filter(p => !p.bankrupt && p.id !== me);
  if (!others.length) return mhead('Propose a trade') + '<p class="muted">Nobody to trade with.</p>';
  if (!draft || !others.some(p => p.id === draft.to)) draft = { to: others[0].id, giveCash: 0, getCash: 0, give: new Set(), get: new Set() };
  const col = (title, pid, cashKey, setKey) => {
    const p = P(pid), tiles = tradable(pid), max = Math.max(0, p.cash);
    draft[cashKey] = Math.min(draft[cashKey], max);
    for (const i of [...draft[setKey]]) if (!tiles.includes(i)) draft[setKey].delete(i);
    return `<div class="tcol"><h4 style="color:${p.color}"><span class="chip mini" style="--c:${p.color}">${p.avatar}</span> ${title}</h4>
      <div class="cashIn"><span>₹</span><input type="number" min="0" max="${max}" step="10" value="${draft[cashKey]}" data-cash="${cashKey}" inputmode="numeric"><small>of ${inr(max)}</small></div>
      <input type="range" class="slider" style="--c:${p.color}" min="0" max="${max}" step="1" value="${draft[cashKey]}" data-cash="${cashKey}" aria-label="Cash">
      <div class="tlist">${tiles.map(i => `<button type="button" class="pchip ${draft[setKey].has(i) ? 'on' : ''}" data-act="tprop" data-side="${setKey}" data-v="${i}"><i style="background:${gcolor(i)}"></i><span>${esc(T(i).name)}${S.g.mortgaged[i] ? ' <small>(mortgaged)</small>' : ''}</span><b>${inr(T(i).price)}</b></button>`).join('') || '<p class="muted">No tradable properties</p>'}</div></div>`;
  };
  return mhead(draft.counter ? 'Negotiate the offer' : 'Propose a trade') + `
    <label class="setRow"><span>Trade with</span><select data-tradeto ${draft.counter ? 'disabled' : ''}>${others.map(p => `<option value="${p.id}" ${p.id === draft.to ? 'selected' : ''}>${esc(p.name)} — ${inr(p.cash)}</option>`).join('')}</select></label>
    <div class="tcols">${col('You give', me, 'giveCash', 'give')}${col(esc(P(draft.to).name) + ' gives', draft.to, 'getCash', 'get')}</div>
    <div id="tsum"></div>
    <p class="muted" style="font-size:12px;margin-top:8px">Drag the slider or type an amount, and tap properties to add them. Cities with buildings in their state can't be traded.</p>
    <div class="mact"><button class="btn primary" data-act="sendTrade">${draft.counter ? 'Send new offer' : 'Send offer'}</button></div>`;
}

function updateTradeSum() {
  const el = $('#tsum');
  if (!el || !draft || !mine() || !P(draft.to)) return;
  const a = draft.giveCash + [...draft.give].reduce((x, i) => x + T(i).price, 0);
  const b = draft.getCash + [...draft.get].reduce((x, i) => x + T(i).price, 0);
  el.innerHTML = balanceHTML(a, b, mine().color, P(draft.to).color, 'You give', 'You get');
}

/* ------------------------------------------------------------------ render & events */
function render() {
  if (!S || !B) return;
  if (GAMES[game]) return GAMES[game].render();
  syncDice(); syncTokens(); syncCard(); syncAuction(); notifyTrades(); detectFx();
  renderTiles(); renderRoomBox(); renderPlayers(); renderChat(); renderRight(); renderCenter(); renderModal();
  flushFx();
}

document.addEventListener('click', e => {
  if (e.target.id === 'modal') return closeModal();
  if (e.target.closest('#cardView')) { $('#cardView').hidden = true; return; }
  if (e.target.closest('#diceRow.canRoll')) return act('roll');
  if (e.target.closest('.hudDie.canRoll')) return Race.send('roll');
  const a = e.target.closest('[data-act]');
  if (a) {
    const k = a.dataset.act, v = a.dataset.v, id = a.dataset.id;
    e.preventDefault();
    if (GAMES[game] && GAMES[game].click && GAMES[game].click(k, v, a)) return;      // a game may handle its own buttons
    switch (k) {
      case 'close': return closeModal();
      case 'mute': muted = !muted; LS.set('rr_mute', muted ? '1' : '0'); renderRoomBox(); if (!muted) SFX.coin(); return;
      case 'rentPv': if (modal) { modal.pv = +v; renderModal(); } return;
      case 'tprop': {
        if (!draft) return;
        const set = draft[a.dataset.side], i = +v;
        if (set.has(i)) set.delete(i); else set.add(i);
        a.classList.toggle('on', set.has(i));
        return updateTradeSum();
      }
      case 'counter': {
        const t = S.g && S.g.trades.find(x => x.id === +v);
        if (!t) return closeModal();
        // receiving: swap the sides so "you give" is your side; sending: reopen your own offer for editing
        draft = t.to === me
          ? { to: t.from, giveCash: t.get.cash, getCash: t.give.cash, give: new Set(t.get.tiles), get: new Set(t.give.tiles), counter: t.id, drop: 'tradeDecline' }
          : { to: t.to, giveCash: t.give.cash, getCash: t.get.cash, give: new Set(t.give.tiles), get: new Set(t.get.tiles), counter: t.id, drop: 'tradeCancel' };
        return openModal('newTrade');
      }
      case 'copy': {
        const url = location.origin + location.pathname + '?room=' + S.code;
        (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('Invite link copied!', true), () => prompt('Copy this link and send it to your friends:', url));
        return;
      }
      case 'leave': if (S.phase !== 'playing' || !me || confirm('Leave this game?')) goHome(); return;
      case 'color': return send({ t: 'appearance', color: v });
      case 'avatar': return send({ t: 'appearance', avatar: v });
      case 'addBot': return send({ t: 'addBot' });
      case 'start': return send({ t: 'start' });
      case 'toLobby': return send({ t: 'toLobby' });
      case 'kick': e.stopPropagation(); if (S.phase === 'lobby' || confirm(GAMES[game] ? 'Remove this player from the game?' : 'Remove this player? Their properties go back to the bank.')) { send({ t: 'kick', id }); closeModal(); } return;
      case 'roll': return GAMES[game] ? Race.send('roll') : act('roll');
      case 'move': return Race.send('move', { i: +v });
      case 'resign': if (confirm('Give up and leave this game?')) act('resign'); return;
      case 'none': return;
      case 'player': return openModal('player', id);
      case 'viewTrade': return openModal('trade', +id);
      case 'newTrade': draft = null; openModal('newTrade'); if (id && draft) { draft.to = id; renderModal(true); } return;
      case 'sendTrade':
        if (!draft) return;
        if (draft.counter) act(draft.drop, { id: draft.counter });   // the old offer is replaced by the new one
        act('tradePropose', { to: draft.to, give: { cash: draft.giveCash, tiles: [...draft.give] }, get: { cash: draft.getCash, tiles: [...draft.get] } });
        return closeModal();
      case 'tradeAccept': case 'tradeDecline': case 'tradeCancel': act(k, { id: +v }); return closeModal();
      case 'bid': return act('bid', { amount: +v });
      case 'build': case 'sellHouse': case 'mortgage': case 'unmortgage': return act(k, { tile: +v });
      case 'bankrupt': if (confirm('Declare bankruptcy? You will be out of the game.')) act('bankrupt'); return;
      default: return act(k);   // roll, buy, decline, endTurn, payJail, useJailCard
    }
  }
  const tile = e.target.closest('[data-tile]');
  if (tile && S && !GAMES[game]) openModal('tile', +tile.dataset.tile);
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.set) {
    const k = el.dataset.set;
    send({ t: 'settings', settings: { [k]: el.type === 'checkbox' ? el.checked : +el.value } });
  } else if (el.dataset.cash && draft) {
    el.value = draft[el.dataset.cash];     // snap a typed amount back inside what the player can afford
  } else if (el.hasAttribute('data-tradeto') && draft) {
    draft.to = el.value; draft.get = new Set(); draft.getCash = 0; renderModal(true);
  }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.dataset) return;
  const k = el.dataset.cash;
  if (k && draft) {
    const v = Math.max(0, Math.min(+el.max || 0, Math.floor(+el.value || 0)));
    draft[k] = v;
    document.querySelectorAll(`[data-cash="${k}"]`).forEach(o => { if (o !== el) o.value = v; });   // slider and typed box stay in step
    updateTradeSum();
  } else if ('utildice' in el.dataset && modal) {
    const d = modal.dice = +el.value;
    $('#ud').textContent = d;
    $('#u1').textContent = inr(d * 4); $('#u2').textContent = inr(d * 10);
    $('#ub1').style.width = d * 4 / 1.2 + '%'; $('#ub2').style.width = d * 10 / 1.2 + '%';
  }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

$('#chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#chatInput').value.trim();
  if (v) send({ t: 'chat', text: v });
  $('#chatInput').value = '';
});

/* Free hosts put the server to sleep when no web requests arrive for a while.
   While someone is in a room, ask for a tiny page every few minutes to keep it awake. */
setInterval(() => { if (code) fetch('/?awake=' + Date.now(), { cache: 'no-store' }).catch(() => {}); }, 4 * 60 * 1000);

/* ------------------------------------------------------------------ home screen */
function readName() {
  myName = $('#nameInput').value.trim().slice(0, 16);
  if (!myName) { toast('Type your name first'); $('#nameInput').focus(); return false; }
  LS.set('ns_name', myName);
  return true;
}
/* which game a new room will play */
const GAME_INFO = {
  rupeerush: { tag: 'Buy cities from Varanasi to Mumbai, collect rent in rupees, and bankrupt your friends — live, on any device.',
    feats: ['🎲 2–8 players, bots included', '🏠 Houses, hotels &amp; mortgages', '🔨 Live auctions', '🤝 Player-to-player trades'] },
  snakes: { tag: 'Race from square 1 to 100. Ladders lift you up, snakes send you sliding back down — pure luck, loud fun.',
    feats: ['🎲 2–8 players, bots included', '🪜 7 ladders, 8 snakes', '⚡ A game takes 5–10 minutes', '📱 Works on any phone'] },
  ludo: { tag: 'Roll a six to get out, race your tokens round the board, and knock your friends back to their yard.',
    feats: ['🎲 2–4 players, bots included', '💥 Captures and bonus rolls', '⭐ Safe star squares', '⚡ Quick mode with 2 tokens'] },
  teenpatti: { tag: 'Three cards each, blind or seen. Bet, bluff, pack or call for a show — with free play chips, never real money.',
    feats: ['🃏 2–6 players, bots included', '🪙 Play chips only', '👁 Blind, chaal, show &amp; side show', '📈 Rising boot keeps it moving'] },
  rummy: { tag: 'Indian 13-card rummy with a wild joker. Build two sequences, one of them pure, and declare before your friends do.',
    feats: ['🂡 2–6 players, bots included', '★ Wild jokers every deal', '🧠 Hand sorted into groups for you', '🏆 Lowest points wins'] },
};
let pick = GAME_INFO[LS.get('rr_game')] ? LS.get('rr_game') : 'rupeerush';
function showPick() {
  document.querySelectorAll('.gcard').forEach(b => b.classList.toggle('on', b.dataset.game === pick));
  $('#home .tag').textContent = GAME_INFO[pick].tag;
  $('#home .feats').innerHTML = GAME_INFO[pick].feats.map(f => `<li>${f}</li>`).join('');
}
document.querySelectorAll('.gcard').forEach(b => b.addEventListener('click', () => { pick = b.dataset.game; LS.set('rr_game', pick); showPick(); tone(660, .05, 'triangle', .05); }));
showPick();
$('#createBtn').addEventListener('click', () => { if (readName()) connect(() => ({ t: 'create', name: myName, game: pick })); });
$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const c = $('#codeInput').value.trim().toUpperCase();
  if (c.length !== 5) return toast('Room codes are 5 letters');
  if (readName()) { code = c; connect(joinMsg); }
});
$('#joinInviteBtn').addEventListener('click', () => { if (readName()) { code = $('#inviteCode').textContent; connect(joinMsg); } });
$('#homeOther').addEventListener('click', () => { history.replaceState(null, '', location.pathname); $('#homeInvite').hidden = true; $('#homeMain').hidden = false; });

(function boot() {
  $('#nameInput').value = myName;
  const c = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  if (!c) return;
  if (myName && (SS.get('ns_tok_' + c) || LS.get('ns_tok_' + c))) { code = c; connect(joinMsg); return; }   // resume a game after refresh
  $('#inviteCode').textContent = c;
  $('#homeInvite').hidden = false; $('#homeMain').hidden = true;
})();
