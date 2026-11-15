"""Snakes & Ladders - rules and bots. The shared lobby and turn code is in rooms.py."""
import random

from rooms import AVATARS, COLORS, GameError, RaceRoom

LAST = 100
# bottom -> top
LADDERS = {4: 25, 13: 46, 33: 49, 42: 63, 50: 69, 62: 81, 74: 92}
# head -> tail
SNAKES = {27: 5, 40: 3, 43: 18, 54: 31, 66: 45, 76: 58, 89: 53, 99: 41}

BOARD = {'last': LAST, 'ladders': [[a, b] for a, b in LADDERS.items()],
         'snakes': [[a, b] for a, b in SNAKES.items()], 'colors': COLORS, 'avatars': AVATARS}


class SnakesRoom(RaceRoom):
    GAME = 'snakes'
    BOARD = BOARD
    MAX_SEATS = 8
    BOOLS = ('exactFinish', 'sixAgain', 'randomOrder', 'playOn')

    def default_settings(self):
        return {'maxPlayers': 6, 'exactFinish': True, 'sixAgain': True, 'randomOrder': True, 'playOn': False}

    def start_game(self):
        if self.phase != 'lobby':
            raise GameError('The game has already started')
        if len(self.players) < 2:
            raise GameError('You need at least 2 players (add a friend or a bot)')
        order = [p.id for p in self.players]
        if self.settings['randomOrder']:
            random.shuffle(order)
        self.begin(order, {'pos': {p.id: 1 for p in self.players}})

    def extra_state(self):
        return {'pos': self.g['pos']}

    def play(self, p, a, m):
        if a != 'roll':
            raise GameError('Unknown action')
        self.roll(p)

    def roll(self, p):
        g = self.g
        self.need_turn(p, 'roll')
        d = random.randint(1, 6)
        g['die'] = d
        frm = g['pos'][p.id]
        ev = {'k': 'roll', 'p': p.id, 'die': d, 'from': frm, 'via': None}
        mid = frm + d
        if mid > LAST:
            if self.settings['exactFinish']:
                mid = frm
                ev['over'] = True
            else:
                mid = LAST
        to = mid
        if mid in LADDERS:
            to, ev['via'] = LADDERS[mid], 'ladder'
        elif mid in SNAKES:
            to, ev['via'] = SNAKES[mid], 'snake'
        ev['mid'], ev['to'] = mid, to
        g['pos'][p.id] = to
        again = d == 6 and self.settings['sixAgain'] and to != LAST
        ev['again'] = again
        if ev.get('over'):
            self.log(f'{p.name} rolled {d} — needs exactly {LAST - frm} to finish', p)
        elif ev['via'] == 'ladder':
            self.log(f'{p.name} rolled {d} and climbed a ladder from {mid} to {to} 🪜', p)
        elif ev['via'] == 'snake':
            self.log(f'{p.name} rolled {d} and slid down a snake from {mid} to {to} 🐍', p)
        else:
            self.log(f'{p.name} rolled {d} and moved to {to}' + (' — rolls again!' if again else ''), p)
        self.emit(ev, 1.25 + (mid - frm) * 0.2 + (1.5 if ev['via'] else 0) + 0.35)
        if to == LAST:
            if not self.finish(p):
                self.next_turn()
        elif not again:
            self.next_turn()

    def bot_turn(self, p):
        self.roll(p)
