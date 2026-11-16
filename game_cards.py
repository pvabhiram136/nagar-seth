"""Playing-card helpers shared by the card games: decks, Teen Patti hand ranks, Rummy melds.

A card is a 3-character string: rank, suit, deck number - 'QS0' is the queen of spades from
deck 0. Ranks are A 2 3 4 5 6 7 8 9 T J Q K, suits S H D C. A printed joker is 'XJ0', 'XJ1'.
"""
import random

RANKS = 'A23456789TJQK'
SUITS = 'SHDC'
VAL = {r: i + 1 for i, r in enumerate(RANKS)}  # A=1 ... K=13


def new_deck(decks=1, jokers=0):
    cards = [r + s + str(d) for d in range(decks) for s in SUITS for r in RANKS]
    cards += ['XJ' + str(j) for j in range(jokers)]
    random.shuffle(cards)
    return cards


# ---------------------------------------------------------------- Teen Patti
TP_NAMES = ['High card', 'Pair', 'Colour', 'Sequence', 'Pure sequence', 'Trail']


def tp_rank(cards):
    """Strength of a 3-card Teen Patti hand as a tuple; a bigger tuple beats a smaller one."""
    v = sorted((14 if c[0] == 'A' else VAL[c[0]] for c in cards), reverse=True)
    flush = len({c[1] for c in cards}) == 1
    seq = 0
    if v[0] - v[1] == 1 and v[1] - v[2] == 1:
        seq = v[0] + 1 if v[0] == 14 else v[0]  # A-K-Q is the best sequence ...
    elif v == [14, 3, 2]:
        seq = 14  # ... and A-2-3 the second best
    if v[0] == v[2]:
        return (5, v[0])
    if seq and flush:
        return (4, seq)
    if seq:
        return (3, seq)
    if flush:
        return (2, v[0], v[1], v[2])
    if v[0] == v[1]:
        return (1, v[0], v[2])
    if v[1] == v[2]:
        return (1, v[1], v[0])
    return (0, v[0], v[1], v[2])


def tp_name(cards):
    return TP_NAMES[tp_rank(cards)[0]]


# ---------------------------------------------------------------- Rummy
def card_points(c, wild):
    """Penalty points of a card left outside a meld. Jokers cost nothing."""
    if c[0] == 'X' or c[0] == wild:
        return 0
    return 10 if c[0] in 'ATJQK' else VAL[c[0]]


class _Search:
    """Finds the best way to split a rummy hand into melds.

    Melds: "pure" (run of 3+ in one suit with no joker standing in), "seq" (a run that uses
    jokers) and "set" (3-4 cards of one rank in different suits, jokers allowed).
    Mode "score" minimises the official penalty points; mode "bot" minimises a gentler
    measure that also rewards being close to a pure sequence, to guide the bots.
    With spare=True the hand holds one card too many (the player has just drawn): the search
    also picks the best card to throw away, never the card named in ban.
    """

    def __init__(self, cards, wild, mode='score', spare=False, ban=None, limit=30000):
        self.wild = wild
        self.mode = mode
        self.spare = spare
        self.ban = ban
        self.nodes = limit
        self.best = None
        self.best_val = 10 ** 9
        self.all = list(cards)
        self.total = sum(card_points(c, wild) for c in cards)
        printed = [c for c in cards if c[0] == 'X']
        wilds = [c for c in cards if c[0] == wild]
        plain = [c for c in cards if c[0] != 'X' and c[0] != wild]
        flex, forced = wilds[:5], wilds[5:]
        # a card of the wild rank may act as a joker or as itself: try every split, most jokers first
        for mask in range((1 << len(flex)) - 1, -1, -1):
            jokers = [c for i, c in enumerate(flex) if mask >> i & 1]
            natural = [c for i, c in enumerate(flex) if not mask >> i & 1]
            rest = sorted(plain + natural, key=lambda c: (c[1], VAL[c[0]], c[2]))
            self.go(rest, printed + forced + jokers, [], [], 0)

    # one finished arrangement ---------------------------------------------
    def throw(self, cands, weight):
        """The costliest card that may be thrown away, or None."""
        cands = [c for c in cands if c != self.ban]
        return max(cands, key=weight) if cands else None

    def leaf(self, free, melds, dead, dead_pts):
        pts_of = lambda c: card_points(c, self.wild)
        pure = sum(1 for t, _ in melds if t == 'pure')
        seqs = sum(1 for t, _ in melds if t != 'set')
        loose_jokers = [c for c in dead if c[0] == self.wild]
        dead = [c for c in dead if c[0] != self.wild]
        free = list(free) + loose_jokers
        good = pure >= 1 and seqs >= 2
        sp = None
        if self.mode == 'score':
            if good:
                counted = dead
            elif pure:
                counted = dead + [c for t, cs in melds if t != 'pure' for c in cs]
            else:
                counted = [c for c in self.all if pts_of(c)]
            pts = sum(pts_of(c) for c in counted)
            if self.spare:
                sp = self.throw(dead, pts_of) or self.throw(counted, pts_of)
                if sp is None:  # nothing loose: give up a spare joker or the end of a long meld
                    ends = [cs[-1] for t, cs in melds if len(cs) >= 4] + [cs[0] for t, cs in melds if len(cs) >= 4]
                    sp = self.throw(free, pts_of) or self.throw(ends, pts_of) or self.throw(self.all, pts_of)
                elif sp in counted:
                    pts -= pts_of(sp)
            pts = min(80, pts)
            complete = good and (len(dead) <= 1 if self.spare else not dead) and (not dead or not self.spare or sp in dead)
            val = pts - (0.5 if complete else 0) - 0.01 * sum(len(cs) for _, cs in melds)
        else:
            def weight(c):
                near = any(o is not c and o[0] != 'X' and ((o[1] == c[1] and 0 < abs(VAL[o[0]] - VAL[c[0]]) <= 2)
                                                         or (o[0] == c[0] and o[1] != c[1])) for o in self.all)
                return pts_of(c) * (0.6 if near else 1.0)
            loose = sum(weight(c) for c in dead)
            if self.spare:
                sp = self.throw(dead, weight)
                if sp is not None:
                    loose -= weight(sp)
                else:
                    sets = [c for t, cs in melds if t == 'set' for c in cs if pts_of(c)]
                    ends = [cs[-1] for t, cs in melds if len(cs) >= 4 and pts_of(cs[-1])]
                    sp = (self.throw(ends, pts_of) or self.throw(sets, pts_of) or self.throw(free, pts_of)
                          or self.throw(self.all, pts_of))
            pts = min(80, sum(pts_of(c) for c in dead))
            complete = good and (len(dead) <= 1 if self.spare else not dead) and (not dead or not self.spare or sp in dead)
            val = loose + (0 if pure else 28) + (0 if seqs >= 2 else 14) - (5 if complete else 0)
        if val < self.best_val:
            self.best_val = val
            self.best = {'melds': [(t, list(cs)) for t, cs in melds], 'dead': dead, 'free': free, 'points': pts,
                         'complete': complete, 'pure': pure, 'seqs': seqs, 'val': val, 'spare': sp}

    # depth-first search: decide the first undecided card, then the rest ------
    def go(self, rest, free, melds, dead, dead_pts):
        if self.nodes <= 0:
            return
        self.nodes -= 1
        slack = 11 if self.spare else 1
        if (dead_pts - slack if self.mode == 'score' else (dead_pts - slack) * 0.6 - 6) >= self.best_val:
            return
        if not rest:
            return self.leaf(free, melds, dead, dead_pts)
        c, others = rest[0], rest[1:]
        suit, v = c[1], VAL[c[0]]
        same_suit = {}
        for o in others:
            if o[1] == suit:
                same_suit.setdefault(VAL[o[0]], o)

        def done(cards, jok):
            used = set(cards)
            self.go([o for o in others if o not in used], free[jok:], melds + [('seq' if jok else 'pure', cards)],
                    dead, dead_pts)

        def up(cards, top, jok):
            """Grow a run upwards from c. top: value just placed; jok: jokers used so far."""
            if len(cards) >= 3:
                done(cards, jok)
            if len(cards) >= 13:
                return
            nxt = top + 1
            if nxt == 14:
                if len(cards) == 2 and jok < len(free):  # Q-K-joker: the joker stands for the ace
                    done(cards + [free[jok]], jok + 1)
                return
            o = same_suit.get(nxt)
            if o is not None:
                up(cards + [o], nxt, jok)
            if jok < len(free):
                up(cards + [free[jok]], nxt, jok + 1)

        def down(cards, low, jok):
            """Grow a run downwards from an ace played high (Q-K-A)."""
            if len(cards) >= 3:
                done(cards, jok)
            nxt = low - 1
            if nxt < 2 or len(cards) >= 13:
                return
            o = same_suit.get(nxt)
            if o is not None:
                down([o] + cards, nxt, jok)
            if jok < len(free):
                down([free[jok]] + cards, nxt, jok + 1)

        # 1. runs
        up([c], v, 0)
        if v == 1:
            down([c], 14, 0)
        if v == 13 and len(free) >= 2:
            done([free[0], free[1], c], 2)  # joker-joker-K

        # 2. sets of the same rank as c
        mates = {}
        for o in others:
            if o[0] == c[0] and o[1] != suit:
                mates.setdefault(o[1], o)
        mates = list(mates.values())
        for mask in range(1 << len(mates)):
            pick = [m for i, m in enumerate(mates) if mask >> i & 1]
            for j in range(0, min(len(free), 2) + 1):
                if 3 <= 1 + len(pick) + j <= 4:
                    self.go([o for o in others if o not in pick], free[j:], melds + [('set', [c] + pick + free[:j])],
                            dead, dead_pts)

        # 3. c stays loose
        self.go(others, free, melds, dead + [c], dead_pts + card_points(c, self.wild))


def arrange(cards, wild, mode='score', spare=False, ban=None, limit=30000):
    """Best arrangement of a hand: {melds: [(type, [cards])], dead: [...], free: [jokers not
    needed], points: penalty, complete: True when the hand can be declared, spare: the card to
    throw away (only with spare=True, for a 14-card hand)}."""
    return _Search(cards, wild, mode, spare, ban, limit).best


def check_melds(res, wild):
    """Used by the tests: every meld in an arrangement really is legal."""
    for t, cs in res['melds']:
        assert len(cs) >= 3, cs
        if t == 'set':
            assert len(cs) <= 4, cs
            ranks = {c[0] for c in cs if c[0] != 'X' and c[0] != wild}
            assert len(ranks) <= 1, cs
            rank = ranks.pop() if ranks else wild
            real = [c for c in cs if c[0] == rank]
            assert len({c[1] for c in real}) == len(real), cs
        else:
            assert len(cs) <= 13, cs
            if t == 'pure':
                assert not any(c[0] == 'X' for c in cs), cs
            fits = False  # some suit and start value where every card is itself or (in a "seq") a joker
            for start in range(1, 15 - len(cs) + 1):
                for suit in SUITS:
                    ok = True
                    for i, c in enumerate(cs):
                        want = RANKS[(start + i - 1) % 13]
                        natural = c[0] == want and c[1] == suit
                        if not natural and (t == 'pure' or not (c[0] == 'X' or c[0] == wild)):
                            ok = False
                            break
                    fits = fits or ok
            assert fits, (t, cs)
    return True
