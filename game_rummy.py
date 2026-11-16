"""Rummy (Indian 13-card rummy) - rules and bots.

Two decks plus two printed jokers. Everyone gets 13 cards; one more card is turned up to pick
the wild joker (every card of that rank is a joker for this deal). On your turn you draw one
card - from the closed deck or the top of the open pile - and throw one away. You may declare
when all 13 cards sit in melds with at least two sequences, one of them pure (no joker).

To keep it friendly on phones the server arranges every hand into its best melds itself, so
nobody has to drag cards into groups and nobody can make a wrong declaration.

Scoring: the winner of a deal scores 0, everyone else the points of the cards left outside
melds (face cards and aces 10, others their number, jokers 0, at most 80). Without a pure
sequence every card counts. Dropping costs 20 before your first turn and 40 after it.
After the chosen number of deals the lowest total wins.
"""
import random
import time

from game_cards import arrange, card_points, new_deck
from rooms import AVATARS, COLORS, CardRoom, GameError

DEAL_OPTIONS = [1, 2, 3, 5]
FIRST_DROP, MIDDLE_DROP, MAX_POINTS = 20, 40, 80

BOARD = {'colors': COLORS, 'avatars': AVATARS, 'dealOptions': DEAL_OPTIONS,
         'firstDrop': FIRST_DROP, 'middleDrop': MIDDLE_DROP, 'maxPoints': MAX_POINTS}


def groups_of(res):
    """An arrangement as a list of [type, cards] for the client."""
    out = [[t, cs] for t, cs in res['melds']]
    if res['free']:
        out.append(['joker', res['free']])
    if res['dead']:
        out.append(['loose', res['dead']])
    return out


class RummyRoom(CardRoom):
    GAME = 'rummy'
    BOARD = BOARD
    MAX_SEATS = 6
    BOOLS = ('randomOrder',)

    def __init__(self, code, loop):
        super().__init__(code, loop)
        self.cache = {}  # player id -> (hand key, arrangement), so a hand is only analysed when it changes

    def default_settings(self):
        return {'maxPlayers': 6, 'deals': 3, 'randomOrder': True}

    def apply_settings(self, s):
        super().apply_settings(s)
        if s.get('deals') in DEAL_OPTIONS and not isinstance(s.get('deals'), bool):
            self.settings['deals'] = s['deals']

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
            'deal': 0, 'dealer': -1, 'deck': [], 'open': [], 'wild': 'A', 'wildCard': None, 'hands': {},
            'active': [], 'dealt': [], 'dropped': {}, 'moved': {}, 'total': {pid: 0 for pid in order},
            'result': None, 'drew': None, 'fresh': None, 'shuffles': 0})
        self.logs = []
        self.cache = {}
        self.log('The game begins! %d deal%s — the lowest total wins.'
                 % (self.settings['deals'], '' if self.settings['deals'] == 1 else 's'))
        self.deal_cards()

    def extra_state(self):
        g = self.g
        return {'deal': g['deal'], 'deals': self.settings['deals'], 'dealer': g['order'][g['dealer']],
                'deckCount': len(g['deck']), 'openTop': g['open'][-1] if g['open'] else None,
                'openCount': len(g['open']), 'wild': g['wild'], 'wildCard': g['wildCard'],
                'active': g['active'], 'dealt': g['dealt'], 'dropped': g['dropped'], 'total': g['total'],
                'counts': {pid: len(h) for pid, h in g['hands'].items()}, 'result': g['result']}

    def look(self, pid):
        """The best arrangement of a hand (cached until the hand changes)."""
        g = self.g
        hand = g['hands'][pid]
        ban = g['drew'] if g['order'][g['turnIdx']] == pid else None
        key = (tuple(hand), g['wild'], ban)
        hit = self.cache.get(pid)
        if not hit or hit[0] != key:
            hit = (key, arrange(hand, g['wild'], 'score', spare=len(hand) == 14, ban=ban, limit=10000))
            self.cache[pid] = hit
        return hit[1]

    def private(self, p):
        g = self.g
        if p.id not in g['hands'] or p.id not in g['active'] or g['turnPhase'] not in ('draw', 'discard'):
            return None
        res = self.look(p.id)
        mine = g['order'][g['turnIdx']] == p.id
        return {'groups': groups_of(res), 'points': res['points'],
                'canDeclare': bool(mine and g['turnPhase'] == 'discard' and res['complete']),
                'drew': g['drew'] if mine else None, 'fresh': g['fresh'] if mine else None,
                'dropCost': MIDDLE_DROP if g['moved'].get(p.id) else FIRST_DROP}

    def seated(self):
        return [pid for pid in self.g['order'] if not self.pl(pid).bankrupt]

    # ------------------------------------------------------------ a deal
    def deal_cards(self):
        g = self.g
        players = self.seated()
        if len(players) < 2:
            return self.finish_game()
        g['deal'] += 1
        n = len(g['order'])
        d = g['dealer']
        for _ in range(n):
            d = (d + 1) % n
            if g['order'][d] in players:
                break
        g['dealer'] = d
        deck = new_deck(2, 2)
        g['hands'] = {pid: [deck.pop() for _ in range(13)] for pid in players}
        g['wildCard'] = deck.pop()
        g['wild'] = 'A' if g['wildCard'][0] == 'X' else g['wildCard'][0]  # a printed joker turned up: aces are wild
        g['open'] = [deck.pop()]
        g['deck'] = deck
        g.update({'active': list(players), 'dealt': list(players), 'dropped': {}, 'moved': {pid: False for pid in players},
                  'result': None, 'drew': None, 'fresh': None, 'shuffles': 0, 'turnIdx': d, 'turnPhase': 'draw'})
        self.cache = {}
        self.emit({'k': 'deal', 'dealer': g['order'][d], 'players': list(players), 'deal': g['deal'],
                   'wild': g['wildCard'], 'open': g['open'][-1]}, 2.6)
        self.log('Deal %d of %d — the wild joker is %s' % (g['deal'], self.settings['deals'], self.rank_name(g['wild'])))
        self.pass_turn()

    @staticmethod
    def rank_name(r):
        return {'A': 'ace', 'T': '10', 'J': 'jack', 'Q': 'queen', 'K': 'king'}.get(r, r)

    def pass_turn(self):
        g = self.g
        n = len(g['order'])
        for _ in range(n):
            g['turnIdx'] = (g['turnIdx'] + 1) % n
            if g['order'][g['turnIdx']] in g['active']:
                break
        g['turnPhase'] = 'draw'
        g['drew'] = g['fresh'] = None

    def play(self, p, a, m):
        g = self.g
        if a == 'endGame':
            self.need_host(p)
            return self.finish_game()
        if a == 'next':
            self.need_host(p)
            if g['turnPhase'] != 'between':
                raise GameError('The deal is still being played')
            if self.next_timer:
                self.next_timer.cancel()
                self.next_timer = None
            return self.deal_cards()
        if a == 'draw':
            self.draw(p, 'open' if m.get('src') == 'open' else 'deck')
        elif a == 'discard':
            self.discard(p, m.get('c'))
        elif a == 'declare':
            self.declare(p)
        elif a == 'drop':
            self.drop(p)
        else:
            raise GameError('Unknown action')

    def draw(self, p, src):
        g = self.g
        self.need_turn(p, 'draw')
        if src == 'open':
            if not g['open']:
                raise GameError('The open pile is empty')
            card = g['open'].pop()
            g['drew'] = card
        else:
            if not g['deck']:  # closed deck used up: shuffle the open pile back in, keeping its top card
                top = g['open'].pop() if g['open'] else None
                g['deck'], g['open'] = g['open'], ([top] if top else [])
                random.shuffle(g['deck'])
                g['shuffles'] += 1
                if not g['deck'] or g['shuffles'] > 2:  # nobody can finish: call the deal off and count the hands
                    return self.end_deal(None)
                self.emit({'k': 'reshuffle'}, 0.8)
            card = g['deck'].pop()
            g['drew'] = None
        g['hands'][p.id].append(card)
        g['fresh'] = card
        g['turnPhase'] = 'discard'
        self.emit({'k': 'draw', 'p': p.id, 'src': src, 'card': card if src == 'open' else None,
                   'top': g['open'][-1] if g['open'] else None}, 0.6)

    def discard(self, p, c):
        g = self.g
        self.need_turn(p, 'discard')
        hand = g['hands'][p.id]
        if c not in hand:
            raise GameError('You do not hold that card')
        if c == g['drew']:
            raise GameError('You cannot throw away the card you just picked from the open pile')
        hand.remove(c)
        g['open'].append(c)
        g['moved'][p.id] = True
        self.emit({'k': 'discard', 'p': p.id, 'card': c}, 0.6)
        self.pass_turn()

    def declare(self, p):
        g = self.g
        self.need_turn(p, 'discard')
        res = self.look(p.id)
        if not res['complete'] or res['spare'] is None:
            raise GameError('Not ready yet: you need two sequences (one pure) and every card in a group')
        g['hands'][p.id].remove(res['spare'])
        self.emit({'k': 'declare', 'p': p.id, 'card': res['spare']}, 1.2)
        self.log(f'{p.name} declares! 🃏', p)
        self.end_deal(p.id)

    def drop(self, p):
        g = self.g
        self.need_turn(p, 'draw')
        cost = MIDDLE_DROP if g['moved'][p.id] else FIRST_DROP
        g['dropped'][p.id] = cost
        g['active'].remove(p.id)
        self.emit({'k': 'fold', 'p': p.id, 'pts': cost}, 0.7)
        self.log(f'{p.name} drops this deal for {cost} points', p)
        if len(g['active']) == 1:
            return self.end_deal(g['active'][0])
        self.pass_turn()

    def end_deal(self, winner):
        g = self.g
        rows = {}
        for pid in g['dealt']:
            if self.pl(pid) is None:
                continue
            if pid in g['dropped']:
                rows[pid] = {'pts': g['dropped'][pid], 'groups': None, 'dropped': True}
                continue
            if pid not in g['active']:
                continue
            res = arrange(g['hands'][pid], g['wild'], 'score', limit=15000)
            pts = 0 if pid == winner else max(2, res['points'])
            rows[pid] = {'pts': pts, 'groups': groups_of(res), 'dropped': False}
        for pid, row in rows.items():
            g['total'][pid] += row['pts']
        g['result'] = {'winner': winner, 'rows': rows, 'deal': g['deal']}
        g['turnPhase'] = 'between'
        g['drew'] = g['fresh'] = None
        self.emit({'k': 'dealend', 'winner': winner, 'rows': rows, 'deal': g['deal']}, 3.0)
        if winner:
            self.log(f'{self.pl(winner).name} wins deal {g["deal"]}', self.pl(winner))
        if g['deal'] >= self.settings['deals'] or len(self.seated()) < 2:
            return self.finish_game()
        self.later(max(0.0, self.busy_until - time.time()) + 9.0, self.deal_cards)

    def finish_game(self):
        g = self.g
        seated = self.seated()
        g['ranks'] = sorted(seated, key=lambda pid: g['total'][pid]) + [pid for pid in g['order'] if pid not in seated]
        if seated:
            w = self.pl(g['ranks'][0])
            self.log(f"{w.name} wins the game with {g['total'][w.id]} points! 🏆", w)
        self.end_game()

    def drop_player(self, p, reason):
        if p.bankrupt or self.phase != 'playing':
            return
        g = self.g
        was_turn = g['order'][g['turnIdx']] == p.id
        p.bankrupt = True
        self.log(f'{p.name} {reason}', p)
        self.emit({'k': 'drop', 'p': p.id}, 0)
        live = g['turnPhase'] in ('draw', 'discard')
        if live and p.id in g['active']:
            g['active'].remove(p.id)
            g['dropped'][p.id] = MAX_POINTS
            if len(g['active']) == 1:
                self.end_deal(g['active'][0])
            elif was_turn:
                self.pass_turn()
        if self.phase == 'playing' and len(self.seated()) < 2:
            if self.next_timer:
                self.next_timer.cancel()
                self.next_timer = None
            self.finish_game()

    # ------------------------------------------------------------ bots
    def bot_plan(self):
        if self.g['turnPhase'] not in ('draw', 'discard'):
            return None
        cur = self.current()
        if cur and self.is_auto(cur):
            wait = max(0.0, self.busy_until - time.time())
            return (wait + random.uniform(0.7, 1.3), lambda: self.bot_turn(cur))
        return None

    def bot_turn(self, p):
        g = self.g
        hand, wild = g['hands'][p.id], g['wild']
        if g['turnPhase'] == 'draw':
            take = False
            top = g['open'][-1] if g['open'] else None
            if top:
                now = arrange(hand, wild, 'bot', limit=2500)
                with_top = arrange(hand + [top], wild, 'bot', spare=True, ban=top, limit=2500)
                take = with_top['val'] < now['val'] - 2.5 or (card_points(top, wild) == 0)
            return self.draw(p, 'open' if take else 'deck')
        if self.look(p.id)['complete']:
            return self.declare(p)
        res = arrange(hand, wild, 'bot', spare=True, ban=g['drew'], limit=2500)
        card = res['spare']
        if card is None or card == g['drew'] or card not in hand:
            card = max((c for c in hand if c != g['drew']), key=lambda c: card_points(c, wild))
        self.discard(p, card)
