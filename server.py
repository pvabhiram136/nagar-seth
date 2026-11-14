"""Nagar Seth - multiplayer server.

Pure standard-library Python (3.9+): serves the web page and speaks WebSocket
on the same port, so there is nothing to install.

    python server.py            -> http://localhost:8000
    PORT=5000 python server.py  -> custom port (hosting services set PORT for you)
"""
import asyncio
import base64
import hashlib
import json
import os
import random
import socket
import struct
import sys
import time

from game import AFK_GRACE, BOARD_PUBLIC, HOST_GRACE, GameError, Room

BASE = os.path.dirname(os.path.abspath(__file__))
# The page normally lives in public/. If the files were uploaded flat (all in one
# folder, as some hosts' drag-and-drop does), serve them from next to this file.
ROOT = os.path.join(BASE, 'public') if os.path.isfile(os.path.join(BASE, 'public', 'index.html')) else BASE
PAGE_TYPES = ('.html', '.css', '.js', '.svg', '.png', '.ico', '.webmanifest')
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
MIME = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml',
        '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
        '.webmanifest': 'application/manifest+json'}
ROOMS = {}
CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
MAX_ROOMS = 500
LOBBY_GRACE = 8


def frame(op, payload):
    n = len(payload)
    if n < 126:
        head = bytes([0x80 | op, n])
    elif n < 65536:
        head = bytes([0x80 | op, 126]) + struct.pack('>H', n)
    else:
        head = bytes([0x80 | op, 127]) + struct.pack('>Q', n)
    return head + payload


class Conn:
    def __init__(self, reader, writer):
        self.r = reader
        self.w = writer
        self.room = None
        self.player = None
        self.alive = True

    def _write(self, data):
        if not self.alive:
            return
        try:
            if self.w.transport.get_write_buffer_size() > 2_000_000:
                raise ConnectionError('client too slow')
            self.w.write(data)
        except Exception:
            self.alive = False
            try:
                self.w.close()
            except Exception:
                pass

    def send_raw(self, text):
        self._write(frame(1, text.encode('utf-8')))

    def send(self, obj):
        self.send_raw(json.dumps(obj, ensure_ascii=False, separators=(',', ':')))

    def ping(self):
        self._write(frame(9, b''))

    def close(self):
        self._write(frame(8, b''))
        self.alive = False
        try:
            self.w.close()
        except Exception:
            pass

    async def recv(self):
        """Return the next text message, or None when the socket closes."""
        buf = b''
        while True:
            h = await self.r.readexactly(2)
            fin, op = h[0] & 0x80, h[0] & 0x0F
            masked, n = h[1] & 0x80, h[1] & 0x7F
            if n == 126:
                n = struct.unpack('>H', await self.r.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', await self.r.readexactly(8))[0]
            if n > 65536 or len(buf) + n > 65536:
                return None
            mask = await self.r.readexactly(4) if masked else None
            data = await self.r.readexactly(n) if n else b''
            if mask:
                data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
            if op == 8:
                return None
            if op == 9:
                self._write(frame(10, data))
                continue
            if op == 10:
                continue
            buf += data
            if fin:
                return buf.decode('utf-8', 'replace')


def clean_name(s):
    s = ' '.join(str(s or '').split())[:16]
    return s or 'Player'


def new_code():
    while True:
        code = ''.join(random.choice(CODE_CHARS) for _ in range(5))
        if code not in ROOMS:
            return code


def joined(conn, room, p):
    conn.room = room
    conn.player = p
    conn.send({'t': 'joined', 'code': room.code, 'you': p.id if p else None,
               'token': p.token if p else None, 'board': BOARD_PUBLIC})
    room.fix_host()
    room.broadcast()
    room.schedule_bots()


def on_message(conn, m):
    t = m.get('t')
    loop = asyncio.get_running_loop()
    if conn.room is None:
        if t == 'create':
            if len(ROOMS) >= MAX_ROOMS:
                return conn.send({'t': 'error', 'm': 'Server is full, try again later'})
            room = Room(new_code(), loop)
            ROOMS[room.code] = room
            p = room.add_player(clean_name(m.get('name')))
            p.conn, p.connected = conn, True
            joined(conn, room, p)
        elif t == 'join':
            room = ROOMS.get(str(m.get('code', '')).upper().strip())
            if not room:
                return conn.send({'t': 'error', 'm': 'Room not found — check the code', 'fatal': True})
            tok = m.get('token')
            p = next((q for q in room.players if tok and q.token == tok and not q.is_bot), None)
            if p and p.connected and not m.get('strong'):
                p = None  # another tab of the same browser: treat as a new person
            if not p and room.phase != 'lobby':
                # No saved seat (new device, or the public link changed): a player who
                # dropped out can take their seat back by joining with the same name.
                nm = clean_name(m.get('name')).lower()
                p = next((q for q in room.players if not q.is_bot and not q.connected
                          and not q.bankrupt and q.name.lower() == nm), None)
            if p:
                if p.conn and p.conn is not conn:
                    old = p.conn
                    old.room = old.player = None
                    old.send({'t': 'replaced'})
                    old.close()
                p.conn, p.connected = conn, True
            elif room.phase == 'lobby':
                try:
                    p = room.add_player(clean_name(m.get('name')))
                except GameError as e:
                    return conn.send({'t': 'error', 'm': str(e), 'fatal': True})
                p.conn, p.connected = conn, True
            else:
                room.spectators.add(conn)
            joined(conn, room, p)
        return
    room, p = conn.room, conn.player
    if p is None:
        return  # spectators only watch
    try:
        room.handle(p, m)
    except GameError as e:
        conn.send({'t': 'error', 'm': str(e)})
    room.broadcast()
    room.schedule_bots()


def on_disconnect(conn):
    room, p = conn.room, conn.player
    conn.alive = False
    if not room:
        return
    room.spectators.discard(conn)
    if p and p.conn is conn:
        p.conn = None
        p.connected = False
        p.disc_at = time.time()
        loop = asyncio.get_running_loop()
        if room.phase == 'lobby':
            def drop():
                if not p.connected and room.phase == 'lobby' and p in room.players:
                    room.remove_player(p)
                    room.broadcast()
            loop.call_later(LOBBY_GRACE, drop)
        else:
            loop.call_later(AFK_GRACE + 0.5, room.schedule_bots)

        def rehost():
            before = room.host_id
            room.fix_host()
            if room.host_id != before:
                room.broadcast()
        loop.call_later(HOST_GRACE + 0.5, rehost)
        room.broadcast()


async def ws_session(conn):
    async def pinger():
        while conn.alive:
            await asyncio.sleep(25)
            conn.ping()
    task = asyncio.ensure_future(pinger())
    try:
        while True:
            raw = await conn.recv()
            if raw is None:
                break
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            if isinstance(m, dict):
                try:
                    on_message(conn, m)
                except Exception as e:  # never let one bad message kill the room
                    print('error handling message:', repr(e), file=sys.stderr)
                    import traceback
                    traceback.print_exc()
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        pass
    finally:
        task.cancel()
        on_disconnect(conn)


def http_response(status, body=b'', ctype='text/plain; charset=utf-8', head_only=False):
    head = (f'HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n'
            'Cache-Control: no-cache\r\nConnection: close\r\n\r\n').encode()
    return head if head_only else head + body


async def handle(reader, writer):
    try:
        line = await asyncio.wait_for(reader.readline(), 20)
        parts = line.decode('latin1').split()
        if len(parts) < 2:
            return
        method, path = parts[0], parts[1].split('?')[0]
        headers = {}
        while True:
            ln = await asyncio.wait_for(reader.readline(), 20)
            if ln in (b'\r\n', b'\n', b''):
                break
            k, _, v = ln.decode('latin1').partition(':')
            headers[k.strip().lower()] = v.strip()
        if headers.get('upgrade', '').lower() == 'websocket':
            key = headers.get('sec-websocket-key', '')
            accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
            writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
                          f'Connection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n').encode())
            await ws_session(Conn(reader, writer))
            return
        if method not in ('GET', 'HEAD'):
            writer.write(http_response('405 Method Not Allowed', b'Method not allowed'))
            return
        rel = path.lstrip('/')
        if not rel or '.' not in os.path.basename(rel):
            rel = 'index.html'
        full = os.path.normpath(os.path.join(ROOT, rel))
        if (not full.startswith(ROOT) or not os.path.isfile(full)
                or os.path.splitext(full)[1].lower() not in PAGE_TYPES):
            writer.write(http_response('404 Not Found', b'Not found'))
            return
        with open(full, 'rb') as f:
            body = f.read()
        ctype = MIME.get(os.path.splitext(full)[1].lower(), 'application/octet-stream')
        writer.write(http_response('200 OK', body, ctype, head_only=(method == 'HEAD')))
        await writer.drain()
    except (asyncio.TimeoutError, ConnectionError, OSError, UnicodeError):
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def sweeper():
    """Forget rooms that nobody has been connected to for a while."""
    while True:
        await asyncio.sleep(60)
        now = time.time()
        for code, room in list(ROOMS.items()):
            if not room.humans_connected() and not room.spectators and now - room.last_active > 900:
                room.cancel_timers()
                del ROOMS[code]


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


async def main():
    port = int(os.environ.get('PORT', '8000'))
    server = await asyncio.start_server(handle, '0.0.0.0', port)
    print('Nagar Seth is running!')
    print(f'  On this computer : http://localhost:{port}')
    ip = lan_ip()
    if ip:
        print(f'  Same Wi-Fi       : http://{ip}:{port}')
    print('Press Ctrl+C to stop.', flush=True)
    asyncio.ensure_future(sweeper())
    async with server:
        await server.serve_forever()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
