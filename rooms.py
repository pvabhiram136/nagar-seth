"""Shared room code for every game on the site.

A room is one private table: its players, host, chat, log, lobby settings and the
bot timer. Each game subclasses BaseRoom and adds only its own rules.

What a game must provide:
    GAME            short id used in messages ('rupeerush', 'snakes', 'ludo')
    start_game()    lobby -> playing
    act(p, m)       one player action ({t:'action', a:...})
    game_state()    the public 'g' part of the state message (None in the lobby)
    drop_player()   take a player out of a running game (kicked / gave up)
    bot_plan()      None, or (delay_seconds, function) for the next automatic move
and may override apply_settings(), default_settings(), bot_stuck().
"""
import json
import random
import secrets
import time

AFK_GRACE = 20  # seconds before a disconnected player is auto-played
HOST_GRACE = 10  # seconds a disconnected host keeps the host role

COLORS = ['#ff6b6b', '#ffa94d', '#ffe066', '#69db7c', '#3bc9db', '#748ffc', '#da77f2', '#f783ac']
AVATARS = ['🛺', '🐘', '🐅', '🦚', '🏏', '🪁', '☕', '🛕', '🥭', '🪔', '🚂', '🐪']
BOT_NAMES = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Isha', 'Vikram']


class GameError(Exception):
    pass


class BasePlayer:
    def __init__(self, name, is_bot=False):
        self.id = secrets.token_hex(4)
        self.token = secrets.token_hex(16)
        self.name = name
        self.color = COLORS[0]
        self.avatar = AVATARS[0]
        self.is_bot = is_bot
        self.conn = None
        self.connected = is_bot
        self.disc_at = 0.0
        self.reset()

    def reset(self):
        self.bankrupt = False  # "out of the game" in every game, whatever the reason

    def public(self):
        return {'id': self.id, 'name': self.name, 'color': self.color, 'avatar': self.avatar,
                'bot': self.is_bot, 'connected': self.connected, 'bankrupt': self.bankrupt}


class BaseRoom:
    GAME = 'base'
    PLAYER = BasePlayer
    COLORS = COLORS
    AVATARS = AVATARS
    BOT_NAMES = BOT_NAMES
    MAX_SEATS = 8
    TIMERS = ('bot_timer',)

    def __init__(self, code, loop):
        self.code = code
        self.loop = loop
        self.players = []
        self.spectators = set()
        self.host_id = None
        self.phase = 'lobby'
        self.settings = self.default_settings()
        self.g = None
        self.logs = []
        self.chat = []
        self.log_seq = 0
        self.bot_timer = None
        self.bot_fail = 0
        self.last_active = time.time()

    def default_settings(self):
        return {'maxPlayers': min(6, self.MAX_SEATS)}

    # ------------------------------------------------------------ helpers
    def pl(self, pid):
        for p in self.players:
            if p.id == pid:
                return p
        return None

    def alive(self):
        return [p for p in self.players if not p.bankrupt]

    def log(self, text, p=None):
        self.log_seq += 1
        self.logs.append({'i': self.log_seq, 'p': p.id if p else None, 'm': text})
        if len(self.logs) > 120:
            del self.logs[:40]

    def humans_connected(self):
        return [p for p in self.players if not p.is_bot and p.connected]

    def fix_host(self):
        h = self.pl(self.host_id)
        if h and not h.is_bot and (h.connected or time.time() - h.disc_at < HOST_GRACE):
            return  # a host who is just refreshing the page keeps the crown
        hs = self.humans_connected()
        self.host_id = hs[0].id if hs else self.host_id

    def need_host(self, p):
        if p.id != self.host_id:
            raise GameError('Only the host can do that')

    # ------------------------------------------------------------ networking
    def game_state(self):
        return None

    def state(self):
        return {'t': 'state', 'game': self.GAME, 'code': self.code, 'phase': self.phase,
                'hostId': self.host_id, 'settings': self.settings,
                'players': [p.public() for p in self.players],
                'g': self.game_state() if self.g else None,
                'log': self.logs[-60:], 'chat': self.chat[-60:]}

    def broadcast(self):
        data = json.dumps(self.state(), ensure_ascii=False, separators=(',', ':'))
        for p in self.players:
            if p.conn:
                p.conn.send_raw(data)
        for c in list(self.spectators):
            c.send_raw(data)

    # ------------------------------------------------------------ lobby
    def add_player(self, name, is_bot=False):
        if self.phase != 'lobby':
            raise GameError('The game has already started')
        if len(self.players) >= self.settings['maxPlayers']:
            raise GameError('This room is full')
        p = self.PLAYER(name, is_bot)
        used = {q.color for q in self.players}
        p.color = next((c for c in self.COLORS if c not in used), self.COLORS[0])
        used_av = {q.avatar for q in self.players}
        p.avatar = next((a for a in self.AVATARS if a not in used_av), self.AVATARS[0])
        self.players.append(p)
        if self.host_id is None and not is_bot:
            self.host_id = p.id
        return p

    def remove_player(self, p):
        if p in self.players:
            self.players.remove(p)
        self.fix_host()

    def apply_settings(self, s):
        mp = s.get('maxPlayers')
        if isinstance(mp, int) and not isinstance(mp, bool) and 2 <= mp <= self.MAX_SEATS and mp >= len(self.players):
            self.settings['maxPlayers'] = mp

    def handle(self, p, m):
        """Dispatch one client message from player p. Raises GameError for user-facing errors."""
        self.last_active = time.time()
        t = m.get('t')
        if t == 'chat':
            text = str(m.get('text', '')).strip()[:200]
            if text:
                self.log_seq += 1
                self.chat.append({'i': self.log_seq, 'p': p.id, 'n': p.name, 'm': text})
                if len(self.chat) > 100:
                    del self.chat[:40]
        elif t == 'appearance':
            if self.phase != 'lobby':
                raise GameError('Appearance can only be changed in the lobby')
            c, a = m.get('color'), m.get('avatar')
            if c in self.COLORS:
                if any(q.color == c and q is not p for q in self.players):
                    raise GameError('That colour is taken')
                p.color = c
            if a in self.AVATARS:
                p.avatar = a
        elif t == 'settings':
            self.need_host(p)
            if self.phase != 'lobby':
                raise GameError('Settings are locked once the game starts')
            s = m.get('settings')
            self.apply_settings(s if isinstance(s, dict) else {})
        elif t == 'addBot':
            self.need_host(p)
            names = [n for n in self.BOT_NAMES if not any(q.name == n for q in self.players)]
            self.add_player(random.choice(names) if names else 'Bot', is_bot=True)
        elif t == 'kick':
            self.need_host(p)
            q = self.pl(m.get('id'))
            if not q or q is p:
                raise GameError('Cannot remove that player')
            if self.phase == 'lobby':
                if q.conn:
                    q.conn.send({'t': 'kicked'})
                    q.conn.room = None
                    q.conn.player = None
                    q.conn = None
                self.remove_player(q)
            elif self.phase == 'playing' and not q.bankrupt:
                self.drop_player(q, 'was removed by the host')
        elif t == 'start':
            self.need_host(p)
            self.start_game()
        elif t == 'toLobby':
            self.need_host(p)
            if self.phase != 'ended':
                raise GameError('The game is still running')
            self.to_lobby()
        elif t == 'action':
            self.act(p, m)
        else:
            raise GameError('Unknown message')

    def to_lobby(self):
        self.cancel_timers()
        self.players = [p for p in self.players if p.is_bot or p.connected]
        for p in self.players:
            p.reset()
        self.g = None
        self.logs = []
        self.phase = 'lobby'
        self.fix_host()

    def cancel_timers(self):
        for name in self.TIMERS:
            h = getattr(self, name)
            if h:
                h.cancel()
            setattr(self, name, None)

    # ------------------------------------------------------------ what each game fills in
    def start_game(self):
        raise NotImplementedError

    def act(self, p, m):
        raise NotImplementedError

    def drop_player(self, p, reason):
        raise NotImplementedError

    def bot_plan(self):
        return None

    def bot_stuck(self):
        """Called when an automatic move has failed three times in a row."""
        self.bot_fail = 0

    # ------------------------------------------------------------ bots
    def is_auto(self, p):
        if p.bankrupt:
            return False
        return p.is_bot or (not p.connected and time.time() - p.disc_at > AFK_GRACE)

    def schedule_bots(self):
        if self.bot_timer or self.phase != 'playing':
            return
        if not self.humans_connected() and not self.spectators:
            return  # nobody is watching: pause until someone reconnects
        plan = self.bot_plan()
        if plan:
            self.bot_timer = self.loop.call_later(plan[0], self.bot_tick)

    def bot_tick(self):
        self.bot_timer = None
        if self.phase != 'playing':
            return
        plan = self.bot_plan()
        if plan:
            try:
                plan[1]()
                self.bot_fail = 0
            except GameError:
                self.bot_fail += 1
                if self.bot_fail >= 3:
                    self.bot_stuck()
            self.broadcast()
        self.schedule_bots()


class RaceRoom(BaseRoom):
    """Shared by the simple race games (Snakes & Ladders, Ludo): one die, a turn order,
    finishing places, and a short list of recent events that the client animates in order.

    Every change a player should *see happen* is recorded with emit(); the client plays the
    events it has not seen yet, one after another, then shows the final state.
    """
    BOOLS = ()  # names of the on/off settings of this game

    def __init__(self, code, loop):
        super().__init__(code, loop)
        self.busy_until = 0.0  # when the clients will have finished animating

    def apply_settings(self, s):
        super().apply_settings(s)
        for k in self.BOOLS:
            if isinstance(s.get(k), bool):
                self.settings[k] = s[k]

    # ------------------------------------------------------------ turns
    def begin(self, order, extra):
        for p in self.players:
            p.reset()
        self.g = {'order': order, 'turnIdx': 0, 'turnPhase': 'roll', 'die': 1, 'seq': 0, 'events': [],
                  'sixes': 0, 'ranks': [], 'winner': None}
        self.g.update(extra)
        self.logs = []
        self.phase = 'playing'
        self.busy_until = 0.0
        self.log(f'The game begins! {self.current().name} goes first.')

    def current(self):
        return self.pl(self.g['order'][self.g['turnIdx']])

    def emit(self, ev, secs):
        """Record something the clients should animate; secs is roughly how long it takes on screen."""
        g = self.g
        g['seq'] += 1
        ev['seq'] = g['seq']
        g['events'].append(ev)
        del g['events'][:-10]
        self.busy_until = max(self.busy_until, time.time()) + secs

    def need_turn(self, p, phase):
        if self.current() is not p:
            raise GameError('It is not your turn')
        if self.g['turnPhase'] != phase:
            raise GameError('You cannot do that right now')

    def racing(self):
        """Players still playing for a place, in turn order."""
        g = self.g
        ps = [self.pl(i) for i in g['order']]
        return [p for p in ps if p and not p.bankrupt and p.id not in g['ranks']]

    def next_turn(self):
        if self.phase != 'playing':
            return
        g = self.g
        n = len(g['order'])
        still = {p.id for p in self.racing()}
        for _ in range(n):
            g['turnIdx'] = (g['turnIdx'] + 1) % n
            if g['order'][g['turnIdx']] in still:
                break
        g['sixes'] = 0
        g['turnPhase'] = 'roll'

    def finish(self, p):
        """p has completed the course. Returns True when that ends the game."""
        g = self.g
        g['ranks'].append(p.id)
        place = len(g['ranks'])
        self.log(f'{p.name} wins the game! 🏆' if place == 1 else f'{p.name} finishes in place {place}', p)
        return self.check_end()

    def check_end(self):
        g = self.g
        left = self.racing()
        if len(left) <= 1 or (g['ranks'] and not self.settings.get('playOn')):
            if g['ranks'] and len(left) == 1 and self.settings.get('playOn'):
                g['ranks'].append(left[0].id)  # the last one still racing takes the last place
            if not g['ranks'] and left:
                g['ranks'].append(left[0].id)  # everyone else left: last player standing
                self.log(f'{left[0].name} wins the game! 🏆', left[0])
            self.end_game()
            return True
        return False

    def end_game(self):
        """Finish the game; g['ranks'] must already hold the finishing order."""
        g = self.g
        g['winner'] = g['ranks'][0] if g['ranks'] else None
        g['turnPhase'] = 'over'
        self.cancel_timers()
        self.phase = 'ended'
        self.emit({'k': 'end', 'winner': g['winner']}, 0)

    def on_drop(self, p):
        """Game-specific clean-up when p leaves a running game."""

    def drop_player(self, p, reason):
        if p.bankrupt or self.phase != 'playing':
            return
        was_turn = self.current() is p
        p.bankrupt = True
        self.on_drop(p)
        self.log(f'{p.name} {reason}', p)
        self.emit({'k': 'drop', 'p': p.id}, 0)
        if self.check_end():
            return
        if was_turn:
            self.next_turn()

    # ------------------------------------------------------------ actions
    def act(self, p, m):
        if self.phase != 'playing':
            raise GameError('The game is not running')
        if p.bankrupt:
            raise GameError('You are out of the game')
        a = m.get('a')
        if a == 'resign':
            return self.drop_player(p, 'left the game')
        if p.id in self.g['ranks']:
            raise GameError('You have already finished')
        self.play(p, a, m)

    def play(self, p, a, m):
        raise NotImplementedError

    def bot_turn(self, p):
        raise NotImplementedError

    def bot_plan(self):
        cur = self.current()
        if cur and self.is_auto(cur):
            wait = max(0.0, self.busy_until - time.time())
            return (wait + random.uniform(0.55, 0.95), lambda: self.bot_turn(cur))
        return None

    def bot_stuck(self):
        self.bot_fail = 0
        cur = self.current()
        if cur and self.is_auto(cur):
            self.drop_player(cur, 'could not continue')

    # ------------------------------------------------------------ networking
    def extra_state(self):
        return {}

    def game_state(self):
        g = self.g
        gs = {'turn': g['order'][g['turnIdx']], 'turnPhase': g['turnPhase'], 'die': g['die'],
              'seq': g['seq'], 'events': g['events'], 'order': g['order'], 'ranks': g['ranks'],
              'winner': g['winner']}
        gs.update(self.extra_state())
        return gs


class CardRoom(RaceRoom):
    """Card games: like RaceRoom, but each player also gets a private part of the state
    (their own hand) under the key 'you'. Nobody else, and no spectator, is ever sent it."""
    TIMERS = ('bot_timer', 'next_timer')

    def __init__(self, code, loop):
        super().__init__(code, loop)
        self.next_timer = None

    def private(self, p):
        return None

    def broadcast(self):
        st = self.state()
        st['you'] = None
        watchers = json.dumps(st, ensure_ascii=False, separators=(',', ':')) if self.spectators else None
        for p in self.players:
            if p.conn:
                st['you'] = self.private(p) if self.g else None
                p.conn.send_raw(json.dumps(st, ensure_ascii=False, separators=(',', ':')))
        for c in list(self.spectators):
            c.send_raw(watchers)

    def later(self, secs, fn):
        """Run fn after secs seconds (replacing any earlier pending call), then tell everyone."""
        if self.next_timer:
            self.next_timer.cancel()

        def fire():
            self.next_timer = None
            if self.phase != 'playing':
                return
            fn()
            self.broadcast()
            self.schedule_bots()
        self.next_timer = self.loop.call_later(secs, fire)
