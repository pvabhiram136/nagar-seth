"""Ludo - rules and bots. The shared lobby and turn code is in rooms.py.

Each token's place is its progress along its own colour's route:
    -1        waiting in the yard
    0 .. 50   on the shared track (0 is the colour's start square)
    51 .. 55  in the colour's home column
    56        home
The shared track has 52 squares; seat k starts 13 * k squares further round.
"""
import random

from rooms import AVATARS, GameError, RaceRoom

HOME = 56
TRACK_END = 50
RING = 52
# seat order goes clockwise round the board: red, green, yellow, blue
SEAT_COLORS = ['#ff6b6b', '#69db7c', '#ffe066', '#748ffc']
SEAT_NAMES = ['Red', 'Green', 'Yellow', 'Blue']
# colours are handed out so that two players sit opposite each other
COLORS = [SEAT_COLORS[0], SEAT_COLORS[2], SEAT_COLORS[1], SEAT_COLORS[3]]
SAFE = {0, 8, 13, 21, 26, 34, 39, 47}  # the four start squares and the four stars

BOARD = {'colors': COLORS, 'seatColors': SEAT_COLORS, 'seatNames': SEAT_NAMES, 'avatars': AVATARS,
         'safe': sorted(SAFE), 'home': HOME, 'trackEnd': TRACK_END, 'ring': RING}


class LudoRoom(RaceRoom):
    GAME = 'ludo'
    BOARD = BOARD
    COLORS = COLORS
    MAX_SEATS = 4
    BOOLS = ('quickStart', 'autoMove', 'randomOrder', 'playOn')

    def default_settings(self):
        return {'maxPlayers': 4, 'tokens': 4, 'quickStart': False, 'autoMove': True, 'randomOrder': True, 'playOn': False}

    def apply_settings(self, s):
        super().apply_settings(s)
        if s.get('tokens') in (2, 4) and not isinstance(s.get('tokens'), bool):
            self.settings['tokens'] = s['tokens']

    def start_game(self):
        if self.phase != 'lobby':
            raise GameError('The game has already started')
        if len(self.players) < 2:
            raise GameError('You need at least 2 players (add a friend or a bot)')
        seat = {p.id: SEAT_COLORS.index(p.color) for p in self.players}
        order = sorted(seat, key=seat.get)  # clockwise
        if self.settings['randomOrder']:
            k = random.randrange(len(order))
            order = order[k:] + order[:k]
        n = self.settings['tokens']
        first = 0 if self.settings['quickStart'] else -1  # quick start: one token already on the start square
        self.begin(order, {'seat': seat, 'tokens': {pid: [first] + [-1] * (n - 1) for pid in order}, 'movable': []})

    def extra_state(self):
        g = self.g
        return {'seat': g['seat'], 'tokens': g['tokens'], 'movable': g['movable'], 'sixes': g['sixes']}

    # ------------------------------------------------------------ rules
    def square(self, pid, r):
        """Shared-track square number for a token of pid at progress r (None when off the track)."""
        return (13 * self.g['seat'][pid] + r) % RING if 0 <= r <= TRACK_END else None

    def legal(self, p, d):
        out = []
        for i, r in enumerate(self.g['tokens'][p.id]):
            if r == -1:
                if d == 6:
                    out.append(i)
            elif r < HOME and r + d <= HOME:
                out.append(i)
        return out

    def play(self, p, a, m):
        if a == 'roll':
            self.roll(p)
        elif a == 'move':
            self.move(p, m.get('i'))
        else:
            raise GameError('Unknown action')

    def roll(self, p):
        g = self.g
        self.need_turn(p, 'roll')
        d = random.randint(1, 6)
        g['die'] = d
        g['sixes'] = g['sixes'] + 1 if d == 6 else 0
        if g['sixes'] >= 3:
            self.emit({'k': 'roll', 'p': p.id, 'die': d, 'n': 0, 'three': True}, 1.9)
            self.log(f'{p.name} rolled a third 6 in a row — the turn is lost', p)
            return self.next_turn()
        moves = self.legal(p, d)
        self.emit({'k': 'roll', 'p': p.id, 'die': d, 'n': len(moves)}, 1.25 if moves else 1.75)
        if not moves:
            self.log(f'{p.name} rolled {d} — no move possible' + (', rolls again' if d == 6 else ''), p)
            if d != 6:
                self.next_turn()
            return
        toks = g['tokens'][p.id]
        same = len({toks[i] for i in moves}) == 1  # e.g. two tokens waiting in the yard: either is the same move
        if self.settings['autoMove'] and (len(moves) == 1 or same):
            return self.do_move(p, moves[0], d)
        g['turnPhase'] = 'move'
        g['movable'] = moves

    def move(self, p, i):
        g = self.g
        self.need_turn(p, 'move')
        if isinstance(i, bool) or not isinstance(i, int) or i not in g['movable']:
            raise GameError('That token cannot move')
        self.do_move(p, i, g['die'])

    def do_move(self, p, i, d):
        g = self.g
        toks = g['tokens'][p.id]
        frm = toks[i]
        to = 0 if frm == -1 else frm + d
        toks[i] = to
        g['movable'] = []
        caps = []
        sq = self.square(p.id, to)
        if sq is not None and sq not in SAFE:
            for q in self.players:
                if q is p or q.bankrupt or q.id not in g['tokens']:
                    continue
                for j, r in enumerate(g['tokens'][q.id]):
                    if self.square(q.id, r) == sq:  # every opponent token on the square goes back
                        caps.append({'p': q.id, 'i': j, 'from': r})
                        g['tokens'][q.id][j] = -1
        steps = 1 if frm == -1 else d
        self.emit({'k': 'move', 'p': p.id, 'i': i, 'from': frm, 'to': to, 'caps': caps},
                  0.3 + steps * 0.19 + 0.85 * len(caps) + (0.8 if to == HOME else 0) + 0.25)
        if frm == -1:
            self.log(f'{p.name} rolled 6 and brought a token out', p)
        elif to == HOME:
            self.log(f'{p.name} rolled {d} and got a token home 🏠', p)
        else:
            self.log(f'{p.name} rolled {d}', p)
        for c in caps:
            self.log(f"{p.name} sent {self.pl(c['p']).name}'s token back to the yard 💥", p)
        if all(r == HOME for r in toks):
            if not self.finish(p):
                self.next_turn()
            return
        if d == 6 or caps or to == HOME:
            g['turnPhase'] = 'roll'  # bonus roll
        else:
            self.next_turn()

    def on_drop(self, p):
        g = self.g
        if p.id in g['tokens']:
            g['tokens'][p.id] = [-1] * len(g['tokens'][p.id])
        if self.current() is p:
            g['movable'] = []
            g['turnPhase'] = 'roll'

    # ------------------------------------------------------------ bots
    def threatened(self, pid, r):
        """True when an opponent token sits 1-6 squares behind progress r of pid on an unsafe square."""
        sq = self.square(pid, r)
        if sq is None or sq in SAFE:
            return False
        g = self.g
        for q in self.players:
            if q.id == pid or q.bankrupt or q.id not in g['tokens']:
                continue
            for qr in g['tokens'][q.id]:
                qs = self.square(q.id, qr)
                if qs is None:
                    continue
                gap = (sq - qs) % RING
                if 1 <= gap <= 6 and qr + gap <= TRACK_END:
                    return True
        return False

    def score(self, p, i, d):
        g = self.g
        frm = g['tokens'][p.id][i]
        to = 0 if frm == -1 else frm + d
        s = random.random() * 4 + to * 0.3
        sq = self.square(p.id, to)
        if sq is not None and sq not in SAFE:
            for q in self.players:
                if q is p or q.bankrupt or q.id not in g['tokens']:
                    continue
                hit = [r for r in g['tokens'][q.id] if self.square(q.id, r) == sq]
                if hit:
                    s += 80 + max(hit) + 20 * (len(hit) - 1)  # far-travelled tokens hurt more to lose
        if to == HOME:
            s += 60
        if frm == -1:
            s += 45
        elif self.threatened(p.id, frm):
            s += 30
        if to < HOME and (to > TRACK_END or sq in SAFE):
            s += 22
        elif self.threatened(p.id, to):
            s -= 25
        return s

    def bot_turn(self, p):
        g = self.g
        if g['turnPhase'] == 'roll':
            self.roll(p)
        elif g['turnPhase'] == 'move':
            self.move(p, max(g['movable'], key=lambda i: self.score(p, i, g['die'])))
