"""RupeeRush - game engine (board data, rules, rooms, bots).

Everything here is synchronous and runs inside the server's asyncio loop.
The lobby, chat, host and bot timer live in rooms.py (shared by every game);
this file adds only the RupeeRush rules.
"""
import random
import time

from rooms import AVATARS, COLORS, BasePlayer, BaseRoom, GameError

SALARY = 200
JAIL_FINE = 50
JAIL_POS = 10
GST_AMOUNT = 75
RENT_MULT = [1, 5, 15, 40, 52, 65]
STATION_RENT = [25, 50, 100, 200]
AUCTION_FIRST_SECS = 10
AUCTION_BID_SECS = 7

GROUPS = {
    'g1': {'name': 'Uttar Pradesh', 'color': '#b08968', 'houseCost': 50},
    'g2': {'name': 'Rajasthan', 'color': '#4fc3f7', 'houseCost': 50},
    'g3': {'name': 'Gujarat', 'color': '#ba68c8', 'houseCost': 100},
    'g4': {'name': 'West Bengal', 'color': '#ff8a65', 'houseCost': 100},
    'g5': {'name': 'Tamil Nadu', 'color': '#26a69a', 'houseCost': 150},
    'g6': {'name': 'Telangana', 'color': '#ffd54f', 'houseCost': 150},
    'g7': {'name': 'Karnataka', 'color': '#ec407a', 'houseCost': 200},
    'g8': {'name': 'Maharashtra', 'color': '#7986cb', 'houseCost': 200},
}


def _city(name, group, price):
    base = (price * 7 + 50) // 100
    return {'type': 'city', 'name': name, 'group': group, 'price': price,
            'rents': [base * m for m in RENT_MULT],
            'houseCost': GROUPS[group]['houseCost']}


def _station(name, short):
    return {'type': 'station', 'name': name, 'short': short, 'group': 'rail', 'price': 200}


def _utility(name, short, icon):
    return {'type': 'utility', 'name': name, 'short': short, 'group': 'util', 'price': 150, 'icon': icon}


DECK_NAMES = {'luck': 'Lucky Card', 'treasure': 'Treasure'}


def _card(deck):
    return {'type': 'card', 'deck': deck, 'name': DECK_NAMES[deck]}


# Every colour set is one state; the last city of a set is its biggest.
TILES = [
    {'type': 'start', 'name': 'Start'},
    _city('Varanasi', 'g1', 60),
    _card('treasure'),
    _city('Lucknow', 'g1', 60),
    {'type': 'tax', 'name': 'Income Tax', 'kind': 'income'},
    _station('New Delhi Railway Station', 'New Delhi'),
    _city('Udaipur', 'g2', 100),
    _card('luck'),
    _city('Jodhpur', 'g2', 100),
    _city('Jaipur', 'g2', 120),
    {'type': 'jail', 'name': 'Jail'},
    _city('Vadodara', 'g3', 140),
    _utility('Electricity Board', 'Power', '💡'),
    _city('Surat', 'g3', 140),
    _city('Ahmedabad', 'g3', 160),
    _station('Howrah Junction', 'Howrah'),
    _city('Siliguri', 'g4', 180),
    _card('treasure'),
    _city('Darjeeling', 'g4', 180),
    _city('Kolkata', 'g4', 200),
    {'type': 'vacation', 'name': 'Goa Vacation'},
    _city('Coimbatore', 'g5', 220),
    _card('luck'),
    _city('Madurai', 'g5', 220),
    _city('Chennai', 'g5', 240),
    _station('Chennai Central', 'Chennai Ctrl'),
    _city('Warangal', 'g6', 260),
    _city('Nizamabad', 'g6', 260),
    _utility('Water Board', 'Water', '🚰'),
    _city('Hyderabad', 'g6', 280),
    {'type': 'gotojail', 'name': 'Go to Jail'},
    _city('Mysuru', 'g7', 300),
    _city('Mangaluru', 'g7', 300),
    _card('treasure'),
    _city('Bengaluru', 'g7', 320),
    _station('Mumbai CSMT', 'CSMT'),
    _card('luck'),
    _city('Pune', 'g8', 350),
    {'type': 'tax', 'name': 'GST', 'kind': 'gst'},
    _city('Mumbai', 'g8', 400),
]
N = len(TILES)
OWNABLE = ('city', 'station', 'utility')
GROUP_TILES = {}
for _i, _t in enumerate(TILES):
    if _t['type'] in OWNABLE:
        GROUP_TILES.setdefault(_t['group'], []).append(_i)
STATIONS = GROUP_TILES['rail']
TILE_BY_NAME = {t['name']: i for i, t in enumerate(TILES)}

LUCK = [
    {'text': 'Your startup gets funded! Collect ₹150.', 'fx': 'cash', 'amt': 150},
    {'text': 'Fresh start! Advance to Start and collect your salary.', 'fx': 'moveTo', 'to': 0},
    {'text': 'Caught without a ticket on the local train. Pay ₹15.', 'fx': 'cash', 'amt': -15},
    {'text': 'Hop on the express! Advance to the nearest railway station.', 'fx': 'nearestStation'},
    {'text': 'Raid at your office! Go directly to Jail.', 'fx': 'jail'},
    {'text': 'A good lawyer in the family. Keep this Bail Card for later.', 'fx': 'jailCard'},
    {'text': 'Wrong turn at the junction. Go back 3 spaces.', 'fx': 'back', 'n': 3},
    {'text': 'Business trip! Advance to Mumbai.', 'fx': 'moveTo', 'to': TILE_BY_NAME['Mumbai']},
    {'text': 'Diwali bonus arrives. Collect ₹100.', 'fx': 'cash', 'amt': 100},
    {'text': 'Monsoon damages your buildings. Pay ₹25 per house and ₹100 per hotel.',
     'fx': 'repairs', 'house': 25, 'hotel': 100},
    {'text': 'You host a big fat wedding. Pay every player ₹50.', 'fx': 'payEach', 'amt': 50},
    {'text': 'Your cricket fantasy team tops the table. Collect ₹50.', 'fx': 'cash', 'amt': 50},
    {'text': 'Heritage tour! Advance to Jaipur.', 'fx': 'moveTo', 'to': TILE_BY_NAME['Jaipur']},
    {'text': 'Traffic fine for jumping a signal. Pay ₹20.', 'fx': 'cash', 'amt': -20},
    {'text': 'Time for a break. Advance to Goa Vacation.', 'fx': 'moveTo', 'to': 20},
    {'text': 'Catch the night mail. Advance to Howrah Junction.', 'fx': 'moveTo', 'to': TILE_BY_NAME['Howrah Junction']},
]
TREASURE = [
    {'text': 'Income tax refund credited. Collect ₹20.', 'fx': 'cash', 'amt': 20},
    {'text': 'Your fixed deposit matures. Collect ₹100.', 'fx': 'cash', 'amt': 100},
    {'text': 'Hospital bill. Pay ₹100.', 'fx': 'cash', 'amt': -100},
    {'text': 'School fees are due. Pay ₹50.', 'fx': 'cash', 'amt': -50},
    {'text': "It's your birthday! Collect ₹10 from every player.", 'fx': 'collectEach', 'amt': 10},
    {'text': 'You inherit ancestral land. Collect ₹100.', 'fx': 'cash', 'amt': 100},
    {'text': 'An old friend is now a judge. Keep this Bail Card for later.', 'fx': 'jailCard'},
    {'text': 'Papers not in order. Go directly to Jail.', 'fx': 'jail'},
    {'text': 'You win the neighbourhood talent contest. Collect ₹10.', 'fx': 'cash', 'amt': 10},
    {'text': 'Sold old gold jewellery at a great rate. Collect ₹50.', 'fx': 'cash', 'amt': 50},
    {'text': 'Municipal repairs notice. Pay ₹40 per house and ₹115 per hotel.',
     'fx': 'repairs', 'house': 40, 'hotel': 115},
    {'text': 'Consultancy fee received. Collect ₹25.', 'fx': 'cash', 'amt': 25},
    {'text': 'Cashback jackpot on a payment app! Collect ₹200.', 'fx': 'cash', 'amt': 200},
    {'text': 'Back to where it began. Advance to Start.', 'fx': 'moveTo', 'to': 0},
    {'text': 'Your monthly investments pay off. Collect ₹45.', 'fx': 'cash', 'amt': 45},
    {'text': 'Paid the electricity bill late. Pay ₹50.', 'fx': 'cash', 'amt': -50},
]
DECKS = {'luck': LUCK, 'treasure': TREASURE}

STARTING_CASH_OPTIONS = [1_000, 1_500, 2_000, 2_500, 3_000]
BOOL_SETTINGS = ['doubleRent', 'vacationCash', 'auction', 'noRentInJail', 'mortgage', 'evenBuild', 'randomOrder']

BOARD_PUBLIC = {
    'tiles': TILES, 'groups': GROUPS, 'colors': COLORS, 'avatars': AVATARS,
    'salary': SALARY, 'jailFine': JAIL_FINE, 'stationRent': STATION_RENT,
    'startingCashOptions': STARTING_CASH_OPTIONS, 'gst': GST_AMOUNT,
}


def inr(n):
    n = int(n)
    return ('-' if n < 0 else '') + '₹' + format(abs(n), ',')


class Player(BasePlayer):
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


class Room(BaseRoom):
    GAME = 'rupeerush'
    BOARD = BOARD_PUBLIC
    PLAYER = Player
    MAX_SEATS = 8
    TIMERS = ('bot_timer', 'auction_timer')

    def __init__(self, code, loop):
        super().__init__(code, loop)
        self.auction_timer = None

    def default_settings(self):
        return {'startingCash': 1_500, 'maxPlayers': 6, 'doubleRent': True,
                'vacationCash': True, 'auction': True, 'noRentInJail': False,
                'mortgage': True, 'evenBuild': True, 'randomOrder': True}

    def apply_settings(self, s):
        if s.get('startingCash') in STARTING_CASH_OPTIONS:
            self.settings['startingCash'] = s['startingCash']
        super().apply_settings(s)
        for k in BOOL_SETTINGS:
            if isinstance(s.get(k), bool):
                self.settings[k] = s[k]

    def drop_player(self, p, reason):
        self.bankrupt(p, reason)

    def bot_stuck(self):
        cur = self.current()
        if self.is_auto(cur) and not self.g['auction']:
            self.bot_fail = 0
            self.bankrupt(cur, 'could not continue')

    # ------------------------------------------------------------ helpers
    def current(self):
        return self.pl(self.g['order'][self.g['turnIdx']])

    # ------------------------------------------------------------ networking
    def game_state(self):
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
        return gs

    # ------------------------------------------------------------ lobby

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
        self.log(f'{p.name} passed Start and collected {inr(SALARY)}', p)

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
                amt = max(0, p.cash) // 10
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
        return dice_total * (10 if n >= 2 else 4)

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
        self.log(f"{p.name} drew a {DECK_NAMES[deck]} card: {c['text']}", p)
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
        if not isinstance(amount, int) or amount <= a['bid'] or amount > 1_000_000:
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
                    a['limits'][p.id] = int(min(want, p.cash - 50))
                lim = min(a['limits'][p.id], p.cash)
                nxt = a['bid'] + (10 if lim - a['bid'] > 30 else 2)
                if nxt <= lim:
                    return (random.uniform(0.8, 2.2), lambda p=p, nxt=nxt: self.bid(p, nxt))
            return None
        for t in g['trades']:
            to = self.pl(t['to'])
            if to and self.is_auto(to):
                return (2.0, lambda to=to, t=t: self.bot_trade_reply(to, t))
        cur = self.current()
        if self.is_auto(cur):
            return (random.uniform(1.6, 2.3), lambda: self.bot_turn(cur))
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
                if unowned and p.cash >= JAIL_FINE + 200:
                    return self.pay_jail(p)
            self.roll(p)
        elif ph == 'buy':
            price = TILES[p.pos]['price']
            if p.is_bot and p.cash - price >= 20:
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
            if g['mortgaged'][i] and p.cash >= self.unmortgage_cost(i) + 250:
                self.unmortgage(p, i)
                return True
        cands = [i for i in mine if TILES[i]['type'] == 'city' and not self.can_build(p, i)
                 and p.cash - TILES[i]['houseCost'] >= 200]
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
