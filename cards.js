'use strict';
/* Shared by the card games (Teen Patti, Rummy): playing cards, the table with its seats,
   flying cards and chips, and their sounds. The engine around the table is Race in race.js.
   Every position on the table is in cqw, which here means "% of the table's width". */

const SUIT_CHAR = { S: '♠', H: '♥', D: '♦', C: '♣' };

Object.assign(SFX, {
  card() { noise(.05, .28, 0, 3400, 1.1); },
  shuffle() { for (let k = 0; k < 9; k++) noise(.035, .2, k * .06, 2600 + Math.random() * 1500, 1.4); },
  flip() { noise(.07, .22, 0, 2000, .9); tone(520, .08, 'triangle', .04, .02, 900); },
  chip() { tone(2300, .035, 'square', .035); tone(3100, .05, 'square', .03, .045); noise(.03, .12, 0, 5200, 3); },
  chips() { for (let k = 0; k < 5; k++) { tone(2100 + Math.random() * 1300, .04, 'square', .03, k * .07); noise(.03, .1, k * .07, 5000, 3); } },
  fold() { noise(.22, .2, 0, 700, .7); },
});

/* one playing card as HTML. c: 'QS0' style id, or null/'' for a face-down card */
function cardHTML(c, cls, attrs) {
  const a = attrs || '';
  if (!c) return `<div class="pc back ${cls || ''}" ${a}></div>`;
  if (c[0] === 'X') return `<div class="pc jk ${cls || ''}" data-c="${c}" ${a}><b>★</b><i>🃏</i></div>`;
  const rank = c[0] === 'T' ? '10' : c[0], s = SUIT_CHAR[c[1]];
  return `<div class="pc ${c[1] === 'H' || c[1] === 'D' ? 'red' : ''} ${cls || ''}" data-c="${c}" ${a}><b>${rank}</b><u>${s}</u><i>${s}</i></div>`;
}

const Table = {
  /* where the other players sit, by how many of them there are: [x, y] of the avatar centre */
  SPOTS: {
    0: [],
    1: [[50, 11]],
    2: [[24, 13], [76, 13]],
    3: [[13, 30], [50, 11], [87, 30]],
    4: [[12, 34], [32, 11], [68, 11], [88, 34]],
    5: [[11, 35], [27, 12], [50, 10], [73, 12], [89, 35]],
  },
  /* on a phone the table is taller, so the side seats, the middle and my own seat sit lower */
  SPOTS_TALL: {
    0: [],
    1: [[50, 11]],
    2: [[24, 13], [76, 13]],
    3: [[13, 36], [50, 11], [87, 36]],
    4: [[12, 40], [32, 11], [68, 11], [88, 40]],
    5: [[11, 42], [27, 12], [50, 10], [73, 12], [89, 42]],
  },
  ME: [13, 66.5],
  CENTER: [50, 41],
  pos: {},              // player id -> [x, y]

  /* phones get a taller table so the hand has room for two rows */
  tall() { return window.innerWidth < 800; },

  build(board) {
    board.innerHTML = '<div class="felt"></div><div id="gcenter"></div><div id="gseats"></div><div id="gmsg" hidden></div><div id="ghand"></div><div class="players" id="gtokens"></div>';
  },

  /* players in seating order, starting with me (or the first player when I am only watching) */
  ring() {
    const ids = S.g ? S.g.order.slice() : S.players.map(p => p.id);
    const list = ids.map(P).filter(Boolean);
    const k = Math.max(0, list.findIndex(p => p.id === me));
    return list.slice(k).concat(list.slice(0, k));
  },

  /* draw every seat. info(p) -> { sub, badge, cards (html), bet, cls } */
  seats(info) {
    const board = $('#gboard');
    const tall = this.tall();
    board.classList.toggle('tall', tall);
    this.ME = [13, tall ? 76 : 66.5];
    this.CENTER = [50, tall ? 49 : 41];
    const ring = this.ring(), spots = (tall ? this.SPOTS_TALL : this.SPOTS)[Math.min(5, ring.length - 1)] || [];
    this.pos = {};
    let h = '';
    ring.forEach((p, k) => {
      const mine = k === 0, [x, y] = mine ? this.ME : (spots[k - 1] || [50, 11]);
      this.pos[p.id] = [x, y];
      const s = info(p) || {};
      h += `<div class="seat ${mine ? 'mine' : ''} ${s.cls || ''}" data-id="${p.id}" style="left:${x}cqw;top:${y}cqw;--c:${p.color}">
        <div class="sav">${p.avatar}${s.badge ? `<em>${s.badge}</em>` : ''}</div>
        <div class="snm">${esc(p.name)}${p.id === me ? ' <small>you</small>' : ''}</div>
        ${s.sub ? `<div class="ssub">${s.sub}</div>` : ''}
        ${s.cards ? `<div class="scards">${s.cards}</div>` : ''}
        ${s.bet ? `<div class="sbet">bet ${s.bet}</div>` : ''}
      </div>`;
    });
    setHTML($('#gseats'), h);
  },

  /* a point between a seat and the middle of the table, where that player's chips or cards land */
  toward(pid, f) {
    const [x, y] = this.pos[pid] || this.CENTER, [cx, cy] = this.CENTER;
    return [x + (cx - x) * f, y + 3 + (cy - y - 3) * f];
  },

  /* fly a piece of HTML from one point to another */
  fly(html, from, to, ms, cls) {
    const layer = $('#gtokens');
    if (!layer) return Promise.resolve();
    const el = document.createElement('div');
    el.className = 'flyer ' + (cls || '');
    el.innerHTML = html;
    el.style.left = from[0] + 'cqw'; el.style.top = from[1] + 'cqw';
    el.style.transitionDuration = ms + 'ms';
    layer.appendChild(el);
    void el.offsetWidth;
    el.style.left = to[0] + 'cqw'; el.style.top = to[1] + 'cqw';
    el.classList.add('go');
    return sleep(ms).then(() => el.remove());
  },

  async chips(from, to, n) {
    const all = [];
    for (let k = 0; k < n; k++) {
      all.push(this.fly('<i class="chipc"></i>', [from[0] + (Math.random() - .5) * 3, from[1] + (Math.random() - .5) * 3], to, 380));
      await sleep(55);
    }
    await Promise.all(all);
  },

  ring1(pid, color) {
    const [x, y] = this.pos[pid] || this.CENTER, r = document.createElement('i');
    r.className = 'ring'; r.style.left = x + 'cqw'; r.style.top = y + 'cqw'; r.style.setProperty('--c', color || '#fff');
    $('#gtokens').appendChild(r);
    setTimeout(() => r.remove(), 700);
  },

  pop(at, text) {
    const f = document.createElement('div');
    f.className = 'gpop'; f.textContent = text; f.style.left = at[0] + 'cqw'; f.style.top = at[1] + 'cqw';
    $('#gtokens').appendChild(f);
    setTimeout(() => f.remove(), 900);
  },

  msg(html) {
    const el = $('#gmsg');
    el.hidden = !html;
    setHTML(el, html || '');
  },
};

const coins = n => '🪙 ' + Math.floor(n).toLocaleString('en-US');
