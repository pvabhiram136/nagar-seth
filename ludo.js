'use strict';
/* Ludo — board drawing and animation. Rules are in game_ludo.py; shared engine in race.js.
   A token's place is its progress along its own colour's route: -1 yard, 0..50 shared track,
   51..55 home column, 56 home. Seats go clockwise: 0 red (top left), 1 green, 2 yellow, 3 blue. */
(() => {
  const GAP = .35, CS = (100 - 16 * GAP) / 15;         // board units are % of the board's width
  const at = k => GAP + k * (CS + GAP) + CS / 2;       // centre of row / column k (k may be fractional)
  const TRACK = [];                                    // the 52 shared squares as [row, col], from red's start square
  (() => {
    const add = (r, c) => TRACK.push([r, c]);
    for (let c = 1; c <= 5; c++) add(6, c);
    for (let r = 5; r >= 0; r--) add(r, 6);
    add(0, 7); add(0, 8);
    for (let r = 1; r <= 5; r++) add(r, 8);
    for (let c = 9; c <= 14; c++) add(6, c);
    add(7, 14); add(8, 14);
    for (let c = 13; c >= 9; c--) add(8, c);
    for (let r = 9; r <= 14; r++) add(r, 8);
    add(14, 7); add(14, 6);
    for (let r = 13; r >= 9; r--) add(r, 6);
    for (let c = 5; c >= 0; c--) add(8, c);
    add(7, 0); add(6, 0);
  })();
  const YARD = [[2.5, 2.5], [2.5, 11.5], [11.5, 11.5], [11.5, 2.5]];       // yard centres [row, col]
  const SPOT = [[-1.05, -1.05], [-1.05, 1.05], [1.05, -1.05], [1.05, 1.05]];
  const homeCol = (seat, k) => [[7, k], [k, 7], [7, 14 - k], [14 - k, 7]][seat];   // k = 1..5
  const HOME_AT = [[7, 6.2], [6.2, 7], [7, 7.8], [7.8, 7]];

  let disp = {};            // player id -> [progress of each token] as currently shown
  let seats = {};           // player id -> seat
  const toks = {};          // 'pid:i' -> { el, tk, pid, i }

  /* where a token stands: [row, col, key]; tokens with the same key share a square and are fanned out */
  function place(seat, r, i, n) {
    if (r < 0) return [YARD[seat][0] + SPOT[i % 4][0], YARD[seat][1] + SPOT[i % 4][1], null];
    if (r <= B.trackEnd) { const [row, col] = TRACK[(13 * seat + r) % B.ring]; return [row, col, row + ',' + col]; }
    if (r < B.home) { const [row, col] = homeCol(seat, r - B.trackEnd); return [row, col, row + ',' + col]; }
    const off = (i - (n - 1) / 2) * .42, [row, col] = HOME_AT[seat];
    return seat % 2 ? [row, col + off, null] : [row + off, col, null];
  }
  const pos = (seat, r, i, n) => { const [row, col] = place(seat, r, i, n); return [at(col), at(row)]; };

  function build(board) {
    for (const k of Object.keys(toks)) delete toks[k];
    const sc = B.seatColors;
    const cell = (r, c, cls, style, inner) => `<div class="lc ${cls}" style="grid-row:${r + 1};grid-column:${c + 1};${style || ''}">${inner || ''}</div>`;
    let h = '';
    YARD.forEach(([r, c], k) => {
      h += `<div class="yard" data-seat="${k}" style="grid-row:${r - 1.5}/span 6;grid-column:${c - 1.5}/span 6;--c:${sc[k]}"><div class="ylabel ${k > 1 ? 'low' : ''}"></div><div class="yin"></div></div>`;
    });
    TRACK.forEach(([r, c], idx) => {
      const start = idx % 13 === 0, star = !start && B.safe.includes(idx);
      h += cell(r, c, start ? 'start' : star ? 'star' : '', start ? `--c:${sc[idx / 13]}` : '', start || star ? '<i>★</i>' : '');
    });
    for (let k = 0; k < 4; k++) for (let j = 1; j <= 5; j++) { const [r, c] = homeCol(k, j); h += cell(r, c, 'lane', `--c:${sc[k]}`); }
    h += `<div class="lhome" style="grid-row:7/span 3;grid-column:7/span 3;background:conic-gradient(from -45deg, ${sc[1]} 0 90deg, ${sc[2]} 0 180deg, ${sc[3]} 0 270deg, ${sc[0]} 0)"><i>🏠</i></div>`;
    h += '<div class="players" id="gspots">';
    YARD.forEach(([r, c], k) => SPOT.forEach(([dr, dc]) => { h += `<i class="yspot" style="left:${at(c + dc)}%;top:${at(r + dr)}%;--c:${sc[k]}"></i>`; }));
    h += '</div><div class="players" id="gtokens"></div>';
    board.innerHTML = h;
  }

  function sync() {
    const layer = $('#gtokens'), g = S.g, live = new Set();
    const idle = !Race.playing && S.phase === 'playing';
    const canMove = idle && g.turn === me && g.turnPhase === 'move' && !Race.pending;
    for (const p of S.players) {
      const arr = disp[p.id] || [];
      arr.forEach((r, i) => {
        const key = p.id + ':' + i;
        live.add(key);
        let t = toks[key];
        if (!t) {
          const el = document.createElement('div');
          el.className = 'pawn lt';
          el.innerHTML = '<div class="tk"></div>';
          layer.appendChild(el);
          t = toks[key] = { el, tk: el.firstChild, pid: p.id, i };
        }
        t.el.style.setProperty('--c', p.color);
        t.el.hidden = p.bankrupt && S.phase !== 'lobby';
        const can = canMove && p.id === me && g.movable.includes(i);
        t.el.classList.toggle('can', can);
        if (can) { t.el.dataset.act = 'move'; t.el.dataset.v = i; } else { delete t.el.dataset.act; delete t.el.dataset.v; }
      });
    }
    for (const key of Object.keys(toks)) if (!live.has(key)) { toks[key].el.remove(); delete toks[key]; }
    // yards: who sits where, and whose turn it is
    const bySeat = {};
    for (const p of S.players) if (seats[p.id] != null) bySeat[seats[p.id]] = p;
    document.querySelectorAll('#gboard .yard').forEach(y => {
      const p = bySeat[+y.dataset.seat];
      const rank = p && g ? g.ranks.indexOf(p.id) : -1;
      y.classList.toggle('empty', !p || (p.bankrupt && S.phase !== 'lobby'));
      y.classList.toggle('turn', !!p && idle && g.turn === p.id);
      setHTML($('.ylabel', y), p ? `${p.avatar} ${esc(p.name)}${p.id === me ? ' <small>you</small>' : ''}${rank >= 0 && !Race.playing ? ' ' + (MEDALS[rank] || '') : ''}` : '');
    });
    layout();
  }

  function layout() {
    const groups = {};
    for (const key in toks) {
      const t = toks[key], arr = disp[t.pid];
      if (!arr || t.el.hidden) continue;
      const [row, col, gk] = place(seats[t.pid], arr[t.i], t.i, arr.length);
      t.x = at(col); t.y = at(row);
      if (gk) (groups[gk] = groups[gk] || []).push(t);
      else { t.el.style.left = t.x + '%'; t.el.style.top = t.y + '%'; t.el.style.setProperty('--s', arr[t.i] === B.home ? .7 : 1); }
    }
    for (const gk in groups) {
      const list = groups[gk], k = list.length, r = k > 1 ? (k > 3 ? 1.75 : 1.45) : 0;
      list.forEach((t, j) => {
        const a = (j / k) * Math.PI * 2 - Math.PI / 4;
        t.el.style.left = t.x + r * Math.cos(a) + '%';
        t.el.style.top = t.y + r * Math.sin(a) + '%';
        t.el.style.setProperty('--s', k > 3 ? .6 : k > 1 ? .74 : 1);
      });
    }
  }

  function snap() {
    const g = S.g;
    disp = {}; seats = {};
    for (const p of S.players) {
      seats[p.id] = g ? g.seat[p.id] : B.seatColors.indexOf(p.color);
      disp[p.id] = g && g.tokens[p.id] ? g.tokens[p.id].slice() : Array(S.settings.tokens).fill(-1);
    }
    sync();
  }

  /* light up the yard of the player whose move is being shown */
  function markYard(pid) {
    document.querySelectorAll('#gboard .yard').forEach(y => y.classList.toggle('turn', pid != null && +y.dataset.seat === seats[pid]));
  }

  async function play(ev, fast) {
    const p = P(ev.p), nm = Race.name(p);
    if (!fast) markYard(ev.p);
    if (ev.k === 'roll') {
      await Race.roll(ev, fast);
      if (fast) return;
      if (ev.three) { Race.say(`${nm} rolled three 6s — turn lost!`); SFX.bump(); await sleep(900); }
      else if (!ev.n) { Race.say(`${nm} rolled <b class="num">${ev.die}</b> — no move${ev.die === 6 ? ', rolls again' : ''}`); SFX.bump(); await sleep(620); }
      return;
    }
    if (ev.k !== 'move') return;
    const t = toks[ev.p + ':' + ev.i], arr = disp[ev.p];
    if (!arr) return;
    if (fast || !t || !p) {
      arr[ev.i] = ev.to;
      for (const c of ev.caps) if (disp[c.p]) disp[c.p][c.i] = -1;
      return layout();
    }
    const seat = seats[ev.p];
    t.el.classList.add('moving');
    if (ev.from === -1) {
      Race.say(`${nm} brings a token out!`);
      SFX.out();
      t.el.classList.add('fly');
      arr[ev.i] = 0; layout();
      await sleep(430);
      t.el.classList.remove('fly');
    } else {
      for (let s = ev.from + 1, k = 1; s <= ev.to; s++, k++) {
        arr[ev.i] = s; layout(); hopEl(t.tk); SFX.step(k);
        await sleep(175);
      }
    }
    const [x, y] = pos(seat, ev.to, ev.i, arr.length);
    squashEl(t.tk); SFX.land(); ringAt(x, y, p.color);
    await sleep(150);
    for (const c of ev.caps) {
      const q = P(c.p), ct = toks[c.p + ':' + c.i];
      Race.say(`💥 ${nm} sends ${Race.name(q)} back!`);
      SFX.capture(); popAt(x, y, '💥');
      const board = $('#gboard');
      if (board.animate) board.animate([{ transform: 'translate(0,0)' }, { transform: 'translate(-.6%, .4%)' }, { transform: 'translate(.5%, -.4%)' }, { transform: 'translate(0,0)' }], { duration: 260 });
      if (disp[c.p]) disp[c.p][c.i] = -1;
      if (ct) ct.el.classList.add('back');
      layout();
      await sleep(700);
      if (ct) { ct.el.classList.remove('back'); squashEl(ct.tk); }
    }
    if (ev.to === B.home) {
      Race.say(`🏠 ${nm} got a token home!`);
      SFX.home(); ringAt(x, y, '#fff'); popAt(x, y, '⭐');
      if (t.tk.animate) t.tk.animate([{ transform: 'rotate(0) scale(1.6)' }, { transform: 'rotate(360deg) scale(1)' }], { duration: 600, easing: 'ease-out' });
      await sleep(650);
    }
    t.el.classList.remove('moving');
  }

  const homeCount = p => (disp[p.id] || []).filter(r => r === B.home).length;

  Race.register('ludo', {
    title: 'Ludo', cls: 'ludo', maxSeats: 4,
    selects: [['tokens', 'Tokens each', [[4, '4 (classic)'], [2, '2 (quick game)']]]],
    toggles: [
      ['quickStart', 'Quick start', 'Everyone begins with one token already on the board'],
      ['autoMove', 'Move automatically', 'When only one move is possible it is played for you'],
      ['randomOrder', 'Random first player', 'Otherwise red starts; turns always go clockwise'],
      ['playOn', 'Play for all places', 'Keep going after the winner to decide 2nd and 3rd'],
    ],
    build, snap, play, layout,
    info: p => `🏠 ${homeCount(p)}/${(disp[p.id] || []).length}`,
    hint(g, myTurn, cur) {
      if (g.turnPhase === 'move') return myTurn ? `You rolled ${g.die} — tap a glowing token` : `${cur ? esc(cur.name) : 'Player'} rolled ${g.die} and is choosing…`;
      return myTurn ? ROLL_HINT : '';
    },
    rules: s => [
      `Each player has <b>${s.tokens} tokens</b>. Get all of them round the board and into the centre to win.`,
      'Roll a <b>6</b> to bring a token out of your yard onto your start square.' + (s.quickStart ? ' Everyone starts with one token already out.' : ''),
      'A <b>6</b>, a <b>capture</b>, or getting a token <b>home</b> gives you another roll. Three 6s in a row and you lose the turn.',
      'Land on an opponent to send their token back to its yard. Squares marked <b>★</b> are safe — nobody can be captured there.',
      'You need the <b>exact</b> number to enter the centre.',
      s.playOn ? 'After the winner, the others play on for the next places.' : 'The first player to get every token home wins.',
    ],
  });
})();
