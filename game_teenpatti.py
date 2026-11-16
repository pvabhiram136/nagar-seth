"""Teen Patti - rules and bots. Played with free play chips only; there is no real money anywhere.

A game is a series of hands. In each hand everyone still holding chips puts in the boot and
gets three cards face down. A player who has not looked at the cards is "blind" and bets the
current stake (or double it); a player who has looked is "seen" and bets twice the stake (or
four times). The hand ends when everyone but one has packed, when two players are left and one
pays for a show, or when the pot limit is reached and every hand still in is compared.
"""
import random
import time

from game_cards import TP_NAMES, VAL, new_deck, tp_name, tp_rank
from rooms import AVATARS, COLORS, CardRoom, GameError

CHIP_OPTIONS = [500, 1000, 2000, 5000]
BOOT_OPTIONS = [5, 10, 20, 50]
POT_OPTIONS = [100, 200, 500]
HAND_OPTIONS = [0, 5, 10, 20]
MAX_STAKE = 32  # the blind stake can grow to this many boots
SIDE_SECS = 15
RISE_EVERY = 5  # hands between each doubling of the boot

BOARD = {'colors': COLORS, 'avatars': AVATARS, 'chipOptions': CHIP_OPTIONS, 'bootOptions': BOOT_OPTIONS, 'riseEvery': RISE_EVERY,
         'potOptions': POT_OPTIONS, 'handOptions': HAND_OPTIONS, 'handNames': TP_NAMES}


class TeenPattiRoom(CardRoom):
    GAME = 'teenpatti'
    BOARD = BOARD
    MAX_SEATS = 6
    BOOLS = ('rising', 'sideshow', 'randomOrder')

    def default_settings(self):
        return {'maxPlayers': 6, 'chips': 1000, 'boot': 10, 'potLimit': 200, 'hands': 0,
                'rising': True, 'sideshow': True, 'randomOrder': True}

    def apply_settings(self, s):
        super().apply_settings(s)
        for key, options in (('chips', CHIP_OPTIONS), ('boot', BOOT_OPTIONS), ('potLimit', POT_OPTIONS),
                             ('hands', HAND_OPTIONS)):
            if s.get(key) in options and not isinstance(s.get(key), bool):
                self.settings[key] = s[key]

    # ------------------------------------------------------------ set-up
    def start_game(self):
        if self.phase != 'lobby':
            raise GameError('The game has already started')
        if len(self.players) < 2:
            raise GameError('You need at least 2 players (add a friend or a bot)')
        order = [p.id for p in self.players]
        if self.settings['randomOrder']:
            random.shuffle(order)
        self.begin(order, {
            'handNo': 0, 'dealer': -1, 'pot': 0, 'stake': self.settings['boot'], 'boot': self.settings['boot'],
            'chips': {pid: self.settings['chips'] for pid in order},
            'inhand': [], 'seen': {}, 'bets': {}, 'side': None, 'result': None,
            'hands': {}, 'peek': {}, 'busted': [], 'acted': {}, 'nerve': {}})
        self.logs = []
        self.log('The game begins! Everyone starts with %d chips.' % self.settings['chips'])
        self.deal_hand()

    def extra_state(self):
        g = self.g
        return {'handNo': g['handNo'], 'dealer': g['order'][g['dealer']], 'pot': g['pot'], 'stake': g['stake'],
                'boot': g['boot'],
                'chips': g['chips'], 'inhand': g['inhand'], 'seen': g['seen'], 'bets': g['bets'], 'side': g['side'],
                'result': g['result'], 'limit': self.pot_limit(), 'maxStake': self.max_stake()}

    def private(self, p):
        g = self.g
        cards = g['hands'].get(p.id) if g['seen'].get(p.id) else None  # unseen cards never leave the server
        return {'cards': cards, 'peek': g['peek'].get(p.id)}

    def pot_limit(self):
        return self.g['boot'] * self.settings['potLimit']

    def max_stake(self):
        return self.g['boot'] * MAX_STAKE

    def funded(self):
        g = self.g
        return [pid for pid in g['order'] if not self.pl(pid).bankrupt and g['chips'][pid] > 0]

    def actors(self):
        """Players in the hand who still have chips to bet."""
        g = self.g
        return [pid for pid in g['inhand'] if g['chips'][pid] > 0]

    def pay(self, pid, amount):
        g = self.g
        amount = min(amount, g['chips'][pid])
        g['chips'][pid] -= amount
        g['pot'] += amount
        g['bets'][pid] += amount
        return amount

    # ------------------------------------------------------------ a hand
    def deal_hand(self):
        g = self.g
        alive = self.funded()
        if len(alive) < 2:
            return self.finish_game()
        g['handNo'] += 1
        # with a rising boot the stakes double every few hands, so a game cannot drag on for ever
        steps = min(8, (g['handNo'] - 1) // RISE_EVERY) if self.settings['rising'] else 0
        boot = g['boot'] = self.settings['boot'] * 2 ** steps
        n = len(g['order'])
        d = g['dealer']
        for _ in range(n):
            d = (d + 1) % n
            if g['order'][d] in alive:
                break
        g['dealer'] = d
        deck = new_deck()
        g.update({'pot': 0, 'stake': boot, 'side': None, 'result': None, 'peek': {}, 'inhand': list(alive),
                  'seen': {pid: False for pid in alive}, 'bets': {pid: 0 for pid in alive},
                  'acted': {pid: 0 for pid in alive}, 'nerve': {pid: random.randint(0, 3) for pid in alive}})
        g['hands'] = {pid: sorted((deck.pop() for _ in range(3)), key=lambda c: -(14 if c[0] == 'A' else VAL[c[0]]))
                      for pid in alive}
        before = dict(g['chips'])
        for pid in alive:
            self.pay(pid, boot)
        g['turnIdx'] = d
        g['turnPhase'] = 'bet'
        self.emit({'k': 'deal', 'dealer': g['order'][d], 'players': list(alive), 'boot': boot, 'pot': g['pot'],
                   'hand': g['handNo'], 'chips': before}, 1.3 + 0.3 * len(alive))
        self.log('Hand %d — everyone puts in the boot of %d' % (g['handNo'], boot))
        self.advance()

    def advance(self):
        """Pass the turn to the next player who can bet, or end the hand if nobody is left to."""
        g = self.g
        if self.phase != 'playing' or g['turnPhase'] != 'bet':
            return
        if len(g['inhand']) == 1:
            return self.win(g['inhand'][0], 'everyone else packed')
        actors = self.actors()
        if len(actors) <= 1:
            return self.showdown(None, 'nobody has chips left to bet')
        if g['pot'] >= self.pot_limit():
            return self.showdown(None, 'the pot limit was reached')
        n = len(g['order'])
        for _ in range(n):
            g['turnIdx'] = (g['turnIdx'] + 1) % n
            if g['order'][g['turnIdx']] in actors:
                break

    def play(self, p, a, m):
        g = self.g
        if a == 'endGame':
            self.need_host(p)
            return self.finish_game()
        if a == 'next':
            self.need_host(p)
            if g['turnPhase'] != 'between':
                raise GameError('The hand is still being played')
            if self.next_timer:
                self.next_timer.cancel()
                self.next_timer = None
            return self.deal_hand()
        if p.id not in g['inhand'] or g['turnPhase'] not in ('bet', 'side'):
            raise GameError('You are not in this hand')
        if a == 'see':
            self.see(p)
        elif a == 'bet':
            self.bet(p, 2 if m.get('x') == 2 else 1)
        elif a == 'pack':
            self.pack(p)
        elif a == 'show':
            self.show(p)
        elif a == 'sideshow':
            self.sideshow(p)
        elif a in ('sideyes', 'sideno'):
            self.side_reply(p, a == 'sideyes')
        else:
            raise GameError('Unknown action')

    def see(self, p):
        g = self.g
        if g['seen'][p.id]:
            raise GameError('You have already seen your cards')
        g['seen'][p.id] = True
        self.emit({'k': 'see', 'p': p.id}, 0.4)
        self.log(f'{p.name} looks at their cards', p)

    def bet(self, p, x):
        g = self.g
        self.need_turn(p, 'bet')
        blind = not g['seen'][p.id]
        if x == 2 and g['stake'] * 2 > self.max_stake():
            raise GameError('The stake is already at its maximum')
        amount = g['stake'] * x * (1 if blind else 2)
        paid = self.pay(p.id, amount)
        if paid == amount:
            g['stake'] = paid if blind else paid // 2
        g['acted'][p.id] += 1
        allin = g['chips'][p.id] == 0
        self.emit({'k': 'bet', 'p': p.id, 'amt': paid, 'blind': blind, 'up': x == 2 and paid == amount,
                   'allin': allin, 'pot': g['pot'], 'stake': g['stake']}, 0.8)
        what = 'goes all in with' if allin else ('raises to' if x == 2 else ('plays blind' if blind else 'plays chaal'))
        self.log(f'{p.name} {what} {paid}', p)
        self.advance()

    def pack(self, p):
        g = self.g
        self.need_turn(p, 'bet')
        g['inhand'].remove(p.id)
        self.emit({'k': 'pack', 'p': p.id}, 0.6)
        self.log(f'{p.name} packs', p)
        self.advance()

    def show(self, p):
        g = self.g
        self.need_turn(p, 'bet')
        if len(self.actors()) != 2:
            raise GameError('A show is only possible when two players are left')
        paid = self.pay(p.id, g['stake'] * (1 if not g['seen'][p.id] else 2))
        self.emit({'k': 'bet', 'p': p.id, 'amt': paid, 'blind': not g['seen'][p.id], 'up': False, 'allin': False,
                   'pot': g['pot'], 'stake': g['stake'], 'show': True}, 0.8)
        self.log(f'{p.name} pays {paid} for a show', p)
        self.showdown(p.id, 'show')

    # side show: a seen player privately compares cards with the previous player ----------
    def side_target(self, pid):
        """The player pid may ask for a side show, or None."""
        g = self.g
        if not self.settings['sideshow'] or len(g['inhand']) <= 2 or not g['seen'].get(pid):
            return None
        if g['chips'][pid] < g['stake'] * 2:
            return None
        order = g['order']
        i = order.index(pid)
        for k in range(1, len(order)):
            prev = order[(i - k) % len(order)]
            if prev in g['inhand']:
                return prev if g['seen'][prev] else None
        return None

    def sideshow(self, p):
        g = self.g
        self.need_turn(p, 'bet')
        to = self.side_target(p.id)
        if not to:
            raise GameError('A side show is only possible with a seen player before you')
        paid = self.pay(p.id, g['stake'] * 2)
        g['acted'][p.id] += 1
        self.emit({'k': 'bet', 'p': p.id, 'amt': paid, 'blind': False, 'up': False, 'allin': g['chips'][p.id] == 0,
                   'pot': g['pot'], 'stake': g['stake']}, 0.8)
        g['side'] = {'from': p.id, 'to': to}
        g['turnPhase'] = 'side'
        self.emit({'k': 'sideask', 'from': p.id, 'to': to}, 0.8)
        self.log(f'{p.name} plays chaal {paid} and asks {self.pl(to).name} for a side show', p)
        self.later(SIDE_SECS, lambda: self.side_reply(self.pl(to), False))

    def side_reply(self, p, yes):
        g = self.g
        side = g['side']
        if g['turnPhase'] != 'side' or not side or not p or side['to'] != p.id:
            raise GameError('Nobody asked you for a side show')
        if self.next_timer:
            self.next_timer.cancel()
            self.next_timer = None
        a, b = side['from'], side['to']
        g['side'] = None
        g['turnPhase'] = 'bet'
        if yes:
            loser = a if tp_rank(g['hands'][a]) <= tp_rank(g['hands'][b]) else b
            g['peek'] = {a: {'p': b, 'cards': g['hands'][b]}, b: {'p': a, 'cards': g['hands'][a]}}
            g['inhand'].remove(loser)
            self.emit({'k': 'sideres', 'from': a, 'to': b, 'ok': True, 'loser': loser}, 2.4)
            self.log(f'Side show: {self.pl(loser).name} had the lower hand and packs', self.pl(loser))
        else:
            self.emit({'k': 'sideres', 'from': a, 'to': b, 'ok': False}, 1.0)
            self.log(f'{p.name} refuses the side show', p)
        g['turnIdx'] = g['order'].index(a)
        self.advance()

    # ------------------------------------------------------------ end of a hand
    def showdown(self, requester, reason):
        g = self.g
        ranks = {pid: tp_rank(g['hands'][pid]) for pid in g['inhand']}
        best = max(ranks.values())
        winners = [pid for pid in g['inhand'] if ranks[pid] == best]
        if requester and len(winners) > 1:
            winners = [w for w in winners if w != requester] or winners  # equal hands: whoever asked for the show loses
        share = g['pot'] // len(winners)
        wins = {w: share for w in winners}
        wins[winners[0]] += g['pot'] - share * len(winners)
        result = {'winners': winners, 'reason': reason, 'pot': g['pot'], 'wins': wins,
                  'shown': {pid: g['hands'][pid] for pid in g['inhand']},
                  'names': {pid: tp_name(g['hands'][pid]) for pid in g['inhand']}}
        self.emit(dict(result, k='show'), 3.4)
        names = ' and '.join(self.pl(w).name for w in winners)
        self.log(f"{names} win{'s' if len(winners) == 1 else ''} {g['pot']} with a {result['names'][winners[0]]} 🏆",
                 self.pl(winners[0]))
        self.finish_hand(result)

    def win(self, pid, reason):
        g = self.g
        result = {'winners': [pid], 'reason': reason, 'pot': g['pot'], 'wins': {pid: g['pot']}, 'shown': {}, 'names': {}}
        self.emit(dict(result, k='win'), 2.2)
        self.log(f"{self.pl(pid).name} wins {g['pot']} — {reason}", self.pl(pid))
        self.finish_hand(result)

    def finish_hand(self, result):
        g = self.g
        for pid, amount in result['wins'].items():
            g['chips'][pid] += amount
        g['pot'] = 0
        g['result'] = result
        g['side'] = None
        g['turnPhase'] = 'between'
        for pid in g['order']:
            q = self.pl(pid)
            if g['chips'][pid] == 0 and not q.bankrupt:
                q.bankrupt = True
                g['busted'].append(pid)
                self.emit({'k': 'bust', 'p': pid}, 0.3)
                self.log(f'{q.name} is out of chips', q)
        limit = self.settings['hands']
        if len(self.funded()) <= 1 or (limit and g['handNo'] >= limit):
            return self.finish_game()
        self.later(max(0.0, self.busy_until - time.time()) + 4.0, self.deal_hand)

    def finish_game(self):
        g = self.g
        funded = sorted(self.funded(), key=lambda pid: -g['chips'][pid])
        g['ranks'] = funded + [pid for pid in reversed(g['busted']) if pid not in funded]
        if funded:
            self.log(f"{self.pl(funded[0]).name} wins the game with {g['chips'][funded[0]]} chips! 🏆", self.pl(funded[0]))
        self.end_game()

    def drop_player(self, p, reason):
        if p.bankrupt or self.phase != 'playing':
            return
        g = self.g
        was_turn = g['order'][g['turnIdx']] == p.id
        p.bankrupt = True
        g['chips'][p.id] = 0
        g['busted'].append(p.id)
        self.log(f'{p.name} {reason}', p)
        self.emit({'k': 'drop', 'p': p.id}, 0)
        live = g['turnPhase'] in ('bet', 'side')
        in_hand = live and p.id in g['inhand']
        if in_hand:
            g['inhand'].remove(p.id)
        side = g['side']
        if side and p.id in (side['from'], side['to']):
            if self.next_timer:
                self.next_timer.cancel()
                self.next_timer = None
            g['side'] = None
            g['turnPhase'] = 'bet'
            g['turnIdx'] = g['order'].index(side['from'])
            self.advance()
        elif in_hand and g['turnPhase'] == 'bet' and (was_turn or len(g['inhand']) == 1 or len(self.actors()) <= 1):
            self.advance()
        if self.phase == 'playing' and g['turnPhase'] == 'between' and len(self.funded()) <= 1:
            if self.next_timer:
                self.next_timer.cancel()
                self.next_timer = None
            self.finish_game()

    # ------------------------------------------------------------ bots
    def bot_plan(self):
        g = self.g
        wait = max(0.0, self.busy_until - time.time())
        if g['turnPhase'] == 'side':
            to = self.pl(g['side']['to'])
            if to and self.is_auto(to):
                return (wait + random.uniform(1.0, 1.8), lambda: self.bot_side(to))
            return None
        if g['turnPhase'] != 'bet':
            return None
        cur = self.current()
        if cur and self.is_auto(cur):
            return (wait + random.uniform(0.9, 1.6), lambda: self.bot_turn(cur))
        return None

    def bot_side(self, p):
        g = self.g
        self.side_reply(p, tp_rank(g['hands'][p.id])[0] >= 1 or random.random() < 0.3)

    def bot_turn(self, p):
        g = self.g
        pid = p.id
        if g['turnPhase'] != 'bet' or self.current() is not p:
            return
        boot, stake, n = g['boot'], g['stake'], g['acted'][pid]
        can_raise = stake * 2 <= self.max_stake()
        heads_up = len(self.actors()) == 2
        rnd = random.random()
        if not g['seen'][pid]:
            if n >= g['nerve'][pid] or stake >= boot * 4:
                return self.see(p)
            return self.bet(p, 2 if can_raise and rnd < 0.12 else 1)
        rank = tp_rank(g['hands'][pid])
        cat, hi = rank[0], rank[1]
        pressure = stake * 2 / max(1, g['chips'][pid] + g['bets'][pid])
        if cat >= 3:
            if heads_up and n >= 4 and rnd < 0.3:
                return self.show(p)
            return self.bet(p, 2 if can_raise and rnd < 0.55 else 1)
        if cat == 2:
            if heads_up and n >= 2 and rnd < 0.4:
                return self.show(p)
            return self.bet(p, 2 if can_raise and rnd < 0.15 else 1)
        if cat == 1:
            if heads_up and n >= 1 and rnd < 0.55:
                return self.show(p)
            if pressure > 0.25 and hi < 10 and rnd < 0.6:
                return self.pack(p)
            if not heads_up and n >= 2 and rnd < 0.3 and self.side_target(pid):
                return self.sideshow(p)
            return self.bet(p, 1)
        if heads_up and hi >= 13 and rnd < 0.6:
            return self.show(p)
        if n == 0 and hi == 14 and rnd < 0.5:
            return self.bet(p, 1)
        if rnd < 0.08:
            return self.bet(p, 1)  # a small bluff now and then
        return self.pack(p)
