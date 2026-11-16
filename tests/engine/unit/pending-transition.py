"""Проверяет binding, exact commit, source drift и недоверенные файлы.
Не создаёт настоящую попытку и не вызывает модель.
"""
import hashlib
import base64
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'engine/lib'))
import pending_transition as pending


class PendingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        attempt = 'a_' + '1' * 32
        folder = self.root / 't7' / 'attempts' / attempt
        folder.mkdir(parents=True, mode=0o700)
        self.path = folder / 'pending-transition.json'
        self.tree = self.root / 'tree.tsv'
        self.tree.write_text('source-v1\n')
        self.state = {
            'taskId': '7', 'attemptId': attempt, 'profile': 'demo-profile',
            'catalogHash': 'b' * 64, 'routeId': 'feature', 'routeHash': 'c' * 64,
            'state': 'ready', 'currentNode': 'prepare', 'eventSequence': 0,
            'headEventHash': 'd' * 64,
        }
        self.args = ['7', attempt, 'prepare', 'done', '2', '', '0', '0', '10', '', '0']

    def save(self):
        pending.prepare(self.path, self.state, 0, self.tree, self.args)
        return pending.load(self.path)

    def test_original_cas_roundtrips(self):
        value = self.save()
        self.assertEqual(pending.classify(value, self.state, {}, b'', self.tree), 'ready')
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o400)
        self.save()

    def test_exact_completed_event_does_not_duplicate(self):
        value = self.save()
        event = {'kind': 'commit', 'sequence': 1, 'node': 'prepare', 'outcome': 'done',
                 'previousEventHash': 'd' * 64, 'verdict': None, 'reason': None}
        raw = (json.dumps(event, sort_keys=True) + '\n').encode()
        state = dict(self.state, eventSequence=1, currentNode='check',
                     headEventHash=hashlib.sha256(raw).hexdigest())
        self.assertEqual(pending.classify(value, state, event, raw, self.tree), 'committed')

    def test_source_drift_does_not_accept_old_done(self):
        value = self.save()
        self.tree.write_text('source-v2\n')
        self.assertEqual(pending.classify(value, self.state, {}, b'', self.tree), 'stale')

    def test_human_rewind_is_new_visit(self):
        value = self.save()
        state = dict(self.state, eventSequence=1, headEventHash='e' * 64)
        self.assertEqual(pending.classify(value, state, {'kind': 'human-rewind'}, b'', self.tree),
                         'stale')

    def test_foreign_identity_is_not_replayed(self):
        value = self.save()
        with self.assertRaises(ValueError):
            pending.classify(value, dict(self.state, taskId='8'), {}, b'', self.tree)

    def test_symlink_and_mutable_receipt_fail_closed(self):
        self.save()
        self.path.chmod(0o600)
        with self.assertRaises(ValueError):
            pending.load(self.path)
        self.path.unlink()
        self.path.symlink_to(self.tree)
        with self.assertRaises((OSError, ValueError)):
            pending.load(self.path)

    def test_generated_stop_reason_belongs_to_validated_writer(self):
        value = self.save()
        typed = {'owner': 'build', 'findings': [{'id': 'same-finding', 'summary': 'прежний дефект'}]}
        value['args'][2:4] = ['verify', 'failed']
        value['args'][5] = base64.b64encode(json.dumps(typed).encode()).decode()
        value['base']['currentNode'] = 'verify'
        for kind in ('no-progress', 'rewind-limit', 'loop-ceiling'):
            with self.subTest(kind=kind):
                event = {'kind': kind, 'sequence': 1, 'node': 'verify', 'outcome': 'failed',
                         'previousEventHash': 'd' * 64, 'verdict': typed,
                         'reason': 'причина штатного предохранителя',
                         'action': {'rewind': 'prepare', 'reset': ['prepare', 'verify']}}
                raw = (json.dumps(event, sort_keys=True) + '\n').encode()
                state = dict(self.state, eventSequence=1, state='stopped', stop=kind,
                             headEventHash=hashlib.sha256(raw).hexdigest())
                self.assertEqual(pending.classify(value, state, event, raw, self.tree), 'committed')
        event['kind'] = 'commit'
        raw = (json.dumps(event, sort_keys=True) + '\n').encode()
        state['headEventHash'] = hashlib.sha256(raw).hexdigest()
        self.assertEqual(pending.classify(value, state, event, raw, self.tree), 'stale')
    def origin_fixture(self):
        origin = {'nodeVisitId': 'nv_' + '2' * 32, 'orchestratorSessionId': 'os_' + '3' * 32,
                  'node': 'prepare', 'runKey': 'PREPARE', 'cursorOrdinal': 0}
        row = {'kind': 'node_visit_started', 'taskId': 't7', 'attemptId': self.args[1],
               'profile': 'demo-profile', 'routeId': 'feature', 'routeHash': 'c' * 64,
               'nodeVisitId': origin['nodeVisitId'], 'orchestratorSessionId': origin['orchestratorSessionId'],
               'nodeId': 'prepare', 'runKey': 'PREPARE', 'details': {'cursorOrdinal': 0}}
        return origin, row

    def test_origin_roundtrip_and_exact_source(self):
        origin, row = self.origin_fixture()
        pending.prepare(self.path, self.state, 0, self.tree, self.args, origin)
        value = pending.load(self.path)
        self.assertEqual(value['origin'], origin)
        self.assertEqual(pending.select_origin(value, [row]), row)
        for rows in ([], [row, row], [dict(row, attemptId='a_' + '4' * 32)],
                     [dict(row, routeHash='e' * 64)], [dict(row, details={'cursorOrdinal': 1})]):
            with self.subTest(rows=rows):
                with self.assertRaises(ValueError):
                    pending.select_origin(value, rows)

    def test_wrong_origin_rejected_before_receipt_write(self):
        origin, _ = self.origin_fixture()
        origin['node'] = 'foreign'
        with self.assertRaises(ValueError):
            pending.prepare(self.path, self.state, 0, self.tree, self.args, origin)
        self.assertFalse(self.path.exists())

    def test_origin_capture_requires_matching_host_context(self):
        origin, _ = self.origin_fixture()
        context = {
            'FACTORY_LIFECYCLE_TASK_ID': 't7', 'FACTORY_LIFECYCLE_ATTEMPT_ID': self.args[1],
            'FACTORY_LIFECYCLE_PROFILE': 'demo-profile', 'FACTORY_LIFECYCLE_ROUTE_ID': 'feature',
            'FACTORY_LIFECYCLE_ROUTE_HASH': 'c' * 64, 'FACTORY_LIFECYCLE_NODE_ID': 'prepare',
            'FACTORY_LIFECYCLE_RUN_KEY': 'PREPARE',
            'FACTORY_LIFECYCLE_NODE_VISIT_ID': origin['nodeVisitId'],
            'FACTORY_LIFECYCLE_SESSION_ID': origin['orchestratorSessionId'],
        }
        with mock.patch.dict(os.environ, context, clear=True):
            self.assertEqual(pending.origin_from_context(self.state, self.args), origin)
        with mock.patch.dict(os.environ, dict(context, FACTORY_LIFECYCLE_TASK_ID='t8'), clear=True):
            with self.assertRaises(ValueError):
                pending.origin_from_context(self.state, self.args)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(pending.origin_from_context(self.state, self.args))


if __name__ == '__main__':
    unittest.main()
