import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('contracts', Path(__file__).parents[1] / 'RSI' / 'contracts.py')
contracts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contracts)


class EvidenceTests(unittest.TestCase):
    def test_projects_only_safe_event_fields(self):
        rows = [
            {'type': 'run_header', 'runId': 'run', 'model': 'test'},
            {'type': 'request_prepared', 'runId': 'run', 'items': ['private context']},
            {'type': 'response', 'runId': 'run', 'iteration': 1, 'thinking': 'private thinking',
             'providerState': {'secret': 'private state'}, 'text': 'hello',
             'toolCalls': [{'callId': 'call', 'name': 'read', 'argumentsText': 'a'}]},
            {'type': 'agent_event', 'event': {'type': 'run_finished', 'runId': 'run', 'result': {'stopReason': 'natural_completion'}}},
        ]
        events, integrity = contracts.project_trace(map(json.dumps, rows), 'run', {'written': 4, 'dropped': 0, 'writeErrors': 0, 'serializationErrors': 0})
        self.assertTrue(integrity['complete'])
        self.assertEqual([event['type'] for event in events], ['run_header', 'response', 'run_finished'])
        self.assertNotIn('private', json.dumps(events))
        self.assertEqual(events[1]['id'], 'run:3')

    def test_never_claims_missing_or_dropped_trace_complete(self):
        rows = [json.dumps({'type': 'run_header', 'runId': 'r'}), '{broken']
        _, integrity = contracts.project_trace(rows, 'r')
        self.assertFalse(integrity['complete'])
        self.assertEqual(integrity['corrupt_lines'], 1)
        self.assertFalse(integrity['finished'])

    def test_secrets_are_removed_before_truncation(self):
        secret = 'a-secret-with-quotes"and-newline\n'
        value = contracts.sanitize({'note': secret + ' x' * 100, 'password': 'abc', 'url': 'https://host/path?token=value'}, [secret], 16)
        self.assertNotIn(secret[:10], json.dumps(value))
        self.assertEqual(value['password'], '<redacted>')
        self.assertNotIn('token=value', value['url'])

    def test_partial_patch_is_marked_not_replayable_when_redacted(self):
        with tempfile.TemporaryDirectory() as root:
            result = contracts.write_evidence(root, {'status': 'agent_error'}, [], ['secret-1234'], patch='secret-1234')
            self.assertEqual(result['status'], 'agent_error')
            self.assertFalse(result['patch']['replayable'])
            artifacts = json.loads((Path(root) / 'artifacts.json').read_text())
            self.assertIn('solution.patch', artifacts['files'])
            for path in Path(root).iterdir():
                self.assertNotIn('secret-1234', path.read_text())

    def test_atomic_json_replaces_complete_document(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'state.json'
            contracts.atomic_json(path, {'step': 1})
            contracts.atomic_json(path, {'step': 2})
            self.assertEqual(json.loads(path.read_text()), {'step': 2})
            self.assertEqual(list(Path(root).iterdir()), [path])


if __name__ == '__main__':
    unittest.main()
