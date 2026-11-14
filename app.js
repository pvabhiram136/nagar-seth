'use strict';
/* Nagar Seth — browser client. The server owns all the rules; this file only draws state and sends intents. */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => (n < 0 ? '-' : '') + '₹' + Math.abs(n).toLocaleString('en-IN');
const short = n => n >= 100000 ? '₹' + (+(n / 100000).toFixed(2)) + 'L' : '₹' + (n / 1000) + 'K';
const store = kind => ({
  get(k) { try { return window[kind].getItem(k); } catch (e) { return null; } },
  set(k, v) { try { window[kind].setItem(k, v); } catch (e) { /* private mode */ } },
});
const LS = store('localStorage'), SS = store('sessionStorage');
const EXTRA_COLORS = { rail: '#aab4c3', util: '#c6d24a' };
const SETTING_LABELS = [
  ['doubleRent', 'Double rent on full sets', 'Own every city of a colour to charge 2× base rent'],
  ['vacationCash', 'Goa holiday pot', 'Taxes and fines pile up in Goa — land there to take it all'],
  ['auction', 'Auctions', 'A property nobody buys is auctioned to all players'],
  ['noRentInJail', 'No rent from jail', "Owners sitting in jail can't collect rent"],
  ['mortgage', 'Mortgages', 'Mortgage a property to the bank for half its price'],
  ['evenBuild', 'Even building', 'Houses must be spread evenly across a set'],
  ['randomOrder', 'Random turn order', 'Shuffle who goes first'],
];

let ws = null, B = null, S = null, me = null, code = null, quitting = false;
let myName = LS.get('ns_name') || '';
let modal = null;           // {kind, arg}
let draft = null;           // new-trade form state
let boardBuilt = false;
let animating = false, rolling = false, lastRollSeq = -1, lastCardSeq = -1, cardTimer = null;
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
    code = m.code; me = m.you; B = m.board;
    if (m.token) { SS.set('ns_tok_' + code, m.token); LS.set('ns_tok_' + code, m.token); }
    history.replaceState(null, '', '?room=' + code);
    $('#home').hidden = true; $('#room').hidden = false;
    if (!boardBuilt) buildBoard();
  } else if (m.t === 'state') {
    S = m; render();
  } else if (m.t === 'error') {
    if (m.fatal) goHome(m.m); else toast(m.m);
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
    if (t.type === 'city') h = `<div class="band" style="background:${gcolor(i)}"></div><div class="body"><div class="tname">${esc(t.name)}</div><div class="tprice">${short(t.price)}</div></div>`;
    else if (t.type === 'station') h = `<div class="body"><div class="ticon">🚂</div><div class="tname">${t.short}</div><div class="tprice">${short(t.price)}</div></div>`;
    else if (t.type === 'utility') h = `<div class="body"><div class="ticon">${t.icon}</div><div class="tname">${t.short}</div><div class="tprice">${short(t.price)}</div></div>`;
    else if (t.type === 'card') h = `<div class="body"><div class="ticon">${t.deck === 'kismat' ? '🪔' : '💎'}</div><div class="tname">${t.name}</div></div>`;
    else if (t.type === 'tax') h = `<div class="body"><div class="ticon">🧾</div><div class="tname">${t.kind === 'income' ? 'Tax 10%' : 'GST'}</div></div>`;
    else if (t.type === 'start') h = `<div class="body"><div class="ticon">🏁</div><div class="tname">Shuru</div><div class="tprice">+${short(B.salary)}</div></div>`;
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

/* ------------------------------------------------------------------ dice & tokens */
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function setDie(el, n) { el.innerHTML = Array.from({ length: 9 }, (_, k) => `<span class="${PIPS[n].includes(k) ? 'on' : ''}"></span>`).join(''); }
function setDice(d) { setDie($('#d1'), d[0]); setDie($('#d2'), d[1]); }

function syncDice() {
  const g = S.g;
  if (!g) { lastRollSeq = -1; return; }
  if (g.rollSeq === lastRollSeq) return;
  const animate = lastRollSeq !== -1 && g.rollSeq > 0;
  lastRollSeq = g.rollSeq;
  if (!animate) return setDice(g.dice);
  rolling = true; animating = true;
  const d1 = $('#d1'), d2 = $('#d2');
  d1.classList.add('rolling'); d2.classList.add('rolling');
  const iv = setInterval(() => setDice([1 + Math.random() * 6 | 0, 1 + Math.random() * 6 | 0]), 70);
  setTimeout(() => {
    clearInterval(iv); rolling = false;
    d1.classList.remove('rolling'); d2.classList.remove('rolling');
    if (S && S.g) setDice(S.g.dice);
  }, 550);
}

function syncTokens() {
  const layer = $('#tokens');
  const ids = new Set(S.players.map(p => p.id));
  for (const id of Object.keys(tok)) if (!ids.has(id)) { tok[id].el.remove(); delete tok[id]; }
  for (const p of S.players) {
    let t = tok[p.id];
    if (!t) {
      const el = document.createElement('div');
      el.className = 'token';
      layer.appendChild(el);
      t = tok[p.id] = { el, pos: p.pos, seq: p.mv.seq, queue: [], wait: 0 };
    }
    t.el.style.setProperty('--c', p.color);
    t.el.textContent = p.avatar;
    t.el.hidden = p.bankrupt;
    t.el.classList.toggle('jailed', p.inJail);
    t.el.classList.toggle('turn', !!S.g && S.phase === 'playing' && S.g.turn === p.id);
    if (p.mv.seq !== t.seq) {
      t.seq = p.mv.seq;
      let cur = t.queue.length ? t.queue[t.queue.length - 1] : t.pos;
      for (const st of p.mv.steps) {
        if (st.kind === 'jump') { t.queue.push(st.to); cur = st.to; continue; }
        const step = st.kind === 'back' ? 39 : 1;
        let guard = 0;
        while (cur !== st.to && guard++ < 40) { cur = (cur + step) % 40; t.queue.push(cur); }
      }
      if (t.queue.length) { t.wait = rolling ? 4 : 0; animating = true; }
    } else if (!t.queue.length && t.pos !== p.pos) {
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

setInterval(() => {
  let moved = false, busy = rolling;
  for (const id in tok) {
    const t = tok[id];
    if (!t.queue.length) continue;
    if (t.wait > 0) { t.wait--; busy = true; continue; }
    t.pos = t.queue.shift(); moved = true;
    if (t.queue.length) busy = true;
  }
  if (moved) layoutTokens();
  if (animating && !busy) { animating = false; if (S) { renderCenter(); } }
}, 150);

/* ------------------------------------------------------------------ left column */
function renderRoomBox() {
  const n = S.players.length;
  setHTML($('#roomBox'), `
    <div class="codeRow"><div><h3>Room code</h3><div class="code">${esc(S.code)}</div></div>
    <button class="btn small primary" data-act="copy">Copy invite link</button></div>
    <div class="hint">${S.phase === 'lobby' ? `Share the link — ${n}/${S.settings.maxPlayers} joined` : me ? 'Game in progress' : 'You are watching this game'}
    · <a href="#" data-act="leave" style="color:inherit">Leave</a></div>`);
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
    || '<div class="muted">No messages yet. Say namaste 🙏</div>';
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
  setHTML(st, myTurn ? `Your turn, ${esc(cur.name)}!` : `${esc(cur.name)}'s turn${cur.bot ? ' 🤖' : ''}`);

  // auction
  if (g.auction) {
    const a = g.auction, t = T(a.tile), b = a.bidder ? P(a.bidder) : null;
    const can = m && !m.bankrupt;
    const btn = inc => `<button class="btn ${inc === 10000 ? 'primary' : ''}" data-act="bid" data-v="${a.bid + inc}" ${can && m.cash >= a.bid + inc ? '' : 'disabled'}>+${short(inc)}</button>`;
    au.hidden = false;
    setHTML(au, `🔨 Auction — <b>${esc(t.name)}</b> <span class="muted">(list price ${inr(t.price)})</span>
      <div class="bidline">${b ? `${inr(a.bid)} <span style="color:${b.color}">${esc(b.name)}${a.bidder === me ? ' (you)' : ''}</span>` : 'No bids yet'}</div>
      <div class="bar"><i id="aucBar"></i></div>
      ${can ? `<div class="bids">${btn(2000)}${btn(10000)}${btn(50000)}</div>` : ''}`);
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
  const c = g.card, el = $('#cardView'), p = P(c.p);
  clearTimeout(cardTimer);
  cardTimer = setTimeout(() => {
    el.className = c.deck;
    el.innerHTML = `<h5>${c.deck === 'kismat' ? '🪔 Kismat' : '💎 Khazana'} · ${esc(p ? p.name : '')}</h5><p>${esc(c.text)}</p>`;
    el.hidden = false;
    cardTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }, 900);
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
}

const mhead = title => `<div class="mhead"><h2>${title}</h2><button class="x" data-act="close">×</button></div>`;
const kv = (k, v, hl) => `<div class="kv ${hl ? 'hl' : ''}"><span>${k}</span><b>${v}</b></div>`;

function tileModal(i) {
  const t = T(i), g = S.g;
  if (!ownable(i)) {
    const info = {
      start: `Collect ${inr(B.salary)} salary every time you pass or land here.`,
      card: t.deck === 'kismat' ? 'Draw a Kismat card — luck can take you anywhere on the board.' : 'Draw a Khazana card — usually money in, sometimes money out.',
      tax: t.kind === 'income' ? 'Pay 10% of the cash in your hand.' : `Pay ${inr(B.gst)} GST.`,
      jail: `Just visiting — unless you were sent here. To get out: roll doubles, pay ${inr(B.jailFine)} bail, or use a Bail Card. After 3 failed rolls you pay bail automatically.`,
      vacation: S.settings.vacationCash ? `Every tax and fine lands in the Goa pot. Stop here to collect it all.${g ? ' Pot right now: ' + inr(g.pot) + '.' : ''}` : 'A quiet beach. Nothing happens here.',
      gotojail: 'Go straight to jail. No salary on the way.',
    }[t.type];
    return mhead(esc(t.name)) + `<p>${info}</p>`;
  }
  const owner = g && g.owner[i] ? P(g.owner[i]) : null;
  const h = g ? g.houses[i] : 0, mort = g && g.mortgaged[i];
  let rows = kv('Price', inr(t.price));
  if (t.type === 'city') {
    const full = owner && ownsGroup(owner.id, t.group) && S.settings.doubleRent;
    const names = ['Base rent', 'With 1 house', 'With 2 houses', 'With 3 houses', 'With 4 houses', 'With a hotel'];
    rows += t.rents.map((r, k) => kv(names[k] + (k === 0 && full ? ' (×2 full set)' : ''), inr(k === 0 && full ? r * 2 : r), !!owner && !mort && h === k)).join('');
    rows += kv('House / hotel cost', inr(t.houseCost));
  } else if (t.type === 'station') {
    const n = owner ? groupTiles('rail').filter(j => g.owner[j] === owner.id).length : 0;
    rows += B.stationRent.map((r, k) => kv(`Rent with ${k + 1} station${k ? 's' : ''}`, inr(r), !mort && n === k + 1)).join('');
  } else {
    rows += kv('Rent with 1 utility', 'dice × ₹4,000') + kv('Rent with both', 'dice × ₹10,000');
  }
  rows += kv('Mortgage value', inr(t.price / 2));
  rows += kv('Owner', owner ? `<span style="color:${owner.color}">${esc(owner.name)}</span>${mort ? ' (mortgaged)' : ''}` : 'For sale');
  let acts = '';
  if (owner && owner.id === me && S.phase === 'playing') {
    const myTurn = g.turn === me, m = mine();
    if (t.type === 'city') {
      const full = ownsGroup(me, t.group);
      acts += `<button class="btn green" data-act="build" data-v="${i}" ${full && myTurn && h < 5 && !mort && m.cash >= t.houseCost ? '' : 'disabled'}>Build ${h === 4 ? 'hotel' : 'house'} −${short(t.houseCost)}</button>
        <button class="btn" data-act="sellHouse" data-v="${i}" ${h ? '' : 'disabled'}>Sell building +${short(t.houseCost / 2)}</button>`;
    }
    if (S.settings.mortgage || mort) {
      acts += mort ? `<button class="btn primary" data-act="unmortgage" data-v="${i}" ${myTurn ? '' : 'disabled'}>Clear mortgage −${inr(t.price * 55 / 100)}</button>`
        : `<button class="btn" data-act="mortgage" data-v="${i}">Mortgage +${short(t.price / 2)}</button>`;
    }
    if (t.type === 'city' && !ownsGroup(me, t.group)) acts += `<p class="muted" style="width:100%;margin:0;font-size:12px">Own all of ${esc(B.groups[t.group].name)} to start building.</p>`;
    else if (g.turn !== me) acts += `<p class="muted" style="width:100%;margin:0;font-size:12px">Building happens on your own turn.</p>`;
  }
  const grp = B.groups[t.group];
  return `<div class="mhead" style="margin-bottom:6px"><span></span><button class="x" data-act="close">×</button></div>
    <div class="deedHead" style="background:${gcolor(i)}"><small>${grp ? esc(grp.name) : t.type === 'station' ? 'Railway station' : 'Utility'}</small>${esc(t.name)}</div>
    ${rows}<div class="mact">${acts}</div>`;
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

function tradeViewModal(t) {
  const a = P(t.from), b = P(t.to);
  let acts = '';
  if (t.to === me) acts = `<button class="btn green" data-act="tradeAccept" data-v="${t.id}">Accept</button><button class="btn danger" data-act="tradeDecline" data-v="${t.id}">Decline</button>`;
  else if (t.from === me) acts = `<button class="btn danger" data-act="tradeCancel" data-v="${t.id}">Withdraw offer</button>`;
  return mhead(`Trade: ${esc(a.name)} → ${esc(b.name)}`) + `<div class="tcols">
    <div class="tcol"><h4 style="color:${a.color}">${esc(a.name)} gives</h4>${sideHTML(t.give)}</div>
    <div class="tcol"><h4 style="color:${b.color}">${esc(b.name)} gives</h4>${sideHTML(t.get)}</div></div>
    <div class="mact">${acts}</div>`;
}

function newTradeModal() {
  const others = S.players.filter(p => !p.bankrupt && p.id !== me);
  if (!others.length) return mhead('Propose a trade') + '<p class="muted">Nobody to trade with.</p>';
  if (!draft || !others.some(p => p.id === draft.to)) draft = { to: others[0].id, giveCash: 0, getCash: 0, give: new Set(), get: new Set() };
  const col = (title, pid, cashKey, setKey) => {
    const p = P(pid), tiles = tradable(pid);
    return `<div class="tcol"><h4 style="color:${p.color}">${title}</h4>
      <label class="cashIn">₹<input type="number" min="0" step="10000" max="${Math.max(0, p.cash)}" value="${draft[cashKey]}" data-cash="${cashKey}" inputmode="numeric"></label>
      <div class="tlist">${tiles.map(i => `<label class="chk"><input type="checkbox" data-tset="${setKey}" value="${i}" ${draft[setKey].has(i) ? 'checked' : ''}><i style="background:${gcolor(i)}"></i>${esc(T(i).name)}${S.g.mortgaged[i] ? ' <span class="muted">(mortgaged)</span>' : ''}</label>`).join('') || '<p class="muted">No tradable properties</p>'}</div></div>`;
  };
  return mhead('Propose a trade') + `
    <label class="setRow"><span>Trade with</span><select data-tradeto>${others.map(p => `<option value="${p.id}" ${p.id === draft.to ? 'selected' : ''}>${esc(p.name)} — ${inr(p.cash)}</option>`).join('')}</select></label>
    <div class="tcols">${col('You give', me, 'giveCash', 'give')}${col(esc(P(draft.to).name) + ' gives', draft.to, 'getCash', 'get')}</div>
    <p class="muted" style="font-size:12px">Cities with buildings in their colour set can't be traded until the buildings are sold.</p>
    <div class="mact"><button class="btn primary" data-act="sendTrade">Send offer</button></div>`;
}

/* ------------------------------------------------------------------ render & events */
function render() {
  if (!S || !B) return;
  syncDice(); syncTokens(); syncCard(); syncAuction(); notifyTrades();
  renderTiles(); renderRoomBox(); renderPlayers(); renderChat(); renderRight(); renderCenter(); renderModal();
}

document.addEventListener('click', e => {
  if (e.target.id === 'modal') return closeModal();
  const a = e.target.closest('[data-act]');
  if (a) {
    const k = a.dataset.act, v = a.dataset.v, id = a.dataset.id;
    e.preventDefault();
    switch (k) {
      case 'close': return closeModal();
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
      case 'kick': e.stopPropagation(); if (S.phase === 'lobby' || confirm('Remove this player? Their properties go back to the bank.')) { send({ t: 'kick', id }); closeModal(); } return;
      case 'player': return openModal('player', id);
      case 'viewTrade': return openModal('trade', +id);
      case 'newTrade': draft = null; openModal('newTrade'); if (id && draft) { draft.to = id; renderModal(true); } return;
      case 'sendTrade':
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
  if (tile && S) openModal('tile', +tile.dataset.tile);
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.set) {
    const k = el.dataset.set;
    send({ t: 'settings', settings: { [k]: el.type === 'checkbox' ? el.checked : +el.value } });
  } else if (el.dataset.tset && draft) {
    const set = draft[el.dataset.tset];
    if (el.checked) set.add(+el.value); else set.delete(+el.value);
  } else if (el.hasAttribute('data-tradeto') && draft) {
    draft.to = el.value; draft.get = new Set(); draft.getCash = 0; renderModal(true);
  }
});
document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.cash;
  if (k && draft) draft[k] = Math.max(0, Math.floor(+e.target.value || 0));
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
$('#createBtn').addEventListener('click', () => { if (readName()) connect(() => ({ t: 'create', name: myName })); });
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
