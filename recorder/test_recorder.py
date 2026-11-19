"""Tests for the iRacing recorder. Run:  python -m unittest recorder/test_recorder.py
Everything except the two Windows calls (opening iRacing's memory, sending the broadcast) is covered here."""
import json
import os
import struct
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import iracing_recorder as R


class FakeMem:
    def __init__(self, data):
        self.data = data

    def read(self, offset, length):
        return bytes(self.data[offset:offset + length])


def sim_memory(values, connected=True, newest=1, extra_vars=40):
    """An image of iRacing's telemetry memory: header, variable headers, and two data buffers."""
    names = ['Speed%d' % i for i in range(extra_vars)] + list(values.keys())
    var_off, buf_len = R.HEADER_SIZE, 64
    buf0 = var_off + len(names) * R.VAR_HEADER_SIZE
    buf1 = buf0 + buf_len
    mem = bytearray(buf1 + buf_len)
    struct.pack_into('<10i', mem, 0, 2, 1 if connected else 0, 60, 1, 0, 0, len(names), var_off, 2, buf_len)
    # buffer 0 is stale (everything off); buffer 1 holds the current values unless told otherwise
    struct.pack_into('<2i', mem, 48, 100 if newest == 1 else 300, buf0)
    struct.pack_into('<2i', mem, 64, 200, buf1)
    for i, name in enumerate(names):
        base = var_off + i * R.VAR_HEADER_SIZE
        struct.pack_into('<3i', mem, base, 1, i, 1)                 # type bool, offset i, count 1
        mem[base + 16:base + 16 + len(name)] = name.encode('ascii')
        if name in values:
            mem[buf1 + i] = 1 if values[name] else 0
    return FakeMem(mem)


class SimReaderTest(unittest.TestCase):
    def test_reads_the_three_flags_from_the_newest_buffer(self):
        r = R.SimReader()
        st = r.read(sim_memory({'IsOnTrack': True, 'IsDiskLoggingEnabled': True, 'IsDiskLoggingActive': False}))
        self.assertEqual(st, {'connected': True, 'on_track': True, 'enabled': True, 'active': False})
        # when the other buffer is newer, its (all off) values are the ones reported
        st = R.SimReader().read(sim_memory({'IsOnTrack': True, 'IsDiskLoggingEnabled': True, 'IsDiskLoggingActive': True}, newest=0))
        self.assertEqual(st, {'connected': True, 'on_track': False, 'enabled': False, 'active': False})

    def test_sim_not_running_or_not_connected(self):
        r = R.SimReader()
        self.assertFalse(r.read(None)['connected'])
        self.assertFalse(r.read(sim_memory({'IsOnTrack': True}, connected=False))['connected'])
        self.assertFalse(r.read(FakeMem(b'\0' * 20))['connected'], 'a short or empty mapping is not a crash')

    def test_values_the_sim_does_not_publish_are_unknown_not_false(self):
        st = R.SimReader().read(sim_memory({'IsOnTrack': True}))
        self.assertEqual(st, {'connected': True, 'on_track': True, 'enabled': None, 'active': None})

    def test_nonsense_offsets_are_refused(self):
        m = sim_memory({'IsOnTrack': True, 'IsDiskLoggingEnabled': True, 'IsDiskLoggingActive': True})
        struct.pack_into('<2i', m.data, 64, 900, R.MEMMAP_SIZE + 5)   # newest buffer points outside the mapping
        self.assertFalse(R.SimReader().read(m)['connected'])


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class RecorderTest(unittest.TestCase):
    def make(self, mode='auto'):
        sim, clock, lines = R.SimulatedSim(), Clock(), []
        return sim, clock, lines, R.Recorder(sim, mode=mode, clock=clock, log=lines.append)

    def test_automatic_mode_switches_recording_on_and_reports_a_saved_run(self):
        sim, clock, lines, rec = self.make()
        st = rec.poll()
        self.assertEqual(sim.sent, ['start'])
        self.assertEqual((st['connected'], st['recording'], st['finished']), (True, False, 0))
        clock.t += 1
        self.assertTrue(rec.poll()['enabled'])
        self.assertEqual(sim.sent, ['start'], 'not sent again once it is on')
        sim.sim_command('sim-enter'); clock.t += 1
        st = rec.poll()
        self.assertTrue(st['recording']); self.assertEqual(st['recordingSince'], int(clock.t * 1000))
        sim.sim_command('sim-exit'); clock.t += 60
        st = rec.poll()
        self.assertEqual((st['recording'], st['finished'], st['lastFinishedAt']), (False, 1, int(clock.t * 1000)))
        self.assertEqual(lines, ['iRacing found.', 'Telemetry recording switched on.', 'Recording.', 'Run saved (1 this session).'])

    def test_a_start_that_did_not_take_is_retried_but_not_hammered(self):
        sim, clock, lines, rec = self.make()
        sim.send = lambda cmd: sim.sent.append(cmd) or True     # the sim ignores it
        rec.poll(); clock.t += 1; rec.poll(); clock.t += 1; rec.poll()
        self.assertEqual(sim.sent, ['start'])
        clock.t += 2; rec.poll()
        self.assertEqual(sim.sent, ['start', 'start'])

    def test_manual_mode_sends_nothing_until_asked(self):
        sim, clock, lines, rec = self.make('manual')
        rec.poll(); clock.t += 10; rec.poll()
        self.assertEqual(sim.sent, [])
        self.assertEqual(rec.command('start'), (True, ''))
        self.assertEqual(sim.sent, ['start'])
        self.assertEqual(rec.command('restart'), (True, ''))
        self.assertEqual(rec.command('nonsense'), (False, 'unknown command'))

    def test_stopping_by_hand_stays_stopped(self):
        sim, clock, lines, rec = self.make()
        rec.poll()
        self.assertEqual(rec.command('stop'), (True, ''))
        self.assertEqual(rec.mode, 'manual')
        clock.t += 30; rec.poll(); clock.t += 30; rec.poll()
        self.assertEqual(sim.sent, ['start', 'stop'], 'automatic mode did not switch it back on')
        rec.command('auto'); clock.t += 5; rec.poll()
        self.assertEqual(sim.sent, ['start', 'stop', 'start'])

    def test_commands_need_the_sim(self):
        sim, clock, lines, rec = self.make()
        sim.sim_command('sim-quit'); rec.poll()
        self.assertEqual(rec.command('start'), (False, 'iRacing is not running'))
        self.assertEqual(sim.sent, [])
        self.assertEqual(rec.command('manual'), (True, ''), 'the mode can still be changed')

    def test_quitting_the_sim_mid_run_counts_the_run_as_saved(self):
        sim, clock, lines, rec = self.make()
        rec.poll(); sim.sim_command('sim-enter'); rec.poll()
        sim.sim_command('sim-quit'); st = rec.poll()
        self.assertEqual((st['connected'], st['finished']), (False, 1))

    def test_older_sim_without_the_logging_flags(self):
        class Old(R.SimulatedSim):
            def state(self):
                st = super().state(); st['enabled'] = st['active'] = None; return st
        sim, clock, lines = Old(), Clock(), []
        rec = R.Recorder(sim, clock=clock, log=lines.append)
        rec.poll(); clock.t += 10; rec.poll()
        self.assertEqual(sim.sent, ['start'], 'asked once when the sim appears')
        sim.sim_command('sim-enter'); clock.t += 10; rec.poll()
        self.assertEqual(sim.sent, ['start', 'start'], 'and again when the car is entered')

    def test_a_read_error_does_not_stop_the_recorder(self):
        sim, clock, lines, rec = self.make()
        def boom():
            raise OSError('memory went away')
        sim.state = boom
        st = rec.poll()
        self.assertEqual((st['connected'], st['error']), (False, 'memory went away'))


class OriginTest(unittest.TestCase):
    def test_who_may_call(self):
        ok = R.origin_allowed
        self.assertTrue(ok(None, []))                                # not a web page
        self.assertTrue(ok('null', []))                              # the app opened from disk
        self.assertTrue(ok('http://localhost:8080', []))
        self.assertTrue(ok('http://127.0.0.1:5500', []))
        self.assertFalse(ok('https://example.com', []))
        self.assertFalse(ok('http://localhost.evil.com', []))
        self.assertFalse(ok('http://127.0.0.1.evil.com:80', []))
        self.assertTrue(ok('https://Whisel.github.io', ['https://whisel.github.io/']))


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.sim = R.SimulatedSim()
        self.rec = R.Recorder(self.sim, mode='manual')
        self.modes = []
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), R.make_handler(self.rec, [], self.modes.append))
        self.url = 'http://127.0.0.1:%d' % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.rec.poll()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()

    def call(self, path, body=None, origin='null', ctype='application/json', method=None):
        req = urllib.request.Request(self.url + path, data=None if body is None else json.dumps(body).encode(), method=method)
        if origin is not None:
            req.add_header('Origin', origin)
        if body is not None and ctype:
            req.add_header('Content-Type', ctype)
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None), resp.headers
        except urllib.error.HTTPError as err:
            raw = err.read()
            return err.code, (json.loads(raw) if raw else None), err.headers

    def test_status(self):
        code, body, headers = self.call('/status')
        self.assertEqual(code, 200)
        self.assertEqual((body['app'], body['sim'], body['mode'], body['connected'], body['recording'], body['simulated']), ('sta-recorder', 'iracing', 'manual', True, False, True))
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'null')

    def test_commands_from_the_app(self):
        code, body, _ = self.call('/command', {'cmd': 'start'})
        self.assertEqual((code, body['ok'], body['enabled']), (200, True, False), 'status is as last polled; the next poll shows it on')
        self.rec.poll()
        self.assertTrue(self.call('/status')[1]['enabled'])
        code, body, _ = self.call('/command', {'cmd': 'auto'})
        self.assertEqual((body['mode'], self.modes), ('auto', ['auto']), 'the mode is remembered for next time')
        code, body, _ = self.call('/command', {'cmd': 'sim-enter'})
        self.assertTrue(body['recording'])
        code, body, _ = self.call('/command', {'cmd': 'sim-exit'})
        self.assertEqual((body['recording'], body['finished']), (False, 1))
        code, body, _ = self.call('/command', {'cmd': 'fly'})
        self.assertEqual((code, body['ok'], body['message']), (409, False, 'unknown command'))

    def test_other_websites_are_refused(self):
        code, body, headers = self.call('/status', origin='https://example.com')
        self.assertEqual(code, 403)
        self.assertIsNone(headers.get('Access-Control-Allow-Origin'))
        code, _, _ = self.call('/command', {'cmd': 'start'}, origin='https://example.com')
        self.assertEqual(code, 403)
        self.assertEqual(self.sim.sent, [])

    def test_a_plain_form_post_cannot_send_a_command(self):
        code, _, _ = self.call('/command', {'cmd': 'start'}, origin=None, ctype='text/plain')
        self.assertEqual(code, 415)
        self.assertEqual(self.sim.sent, [])

    def test_preflight(self):
        code, _, headers = self.call('/command', origin='null', method='OPTIONS')
        self.assertEqual(code, 204)
        self.assertIn('POST', headers['Access-Control-Allow-Methods'])
        self.assertEqual(self.call('/command', origin='https://example.com', method='OPTIONS')[0], 403)

    def test_unknown_paths(self):
        self.assertEqual(self.call('/')[0], 404)
        self.assertEqual(self.call('/elsewhere', {'cmd': 'start'})[0], 404)


if __name__ == '__main__':
    unittest.main()
