'use strict';
/* Teen Patti — table drawing and animation. Rules are in game_teenpatti.py; shared table code in
   cards.js and the engine in race.js. Play chips only: there is no real money anywhere. */
(() => {
  /* D is what the table shows right now. It follows the events one by one, so it can be a little
     behind the true state in S.g while animations are playing. */
  let D = null;

  const RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
  const val = c => RANK[c[0]] || +c[0];
  function handName(cards) {
    const v = cards.map(val).sort((a, b) => b - a), flush = new Set(cards.map(c => c[1])).size === 1;
    const seq = (v[0] - v[1] === 1 && v[1] - v[2] === 1) || (v[0] === 14 && v[1] === 3 && v[2] === 2);
    if (v[0] === v[2]) return 'Trail';
    if (seq && flush) return 'Pure sequence';
    if (seq) return 'Sequence';
    if (flush) return 'Colour';
    if (v[0] === v[1] || v[1] === v[2]) return 'Pair';
    return 'High card';
  }

  function snap() {
    const g = S.g;
    D = g ? { chips: Object.assign({}, g.chips), bets: Object.assign({}, g.bets), inhand: g.inhand.slice(), seen: Object.assign({}, g.seen),
      pot: g.pot, stake: g.stake, boot: g.boot, result: g.result, dealer: g.dealer, hand: g.handNo } : null;
    draw();
  }

  function draw() {
    const g = S.g, idle = !Race.playing;
    const turnId = !g ? null : idle ? (S.phase === 'playing' ? turn(g) : null) : Race.shownTurn;
    const you = S.you || {};
    Table.seats(p => {
      if (!D) return { sub: coins(S.settings.chips) };
      const inh = D.inhand.includes(p.id), res = D.result, shown = res && res.shown && res.shown[p.id];
      const peek = you.peek && you.peek.p === p.id && !res ? you.peek.cards : null;
      let badge = '', cls = '', cards = '';
      if (res && res.winners.includes(p.id)) { badge = 'Winner'; cls = 'won'; }
      else if (p.bankrupt) { badge = 'Out'; cls = 'out'; }
      else if (!inh) { badge = 'Packed'; cls = 'packed'; }
      else if (D.chips[p.id] === 0) badge = 'All in';
      else badge = D.seen[p.id] ? 'Seen' : 'Blind';
      if (p.id !== me) {                               // my own cards are drawn large at the bottom
        if (shown) cards = shown.map(c => cardHTML(c, 'mini')).join('') + `<span class="hname">${res.names[p.id]}</span>`;
        else if (peek) cards = peek.map(c => cardHTML(c, 'mini')).join('') + '<span class="hname">side show</span>';
        else if (inh) cards = cardHTML(null, 'mini').repeat(3);
      }
      if (turnId === p.id) cls += ' turn';
      return { sub: coins(D.chips[p.id] || 0), badge: (p.id === D.dealer ? 'Ⓓ ' : '') + badge, cards, cls,
        bet: D.bets[p.id] && !res ? coins(D.bets[p.id]) : '' };
    });

    setHTML($('#gcenter'), !D ? '<div class="pot empty"><b>Teen Patti</b><small>3 cards · best hand wins the pot</small></div>'
      : `<div class="pot ${D.pot ? '' : 'empty'}"><div class="pile">${'<i class="chipc"></i>'.repeat(Math.min(14, Math.ceil(D.pot / (D.boot || 1) / 2)))}</div>
         <b>${coins(D.pot)}</b><small>Hand ${D.hand} · boot ${D.boot} · stake ${D.stake}</small></div>`);

    // my three cards
    let h = '';
    const m = mine();
    if (D && m && g) {
      const res = D.result, inh = D.inhand.includes(me), shown = res && res.shown && res.shown[me];
      const faces = shown || (D.seen[me] && you.cards) || null;
      if (inh || shown) {
        const canSee = idle && inh && !D.seen[me] && !res && (g.turnPhase === 'bet' || g.turnPhase === 'side');
        h = `<div class="tp3 ${canSee ? 'cansee' : ''}" ${canSee ? 'data-act="see"' : ''}>${[0, 1, 2].map(i => cardHTML(faces ? faces[i] : null, 'big')).join('')}</div>
          <div class="hlabel">${faces ? handName(faces) : canSee ? 'Tap your cards to look at them' : 'Your cards are face down'}</div>`;
      } else if (D.hand && !m.bankrupt) h = '<div class="hlabel dim">You packed this hand</div>';
      else if (m.bankrupt) h = '<div class="hlabel dim">You are out of chips — watching</div>';
    }
    setHTML($('#ghand'), h);

    const r = D && D.result;
    Table.msg(r ? `<b>${r.winners.map(w => P(w) ? esc(P(w).name) : '?').join(' &amp; ')}</b> won ${coins(r.pot)}<small>${r.names[r.winners[0]] ? 'with a ' + r.names[r.winners[0]] : esc(r.reason)}</small>` : '');
  }

  const spot = pid => pid === me ? [50, 80] : Table.toward(pid, .1);

  async function payout(ev, fast) {
    if (!fast) {
      Race.say(`🏆 ${ev.winners.map(w => Race.name(P(w))).join(' and ')} win${ev.winners.length === 1 ? 's' : ''} <b class="num">${ev.pot}</b>`);
      SFX.coin();
      for (const w of ev.winners) {
        const p = P(w);
        Table.ring1(w, p ? p.color : '#fff');
        SFX.chips();
        await Table.chips(Table.CENTER, Table.pos[w] || Table.CENTER, 7);
      }
    }
    for (const w in ev.wins) D.chips[w] = (D.chips[w] || 0) + ev.wins[w];
    D.pot = 0; D.bets = {};
    draw();
    if (!fast) await sleep(900);
  }

  async function play(ev, fast) {
    const p = P(ev.p), nm = Race.name(p);
    if (!D) snap();
    switch (ev.k) {
      case 'deal': {
        D = { chips: Object.assign({}, ev.chips), bets: {}, inhand: [], seen: {}, pot: 0, stake: ev.boot, boot: ev.boot, result: null, dealer: ev.dealer, hand: ev.hand };
        draw();
        if (!fast) { Race.say(`Hand ${ev.hand} — everyone puts in the boot of <b class="num">${ev.boot}</b>`); SFX.shuffle(); await sleep(500); }
        for (const pid of ev.players) {
          const pay = Math.min(ev.boot, D.chips[pid] || 0);
          D.chips[pid] -= pay; D.bets[pid] = pay;
          if (!fast) Table.chips(Table.toward(pid, .12), Table.CENTER, 1);
        }
        D.pot = ev.pot;
        if (!fast) { SFX.chips(); await sleep(480); draw(); }
        if (!fast) {
          for (let r = 0; r < 3; r++) for (const pid of ev.players) {
            SFX.card();
            Table.fly(cardHTML(null, 'mini'), Table.CENTER, spot(pid), 260, 'cardfly');
            await sleep(75);
          }
          await sleep(240);
        }
        D.inhand = ev.players.slice();
        for (const pid of ev.players) D.seen[pid] = false;
        draw();
        break;
      }
      case 'see':
        D.seen[ev.p] = true;
        if (!fast) { Race.say(`${nm} looks at the cards`); SFX.flip(); }
        draw();
        if (!fast) await sleep(ev.p === me ? 550 : 380);
        break;
      case 'bet':
        D.chips[ev.p] = Math.max(0, (D.chips[ev.p] || 0) - ev.amt);
        D.bets[ev.p] = (D.bets[ev.p] || 0) + ev.amt;
        if (!fast) {
          const what = ev.show ? 'pays for a show' : ev.allin ? 'goes all in' : ev.up ? 'raises' : ev.blind ? 'plays blind' : 'plays chaal';
          Race.say(`${nm} ${what} — <b class="num">${ev.amt}</b>`);
          SFX.chips();
          draw();
          await Table.chips(Table.toward(ev.p, .12), Table.CENTER, Math.min(6, 1 + Math.round(ev.amt / (D.boot || 1) / 2)));
        }
        D.pot = ev.pot; D.stake = ev.stake || D.stake;
        draw();
        if (!fast) await sleep(180);
        break;
      case 'pack':
        if (!fast) {
          Race.say(`${nm} packs`); SFX.fold();
          Table.fly(cardHTML(null, 'mini'), spot(ev.p), Table.CENTER, 380, 'cardfly fade');
        }
        D.inhand = D.inhand.filter(x => x !== ev.p);
        draw();
        if (!fast) await sleep(450);
        break;
      case 'sideask':
        if (!fast) { Race.say(`${Race.name(P(ev.from))} asks ${Race.name(P(ev.to))} for a side show`); SFX.card(); await sleep(750); }
        break;
      case 'sideres':
        if (ev.ok) {
          D.inhand = D.inhand.filter(x => x !== ev.loser);
          if (!fast) { Race.say(`Side show — ${Race.name(P(ev.loser))} had the lower hand and packs`); SFX.flip(); draw(); await sleep(2000); }
        } else if (!fast) { Race.say(`${Race.name(P(ev.to))} refuses the side show`); SFX.bump(); await sleep(850); }
        draw();
        break;
      case 'show':
        D.result = ev;
        draw();
        if (!fast) { Race.say('Show! The cards are turned over'); SFX.flip(); await sleep(1500); }
        await payout(ev, fast);
        break;
      case 'win':
        D.result = ev;
        draw();
        await payout(ev, fast);
        break;
      case 'bust':
        if (!fast) { Race.say(`${nm} is out of chips`); SFX.bump(); await sleep(550); }
        draw();
        break;
    }
  }

  const turn = g => g.turnPhase === 'bet' ? g.turn : g.turnPhase === 'side' ? g.side.to : null;

  /* the seen player before me that I may ask for a side show */
  function sideTarget(g) {
    if (!S.settings.sideshow || g.inhand.length <= 2 || !g.seen[me] || g.chips[me] < g.stake * 2) return null;
    const i = g.order.indexOf(me), n = g.order.length;
    for (let k = 1; k < n; k++) {
      const prev = g.order[(i - k + n) % n];
      if (g.inhand.includes(prev)) return g.seen[prev] ? prev : null;
    }
    return null;
  }

  function hud(g, myTurn, cur) {
    const m = mine(), inh = !!m && g.inhand.includes(me), seen = !!g.seen[me];
    const seeBtn = inh && !seen && g.turnPhase !== 'between' ? '<button class="btn" data-act="see">👁 See cards</button>' : '';
    let t = '', a = '';
    if (g.turnPhase === 'between') {
      const r = g.result;
      t = `<b>${r ? r.winners.map(w => P(w) ? esc(P(w).name) : '?').join(' and ') + ' won ' + coins(r.pot) : 'Hand over'}</b><small>The next hand starts in a moment…</small>`;
      a = isHost() ? '<button class="btn green" data-act="next">Deal now</button>' : '';
    } else if (g.turnPhase === 'side') {
      if (g.side.to === me) {
        t = `${Race.name(P(g.side.from))} asks you for a side show<small>You compare cards in private and the lower hand packs</small>`;
        a = '<button class="btn green" data-act="sideyes">Accept</button><button class="btn" data-act="sideno">Refuse</button>';
      } else t = `${Race.name(P(g.side.to))} is deciding on a side show…`;
    } else if (myTurn) {
      const blind = !seen, chips = g.chips[me], base = Math.min(chips, g.stake * (blind ? 1 : 2));
      const actors = g.inhand.filter(id => g.chips[id] > 0).length;
      const canRaise = g.stake * 2 <= g.maxStake && chips >= g.stake * (blind ? 2 : 4);
      t = `<span class="myturn">Your turn!</span><small>You are ${blind ? 'playing blind' : 'seen'} · pot ${g.pot} of ${g.limit}</small>`;
      a = '<button class="btn danger" data-act="pack">Pack</button>'
        + `<button class="btn primary" data-act="bet" data-v="1">${chips <= g.stake * (blind ? 1 : 2) ? 'All in' : blind ? 'Blind' : 'Chaal'} ${base}</button>`
        + (canRaise ? `<button class="btn" data-act="bet" data-v="2">Raise ${g.stake * (blind ? 2 : 4)}</button>` : '')
        + (actors === 2 ? `<button class="btn green" data-act="show">Show ${base}</button>` : '')
        + (sideTarget(g) ? '<button class="btn" data-act="sideshow">Side show</button>' : '') + seeBtn;
    } else {
      t = cur ? `${Race.name(cur)}'s turn${cur.bot ? ' 🤖' : ''}` : '';
      if (m && m.bankrupt) t += '<small>You are out of chips — watching</small>';
      else if (m && !inh) t += '<small>You packed this hand</small>';
      a = seeBtn;
    }
    return { t, a };
  }

  function click(k, v) {
    if (k === 'bet') { Race.send('bet', { x: +v }); return true; }
    if (['pack', 'show', 'sideshow', 'sideyes', 'sideno', 'see', 'next'].includes(k)) { Race.send(k); return true; }
    if (k === 'endGame') { if (confirm('End the game now? Whoever has the most chips wins.')) act('endGame'); return true; }
    return false;
  }

  Race.register('teenpatti', {
    title: 'Teen Patti', cls: 'ctable', maxSeats: 6, noDie: true, hostEnd: true, outText: 'out', resize: true,
    selects: [
      ['chips', 'Starting chips', B => B.chipOptions.map(v => [v, v.toLocaleString('en-US')])],
      ['boot', 'Boot (entry each hand)', B => B.bootOptions.map(v => [v, v])],
      ['potLimit', 'Pot limit', B => B.potOptions.map(v => [v, v + ' × boot'])],
      ['hands', 'Game length', B => B.handOptions.map(v => [v, v ? v + ' hands' : 'Until one player is left'])],
    ],
    toggles: [
      ['rising', 'Rising boot', 'The boot doubles every 5 hands so the game cannot drag on'],
      ['sideshow', 'Side show', 'A seen player can privately compare cards with the seen player before them'],
      ['randomOrder', 'Random seats', 'Shuffle who sits where'],
    ],
    build: b => Table.build(b), snap, play, layout: draw, turn, hud, click,
    info: p => coins(D ? D.chips[p.id] || 0 : 0),
    hint: () => '',
    rules: s => [
      'Play chips only — nothing here is real money. Everyone starts with <b>' + s.chips.toLocaleString('en-US') + '</b> chips.',
      'Each hand everyone puts in the <b>boot</b> and gets 3 cards face down.',
      'Until you look you are <b>blind</b> and bet the stake. Once <b>seen</b> you bet double (chaal). Either may raise to twice that.',
      '<b>Pack</b> to give up the hand. With two players left you can pay for a <b>show</b>: both hands are turned over.',
      s.sideshow ? 'A seen player may ask the seen player before them for a <b>side show</b>; the lower hand packs.' : 'Side shows are switched off.',
      'Hands, best first: <b>Trail</b> (three of a kind), <b>Pure sequence</b>, <b>Sequence</b>, <b>Colour</b>, <b>Pair</b>, <b>High card</b>. A-K-Q is the top sequence, A-2-3 the second.',
      'When the pot reaches the limit every hand still in is compared.' + (s.rising ? ' The boot doubles every 5 hands.' : ''),
      s.hands ? `After ${s.hands} hands the player with the most chips wins.` : 'The last player with chips wins.',
    ],
  });
})();
