'use strict';
/* Shared by the race games (Snakes & Ladders, Ludo).
   The server sends a short list of recent events with every state. Race plays the ones it has not
   shown yet, one after another (dice roll, token walking, snake slide ...), and only then shows the
   final state. A game plugs in with Race.register(name, impl), where impl has:
     title, cls, maxSeats, toggles, selects      static description
     build(board)      draw the empty board            snap()        show the true state at once
     play(ev, fast)    animate one event (async)       layout()      re-place the tokens
     info(player)      short text for the players list hint(g, mine) small line under the turn text
     rules(settings)   list of rule sentences                                                          */

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MEDALS = ['🥇', '🥈', '🥉'];
const ROLL_HINT = window.matchMedia && matchMedia('(pointer: coarse)').matches ? 'Tap the die to roll' : 'Click the die, or press Space';
spin.gd = [0, 0];

/* ------------------------------------------------------------------ extra sounds */
function noise(dur, vol, when, freq, q) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t0 = audio.currentTime + (when || 0), n = Math.max(1, Math.floor(audio.sampleRate * dur));
    const buf = audio.createBuffer(1, n, audio.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = audio.createBufferSource(), f = audio.createBiquadFilter(), g = audio.createGain();
    src.buffer = buf; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(audio.destination); src.start(t0);
  } catch (e) { /* no sound on this device */ }
}
Object.assign(SFX, {
  die1() { for (let k = 0; k < 7; k++) { tone(190 + Math.random() * 260, .045, 'square', .045, k * .12); noise(.035, .16, k * .12, 2400, 2); } },
  six() { tone(1047, .09, 'square', .04); tone(1568, .2, 'square', .04, .09); },
  ladder() { [392, 494, 587, 698, 784, 988, 1175].forEach((f, k) => tone(f, .15, 'triangle', .07, k * .125)); },
  hiss() { noise(.6, .16, 0, 5200, 1.4); noise(.5, .08, .05, 7600, 2); },
  slide() { tone(880, 1.2, 'sawtooth', .04, 0, 110); tone(1320, 1.2, 'sine', .045, 0, 165); },
  thud() { tone(150, .26, 'sine', .2, 0, 48); noise(.12, .16, 0, 320, 1); },
  bump() { tone(160, .14, 'square', .05); tone(125, .2, 'square', .05, .13); },
  out() { tone(392, .09, 'triangle', .08); tone(587, .09, 'triangle', .08, .08); tone(784, .2, 'triangle', .08, .16); },
  capture() { noise(.2, .3, 0, 900, .8); tone(560, .42, 'sawtooth', .06, .04, 80); tone(90, .3, 'sine', .2, 0, 45); },
  home() { [784, 988, 1175, 1568].forEach((f, k) => tone(f, .24, 'sine', .08, k * .09)); },
});

/* ------------------------------------------------------------------ small animation helpers */
function hopEl(el, ms) {
  if (el.animate) el.animate([{ transform: 'translateY(0) scale(1)' }, { transform: 'translateY(-35%) scale(1.28)' }, { transform: 'translateY(0) scale(1)' }], { duration: ms || 170, easing: 'ease-out' });
}
function squashEl(el) {
  if (el.animate) el.animate([{ transform: 'scale(1.35, .7)' }, { transform: 'scale(.9, 1.15)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
}
function shakeEl(el) {
  if (el.animate) el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-12%)' }, { transform: 'translateX(12%)' }, { transform: 'translateX(-8%)' }, { transform: 'translateX(8%)' }, { transform: 'translateX(0)' }], { duration: 420 });
}
/* expanding ring at a board position given in % */
function ringAt(x, y, color) {
  const layer = $('#gtokens');
  if (!layer) return;
  const r = document.createElement('i');
  r.className = 'ring'; r.style.left = x + '%'; r.style.top = y + '%'; r.style.setProperty('--c', color);
  layer.appendChild(r);
  setTimeout(() => r.remove(), 700);
}
/* a symbol that pops up and fades at a board position */
function popAt(x, y, text) {
  const layer = $('#gtokens');
  if (!layer) return;
  const f = document.createElement('div');
  f.className = 'gpop'; f.textContent = text; f.style.left = x + '%'; f.style.top = y + '%';
  layer.appendChild(f);
  setTimeout(() => f.remove(), 900);
}
/* move an element along a line of points (in %) in ms milliseconds */
function glide(el, pts, ms) {
  const seg = [0];
  for (let i = 1; i < pts.length; i++) seg.push(seg[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = seg[seg.length - 1] || 1;
  const place = u => {
    const d = u * total;
    let i = 1;
    while (i < seg.length - 1 && seg[i] < d) i++;
    const f = (d - seg[i - 1]) / ((seg[i] - seg[i - 1]) || 1);
    el.style.left = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f + '%';
    el.style.top = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f + '%';
  };
  const run = new Promise(res => {
    const t0 = performance.now();
    const step = now => {
      const u = Math.min(1, (now - t0) / ms);
      place(u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
      if (u < 1) requestAnimationFrame(step); else res();
    };
    requestAnimationFrame(step);
  });
  return Promise.race([run, sleep(ms + 300)]).then(() => place(1));   // the timer wins when the tab is in the background
}

/* ------------------------------------------------------------------ the engine */
const Race = {
  impl: null, q: [], playing: false, lastSeq: -1, gen: 0, pending: false, caption: '', lastTurn: null, logKeep: null,
  shownTurn: null,          // whose move is on screen right now (the animation can be behind the server)

  register(name, impl) {
    GAMES[name] = {
      enter: () => Race.enter(impl), leave: () => Race.leave(), render: () => Race.render(),
      onError: () => { Race.pending = false; if (S && Race.impl) { Race.impl.snap(); Race.hud(); } },
      click: (k, v, el) => !!(Race.impl && Race.impl.click && Race.impl.click(k, v, el)),
    };
  },

  enter(impl) {
    this.gen++; this.impl = impl; this.q = []; this.playing = false; this.lastSeq = -1;
    this.pending = false; this.caption = ''; this.lastTurn = null; this.logKeep = null; this.sawLobby = false;
    const b = $('#gboard');
    b.className = impl.cls; b.innerHTML = '';
    impl.build(b);
    setDie('gd', 1);
    $('.hudDie').classList.remove('rolling', 'canRoll');
    $('.hudDie').hidden = !!impl.noDie;                 // card games have no die
    $('#hud').classList.toggle('wide', !!impl.noDie);
  },

  leave() {
    this.gen++; this.q = []; this.playing = false; this.impl = null;
    $('#gboard').innerHTML = '';
  },

  render() {
    const impl = this.impl, g = S.g;
    if (!impl) return;
    this.pending = false;
    renderRoomBox(); renderChat();
    if (!g) {
      this.lastSeq = -1; this.q.length = 0; this.lastTurn = null; this.logKeep = null;
      this.sawLobby = true;
      if (!this.playing) impl.snap();
    } else if ((this.lastSeq === -1 && !(this.sawLobby && g.seq <= g.events.length)) || g.seq < this.lastSeq || g.seq - Math.max(0, this.lastSeq) > g.events.length) {
      this.lastSeq = g.seq; this.q.length = 0;          // just joined, or missed too much: jump to the truth
      this.sawLobby = false;
      if (!this.playing) impl.snap();
    } else {
      if (this.lastSeq === -1) this.lastSeq = 0;      // we watched this game start: show its first events too
      this.sawLobby = false;
      for (const ev of g.events) if (ev.seq > this.lastSeq) { this.q.push(ev); this.lastSeq = ev.seq; }
      if (this.q.length) this.pump(); else if (!this.playing) impl.snap();
    }
    this.players(); this.right(); this.hud();
  },

  async pump() {
    if (this.playing) return;
    this.playing = true;
    const my = this.gen, impl = this.impl;
    this.hud();
    while (this.q.length && my === this.gen) {
      const ev = this.q.shift(), fast = document.hidden || this.q.length > 4;
      if (ev.p && ev.k !== 'drop' && S) { this.shownTurn = ev.p; this.players(); }
      try {
        if (ev.k === 'end') { if (!fast) { confetti(); SFX.win(); } }
        else if (ev.k === 'drop') impl.layout();
        else await impl.play(ev, fast);
      } catch (e) { console.error(e); }
      if (my === this.gen && S) this.players();
    }
    if (my !== this.gen) return;
    this.playing = false; this.caption = '';
    if (S) { impl.snap(); this.players(); this.right(); this.hud(); }
  },

  say(html) { this.caption = html; if (S) this.hud(); },
  name(p) { return p ? `<b style="color:${p.color}">${esc(p.name)}</b>` : 'Someone'; },

  /* the dice part of a roll event */
  async roll(ev, fast) {
    const p = P(ev.p);
    $('#hud').style.setProperty('--pc', p ? p.color : '#fff');
    if (fast) { setDie('gd', ev.die); return; }
    this.say(`${this.name(p)} is rolling…`);
    const box = $('.hudDie');
    box.classList.remove('rolling'); void box.offsetWidth; box.classList.add('rolling');
    setDie('gd', ev.die, [2, 1]);
    SFX.die1();
    await sleep(1000);
    box.classList.remove('rolling');
    this.say(`${this.name(p)} rolled <b class="num">${ev.die}</b>`);
    if (ev.die === 6) SFX.six();
    await sleep(200);
  },

  send(a, extra) {
    if (this.pending || this.playing || !S || S.phase !== 'playing') return;
    this.pending = true;
    act(a, extra);
    this.impl.snap(); this.hud();
    const my = this.gen;
    setTimeout(() => { if (this.pending && my === this.gen && S) { this.pending = false; this.impl.snap(); this.hud(); } }, 4000);
  },

  /* ---------------------------------------------------------------- bar under the board */
  hud() {
    const impl = this.impl, g = S.g, text = $('#hudText'), actEl = $('#hudAct');
    let t = '', a = '', can = false;
    if (S.phase === 'lobby') {
      t = `<b>${impl.title}</b><small>${S.players.length} in the room · share the invite link</small>`;
      a = isHost() ? `<button class="btn green" data-act="start" ${S.players.length < 2 ? 'disabled' : ''}>Start game</button>` : '<span class="muted">The host will start the game</span>';
    } else if (this.playing) {
      t = this.caption;
    } else if (S.phase === 'ended') {
      const w = P(g.winner);
      t = `<span class="winner">🏆 ${w ? esc(w.name) : 'Nobody'} wins!</span>`;
      a = isHost() ? '<button class="btn green" data-act="toLobby">Play again</button>' : '<span class="muted">Waiting for the host</span>';
    } else {
      const tid = impl.turn ? impl.turn(g) : g.turn, cur = tid ? P(tid) : null, myTurn = !!tid && tid === me;
      $('#hud').style.setProperty('--pc', cur ? cur.color : '#fff');
      if (impl.hud) {                     // card games draw their own text and buttons
        const r = impl.hud(g, myTurn, cur);
        t = r.t; a = r.a;
      } else {
        const hint = impl.hint(g, myTurn, cur);
        t = (myTurn ? `<span class="myturn">Your turn, ${esc(cur.name)}!</span>` : `${this.name(cur)}'s turn${cur && cur.bot ? ' 🤖' : ''}`) + (hint ? `<small>${hint}</small>` : '');
        if (myTurn && g.turnPhase === 'roll') {
          can = !this.pending;
          a = `<button class="btn primary" data-act="roll" ${can ? '' : 'disabled'}>🎲 Roll</button>`;
        }
      }
      if (myTurn && this.lastTurn !== me) SFX.turn();
      this.lastTurn = tid;
    }
    setHTML(text, t); setHTML(actEl, a);
    $('.hudDie').classList.toggle('canRoll', can);
  },

  /* ---------------------------------------------------------------- left column */
  players() {
    const impl = this.impl, g = S.g, host = isHost();
    const rows = S.players.map(p => {
      const tags = [p.id === me ? 'you' : '', p.id === S.hostId ? '👑' : '', p.bot ? '🤖' : '', !p.connected && !p.bot ? '⚠ offline' : ''].filter(Boolean).join(' ');
      const turn = g && (this.playing ? this.shownTurn === p.id : S.phase === 'playing' && (impl.turn ? impl.turn(g) : g.turn) === p.id);
      const rank = g ? g.ranks.indexOf(p.id) : -1;
      const kick = host && p.id !== me && !p.bankrupt && S.phase !== 'ended' ? `<button class="x" data-act="kick" data-id="${p.id}" title="Remove">✕</button>` : '';
      const info = S.phase === 'lobby' ? '' : `<span class="pinfo">${rank >= 0 && !this.playing && (S.phase === 'ended' || !p.bankrupt) ? (MEDALS[rank] || '#' + (rank + 1)) : p.bankrupt ? (impl.outText || 'left') : impl.info(p)}</span>`;
      return `<div class="prow ${turn ? 'turn' : ''} ${p.bankrupt ? 'out' : ''}" data-act="none">
        <span class="chip" style="--c:${p.color}">${p.avatar}</span>
        <span class="nm">${esc(p.name)}<small>${tags}</small></span>${info}${kick}</div>`;
    }).join('');
    setHTML($('#playersBox'), `<h3>Players</h3>${rows}`);
  },

  /* ---------------------------------------------------------------- right column */
  right() {
    const el = $('#right'), impl = this.impl, g = S.g, m = mine();
    if (S.phase === 'lobby') return setHTML(el, this.lobby());
    let h = '';
    if (!m) h += '<div class="panel"><h3>Spectating</h3><p class="muted">This game started before you joined. You can watch, and join the next round from the lobby.</p></div>';
    if (S.phase === 'ended' && !this.playing) {
      h += `<div class="panel"><h3>Results</h3>${g.ranks.map((id, k) => { const p = P(id); return p ? `<div class="res"><span>${MEDALS[k] || '#' + (k + 1)}</span><span class="chip mini" style="--c:${p.color}">${p.avatar}</span><b>${esc(p.name)}</b></div>` : ''; }).join('') || '<p class="muted">Nobody finished.</p>'}</div>`;
    }
    if (!this.playing || !this.logKeep) this.logKeep = S.log;     // do not give the result away before the animation shows it
    const log = this.logKeep.slice(-40).map(l => { const p = l.p && P(l.p); return `<div class="ln"><i class="dot" style="--c:${p ? p.color : '#666'}"></i><span>${esc(l.m)}</span></div>`; }).join('');
    h += `<div class="panel"><h3>Game log</h3><div class="glog">${log}</div></div>`;
    h += `<div class="panel"><h3>How to play</h3><ul class="rules">${impl.rules(S.settings).map(r => `<li>${r}</li>`).join('')}</ul></div>`;
    if (impl.hostEnd && isHost() && S.phase === 'playing') h += '<button class="btn small" data-act="endGame">End the game now</button>';
    if (m && !m.bankrupt && S.phase === 'playing' && !g.ranks.includes(me)) h +='<button class="btn danger small" data-act="resign">Give up</button>';
    if (setHTML(el, h)) { const l = $('.glog', el); if (l) l.scrollTop = l.scrollHeight; }
  },

  lobby() {
    const impl = this.impl, m = mine(), host = isHost(), s = S.settings;
    if (!m) return '<div class="panel"><p class="muted">Joining…</p></div>';
    const taken = new Set(S.players.filter(p => p.id !== me).map(p => p.color));
    const sw = B.colors.map(c => `<button class="sw ${c === m.color ? 'on' : ''} ${taken.has(c) ? 'taken' : ''}" style="--c:${c}" data-act="color" data-v="${c}" ${taken.has(c) ? 'disabled' : ''}></button>`).join('');
    const av = B.avatars.map(a => `<button class="av ${a === m.avatar ? 'on' : ''}" data-act="avatar" data-v="${a}">${a}</button>`).join('');
    const dis = host ? '' : 'disabled';
    const seats = [];
    for (let v = 2; v <= impl.maxSeats; v++) seats.push(v);
    const selects = [['maxPlayers', 'Max players', seats.map(v => [v, v])]].concat(impl.selects || [])
      .map(([k, l, opts]) => `<label class="setRow"><span>${l}</span><select data-set="${k}" ${dis}>${(typeof opts === 'function' ? opts(B) : opts).map(([v, t]) => `<option value="${v}" ${v === s[k] ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`).join('');
    const toggles = impl.toggles.map(([k, l, d]) => `<label class="setRow"><span>${l}<small>${d}</small></span><input type="checkbox" class="sw-t" data-set="${k}" ${s[k] ? 'checked' : ''} ${dis}></label>`).join('');
    return `
      <div class="panel"><h3>Your colour</h3><div class="swatches">${sw}</div><div class="avatars">${av}</div></div>
      <div class="panel"><h3>Game settings ${host ? '' : '<span style="text-transform:none;letter-spacing:0">(host decides)</span>'}</h3>${selects}${toggles}</div>
      ${host ? `<div class="stack"><button class="btn" data-act="addBot" ${S.players.length >= s.maxPlayers ? 'disabled' : ''}>🤖 Add a bot</button>
        <button class="btn green big" data-act="start" ${S.players.length < 2 ? 'disabled' : ''}>Start game</button></div>` : ''}`;
  },
};

/* Space or Enter rolls the die when it is your turn */
document.addEventListener('keydown', e => {
  if ((e.key === ' ' || e.key === 'Enter') && GAMES[game] && S && !/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(e.target.tagName) && $('.hudDie.canRoll')) {
    e.preventDefault();
    Race.send('roll');
  }
});

/* card tables are laid out from the window size, so redraw them when it changes */
window.addEventListener('resize', () => { if (Race.impl && Race.impl.resize && S && !Race.playing) Race.impl.snap(); });
