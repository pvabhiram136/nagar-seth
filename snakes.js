'use strict';
/* Snakes & Ladders — board drawing and animation. Rules are in game_snakes.py; shared engine in race.js. */
(() => {
  const GAP = .3, CS = (100 - 11 * GAP) / 10;          // board units are % of the board's width
  const SNAKE_COLORS = [['#7bd88f', '#1f7a3a'], ['#f783ac', '#a61e4d'], ['#ffa94d', '#b85c00'], ['#b197fc', '#5f3dc4'],
    ['#63e6be', '#087f5b'], ['#ffd43b', '#a67c00'], ['#ff8787', '#c92a2a'], ['#74c0fc', '#1864ab']];
  let disp = {};            // player id -> square currently shown
  const toks = {};          // player id -> { el, tk }
  let paths = {};           // snake head square -> points from head to tail

  const rc = n => { const k = n - 1, row = Math.floor(k / 10), c = k % 10; return [row, row % 2 ? 9 - c : c]; };
  const xy = n => { const [row, col] = rc(n); return [GAP + col * (CS + GAP) + CS / 2, GAP + (9 - row) * (CS + GAP) + CS / 2]; };
  const f2 = v => v.toFixed(2);

  function snakePts(a, b, idx) {
    const [x1, y1] = xy(a), [x2, y2] = xy(b), dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), nx = -dy / len, ny = dx / len;
    const waves = Math.max(1.5, Math.round(len / 14) + .5), amp = Math.min(3.3, 1.5 + len / 38), N = 56, pts = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, env = Math.pow(Math.sin(Math.PI * t), .7);
      const o = Math.sin(t * waves * 2 * Math.PI) * amp * env * (idx % 2 ? -1 : 1);
      pts.push([x1 + dx * t + nx * o, y1 + dy * t + ny * o]);
    }
    return pts;
  }

  function drawLadder(a, b) {
    const [x1, y1] = xy(a), [x2, y2] = xy(b), dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, nx = -uy, ny = ux, w = 1.75;
    const line = (ax, ay, bx, by, sw, col) => `<line x1="${f2(ax)}" y1="${f2(ay)}" x2="${f2(bx)}" y2="${f2(by)}" stroke="${col}" stroke-width="${sw}"/>`;
    const parts = [];
    for (const [sw, col] of [[1.55, '#2a1706'], [.85, '#e8b267']]) {
      for (const s of [-1, 1]) parts.push(line(x1 + nx * w * s, y1 + ny * w * s, x2 + nx * w * s, y2 + ny * w * s, sw, col));
      const n = Math.max(2, Math.round(len / 3.4));
      for (let k = 1; k < n; k++) {
        const px = x1 + dx * k / n, py = y1 + dy * k / n;
        parts.push(line(px - nx * w, py - ny * w, px + nx * w, py + ny * w, sw * .8, col === '#e8b267' ? '#d39a4c' : col));
      }
    }
    return `<g class="ladder" data-foot="${a}">${parts.join('')}</g>`;
  }

  function drawSnake(a, b, idx) {
    const pts = paths[a] = snakePts(a, b, idx), [c1, c2] = SNAKE_COLORS[idx % SNAKE_COLORS.length], N = pts.length - 1;
    let outline = '', body = '', bands = '';
    for (let i = 0; i < N; i++) {
      const t = i / N, w = 3 - 2.1 * Math.pow(t, 1.25), p = pts[i], q = pts[i + 1];
      const at = `x1="${f2(p[0])}" y1="${f2(p[1])}" x2="${f2(q[0])}" y2="${f2(q[1])}"`;
      outline += `<line ${at} stroke="#120c1c" stroke-width="${f2(w + .9)}"/>`;
      body += `<line ${at} stroke="${c1}" stroke-width="${f2(w)}"/>`;
      if (i % 5 === 2 && i > 3) bands += `<line ${at} stroke="${c2}" stroke-width="${f2(w * .62)}"/>`;
    }
    // head: an oval pointing away from the body, with eyes and a forked tongue
    let hx = pts[0][0] - pts[3][0], hy = pts[0][1] - pts[3][1];
    const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
    const px = -hy, py = hx, cx = pts[0][0] + hx * .5, cy = pts[0][1] + hy * .5, ang = Math.atan2(hy, hx) * 180 / Math.PI;
    const eye = s => { const ex = cx + hx * .7 + px * 1.02 * s, ey = cy + hy * .7 + py * 1.02 * s; return `<circle cx="${f2(ex)}" cy="${f2(ey)}" r=".68" fill="#fff" stroke="#120c1c" stroke-width=".18"/><circle cx="${f2(ex + hx * .2)}" cy="${f2(ey + hy * .2)}" r=".32" fill="#120c1c"/>`; };
    const tx = cx + hx * 2.4, ty = cy + hy * 2.4;
    const tongue = `<path d="M${f2(tx)} ${f2(ty)} l${f2(hx * 1.3)} ${f2(hy * 1.3)} m0 0 l${f2(hx * .8 + px * .6)} ${f2(hy * .8 + py * .6)} m${f2(-hx * .8 - px * .6)} ${f2(-hy * .8 - py * .6)} l${f2(hx * .8 - px * .6)} ${f2(hy * .8 - py * .6)}" stroke="#ff4d6d" stroke-width=".36" fill="none"/>`;
    const head = `${tongue}<ellipse cx="${f2(cx)}" cy="${f2(cy)}" rx="2.6" ry="2.05" transform="rotate(${f2(ang)} ${f2(cx)} ${f2(cy)})" fill="${c1}" stroke="#120c1c" stroke-width=".45"/>${eye(1)}${eye(-1)}`;
    return `<g class="snake" data-head="${a}" style="transform-origin:${f2(cx)}px ${f2(cy)}px">${outline}${body}${bands}${head}</g>`;
  }

  function build(board) {
    paths = {};
    for (const k of Object.keys(toks)) delete toks[k];
    const foot = new Set(B.ladders.map(l => l[0])), head = new Set(B.snakes.map(s => s[0]));
    let h = '';
    for (let n = 1; n <= B.last; n++) {
      const [row, col] = rc(n);
      const cls = n === B.last ? 'goal' : n === 1 ? 'first' : foot.has(n) ? 'foot' : head.has(n) ? 'head' : '';
      h += `<div class="sc ${(row + col) % 2 ? 'b' : 'a'} ${cls}" data-n="${n}" style="grid-row:${10 - row};grid-column:${col + 1};--row:${row}"><span>${n}</span>${n === B.last ? '<i>🏆</i>' : n === 1 ? '<i>🏁</i>' : ''}</div>`;
    }
    h += `<svg class="slayer" viewBox="0 0 100 100" stroke-linecap="round">${B.ladders.map(l => drawLadder(l[0], l[1])).join('')}${B.snakes.map((s, i) => drawSnake(s[0], s[1], i)).join('')}</svg>`;
    h += '<div class="players" id="gtokens"></div>';
    board.innerHTML = h;
  }

  function sync() {
    const layer = $('#gtokens'), g = S.g, ids = new Set(S.players.map(p => p.id));
    for (const id of Object.keys(toks)) if (!ids.has(id)) { toks[id].el.remove(); delete toks[id]; }
    for (const p of S.players) {
      let t = toks[p.id];
      if (!t) {
        const el = document.createElement('div');
        el.className = 'pawn';
        el.innerHTML = '<div class="tk"></div>';
        layer.appendChild(el);
        t = toks[p.id] = { el, tk: el.firstChild };
      }
      t.el.style.setProperty('--c', p.color);
      t.tk.textContent = p.avatar;
      t.el.hidden = p.bankrupt;
      t.el.classList.toggle('turn', !!g && S.phase === 'playing' && !Race.playing && g.turn === p.id);
    }
    layout();
  }

  function layout() {
    const at = {};
    for (const id in toks) if (!toks[id].el.hidden) (at[disp[id] || 1] = at[disp[id] || 1] || []).push(toks[id]);
    for (const n in at) {
      const list = at[n], [x, y] = xy(+n), k = list.length, r = k > 1 ? (k > 4 ? 2.9 : 2.3) : 0;
      list.forEach((t, i) => {
        if (t.el.classList.contains('free')) return;
        const a = (i / k) * Math.PI * 2 - Math.PI / 2;
        t.el.style.left = x + r * Math.cos(a) + '%';
        t.el.style.top = y + r * Math.sin(a) + '%';
        t.el.style.setProperty('--s', k > 4 ? .62 : k > 1 ? .78 : 1);
      });
    }
  }

  function snap() {
    const g = S.g;
    disp = {};
    for (const p of S.players) disp[p.id] = g && g.pos[p.id] ? g.pos[p.id] : 1;
    sync();
  }

  function flash(n) {
    const el = $(`.sc[data-n="${n}"]`);
    if (!el) return;
    el.classList.remove('step'); void el.offsetWidth; el.classList.add('step');
  }

  async function ride(t, pts, ms) {
    t.el.classList.add('free');
    t.el.style.setProperty('--s', 1.15);
    await glide(t.el, pts, ms);
  }
  function settle(t, id, n) {
    disp[id] = n;
    t.el.classList.remove('free');
    layout();
  }

  async function play(ev, fast) {
    if (ev.k !== 'roll') return;
    await Race.roll(ev, fast);
    const p = P(ev.p), t = toks[ev.p], nm = Race.name(p);
    if (!t || !p) return;
    if (fast) { disp[ev.p] = ev.to; t.el.classList.remove('free'); layout(); return; }
    t.el.classList.add('moving');
    if (ev.over) {
      Race.say(`${nm} rolled <b class="num">${ev.die}</b> — needs exactly ${B.last - ev.from}`);
      SFX.bump(); shakeEl(t.tk);
      await sleep(900);
    }
    for (let s = ev.from + 1, k = 1; s <= ev.mid; s++, k++) {
      disp[ev.p] = s; layout(); hopEl(t.tk); flash(s); SFX.step(k);
      await sleep(175);
    }
    if (ev.mid !== ev.from) { squashEl(t.tk); SFX.land(); const [x, y] = xy(ev.mid); ringAt(x, y, p.color); await sleep(160); }
    if (ev.via === 'ladder') {
      Race.say(`🪜 ${nm} found a ladder!`);
      const lad = $(`.ladder[data-foot="${ev.mid}"]`);
      if (lad) { lad.classList.remove('glow'); void lad.getBoundingClientRect(); lad.classList.add('glow'); }
      await sleep(280);
      SFX.ladder();
      await ride(t, [xy(ev.mid), xy(ev.to)], 950);
      settle(t, ev.p, ev.to);
      const [x, y] = xy(ev.to);
      ringAt(x, y, '#69db7c'); popAt(x, y, '⬆'); squashEl(t.tk); SFX.coin();
      await sleep(300);
    } else if (ev.via === 'snake') {
      Race.say(`🐍 A snake got ${nm}!`);
      const sn = $(`.snake[data-head="${ev.mid}"]`);
      if (sn) { sn.classList.remove('bite'); void sn.getBoundingClientRect(); sn.classList.add('bite'); }
      SFX.hiss(); shakeEl(t.tk);
      await sleep(520);
      SFX.slide();
      await ride(t, paths[ev.mid] || [xy(ev.mid), xy(ev.to)], 1250);
      settle(t, ev.p, ev.to);
      const [x, y] = xy(ev.to);
      ringAt(x, y, '#ff6b6b'); popAt(x, y, '💫'); squashEl(t.tk); SFX.thud();
      const board = $('#gboard');
      if (board.animate) board.animate([{ transform: 'translate(0,0)' }, { transform: 'translate(-.5%, .4%)' }, { transform: 'translate(.4%, -.3%)' }, { transform: 'translate(0,0)' }], { duration: 240 });
      await sleep(320);
    }
    if (ev.to === B.last) {
      Race.say(`🏆 ${nm} reached ${B.last}!`);
      const [x, y] = xy(ev.to);
      SFX.home(); ringAt(x, y, '#ffd43b'); popAt(x, y, '🎉');
      await sleep(600);
    } else if (ev.again) {
      Race.say(`${nm} rolled a 6 — roll again!`);
      await sleep(380);
    }
    t.el.classList.remove('moving');
  }

  Race.register('snakes', {
    title: 'Snakes &amp; Ladders', cls: 'snakes', maxSeats: 8,
    toggles: [
      ['exactFinish', 'Exact roll to finish', 'You must roll the exact number to land on 100'],
      ['sixAgain', 'Roll again on a 6', 'Every 6 gives you another roll'],
      ['randomOrder', 'Random turn order', 'Shuffle who goes first'],
      ['playOn', 'Play for all places', 'Keep going after the winner to decide 2nd and 3rd'],
    ],
    build, snap, play, layout,
    info: p => `<small>square</small> ${disp[p.id] || 1}`,
    hint: (g, myTurn) => myTurn ? ROLL_HINT : '',
    rules: s => [
      'Everyone starts on square 1. Roll the die and move that many squares.',
      'Land on the foot of a <b>ladder</b> 🪜 to climb it. Land on the head of a <b>snake</b> 🐍 and you slide down to its tail.',
      s.sixAgain ? 'Rolling a <b>6</b> gives you another roll.' : 'One roll per turn, even on a 6.',
      s.exactFinish ? 'You need the <b>exact</b> number to land on 100 — otherwise you stay where you are.' : 'Any roll that reaches or passes 100 finishes.',
      s.playOn ? 'First to 100 wins; the others play on for the next places.' : 'First to 100 wins the game.',
    ],
  });
})();
