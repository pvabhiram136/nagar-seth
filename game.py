"""Nagar Seth - game engine (board data, rules, rooms, bots).

Everything here is synchronous and runs inside the server's asyncio loop.
The server only needs: Room, Player, GameError, BOARD_PUBLIC.
"""
import json
import random
import secrets
import time

SALARY = 200_000
JAIL_FINE = 50_000
JAIL_POS = 10
GST_AMOUNT = 75_000
RENT_MULT = [1, 5, 15, 40, 52, 65]
STATION_RENT = [25_000, 50_000, 100_000, 200_000]
AUCTION_FIRST_SECS = 10
AUCTION_BID_SECS = 7
AFK_GRACE = 20  # seconds before a disconnected player is auto-played
HOST_GRACE = 10  # seconds a disconnected host keeps the host role

GROUPS = {
    'g1': {'name': 'Bihar & Jharkhand', 'color': '#b08968', 'houseCost': 50_000},
    'g2': {'name': 'Central India', 'color': '#4fc3f7', 'houseCost': 50_000},
    'g3': {'name': 'Uttar Pradesh', 'color': '#ba68c8', 'houseCost': 100_000},
    'g4': {'name': 'Rajasthan', 'color': '#ff8a65', 'houseCost': 100_000},
    'g5': {'name': 'The South', 'color': '#26a69a', 'houseCost': 150_000},
    'g6': {'name': 'The West', 'color': '#ffd54f', 'houseCost': 150_000},
    'g7': {'name': 'Big Metros', 'color': '#ec407a', 'houseCost': 200_000},
    'g8': {'name': 'Power Capitals', 'color': '#7986cb', 'houseCost': 200_000},
}


def _city(name, group, price):
    base = (price * 7 + 50_000) // 100_000 * 1000
    return {'type': 'city', 'name': name, 'group': group, 'price': price,
            'rents': [base * m for m in RENT_MULT],
            'houseCost': GROUPS[group]['houseCost']}


def _station(name, short):
    return {'type': 'station', 'name': name, 'short': short, 'group': 'rail', 'price': 200_000}


def _utility(name, short, icon):
    return {'type': 'utility', 'name': name, 'short': short, 'group': 'util', 'price': 150_000, 'icon': icon}


def _card(deck):
    return {'type': 'card', 'deck': deck, 'name': 'Kismat' if deck == 'kismat' else 'Khazana'}


TILES = [
    {'type': 'start', 'name': 'Shuru'},
    _city('Patna', 'g1', 60_000),
    _card('khazana'),
    _city('Ranchi', 'g1', 60_000),
    {'type': 'tax', 'name': 'Income Tax', 'kind': 'income'},
    _station('New Delhi Railway Station', 'NDLS'),
    _city('Bhopal', 'g2', 100_000),
    _card('kismat'),
    _city('Indore', 'g2', 100_000),
    _city('Raipur', 'g2', 120_000),
    {'type': 'jail', 'name': 'Jail'},
    _city('Lucknow', 'g3', 140_000),
    _utility('Bijli Board', 'Bijli', '💡'),
    _city('Kanpur', 'g3', 140_000),
    _city('Varanasi', 'g3', 160_000),
    _station('Howrah Junction', 'HWH'),
    _city('Jaipur', 'g4', 180_000),
    _card('khazana'),
    _city('Udaipur', 'g4', 180_000),
    _city('Jodhpur', 'g4', 200_000),
    {'type': 'vacation', 'name': 'Goa Chhutti'},
    _city('Kochi', 'g5', 220_000),
    _card('kismat'),
    _city('Coimbatore', 'g5', 220_000),
    _city('Chennai', 'g5', 240_000),
    _station('Chennai Central', 'MAS'),
    _city('Ahmedabad', 'g6', 260_000),
    _city('Surat', 'g6', 260_000),
    _utility('Jal Board', 'Jal', '🚰'),
    _city('Pune', 'g6', 280_000),
    {'type': 'gotojail', 'name': 'Go to Jail'},
    _city('Kolkata', 'g7', 300_000),
    _city('Hyderabad', 'g7', 300_000),
    _card('khazana'),
    _city('Bengaluru', 'g7', 320_000),
    _station('Mumbai CSMT', 'CSMT'),
    _card('kismat'),
    _city('Delhi', 'g8', 350_000),
    {'type': 'tax', 'name': 'GST', 'kind': 'gst'},
    _city('Mumbai', 'g8', 400_000),
]
N = len(TILES)
OWNABLE = ('city', 'station', 'utility')
GROUP_TILES = {}
for _i, _t in enumerate(TILES):
    if _t['type'] in OWNABLE:
        GROUP_TILES.setdefault(_t['group'], []).append(_i)
STATIONS = GROUP_TILES['rail']
TILE_BY_NAME = {t['name']: i for i, t in enumerate(TILES)}

KISMAT = [
    {'text': 'Your startup gets funded! Collect ₹1,50,000.', 'fx': 'cash', 'amt': 150_000},
    {'text': 'Fresh start! Advance to Shuru and collect your salary.', 'fx': 'moveTo', 'to': 0},
    {'text': 'Caught without a ticket on the local train. Pay ₹15,000.', 'fx': 'cash', 'amt': -15_000},
    {'text': 'Hop on the express! Advance to the nearest railway station.', 'fx': 'nearestStation'},
    {'text': 'Raid at your office! Go directly to Jail.', 'fx': 'jail'},
    {'text': 'A good lawyer in the family. Keep this Bail Card for later.', 'fx': 'jailCard'},
    {'text': 'Wrong turn at the chowk. Go back 3 spaces.', 'fx': 'back', 'n': 3},
    {'text': 'Business trip! Advance to Mumbai.', 'fx': 'moveTo', 'to': TILE_BY_NAME['Mumbai']},
    {'text': 'Diwali bonus arrives. Collect ₹1,00,000.', 'fx': 'cash', 'amt': 100_000},
    {'text': 'Monsoon damages your buildings. Pay ₹25,000 per house and ₹1,00,000 per hotel.',
     'fx': 'repairs', 'house': 25_000, 'hotel': 100_000},
    {'text': 'You host a big fat wedding. Pay every player ₹50,000.', 'fx': 'payEach', 'amt': 50_000},
    {'text': 'Your cricket fantasy team tops the table. Collect ₹50,000.', 'fx': 'cash', 'amt': 50_000},
    {'text': 'Heritage tour! Advance to Jaipur.', 'fx': 'moveTo', 'to': TILE_BY_NAME['Jaipur']},
    {'text': 'Traffic challan for jumping a signal. Pay ₹20,000.', 'fx': 'cash', 'amt': -20_000},
    {'text': 'Time for a break. Advance to Goa Chhutti.', 'fx': 'moveTo', 'to': 20},
    {'text': 'Catch the night mail. Advance to Howrah Junction.', 'fx': 'moveTo', 'to': TILE_BY_NAME['Howrah Junction']},
]
KHAZANA = [
    {'text': 'Income tax refund credited. Collect ₹20,000.', 'fx': 'cash', 'amt': 20_000},
    {'text': 'Your fixed deposit matures. Collect ₹1,00,000.', 'fx': 'cash', 'amt': 100_000},
    {'text': 'Hospital bill. Pay ₹1,00,000.', 'fx': 'cash', 'amt': -100_000},
    {'text': 'School fees are due. Pay ₹50,000.', 'fx': 'cash', 'amt': -50_000},
    {'text': "It's your birthday! Collect ₹10,000 from every player.", 'fx': 'collectEach', 'amt': 10_000},
    {'text': 'You inherit ancestral land. Collect ₹1,00,000.', 'fx': 'cash', 'amt': 100_000},
    {'text': 'An old friend is now a judge. Keep this Bail Card for later.', 'fx': 'jailCard'},
    {'text': 'Papers not in order. Go directly to Jail.', 'fx': 'jail'},
    {'text': 'You win the colony rangoli contest. Collect ₹10,000.', 'fx': 'cash', 'amt': 10_000},
    {'text': 'Sold old gold jewellery at a great rate. Collect ₹50,000.', 'fx': 'cash', 'amt': 50_000},
    {'text': 'Municipal repairs notice. Pay ₹40,000 per house and ₹1,15,000 per hotel.',
     'fx': 'repairs', 'house': 40_000, 'hotel': 115_000},
    {'text': 'Consultancy fee received. Collect ₹25,000.', 'fx': 'cash', 'amt': 25_000},
    {'text': 'Cashback jackpot on a payment app! Collect ₹2,00,000.', 'fx': 'cash', 'amt': 200_000},
    {'text': 'Back to where it began. Advance to Shuru.', 'fx': 'moveTo', 'to': 0},
    {'text': 'Your monthly investments pay off. Collect ₹45,000.', 'fx': 'cash', 'amt': 45_000},
    {'text': 'Paid the electricity bill late. Pay ₹50,000.', 'fx': 'cash', 'amt': -50_000},
]
DECKS = {'kismat': KISMAT, 'khazana': KHAZANA}

COLORS = ['#ff6b6b', '#ffa94d', '#ffe066', '#69db7c', '#3bc9db', '#748ffc', '#da77f2', '#f783ac']
AVATARS = ['🛺', '🐘', '🐅', '🦚', '🏏', '🪁', '☕', '🛕', '🥭', '🪔', '🚂', '🐪']
BOT_NAMES = ['Seth Dhaniram', 'Lala Kuberchand', 'Munshi Ji', 'Nawab Sahab',
             'Rani Sahiba', 'Thakur Sahab', 'Bibi Ji']
STARTING_CASH_OPTIONS = [1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000]
BOOL_SETTINGS = ['doubleRent', 'vacationCash', 'auction', 'noRentInJail', 'mortgage', 'evenBuild', 'randomOrder']

BOARD_PUBLIC = {
    'tiles': TILES, 'groups': GROUPS, 'colors': COLORS, 'avatars': AVATARS,
    'salary': SALARY, 'jailFine': JAIL_FINE, 'stationRent': STATION_RENT,
    'startingCashOptions': STARTING_CASH_OPTIONS, 'gst': GST_AMOUNT,
}


def inr(n):
    n = int(n)
    s = str(abs(n))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ','.join(parts) + ',' + tail
    return ('-' if n < 0 else '') + '₹' + s


class GameError(Exception):
    pass


class Player:
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
        self.cash = 0
        self.pos = 0
        self.in_jail = False
        self.jail_turns = 0
        self.jail_cards = 0
        self.bankrupt = False
        self.debt_to = None
        self.mv = {'seq': 0, 'steps': []}

    def public(self):
        return {'id': self.id, 'name': self.name, 'color': self.color, 'avatar': self.avatar,
                'bot': self.is_bot, 'connected': self.connected, 'cash': self.cash, 'pos': self.pos,
                'inJail': self.in_jail, 'jailTurns': self.jail_turns, 'jailCards': self.jail_cards,
                'bankrupt': self.bankrupt, 'mv': self.mv}


class Room:
    def __init__(self, code, loop):
        self.code = code
        self.loop = loop
        self.players = []
        self.spectators = set()
        self.host_id = None
        self.phase = 'lobby'
        self.settings = {'startingCash': 1_500_000, 'maxPlayers': 6, 'doubleRent': True,
                         'vacationCash': True, 'auction': True, 'noRentInJail': False,
                         'mortgage': True, 'evenBuild': True, 'randomOrder': True}
        self.g = None
        self.logs = []
        self.chat = []
        self.log_seq = 0
        self.bot_timer = None
        self.auction_timer = None
        self.bot_fail = 0
        self.last_active = time.time()

    # ------------------------------------------------------------ helpers
    def pl(self, pid):
        for p in self.players:
            if p.id == pid:
                return p
        return None

    def alive(self):
        return [p for p in self.players if not p.bankrupt]

    def current(self):
        return self.pl(self.g['order'][self.g['turnIdx']])

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

    # ------------------------------------------------------------ networking
    def state(self):
        g = self.g
        gs = None
        if g:
            a = g['auction']
            gs = {'turn': g['order'][g['turnIdx']], 'turnPhase': g['turnPhase'], 'dice': g['dice'],
                  'rollSeq': g['rollSeq'], 'again': g['again'], 'owner': g['owner'],
                  'houses': g['houses'], 'mortgaged': g['mortgaged'], 'pot': g['pot'],
                  'trades': g['trades'], 'card': g['card'], 'winner': g['winner'], 'order': g['order'],
                  'auction': None if not a else {
                      'tile': a['tile'], 'bid': a['bid'], 'bidder': a['bidder'],
                      'endsIn': max(0, int((a['ends'] - time.time()) * 1000))}}
        return {'t': 'state', 'code': self.code, 'phase': self.phase, 'hostId': self.host_id,
                'settings': self.settings, 'players': [p.public() for p in self.players],
                'g': gs, 'log': self.logs[-60:], 'chat': self.chat[-60:]}

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
        p = Player(name, is_bot)
        used = {q.color for q in self.players}
        p.color = next((c for c in COLORS if c not in used), COLORS[0])
        used_av = {q.avatar for q in self.players}
        p.avatar = next((a for a in AVATARS if a not in used_av), AVATARS[0])
        self.players.append(p)
        if self.host_id is None and not is_bot:
            self.host_id = p.id
        return p

    def remove_player(self, p):
        if p in self.players:
            self.players.remove(p)
        self.fix_host()

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
            if c in COLORS:
                if any(q.color == c and q is not p for q in self.players):
                    raise GameError('That colour is taken')
                p.color = c
            if a in AVATARS:
                p.avatar = a
        elif t == 'settings':
            self.need_host(p)
            if self.phase != 'lobby':
                raise GameError('Settings are locked once the game starts')
            s = m.get('settings') or {}
            if s.get('startingCash') in STARTING_CASH_OPTIONS:
                self.settings['startingCash'] = s['startingCash']
            mp = s.get('maxPlayers')
            if isinstance(mp, int) and 2 <= mp <= 8 and mp >= len(self.players):
                self.settings['maxPlayers'] = mp
            for k in BOOL_SETTINGS:
                if isinstance(s.get(k), bool):
                    self.settings[k] = s[k]
        elif t == 'addBot':
            self.need_host(p)
            names = [n for n in BOT_NAMES if not any(q.name == n for q in self.players)]
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
                self.bankrupt(q, 'was removed by the host')
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

    def need_host(self, p):
        if p.id != self.host_id:
            raise GameError('Only the host can do that')

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
        for name in ('bot_timer', 'auction_timer'):
            h = getattr(self, name)
            if h:
                h.cancel()
            setattr(self, name, None)

    def start_game(self):
        if self.phase != 'lobby':
            raise GameError('The game has already started')
        if len(self.players) < 2:
            raise GameError('You need at least 2 players (add a friend or a bot)')
        order = [p.id for p in self.players]
        if self.settings['randomOrder']:
            random.shuffle(order)
        for p in self.players:
            p.reset()
            p.cash = self.settings['startingCash']
        decks = {}
        for k, cards in DECKS.items():
            d = list(range(len(cards)))
            random.shuffle(d)
            decks[k] = d
        self.g = {'order': order, 'turnIdx': 0, 'turnPhase': 'roll', 'dice': [1, 1], 'rollSeq': 0,
                  'doubles': 0, 'again': False, 'owner': [None] * N, 'houses': [0] * N,
                  'mortgaged': [False] * N, 'pot': 0, 'auction': None, 'trades': [], 'tradeSeq': 0,
                  'card': None, 'cardSeq': 0, 'winner': None, 'decks': decks}
        self.logs = []
        self.phase = 'playing'
        self.log(f'The game begins! {self.current().name} goes first.')

    # ------------------------------------------------------------ actions
    def act(self, p, m):
        if self.phase != 'playing':
            raise GameError('The game is not running')
        if p.bankrupt:
            raise GameError('You are out of the game')
        a = m.get('a')
        g = self.g
        if a == 'bid':
            return self.bid(p, m.get('amount'))
        if a == 'bankrupt':
            return self.bankrupt(p)
        if g['auction']:
            raise GameError('Wait for the auction to finish')
        tile = m.get('tile')
        if a in ('build', 'sellHouse', 'mortgage', 'unmortgage'):
            if not isinstance(tile, int) or not (0 <= tile < N) or g['owner'][tile] != p.id:
                raise GameError('You do not own that property')
        if a == 'roll':
            self.roll(p)
        elif a == 'buy':
            self.buy(p)
        elif a == 'decline':
            self.decline(p)
        elif a == 'endTurn':
            self.end_turn(p)
        elif a == 'payJail':
            self.pay_jail(p)
        elif a == 'useJailCard':
            self.use_jail_card(p)
        elif a == 'build':
            self.build(p, tile)
        elif a == 'sellHouse':
            self.sell_house(p, tile)
        elif a == 'mortgage':
            self.mortgage(p, tile)
        elif a == 'unmortgage':
            self.unmortgage(p, tile)
        elif a == 'tradePropose':
            self.trade_propose(p, m)
        elif a == 'tradeAccept':
            self.trade_accept(p, m.get('id'))
        elif a in ('tradeDecline', 'tradeCancel'):
            self.trade_remove(p, m.get('id'))
        else:
            raise GameError('Unknown action')

    def need_turn(self, p, phase):
        g = self.g
        if self.current() is not p:
            raise GameError('It is not your turn')
        if g['turnPhase'] != phase:
            raise GameError('You cannot do that right now')

    def roll(self, p):
        g = self.g
        self.need_turn(p, 'roll')
        if p.cash < 0:
            raise GameError('Clear your debt first')
        d1, d2 = random.randint(1, 6), random.randint(1, 6)
        g['dice'] = [d1, d2]
        g['rollSeq'] += 1
        p.mv = {'seq': p.mv['seq'] + 1, 'steps': []}
        dbl = d1 == d2
        total = d1 + d2
        g['again'] = False
        self.log(f'{p.name} rolled {d1} + {d2}' + (' — doubles!' if dbl else ''), p)
        if p.in_jail:
            if dbl:
                p.in_jail = False
                p.jail_turns = 0
                self.log(f'{p.name} rolled doubles and walks out of jail', p)
            else:
                p.jail_turns += 1
                if p.jail_turns >= 3:
                    p.in_jail = False
                    p.jail_turns = 0
                    self.pay(p, JAIL_FINE, None, 'the jail fine after 3 turns')
                else:
                    g['turnPhase'] = 'end'
                    return
        elif dbl:
            g['doubles'] += 1
            if g['doubles'] >= 3:
                self.log(f'{p.name} rolled three doubles in a row — off to jail!', p)
                self.go_to_jail(p)
                g['turnPhase'] = 'end'
                return
            g['again'] = True
        self.move_by(p, total)
        self.land(p, total)
        if g['turnPhase'] != 'buy':
            self.post_roll()

    def post_roll(self):
        if self.phase != 'playing':
            return
        g = self.g
        p = self.current()
        if p.bankrupt:
            return self.next_turn()
        g['turnPhase'] = 'roll' if (g['again'] and not p.in_jail) else 'end'

    def next_turn(self):
        if self.phase != 'playing':
            return
        g = self.g
        n = len(g['order'])
        for _ in range(n):
            g['turnIdx'] = (g['turnIdx'] + 1) % n
            if not self.pl(g['order'][g['turnIdx']]).bankrupt:
                break
        g['doubles'] = 0
        g['again'] = False
        g['turnPhase'] = 'roll'

    def end_turn(self, p):
        self.need_turn(p, 'end')
        if p.cash < 0:
            raise GameError('Clear your debt first — sell, mortgage, trade or declare bankruptcy')
        self.next_turn()

    # movement -----------------------------------------------------------
    def salary(self, p):
        p.cash += SALARY
        self.log(f'{p.name} passed Shuru and collected {inr(SALARY)}', p)

    def move_by(self, p, n):
        new = (p.pos + n) % N
        if new < p.pos:
            self.salary(p)
        p.pos = new
        p.mv['steps'].append({'to': new, 'kind': 'walk'})

    def move_to(self, p, idx):
        if idx <= p.pos:
            self.salary(p)
        p.pos = idx
        p.mv['steps'].append({'to': idx, 'kind': 'walk'})

    def go_to_jail(self, p):
        p.pos = JAIL_POS
        p.in_jail = True
        p.jail_turns = 0
        p.mv['steps'].append({'to': JAIL_POS, 'kind': 'jump'})
        self.g['again'] = False
        self.log(f'{p.name} is sent to jail', p)

    def land(self, p, dice_total):
        g = self.g
        t = TILES[p.pos]
        ty = t['type']
        if ty in OWNABLE:
            oid = g['owner'][p.pos]
            if oid is None:
                g['turnPhase'] = 'buy'
            elif oid != p.id:
                o = self.pl(oid)
                if g['mortgaged'][p.pos]:
                    self.log(f"{p.name} landed on {t['name']} — mortgaged, no rent", p)
                elif o.in_jail and self.settings['noRentInJail']:
                    self.log(f"{p.name} landed on {t['name']} — {o.name} is in jail, no rent", p)
                else:
                    self.pay(p, self.rent(p.pos, dice_total), o, f"rent for {t['name']}")
        elif ty == 'tax':
            if t['kind'] == 'income':
                amt = max(0, p.cash) // 10 // 1000 * 1000
                self.pay(p, amt, None, 'income tax (10%)')
            else:
                self.pay(p, GST_AMOUNT, None, 'GST')
        elif ty == 'card':
            self.draw(p, t['deck'], dice_total)
        elif ty == 'vacation':
            if self.settings['vacationCash'] and g['pot'] > 0:
                p.cash += g['pot']
                self.log(f"{p.name} reached Goa and scooped the holiday pot of {inr(g['pot'])}!", p)
                g['pot'] = 0
            else:
                self.log(f'{p.name} is relaxing in Goa', p)
        elif ty == 'gotojail':
            self.go_to_jail(p)

    def owns_group(self, pid, gid):
        return all(self.g['owner'][i] == pid for i in GROUP_TILES[gid])

    def rent(self, idx, dice_total):
        g = self.g
        t = TILES[idx]
        oid = g['owner'][idx]
        if t['type'] == 'city':
            h = g['houses'][idx]
            if h > 0:
                return t['rents'][h]
            r = t['rents'][0]
            if self.settings['doubleRent'] and self.owns_group(oid, t['group']):
                r *= 2
            return r
        if t['type'] == 'station':
            n = sum(1 for i in STATIONS if g['owner'][i] == oid)
            return STATION_RENT[n - 1]
        n = sum(1 for i in GROUP_TILES['util'] if g['owner'][i] == oid)
        return dice_total * (10_000 if n >= 2 else 4_000)

    def pay(self, p, amount, to, what):
        if amount <= 0:
            return
        p.cash -= amount
        if to:
            to.cash += amount
            self.log(f'{p.name} paid {inr(amount)} to {to.name} — {what}', p)
        else:
            if self.settings['vacationCash']:
                self.g['pot'] += amount
            self.log(f'{p.name} paid {inr(amount)} — {what}', p)
        if p.cash < 0:
            p.debt_to = to.id if to else None

    def draw(self, p, deck, dice_total):
        g = self.g
        d = g['decks'][deck]
        ci = d.pop(0)
        d.append(ci)
        c = DECKS[deck][ci]
        g['cardSeq'] += 1
        g['card'] = {'seq': g['cardSeq'], 'deck': deck, 'text': c['text'], 'p': p.id}
        self.log(f"{p.name} drew {'Kismat' if deck == 'kismat' else 'Khazana'}: {c['text']}", p)
        fx = c['fx']
        if fx == 'cash':
            if c['amt'] >= 0:
                p.cash += c['amt']
            else:
                self.pay(p, -c['amt'], None, 'card')
        elif fx == 'moveTo':
            self.move_to(p, c['to'])
            self.land(p, dice_total)
        elif fx == 'nearestStation':
            nxt = next((i for i in STATIONS if i > p.pos), STATIONS[0])
            self.move_to(p, nxt)
            self.land(p, dice_total)
        elif fx == 'back':
            p.pos = (p.pos - c['n']) % N
            p.mv['steps'].append({'to': p.pos, 'kind': 'back'})
            self.land(p, dice_total)
        elif fx == 'jail':
            self.go_to_jail(p)
        elif fx == 'jailCard':
            p.jail_cards += 1
        elif fx == 'repairs':
            total = 0
            for i in range(N):
                if g['owner'][i] == p.id:
                    h = g['houses'][i]
                    total += c['hotel'] if h == 5 else h * c['house']
            self.pay(p, total, None, 'repairs')
        elif fx == 'payEach':
            for o in self.alive():
                if o is not p:
                    self.pay(p, c['amt'], o, 'card')
        elif fx == 'collectEach':
            for o in self.alive():
                if o is not p:
                    self.pay(o, c['amt'], p, 'card')

    # buying & auctions ----------------------------------------------------
    def buy(self, p):
        g = self.g
        self.need_turn(p, 'buy')
        t = TILES[p.pos]
        if p.cash < t['price']:
            raise GameError('You cannot afford this')
        p.cash -= t['price']
        g['owner'][p.pos] = p.id
        self.log(f"{p.name} bought {t['name']} for {inr(t['price'])}", p)
        self.post_roll()

    def decline(self, p):
        g = self.g
        self.need_turn(p, 'buy')
        t = TILES[p.pos]
        if not self.settings['auction']:
            self.log(f"{p.name} passed on {t['name']}", p)
            return self.post_roll()
        g['auction'] = {'tile': p.pos, 'bid': 0, 'bidder': None, 'limits': {},
                        'ends': time.time() + AUCTION_FIRST_SECS}
        self.log(f"{t['name']} goes under the hammer!", p)
        self.auction_timer = self.loop.call_later(AUCTION_FIRST_SECS, self.auction_end)

    def bid(self, p, amount):
        a = self.g['auction']
        if not a:
            raise GameError('There is no auction right now')
        if not isinstance(amount, int) or amount <= a['bid'] or amount % 1000:
            raise GameError('Bid too low')
        if amount > p.cash:
            raise GameError('You do not have that much cash')
        a['bid'] = amount
        a['bidder'] = p.id
        a['ends'] = time.time() + AUCTION_BID_SECS
        if self.auction_timer:
            self.auction_timer.cancel()
        self.auction_timer = self.loop.call_later(AUCTION_BID_SECS, self.auction_end)

    def auction_end(self):
        self.auction_timer = None
        if self.phase != 'playing':
            return
        g = self.g
        a = g['auction']
        if not a:
            return
        g['auction'] = None
        t = TILES[a['tile']]
        w = self.pl(a['bidder']) if a['bidder'] else None
        if w and not w.bankrupt:
            w.cash -= a['bid']
            g['owner'][a['tile']] = w.id
            self.log(f"{w.name} won {t['name']} at auction for {inr(a['bid'])}", w)
        else:
            self.log(f"No bids — {t['name']} stays unsold")
        self.post_roll()
        self.broadcast()
        self.schedule_bots()

    # jail ---------------------------------------------------------------
    def pay_jail(self, p):
        self.need_turn(p, 'roll')
        if not p.in_jail:
            raise GameError('You are not in jail')
        if p.cash < JAIL_FINE:
            raise GameError('Not enough cash for bail')
        p.in_jail = False
        p.jail_turns = 0
        self.pay(p, JAIL_FINE, None, 'bail')

    def use_jail_card(self, p):
        self.need_turn(p, 'roll')
        if not p.in_jail or p.jail_cards < 1:
            raise GameError('You have no Bail Card to use')
        p.jail_cards -= 1
        p.in_jail = False
        p.jail_turns = 0
        self.log(f'{p.name} used a Bail Card', p)

    # building & mortgages -------------------------------------------------
    def group_houses(self, gid):
        return [self.g['houses'][i] for i in GROUP_TILES[gid]]

    def can_build(self, p, idx):
        g = self.g
        t = TILES[idx]
        if t['type'] != 'city':
            return 'You can only build in cities'
        if self.current() is not p:
            return 'You can only build on your turn'
        if not self.owns_group(p.id, t['group']):
            return 'Own every city of this colour first'
        if any(g['mortgaged'][i] for i in GROUP_TILES[t['group']]):
            return 'Unmortgage the whole set first'
        if g['houses'][idx] >= 5:
            return 'Already has a hotel'
        if self.settings['evenBuild'] and g['houses'][idx] > min(self.group_houses(t['group'])):
            return 'Build evenly across the set'
        if p.cash < t['houseCost']:
            return 'Not enough cash'
        return None

    def build(self, p, idx):
        err = self.can_build(p, idx)
        if err:
            raise GameError(err)
        g = self.g
        t = TILES[idx]
        p.cash -= t['houseCost']
        g['houses'][idx] += 1
        what = 'a hotel' if g['houses'][idx] == 5 else 'a house'
        self.log(f"{p.name} built {what} in {t['name']}", p)

    def sell_house(self, p, idx):
        g = self.g
        t = TILES[idx]
        if t['type'] != 'city' or g['houses'][idx] < 1:
            raise GameError('Nothing to sell there')
        if self.settings['evenBuild'] and g['houses'][idx] < max(self.group_houses(t['group'])):
            raise GameError('Sell evenly across the set')
        g['houses'][idx] -= 1
        p.cash += t['houseCost'] // 2
        self.log(f"{p.name} sold a building in {t['name']} for {inr(t['houseCost'] // 2)}", p)

    def mortgage(self, p, idx):
        g = self.g
        t = TILES[idx]
        if not self.settings['mortgage']:
            raise GameError('Mortgages are switched off in this room')
        if g['mortgaged'][idx]:
            raise GameError('Already mortgaged')
        if any(g['houses'][i] for i in GROUP_TILES[t['group']]):
            raise GameError('Sell the buildings in this set first')
        g['mortgaged'][idx] = True
        p.cash += t['price'] // 2
        self.log(f"{p.name} mortgaged {t['name']} for {inr(t['price'] // 2)}", p)

    def unmortgage_cost(self, idx):
        return TILES[idx]['price'] * 55 // 100

    def unmortgage(self, p, idx):
        g = self.g
        if not g['mortgaged'][idx]:
            raise GameError('Not mortgaged')
        cost = self.unmortgage_cost(idx)
        if p.cash < cost:
            raise GameError('Not enough cash')
        p.cash -= cost
        g['mortgaged'][idx] = False
        self.log(f"{p.name} cleared the mortgage on {TILES[idx]['name']}", p)

    # trades ---------------------------------------------------------------
    def check_trade(self, t):
        g = self.g
        a, b = self.pl(t['from']), self.pl(t['to'])
        if not a or not b or a is b or a.bankrupt or b.bankrupt:
            return 'That player is not available'
        for side, owner in ((t['give'], a), (t['get'], b)):
            if side['cash'] > max(0, owner.cash):
                return f'{owner.name} does not have enough cash'
            for i in side['tiles']:
                if g['owner'][i] != owner.id:
                    return f"{owner.name} no longer owns {TILES[i]['name']}"
                if any(g['houses'][j] for j in GROUP_TILES[TILES[i]['group']]):
                    return f"Sell the buildings around {TILES[i]['name']} before trading it"
        return None

    def trade_propose(self, p, m):
        g = self.g

        def side(x):
            x = x or {}
            cash = x.get('cash', 0)
            tiles = x.get('tiles', [])
            if not isinstance(cash, int) or cash < 0 or not isinstance(tiles, list):
                raise GameError('Invalid trade')
            tiles = sorted({i for i in tiles if isinstance(i, int) and 0 <= i < N})
            return {'cash': cash, 'tiles': tiles}

        t = {'from': p.id, 'to': m.get('to'), 'give': side(m.get('give')), 'get': side(m.get('get'))}
        if not (t['give']['cash'] or t['give']['tiles'] or t['get']['cash'] or t['get']['tiles']):
            raise GameError('The trade is empty')
        err = self.check_trade(t)
        if err:
            raise GameError(err)
        if sum(1 for x in g['trades'] if x['from'] == p.id) >= 5:
            raise GameError('You have too many open offers — cancel one first')
        g['tradeSeq'] += 1
        t['id'] = g['tradeSeq']
        g['trades'].append(t)
        self.log(f"{p.name} offered a trade to {self.pl(t['to']).name}", p)

    def find_trade(self, tid):
        for t in self.g['trades']:
            if t['id'] == tid:
                return t
        raise GameError('That trade is no longer available')

    def trade_accept(self, p, tid):
        g = self.g
        t = self.find_trade(tid)
        if t['to'] != p.id:
            raise GameError('That offer is not for you')
        err = self.check_trade(t)
        if err:
            g['trades'].remove(t)
            raise GameError(err)
        a, b = self.pl(t['from']), p
        a.cash += t['get']['cash'] - t['give']['cash']
        b.cash += t['give']['cash'] - t['get']['cash']
        for i in t['give']['tiles']:
            g['owner'][i] = b.id
        for i in t['get']['tiles']:
            g['owner'][i] = a.id
        g['trades'].remove(t)
        moved = set(t['give']['tiles']) | set(t['get']['tiles'])
        g['trades'] = [x for x in g['trades']
                       if not (moved & (set(x['give']['tiles']) | set(x['get']['tiles'])))]
        self.log(f'{b.name} accepted a trade with {a.name}', b)

    def trade_remove(self, p, tid):
        t = self.find_trade(tid)
        if p.id not in (t['from'], t['to']):
            raise GameError('That is not your trade')
        self.g['trades'].remove(t)
        other = self.pl(t['from'] if p.id == t['to'] else t['to'])
        verb = 'declined a trade from' if p.id == t['to'] else 'withdrew an offer to'
        self.log(f'{p.name} {verb} {other.name}', p)

    # bankruptcy -----------------------------------------------------------
    def bankrupt(self, p, reason='declared bankruptcy'):
        g = self.g
        for i in range(N):
            if g['owner'][i] == p.id and g['houses'][i]:
                p.cash += g['houses'][i] * TILES[i]['houseCost'] // 2
                g['houses'][i] = 0
        cred = self.pl(p.debt_to) if (p.cash < 0 and p.debt_to) else None
        if cred and cred.bankrupt:
            cred = None
        if cred:
            cred.cash += p.cash  # claw back what the debtor could not really pay
        for i in range(N):
            if g['owner'][i] == p.id:
                if cred:
                    g['owner'][i] = cred.id
                else:
                    g['owner'][i] = None
                    g['mortgaged'][i] = False
        p.cash = 0
        p.bankrupt = True
        p.in_jail = False
        p.jail_cards = 0
        g['trades'] = [t for t in g['trades'] if p.id not in (t['from'], t['to'])]
        a = g['auction']
        if a and a['bidder'] == p.id:
            a['bidder'] = None
            a['bid'] = 0
        self.log(f'{p.name} {reason}' + (f' — everything goes to {cred.name}' if cred else ''), p)
        alive = self.alive()
        if len(alive) <= 1:
            self.cancel_timers()
            g['auction'] = None
            g['winner'] = alive[0].id if alive else None
            self.phase = 'ended'
            if alive:
                self.log(f'{alive[0].name} wins the game! 🏆', alive[0])
            return
        if self.current() is p and not g['auction']:
            self.next_turn()

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
                cur = self.current()
                if self.bot_fail >= 3 and self.is_auto(cur) and not self.g['auction']:
                    self.bot_fail = 0
                    self.bankrupt(cur, 'could not continue')
            self.broadcast()
        self.schedule_bots()

    def bot_plan(self):
        g = self.g
        a = g['auction']
        if a:
            t = TILES[a['tile']]
            bots = [p for p in self.alive() if p.is_bot and p.id != a['bidder']]
            random.shuffle(bots)
            for p in bots:
                if p.id not in a['limits']:
                    want = t['price'] * random.uniform(0.45, 1.0)
                    if all(g['owner'][i] == p.id for i in GROUP_TILES[t['group']] if i != a['tile']):
                        want = t['price'] * 1.4
                    a['limits'][p.id] = int(min(want, p.cash - 50_000)) // 1000 * 1000
                lim = min(a['limits'][p.id], p.cash)
                nxt = a['bid'] + (10_000 if lim - a['bid'] > 30_000 else 2_000)
                if nxt <= lim:
                    return (random.uniform(0.8, 2.2), lambda p=p, nxt=nxt: self.bid(p, nxt))
            return None
        for t in g['trades']:
            to = self.pl(t['to'])
            if to and self.is_auto(to):
                return (2.0, lambda to=to, t=t: self.bot_trade_reply(to, t))
        cur = self.current()
        if self.is_auto(cur):
            return (random.uniform(0.9, 1.5), lambda: self.bot_turn(cur))
        return None

    def bot_turn(self, p):
        g = self.g
        if p.cash < 0:
            if not self.bot_raise(p):
                self.bankrupt(p, 'went bankrupt')
            return
        ph = g['turnPhase']
        if ph == 'roll':
            if p.in_jail:
                if p.jail_cards:
                    return self.use_jail_card(p)
                unowned = any(g['owner'][i] is None for i in range(N) if TILES[i]['type'] in OWNABLE)
                if unowned and p.cash >= JAIL_FINE + 200_000:
                    return self.pay_jail(p)
            self.roll(p)
        elif ph == 'buy':
            price = TILES[p.pos]['price']
            if p.is_bot and p.cash - price >= 20_000:
                self.buy(p)
            else:
                self.decline(p)
        else:
            if p.is_bot and self.bot_improve(p):
                return
            self.end_turn(p)

    def bot_raise(self, p):
        """Take one step towards clearing a debt. Returns False when nothing is left to sell."""
        g = self.g
        mine = [i for i in range(N) if g['owner'][i] == p.id]
        built = [i for i in mine if g['houses'][i] > 0]
        if built:
            i = max(built, key=lambda j: g['houses'][j])
            self.sell_house(p, i)
            return True
        if self.settings['mortgage']:
            free = [i for i in mine if not g['mortgaged'][i]]
            if free:
                self.mortgage(p, min(free, key=lambda j: TILES[j]['price']))
                return True
        return False

    def bot_improve(self, p):
        g = self.g
        mine = [i for i in range(N) if g['owner'][i] == p.id]
        for i in mine:
            if g['mortgaged'][i] and p.cash >= self.unmortgage_cost(i) + 250_000:
                self.unmortgage(p, i)
                return True
        cands = [i for i in mine if TILES[i]['type'] == 'city' and not self.can_build(p, i)
                 and p.cash - TILES[i]['houseCost'] >= 200_000]
        if cands:
            self.build(p, min(cands, key=lambda j: (g['houses'][j], -TILES[j]['price'])))
            return True
        return False

    def bot_trade_reply(self, to, t):
        g = self.g
        if not to.is_bot:
            return self.trade_remove(to, t['id'])

        def worth(side):
            return side['cash'] + sum(TILES[i]['price'] // (2 if g['mortgaged'][i] else 1) for i in side['tiles'])

        def completes(pid, tiles_in, tiles_out):
            for i in tiles_in:
                grp = GROUP_TILES[TILES[i]['group']]
                if all((g['owner'][j] == pid and j not in tiles_out) or j in tiles_in for j in grp):
                    return True
            return False

        gain, loss = worth(t['give']), worth(t['get'])
        they_complete = completes(t['from'], t['get']['tiles'], t['give']['tiles'])
        i_complete = completes(to.id, t['give']['tiles'], t['get']['tiles'])
        ok = gain >= loss * 1.15 and (not they_complete or i_complete or gain >= loss * 2)
        if ok and not self.check_trade(t):
            self.trade_accept(to, t['id'])
        else:
            self.trade_remove(to, t['id'])
