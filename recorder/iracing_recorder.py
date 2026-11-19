#!/usr/bin/env python3
"""iRacing recorder: switches iRacing's telemetry recording on and off.

A small program that runs next to iRacing on the same Windows PC and works with
the Setup and Telemetry web app. It needs Python 3.8 or later and nothing else.

What it does
  - Watches for iRacing through the sim's own SDK (read-only shared memory).
  - In automatic mode, switches disk telemetry on whenever the sim is running,
    so every run is recorded without pressing Alt+L. iRacing itself only writes
    a file while you are in the car, and closes it when you get out.
  - Lets the web app start, stop and split recording, and tells it when a run
    has been saved, so the app can pick the new file up straight away.

How it talks to iRacing
  Only through the two channels iRacing provides for add-on programs:
  - reading the telemetry memory the sim publishes ("Local\\IRSDKMemMapFileName")
  - sending the SDK's telemetry command (broadcast message 10: stop, start,
    restart), which is the same switch as Alt+L
  It never writes to the sim's memory, files or settings and injects nothing.

How it talks to the web app
  A tiny web server on this computer only (127.0.0.1). It answers
    GET  /status    what the sim and the recording are doing
    POST /command   {"cmd": "start" | "stop" | "restart" | "auto" | "manual"}
  Pages opened from disk and pages on localhost may call it. Any other website
  is refused unless you list it with --allow-origin.

Run it
  python iracing_recorder.py              automatic mode, port 8765
  python iracing_recorder.py --manual     only record when the app says so
  python iracing_recorder.py --simulate   no iRacing needed: a pretend sim, for testing
"""
import argparse
import json
import os
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '1.0'
DEFAULT_PORT = 8765

# iRacing SDK constants (irsdk_defines.h)
MEMMAP_NAME = 'Local\\IRSDKMemMapFileName'
MEMMAP_SIZE = 1164 * 1024
BROADCAST_NAME = 'IRSDK_BROADCASTMSG'
BROADCAST_TELEM_COMMAND = 10          # irsdk_BroadcastTelemCommand
TELEM = {'stop': 0, 'start': 1, 'restart': 2}   # irsdk_TelemCommandMode
STATUS_CONNECTED = 1
HEADER_SIZE = 112                      # 10 ints, 2 pad ints, 4 buffers of 16 bytes
VAR_HEADER_SIZE = 144
WANTED = ('IsOnTrack', 'IsDiskLoggingEnabled', 'IsDiskLoggingActive')


# ---------------------------------------------------------------- reading the sim

class SimReader:
    """Reads a few yes/no values out of iRacing's telemetry memory.

    mem is anything with read(offset, length) -> bytes, or None when the memory
    is not there. The layout is the same as the header of an .ibt file.
    """

    def __init__(self):
        self._vars = None        # name -> (type, offset)
        self._layout = None      # (numVars, varHeaderOffset) the map was built for

    def read(self, mem):
        """-> dict(connected, on_track, enabled, active). enabled/active are None if the sim does not publish them."""
        off = {'connected': False, 'on_track': False, 'enabled': None, 'active': None}
        if mem is None:
            self._vars = None
            return off
        head = mem.read(0, HEADER_SIZE)
        if len(head) < HEADER_SIZE:
            return off
        (_ver, status, _tick, _upd, _ilen, _ioff, num_vars, var_off, num_buf, buf_len) = struct.unpack_from('<10i', head, 0)
        if not (status & STATUS_CONNECTED) or num_vars <= 0 or num_vars > 4096 or not (0 < num_buf <= 4):
            self._vars = None
            return off
        if self._vars is None or self._layout != (num_vars, var_off):
            self._vars = self._read_var_headers(mem, num_vars, var_off)
            self._layout = (num_vars, var_off)
        # The sim rotates between buffers; the one with the highest tick is the newest complete one.
        best_tick, best_off = -1, None
        for i in range(num_buf):
            tick, b_off = struct.unpack_from('<2i', head, 48 + 16 * i)
            if tick > best_tick:
                best_tick, best_off = tick, b_off
        if best_off is None or best_off <= 0 or best_off + buf_len > MEMMAP_SIZE:
            return off
        buf = mem.read(best_off, buf_len)

        def flag(name):
            v = self._vars.get(name)
            if v is None or v[1] < 0 or v[1] >= len(buf):
                return None
            return buf[v[1]] != 0

        return {'connected': True, 'on_track': bool(flag('IsOnTrack')), 'enabled': flag('IsDiskLoggingEnabled'), 'active': flag('IsDiskLoggingActive')}

    @staticmethod
    def _read_var_headers(mem, num_vars, var_off):
        out = {}
        if var_off <= 0 or var_off + num_vars * VAR_HEADER_SIZE > MEMMAP_SIZE:
            return out
        raw = mem.read(var_off, num_vars * VAR_HEADER_SIZE)
        for i in range(len(raw) // VAR_HEADER_SIZE):
            base = i * VAR_HEADER_SIZE
            vtype, offset = struct.unpack_from('<2i', raw, base)
            name = raw[base + 16:base + 48].split(b'\0', 1)[0].decode('ascii', 'replace')
            if name in WANTED:
                out[name] = (vtype, offset)
        return out


class WindowsSim:
    """The real thing: iRacing's shared memory and SDK broadcast message. Windows only."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self._ct = ctypes
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        u32 = ctypes.WinDLL('user32', use_last_error=True)
        # OpenFileMapping only opens a mapping that already exists. (Creating one under this
        # name before the sim starts could get in the sim's way, so that is never done.)
        k32.OpenFileMappingW.restype = wintypes.HANDLE
        k32.OpenFileMappingW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
        k32.MapViewOfFile.restype = ctypes.c_void_p
        k32.MapViewOfFile.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.c_size_t]
        k32.UnmapViewOfFile.restype = wintypes.BOOL
        k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
        k32.CloseHandle.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        u32.RegisterWindowMessageW.restype = wintypes.UINT
        u32.RegisterWindowMessageW.argtypes = [wintypes.LPCWSTR]
        u32.SendNotifyMessageW.restype = wintypes.BOOL
        u32.SendNotifyMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        self._k32, self._u32 = k32, u32
        self._msg = u32.RegisterWindowMessageW(BROADCAST_NAME)
        self._handle = None
        self._ptr = None
        self._reader = SimReader()

    # read(offset, length) for SimReader
    def read(self, offset, length):
        if self._ptr is None or offset < 0 or length <= 0 or offset + length > MEMMAP_SIZE:
            return b''
        return self._ct.string_at(self._ptr + offset, length)

    def _open(self):
        FILE_MAP_READ = 0x0004
        handle = self._k32.OpenFileMappingW(FILE_MAP_READ, False, MEMMAP_NAME)
        if not handle:
            return False
        ptr = self._k32.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0)
        if not ptr:
            self._k32.CloseHandle(handle)
            return False
        self._handle, self._ptr = handle, ptr
        return True

    def _close(self):
        if self._ptr is not None:
            self._k32.UnmapViewOfFile(self._ptr)
        if self._handle is not None:
            self._k32.CloseHandle(self._handle)
        self._handle = self._ptr = None

    def state(self):
        if self._ptr is None and not self._open():
            return self._reader.read(None)
        st = self._reader.read(self)
        # Let go of the memory while the sim is not running, so nothing of iRacing's is held open.
        if not st['connected']:
            self._close()
        return st

    def send(self, cmd):
        if not self._msg:
            return False
        HWND_BROADCAST = 0xFFFF
        wparam = (BROADCAST_TELEM_COMMAND & 0xFFFF) | ((TELEM[cmd] & 0xFFFF) << 16)   # MAKELONG(message, command)
        return bool(self._u32.SendNotifyMessageW(HWND_BROADCAST, self._msg, wparam, 0))

    def close(self):
        self._close()


class SimulatedSim:
    """A pretend iRacing for trying the recorder and the web app without the sim."""

    def __init__(self):
        self.running = True
        self.on_track = False
        self.enabled = False
        self.sent = []

    def state(self):
        if not self.running:
            return {'connected': False, 'on_track': False, 'enabled': None, 'active': None}
        return {'connected': True, 'on_track': self.on_track, 'enabled': self.enabled, 'active': self.enabled and self.on_track}

    def send(self, cmd):
        self.sent.append(cmd)
        if not self.running:
            return True
        if cmd == 'start':
            self.enabled = True
        elif cmd == 'stop':
            self.enabled = False
        return True

    def sim_command(self, cmd):
        if cmd == 'sim-enter':
            self.on_track = True
        elif cmd == 'sim-exit':
            self.on_track = False
        elif cmd == 'sim-quit':
            self.running, self.on_track, self.enabled = False, False, False
        elif cmd == 'sim-launch':
            self.running = True
        else:
            return False
        return True

    def close(self):
        pass


# ---------------------------------------------------------------- deciding what to do

class Recorder:
    """Keeps track of the sim and decides when to send a telemetry command.

    automatic: recording is switched on whenever the sim is running.
    manual:    nothing is sent unless the app asks.
    """

    RETRY_SECONDS = 3.0

    def __init__(self, sim, mode='auto', clock=time.time, log=None):
        self.sim = sim
        self.mode = mode if mode in ('auto', 'manual') else 'auto'
        self.clock = clock
        self.log = log or (lambda text: None)
        self.lock = threading.Lock()
        self.state = {'connected': False, 'on_track': False, 'enabled': None, 'active': None}
        self.finished = 0             # runs saved since this program started
        self.last_finished = None     # when the last one was saved (seconds since 1970)
        self.started_at = None        # when the current recording began
        self._last_sent = 0.0
        self.last_error = ''

    def poll(self):
        with self.lock:
            try:
                now = self.sim.state()
            except Exception as err:           # never let a read error stop the program
                self.last_error = str(err)
                now = {'connected': False, 'on_track': False, 'enabled': None, 'active': None}
            before, self.state = self.state, now
            t = self.clock()
            if now['connected'] and not before['connected']:
                self.log('iRacing found.')
            if before['connected'] and not now['connected']:
                self.log('iRacing closed.')
            # The file is being written while "active". When that ends, a run has been saved.
            was, is_ = self._writing(before), self._writing(now)
            if is_ and not was:
                self.started_at = t
                self.log('Recording.')
            if was and not is_:
                self.finished += 1
                self.last_finished = t
                self.started_at = None
                self.log('Run saved (%d this session).' % self.finished)
            if self.mode == 'auto' and now['connected'] and self._needs_start(now, before) and t - self._last_sent >= self.RETRY_SECONDS:
                self._send('start', t)
            return self.status_locked()

    @staticmethod
    def _writing(st):
        if not st['connected']:
            return False
        if st['active'] is not None:
            return bool(st['active'])
        # Older builds without the "active" value: enabled and in the car means a file is being written.
        return bool(st['enabled']) and bool(st['on_track'])

    @staticmethod
    def _needs_start(now, before):
        if now['enabled'] is None:
            # The sim does not say whether recording is on: ask again each time it starts or the car is entered.
            return (not before['connected']) or (now['on_track'] and not before['on_track'])
        return not now['enabled']

    def _send(self, cmd, t):
        self._last_sent = t
        try:
            ok = self.sim.send(cmd)
        except Exception as err:
            ok, self.last_error = False, str(err)
        if ok:
            self.log({'start': 'Telemetry recording switched on.', 'stop': 'Telemetry recording switched off.', 'restart': 'New telemetry file started.'}[cmd])
        return ok

    def command(self, cmd):
        """-> (ok, message)"""
        with self.lock:
            if cmd in ('auto', 'manual'):
                self.mode = cmd
                self.log('Mode: ' + ('automatic' if cmd == 'auto' else 'manual') + '.')
                return True, ''
            if cmd not in TELEM:
                return False, 'unknown command'
            if not self.state['connected']:
                return False, 'iRacing is not running'
            # Stopping by hand means "leave it off": automatic mode would switch it straight back on.
            if cmd == 'stop' and self.mode == 'auto':
                self.mode = 'manual'
            ok = self._send(cmd, self.clock())
            return ok, '' if ok else 'the command could not be sent'

    def status_locked(self):
        s = self.state
        return {
            'app': 'sta-recorder', 'version': VERSION, 'sim': 'iracing', 'mode': self.mode,
            'connected': s['connected'], 'onTrack': s['on_track'], 'enabled': s['enabled'], 'recording': self._writing(s),
            'finished': self.finished, 'lastFinishedAt': int(self.last_finished * 1000) if self.last_finished else None,
            'recordingSince': int(self.started_at * 1000) if self.started_at else None,
            'simulated': isinstance(self.sim, SimulatedSim), 'error': self.last_error,
        }

    def status(self):
        with self.lock:
            return self.status_locked()


# ---------------------------------------------------------------- talking to the web app

def origin_allowed(origin, extra):
    """Pages opened from disk send "null"; localhost pages send their address. Anything else must be listed."""
    if origin is None:
        return True          # not a web page (a command-line tool or the address bar)
    if origin == 'null':
        return True
    low = origin.lower()
    for prefix in ('http://localhost', 'http://127.0.0.1', 'https://localhost', 'https://127.0.0.1'):
        if low == prefix or low.startswith(prefix + ':'):
            return True
    return low in [e.lower().rstrip('/') for e in extra]


def make_handler(recorder, extra_origins, on_mode_change=None):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'sta-recorder/' + VERSION

        def log_message(self, fmt, *args):   # keep the console for things the driver cares about
            pass

        def _reply(self, code, body=None):
            origin = self.headers.get('Origin')
            data = json.dumps(body).encode('utf-8') if body is not None else b''
            self.send_response(code)
            if origin is not None and origin_allowed(origin, extra_origins):
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'content-type')
                self.send_header('Access-Control-Allow-Private-Network', 'true')
                self.send_header('Access-Control-Max-Age', '600')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            if data:
                self.wfile.write(data)

        def _allowed(self):
            if origin_allowed(self.headers.get('Origin'), extra_origins):
                return True
            self._reply(403, {'error': 'this website is not allowed to use the recorder'})
            return False

        def do_OPTIONS(self):
            if self._allowed():
                self._reply(204)

        def do_GET(self):
            if not self._allowed():
                return
            if self.path.split('?')[0] == '/status':
                self._reply(200, recorder.status())
            else:
                self._reply(404, {'error': 'not found'})

        def do_POST(self):
            if not self._allowed():
                return
            if self.path.split('?')[0] != '/command':
                self._reply(404, {'error': 'not found'})
                return
            # Commands must be JSON sent by a page: a plain form or link from another site cannot do that.
            if 'application/json' not in (self.headers.get('Content-Type') or '').lower():
                self._reply(415, {'error': 'send JSON'})
                return
            try:
                length = min(int(self.headers.get('Content-Length') or 0), 4096)
                cmd = str(json.loads(self.rfile.read(length).decode('utf-8') or '{}').get('cmd', ''))
            except Exception:
                self._reply(400, {'error': 'bad request'})
                return
            if cmd.startswith('sim-') and isinstance(recorder.sim, SimulatedSim):
                ok, msg = recorder.sim.sim_command(cmd), ''
                recorder.poll()
            else:
                before = recorder.mode
                ok, msg = recorder.command(cmd)
                if on_mode_change and recorder.mode != before:
                    on_mode_change(recorder.mode)
            body = recorder.status()
            body['ok'] = bool(ok)
            if msg:
                body['message'] = msg
            self._reply(200 if ok else 409, body)

    return Handler


# ---------------------------------------------------------------- settings and start-up

def settings_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), 'recorder-settings.json')


def load_mode(default):
    try:
        with open(settings_path(), 'r', encoding='utf-8') as fh:
            mode = json.load(fh).get('mode')
        return mode if mode in ('auto', 'manual') else default
    except Exception:
        return default


def save_mode(mode):
    try:
        with open(settings_path(), 'w', encoding='utf-8') as fh:
            json.dump({'mode': mode}, fh)
    except Exception:
        pass


def main(argv=None):
    ap = argparse.ArgumentParser(description='Switches iRacing telemetry recording on and off, with the Setup and Telemetry app.')
    ap.add_argument('--port', type=int, default=DEFAULT_PORT, help='port on this computer the app connects to (default %d)' % DEFAULT_PORT)
    ap.add_argument('--manual', action='store_true', help='do not switch recording on automatically')
    ap.add_argument('--auto', action='store_true', help='switch recording on whenever iRacing is running')
    ap.add_argument('--allow-origin', action='append', default=[], metavar='URL', help='a website allowed to use the recorder, e.g. https://you.github.io (pages opened from disk and localhost are always allowed)')
    ap.add_argument('--simulate', action='store_true', help='pretend iRacing is running (for testing; works on any system)')
    args = ap.parse_args(argv)

    def log(text):
        print(time.strftime('%H:%M:%S') + '  ' + text, flush=True)

    if args.simulate:
        sim = SimulatedSim()
    elif sys.platform != 'win32':
        print('iRacing runs on Windows, so the recorder does too. Use --simulate to try it here.')
        return 2
    else:
        sim = WindowsSim()

    mode = 'manual' if args.manual else 'auto' if args.auto else load_mode('auto')
    recorder = Recorder(sim, mode=mode, log=log)
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(recorder, args.allow_origin, None if args.simulate else save_mode))
    except OSError as err:
        print('Port %d on this computer is in use (%s). Is the recorder already running? Otherwise pick another with --port and set the same number in the app.' % (args.port, err))
        return 1
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()

    log('iRacing recorder %s%s. Mode: %s. Listening on http://127.0.0.1:%d' % (VERSION, ' (simulated sim)' if args.simulate else '', 'automatic' if mode == 'auto' else 'manual', args.port))
    log('Leave this window open while you drive. Close it, or press Ctrl+C, to stop.')
    if not args.simulate:
        log('Waiting for iRacing...')
    try:
        while True:
            recorder.poll()
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        sim.close()
    log('Stopped. Telemetry recording in iRacing is left as it was.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
