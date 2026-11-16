'use strict';
/* Rummy (Indian 13-card) — table drawing and animation. Rules are in game_rummy.py; shared table
   code in cards.js and the engine in race.js. The server arranges every hand into its best melds,
   so the hand below is always shown grouped: nobody has to drag cards around. */
(() => {
  let D = null;             // what the table shows right now (follows the events one by one)
  let sel = null;           // the card I have tapped

  const GROUP = { pure: ['Pure sequence', 'ok pure'], seq: ['Sequence', 'ok'], set: ['Set', 'ok'], joker: ['Joker', 'jk'], loose: ['Not grouped', 'bad'] };
  const rankName = r => ({ A: 'Ace', T: '10', J: 'Jack', Q: 'Queen', K: 'King' }[r] || r);
  const isWild = c => !!D && c[0] !== 'X' && c[0] === D.wild;

  function snap() {
    const g = S.g;
    D = g ? { counts: Object.assign({}, g.counts), total: Object.assign({}, g.total), active: g.active.slice(), dropped: Object.assign({}, g.dropped),
      openTop: g.openTop, deckCount: g.deckCount, wild: g.wild, wildCard: g.wildCard, result: g.result, dealer: g.dealer, deal: g.deal } : null;
    draw();
  }

  /* my hand: positions for every card, one row on wide tables and two rows on phones */
  function handHTML() {
    const you = S.you;
    if (!you || !you.groups) return '';
    const groups = you.groups.filter(gr => gr[1].length);
    const n = groups.reduce((a, gr) => a + gr[1].length, 0);
    if (!groups.some(gr => gr[1].includes(sel))) sel = null;
    const tall = Table.tall(), gap = 1.8;
    let rows = [groups];
    if (tall) {                                   // split the groups over two rows of similar length
      const first = [];
      let count = 0;
      for (const gr of groups) { if (count >= n / 2 && first.length) break; first.push(gr); count += gr[1].length; }
      rows = [first, groups.slice(first.length)].filter(r => r.length);
    }
    const cw = tall ? 12.4 : 9.4, ch = cw * 1.42, rowGap = ch + 5.2;
    let h = '';
    rows.forEach((row, ri) => {
      const cards = row.reduce((a, gr) => a + gr[1].length, 0);
      // groups sit side by side; inside a group the cards overlap by whatever it takes to fit the row
      const G = row.length, step = Math.min(cw * (tall ? .86 : .72), (94 - G * cw - (G - 1) * gap) / Math.max(1, cards - G));
      const width = G * cw + (cards - G) * step + (G - 1) * gap;
      let x = (100 - width) / 2;
      const y = 1.6 + ri * rowGap;
      row.forEach(([type, list]) => {
        const x0 = x;
        list.forEach(c => {
          const cls = 'hc' + (c === sel ? ' sel' : '') + (c === you.fresh ? ' fresh' : '') + (isWild(c) ? ' wild' : '');
          h += cardHTML(c, cls, `data-act="pick" data-v="${c}" style="--cw:${cw}cqw;left:${x.toFixed(2)}cqw;top:${y}cqw"`);
          x += step;
        });
        x += cw - step;
        const [label, cls] = GROUP[type] || GROUP.loose;
        h += `<span class="glabel ${cls}" style="left:${((x0 + x) / 2).toFixed(2)}cqw;top:${(y + ch + .7).toFixed(2)}cqw">${label}</span>`;
        x += gap;
      });
    });
    return h;
  }

  const tiny = groups => (groups || []).map(([type, list]) => `<span class="tg ${(GROUP[type] || GROUP.loose)[1]}">${list.map(c => cardHTML(c, 'tiny' + (isWild(c) ? ' wild' : ''))).join('')}</span>`).join('');

  function resultHTML(r) {
    const w = r.winner && P(r.winner);
    const ids = S.g.order.filter(id => r.rows[id]);
    return `<div class="rres"><h4>Deal ${r.deal} — ${w ? esc(w.name) + ' wins' : 'called off'}</h4>${ids.map(id => {
      const p = P(id), row = r.rows[id];
      if (!p) return '';
      return `<div class="rrow ${id === r.winner ? 'win' : ''}"><span class="chip mini" style="--c:${p.color}">${p.avatar}</span><b>${esc(p.name)}</b>
        <div class="rcards">${row.dropped ? '<i>dropped</i>' : tiny(row.groups)}</div><em>${id === r.winner ? '🏆' : '+' + row.pts}</em></div>`;
    }).join('')}</div>`;
  }

  function draw() {
    const g = S.g, idle = !Race.playing;
    const turnId = !g ? null : idle ? (S.phase === 'playing' ? turn(g) : null) : Race.shownTurn;
    Table.seats(p => {
      if (!D) return { sub: 'ready' };
      const active = D.active.includes(p.id), dropped = p.id in D.dropped;
      let badge = '', cls = '';
      if (p.bankrupt) { badge = 'Left'; cls = 'out'; }
      else if (D.result && D.result.winner === p.id) { badge = 'Winner'; cls = 'won'; }
      else if (dropped) { badge = 'Dropped'; cls = 'packed'; }
      if (turnId === p.id) cls += ' turn';
      const n = D.counts[p.id] || 0;
      return { sub: (D.total[p.id] || 0) + ' pts', badge: (p.id === D.dealer ? 'Ⓓ ' : '') + badge, cls,
        cards: p.id !== me && active && n && !D.result ? `<span class="fan">${cardHTML(null, 'mini').repeat(3)}<b>${n}</b></span>` : '' };
    });

    const myTurn = !!g && idle && S.phase === 'playing' && g.turn === me;
    const canDraw = myTurn && g.turnPhase === 'draw' && !Race.pending, canDrop = myTurn && g.turnPhase === 'discard' && !!sel;
    setHTML($('#gcenter'), !D ? '<div class="pot empty"><b>Rummy</b><small>13 cards · two sequences, one of them pure</small></div>'
      : `<div class="piles">
          <div class="pile1"><small>Joker</small>${D.wildCard ? cardHTML(D.wildCard, 'mid') : ''}<span>${D.wildCard && D.wildCard[0] === 'X' ? 'Aces' : rankName(D.wild) + 's'} are wild</span></div>
          <div class="pile1 ${canDraw ? 'can' : ''}" data-act="draw" data-v="deck"><small>Deck</small><div class="stack">${cardHTML(null, 'mid')}</div><span>${D.deckCount} left</span></div>
          <div class="pile1 ${canDraw && D.openTop ? 'can' : ''} ${canDrop ? 'drop' : ''}" data-act="${canDrop ? 'discardSel' : 'draw'}" data-v="open"><small>Open pile</small>${D.openTop ? cardHTML(D.openTop, 'mid' + (isWild(D.openTop) ? ' wild' : '')) : '<div class="pc mid slot"></div>'}<span>${canDrop ? 'throw here' : canDraw && D.openTop ? 'take it' : '&nbsp;'}</span></div>
        </div>`);

    const showHand = !!D && !D.result && S.phase === 'playing';
    setHTML($('#ghand'), showHand ? handHTML() : '');
    const m = mine();
    if (showHand && m && !S.you) setHTML($('#ghand'), `<div class="hlabel dim">${m.bankrupt ? 'You left this game' : 'You dropped this deal'}</div>`);
    Table.msg(D && D.result ? resultHTML(D.result) : '');
    $('#gmsg').classList.toggle('big', !!(D && D.result));
  }

  const spot = pid => pid === me ? [50, 82] : Table.toward(pid, .08);

  async function play(ev, fast) {
    const p = P(ev.p), nm = Race.name(p);
    if (!D) snap();
    const DECK = [50, Table.CENTER[1]], OPEN = [66, Table.CENTER[1]];
    switch (ev.k) {
      case 'deal': {
        sel = null;
        D = { counts: {}, total: D.total, active: ev.players.slice(), dropped: {}, openTop: null, deckCount: 106, wild: ev.wild[0] === 'X' ? 'A' : ev.wild[0],
          wildCard: null, result: null, dealer: ev.dealer, deal: ev.deal };
        draw();
        if (!fast) {
          Race.say(`Deal ${ev.deal} — shuffling…`); SFX.shuffle();
          await sleep(550);
          for (let r = 0; r < 5; r++) {
            for (const pid of ev.players) { SFX.card(); Table.fly(cardHTML(null, 'mini'), DECK, spot(pid), 250, 'cardfly'); await sleep(45); }
            for (const pid of ev.players) D.counts[pid] = Math.min(13, (r + 1) * 3);
          }
          await sleep(250);
        }
        for (const pid of ev.players) D.counts[pid] = 13;
        D.deckCount = 106 - 13 * ev.players.length - 2;
        D.wildCard = ev.wild; D.openTop = ev.open;
        draw();
        if (!fast) {
          SFX.flip();
          Race.say(`The joker is the <b class="num">${ev.wild[0] === 'X' ? 'Ace' : rankName(ev.wild[0])}</b>`);
          await sleep(900);
        }
        break;
      }
      case 'draw':
        if (ev.src === 'open') D.openTop = ev.top || null; else D.deckCount = Math.max(0, D.deckCount - 1);
        if (!fast) {
          Race.say(`${nm} takes ${ev.src === 'open' ? 'the open card' : 'a card from the deck'}`);
          SFX.card();
          draw();
          await Table.fly(cardHTML(ev.src === 'open' ? ev.card : null, 'mini'), ev.src === 'open' ? OPEN : DECK, spot(ev.p), 300, 'cardfly');
        }
        D.counts[ev.p] = (D.counts[ev.p] || 0) + 1;
        draw();
        if (!fast) await sleep(120);
        break;
      case 'discard':
        D.counts[ev.p] = Math.max(0, (D.counts[ev.p] || 0) - 1);
        if (!fast) {
          Race.say(`${nm} throws a card away`);
          SFX.card();
          draw();
          await Table.fly(cardHTML(ev.card, 'mini'), spot(ev.p), OPEN, 300, 'cardfly');
        }
        D.openTop = ev.card;
        draw();
        if (!fast) await sleep(150);
        break;
      case 'declare':
        D.counts[ev.p] = 13;
        if (!fast) {
          Race.say(`🃏 ${nm} declares!`);
          SFX.home();
          Table.ring1(ev.p, p ? p.color : '#fff');
          Table.pop(Table.pos[ev.p] || Table.CENTER, '🃏');
          await sleep(1100);
        }
        break;
      case 'fold':
        D.active = D.active.filter(x => x !== ev.p);
        D.dropped[ev.p] = ev.pts;
        if (!fast) { Race.say(`${nm} drops this deal (+${ev.pts} points)`); SFX.fold(); }
        draw();
        if (!fast) await sleep(600);
        break;
      case 'reshuffle':
        if (!fast) { Race.say('The open pile is shuffled back into the deck'); SFX.shuffle(); await sleep(700); }
        break;
      case 'dealend': {
        for (const id in ev.rows) D.total[id] = (D.total[id] || 0) + ev.rows[id].pts;
        D.result = ev;
        const w = ev.winner && P(ev.winner);
        if (!fast) { Race.say(w ? `🏆 ${Race.name(w)} wins deal ${ev.deal}` : `Deal ${ev.deal} is called off`); SFX.coin(); }
        draw();
        if (!fast) await sleep(1600);
        break;
      }
    }
  }

  const turn = g => g.turnPhase === 'draw' || g.turnPhase === 'discard' ? g.turn : null;

  function hud(g, myTurn, cur) {
    const you = S.you, m = mine();
    const pts = you ? `your hand: ${you.points} point${you.points === 1 ? '' : 's'} outside groups` : '';
    let t = '', a = '';
    if (g.turnPhase === 'between') {
      const w = g.result && g.result.winner && P(g.result.winner);
      t = `<b>${w ? esc(w.name) + ' won deal ' + g.deal : 'Deal ' + g.deal + ' was called off'}</b><small>The next deal starts in a moment…</small>`;
      a = isHost() ? '<button class="btn green" data-act="next">Deal now</button>' : '';
    } else if (myTurn && g.turnPhase === 'draw') {
      t = `<span class="myturn">Your turn — take a card</span><small>Tap the deck or the open card · ${pts}</small>`;
      a = `<button class="btn" data-act="drop">Drop (+${you ? you.dropCost : 20})</button>`;
    } else if (myTurn && you) {
      const ready = you.canDeclare;
      t = ready ? '<span class="myturn">Your hand is complete!</span><small>Declare to win this deal</small>'
        : `<span class="myturn">Now throw one card away</span><small>Tap a card, then Discard · ${pts}</small>`;
      a = (ready ? '<button class="btn green" data-act="declare">🏆 Declare</button>' : '')
        + `<button class="btn primary" data-act="discardSel" ${sel && sel !== you.drew ? '' : 'disabled'}>Discard</button>`;
    } else {
      t = cur ? `${Race.name(cur)}'s turn${cur.bot ? ' 🤖' : ''}` : '';
      t += `<small>${m && !you ? (m.bankrupt ? 'You left this game' : 'You dropped this deal') : pts}</small>`;
    }
    return { t, a };
  }

  function click(k, v) {
    if (k === 'pick') {
      sel = sel === v ? null : v;
      tone(sel ? 760 : 520, .04, 'triangle', .05);
      if (S && !Race.playing) { draw(); Race.hud(); }
      return true;
    }
    if (k === 'discardSel') {
      if (!sel) return true;
      if (S.you && sel === S.you.drew) { toast('You cannot throw away the card you just picked from the open pile'); return true; }
      const c = sel;
      sel = null;
      Race.send('discard', { c });
      return true;
    }
    if (k === 'draw') { Race.send('draw', { src: v }); return true; }
    if (k === 'drop') { if (confirm('Drop this deal? You take the penalty points and sit out until the next deal.')) Race.send('drop'); return true; }
    if (k === 'declare' || k === 'next') { Race.send(k); return true; }
    if (k === 'endGame') { if (confirm('End the game now? Whoever has the fewest points wins.')) act('endGame'); return true; }
    return false;
  }

  Race.register('rummy', {
    title: 'Rummy', cls: 'ctable rummy', maxSeats: 6, noDie: true, hostEnd: true, resize: true,
    selects: [['deals', 'Number of deals', B => B.dealOptions.map(v => [v, v + (v === 1 ? ' deal' : ' deals')])]],
    toggles: [['randomOrder', 'Random seats', 'Shuffle who sits where']],
    build: b => Table.build(b), snap, play, layout: draw, turn, hud, click,
    info: p => (D ? D.total[p.id] || 0 : 0) + ' pts',
    hint: () => '',
    rules: s => [
      'Everyone gets <b>13 cards</b>. On your turn take one card (from the deck or the open pile), then throw one away.',
      'Arrange your hand into <b>sequences</b> (3 or more cards in a row of one suit) and <b>sets</b> (3 or 4 cards of the same rank in different suits).',
      'You need at least <b>two sequences</b>, and one must be <b>pure</b> (no joker standing in). Then all 13 cards must be in groups and you can <b>declare</b>.',
      'The card turned up next to the deck picks the <b>wild joker</b> for the deal: every card of that rank, and the printed jokers, can stand in for any card. They are marked ★.',
      'Your hand is sorted into its best groups for you, with labels underneath.',
      'The winner of a deal scores 0. Everyone else scores the cards outside their groups: face cards and aces 10, others their number, jokers 0, at most 80. No pure sequence: every card counts.',
      '<b>Drop</b> at the start of your turn to sit a deal out: 20 points before your first turn, 40 after.',
      `After ${s.deals} deal${s.deals === 1 ? '' : 's'} the <b>lowest</b> total wins.`,
    ],
  });
})();
