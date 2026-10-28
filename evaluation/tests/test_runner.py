import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock


RUNNER_PATH = Path(__file__).resolve().parents[1] / 'benchmarks' / 'swe-bench-lite' / 'run.py'
spec = importlib.util.spec_from_file_location('swebench_runner', RUNNER_PATH)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

SECRET = 'sk-test-secret-0123456789abcdef'
TRACE_STATS = {'written': 7, 'dropped': 0, 'writeErrors': 0, 'serializationErrors': 0}


def trace_lines(stats=None, secret=''):
    def event(line):
        return json.dumps(line) + '\n'
    lines = [event({'v': 1, 'at': 1, 'sessionId': 'session-1', 'type': 'run_header',
                    'runId': 'run-1', 'profileName': 'bench', 'model': 'm',
                    'protocol': 'openai-chat', 'mode': 'agent', 'trigger': 'message',
                    'workspaceRoot': '/testbed'})]
    for iteration in (1, 2, 3):
        call_id = f'call-{iteration}'
        lines.append(event({'v': 1, 'at': iteration, 'sessionId': 'session-1', 'type': 'response',
                            'runId': 'run-1', 'iterationId': f'it-{iteration}', 'iteration': iteration,
                            'text': 'assistant text', 'thinking': 'private chain of thought',
                            'toolCalls': [{'callId': call_id, 'providerCallId': None,
                                           'name': 'read_file',
                                           'argumentsText': '{"path":"/testbed/a.py"}'}],
                            'usage': {'inputTokens': 10, 'outputTokens': 2},
                            'finishReason': 'tool_calls', 'providerState': {'opaque': secret},
                            'errorCode': None, 'errorMessage': None, 'durationMs': 1}))
        lines.append(event({'v': 1, 'at': iteration, 'sessionId': 'session-1', 'type': 'agent_event',
                            'event': {'type': 'tool_result', 'sessionId': 'session-1',
                                      'runId': 'run-1', 'iterationId': f'it-{iteration}',
                                      'iteration': iteration, 'callId': call_id,
                                      'result': {'status': 'success', 'output': {'content': 'same'}}}}))
    lines.append(event({'v': 1, 'at': 9, 'sessionId': 'session-1', 'type': 'agent_event',
                        'event': {'type': 'run_finished', 'runId': 'run-1',
                                  'result': {'status': 'completed', 'stopReason': 'natural_completion'}}}))
    return ''.join(lines)


def completed(args, returncode=0, stdout='', stderr='', stdout_truncated=False,
              stderr_truncated=False):
    value = subprocess.CompletedProcess(args, returncode, stdout, stderr)
    value.stdout_truncated = stdout_truncated
    value.stderr_truncated = stderr_truncated
    return value


def summary(stop='natural_completion', status='idle', stats=None, error=''):
    return json.dumps({'status': status, 'stopReason': stop, 'iterations': 3,
                       'toolCalls': [{'name': 'read_file', 'status': 'success'}],
                       'inputTokens': 120, 'outputTokens': 30, 'reply': 'done',
                       'errorCode': None, 'errorMessage': error or None, 'error': None,
                       'sessionId': 'session-1', 'runId': 'run-1',
                       'trace': stats if stats is not None else TRACE_STATS})


class FakeRunner:
    def __init__(self, *, agent_stdout=None, agent_returncode=0, agent_timeout=False,
                 trace='', stats=None, patch='diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n'):
        self.agent_stdout = agent_stdout if agent_stdout is not None else summary(stats=stats)
        self.agent_returncode = agent_returncode
        self.agent_timeout = agent_timeout
        self.trace = trace
        self.patch = patch
        self.agent_environments = []

    def __call__(self, args, *, input=None, env=None, cwd=None, timeout=120,
                 max_output=1024 * 1024, check=True):
        if 'network' in args and 'inspect' in args:
            return completed(args, stdout='true\n')
        if 'run' in args and args[1:3] == ['run', '-d']:
            return completed(args, stdout='container-id\n')
        if 'rm' in args:
            return completed(args)
        if runner.TRACE_READER in args:
            data = self.trace.encode()
            return completed(args, stdout=json.dumps({
                'sessionId': 'session-1', 'bytes': len(data), 'truncated': False,
                'data': base64.b64encode(data).decode('ascii')}) + '\n')
        if any('import os,signal' in str(part) for part in args):
            return completed(args)
        if 'diff' in args and '--no-ext-diff' in args:
            return completed(args, stdout=self.patch)
        if 'add' in args:
            return completed(args)
        if 'timeout' in args and any(str(part).endswith('bitori.js') for part in args):
            self.agent_environments.append(env)
            if self.agent_timeout:
                raise subprocess.TimeoutExpired(args, timeout)
            return completed(args, returncode=self.agent_returncode, stdout=self.agent_stdout)
        if 'sh' in args:
            return completed(args)
        raise AssertionError(f'unexpected command: {args}')


def dataset_module(instance):
    module = types.ModuleType('datasets')
    module.load_dataset = lambda *args, **kwargs: [dict(instance, instance_id=f'repo__repo-{i}')
                                                   for i in range(1, 24)]
    return module


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.agent_root = root / 'agent'
        (self.agent_root / 'dist' / 'bin').mkdir(parents=True)
        (self.agent_root / 'dist' / 'bin' / 'bitori.js').write_text('// build\n')
        (self.agent_root / 'node_modules').mkdir()
        (self.agent_root / 'package.json').write_text('{"name":"bitori"}\n')
        self.node = root / 'node'
        self.node.write_text('#!/bin/sh\n')
        self.output = root / 'out'
        self.instance = {'instance_id': 'repo__repo-1', 'repo': 'org/repo',
                         'problem_statement': 'fix the bug', 'patch': 'GOLD PATCH',
                         'test_patch': 'HIDDEN TEST PATCH', 'image_name': 'example/image:latest'}
        self.environment = {'BITORI_PROVIDER': 'xunfei', 'BITORI_PROTOCOL': 'openai-responses',
                            'BITORI_BASE_URL': 'https://provider.invalid/v1',
                            'BITORI_MODEL': 'model-1', 'BITORI_API_KEY': SECRET,
                            'BITORI_NODE': str(self.node), 'PATH': '/usr/bin:/bin'}
        self.modules = mock.patch.dict(sys.modules, {'datasets': dataset_module(self.instance)})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.grades = []

    def args(self, *extra, gateway=False):
        values = ['--index', '0', '--output', str(self.output),
                  '--agent-root', str(self.agent_root), '--agent-sha', 'a' * 40,
                  '--harness-sha', 'b' * 40, '--attempt-id', 'attempt-1',
                  '--max-iterations', '30', '--timeout', '60']
        if gateway:
            values += ['--network', 'rsi-internal', '--gateway-url', 'http://rsi-gateway:8080']
        return runner.argument_parser().parse_args(values + list(extra))

    def run_instance(self, fake, gateway=False):
        def grade(dataset, iid, predictions, run_id):
            self.grades.append((str(predictions), run_id))
            return {'resolved': True}
        with mock.patch.object(runner, 'command', fake), \
                mock.patch.object(runner, 'image_id', return_value='sha256:' + 'c' * 64), \
                mock.patch.object(runner, 'grade', side_effect=grade), \
                contextlib.redirect_stdout(io.StringIO()):
            return runner.run_instance(self.args(gateway=gateway), dict(self.environment))

    def read(self, name):
        return (self.output / name).read_text()

    def test_normal_completion_exports_safe_complete_evidence(self):
        result = self.run_instance(FakeRunner(trace=trace_lines()))
        self.assertEqual(result['status'], 'resolved')
        self.assertEqual(result['session_id'], 'session-1')
        self.assertEqual(result['run_id'], 'run-1')
        self.assertTrue(result['trace_integrity']['complete'])
        self.assertEqual(self.grades and self.grades[-1][1].startswith('candidate-'), True)
        manifest = json.loads(self.read('artifacts.json'))['files']
        self.assertEqual(set(manifest), {'result.json', 'trajectory.jsonl',
                                         'solution.patch', 'diagnosis.json'})
        for name in manifest:
            self.assertTrue((self.output / name).is_file())
        stored = json.loads(self.read('result.json'))
        self.assertTrue(stored['gold_verified'])
        self.assertIn('comparison_config', stored)
        self.assertNotIn('instance.json', {path.name for path in self.output.iterdir()})
        everything = ''.join(path.read_text() for path in self.output.iterdir())
        for secret in (SECRET, 'GOLD PATCH', 'HIDDEN TEST PATCH', 'private chain of thought'):
            self.assertNotIn(secret, everything)
        events = [json.loads(line) for line in self.read('trajectory.jsonl').splitlines()]
        self.assertEqual(sum(event['type'] == 'tool_result' for event in events), 3)
        self.assertFalse(any('providerState' in event or 'thinking' in event for event in events))
        diagnosis = json.loads(self.read('diagnosis.json'))
        self.assertEqual(diagnosis['category'], 'success')
        self.assertNotIn('suspected_repetition', {finding['code'] for finding in diagnosis['findings']})
        self.assertFalse(diagnosis['eligible_for_candidate'])

    def test_iteration_limit_is_agent_error_but_keeps_partial_evidence(self):
        fake = FakeRunner(agent_stdout=summary(stop='iteration_limit', status='failed'),
                          agent_returncode=1, trace=trace_lines())
        result = self.run_instance(fake)
        self.assertEqual(result['status'], 'agent_error')
        self.assertEqual(result['failure_stage'], 'agent_execution')
        self.assertFalse(result['grading']['attempted'])
        self.assertTrue(result['patch']['collected'])
        self.assertEqual(self.grades[-1][1].startswith('gold-'), True)
        self.assertEqual(result['trace_integrity']['complete'], True)
        diagnosis = json.loads(self.read('diagnosis.json'))
        self.assertIn('suspected_repetition', {finding['code'] for finding in diagnosis['findings']})
        self.assertIn('iteration_limit', {finding['code'] for finding in diagnosis['findings']})
        self.assertTrue(diagnosis['eligible_for_candidate'])

    def test_dropped_trace_degrades_integrity_without_faking_success(self):
        stats = dict(TRACE_STATS, dropped=2)
        fake = FakeRunner(agent_stdout=summary(stats=stats), trace=trace_lines())
        result = self.run_instance(fake)
        self.assertEqual(result['status'], 'resolved')
        self.assertFalse(result['trace_integrity']['complete'])
        self.assertEqual(result['trace_integrity']['dropped'], 2)
        diagnosis = json.loads(self.read('diagnosis.json'))
        self.assertIn('trace_incomplete', {finding['code'] for finding in diagnosis['findings']})

    def test_timeout_records_agent_error_and_still_collects(self):
        fake = FakeRunner(agent_timeout=True, trace=trace_lines())
        result = self.run_instance(fake)
        self.assertEqual(result['status'], 'agent_error')
        self.assertEqual(result['failure_stage'], 'agent_timeout')
        self.assertTrue(result['patch']['collected'])
        self.assertTrue(result['trace_integrity']['available'])

    def test_initialization_failure_writes_no_partial_evidence(self):
        self.output.mkdir()
        (self.output / 'keep.txt').write_text('existing\n')
        result = self.run_instance(FakeRunner(trace=trace_lines()))
        self.assertEqual(result['status'], 'infrastructure_error')
        self.assertEqual(result['failure_stage'], 'initialization')
        self.assertEqual({path.name for path in self.output.iterdir()}, {'keep.txt'})

    def test_gateway_mode_requires_internal_network_and_run_token(self):
        environment = dict(self.environment)
        environment.pop('BITORI_API_KEY')
        environment['BITORI_RUN_TOKEN'] = 'r' * 48
        fake = FakeRunner(trace=trace_lines())
        with mock.patch.object(runner, 'command', fake), \
                mock.patch.object(runner, 'image_id', return_value='sha256:' + 'c' * 64), \
                mock.patch.object(runner, 'grade', return_value={'resolved': True}), \
                contextlib.redirect_stdout(io.StringIO()):
            result = runner.run_instance(self.args(gateway=True), environment)
        self.assertEqual(result['status'], 'resolved')
        self.assertEqual(result['model_access'], 'gateway')
        self.assertEqual(fake.agent_environments[0]['BITORI_RUN_TOKEN'], 'r' * 48)
        self.assertNotIn('BITORI_API_KEY', fake.agent_environments[0])
        with mock.patch.object(runner, 'command', fake), \
                mock.patch.object(runner, 'image_id', return_value='sha256:' + 'c' * 64), \
                mock.patch.object(runner, 'grade', return_value={'resolved': True}), \
                contextlib.redirect_stdout(io.StringIO()):
            direct = runner.run_instance(
                runner.argument_parser().parse_args(
                    ['--index', '0', '--output', str(self.output.parent / 'direct'),
                     '--agent-root', str(self.agent_root), '--attempt-id', 'attempt-2']),
                environment)
        self.assertEqual(direct['failure_stage'], 'configuration')
        self.assertEqual(direct['status'], 'infrastructure_error')
        self.assertFalse(direct['gold_verified'])

    def test_arm_identity_excludes_candidate_build_but_detects_environment_changes(self):
        base = {'instance_id': 'i', 'model': 'm', 'provider': 'p', 'protocol': 'c',
                'environment_adjustments': [], 'fingerprint': {'endpoint': 'e', 'image_id': 'x'}}
        changed = {**base, 'agent_sha': 'f' * 40, 'harness_sha': 'e' * 40,
                   'fingerprint': {**base['fingerprint'], 'source_sha': 'f' * 40}}
        self.assertEqual(runner.arm_identity(base), runner.arm_identity(changed))
        other_image = {**base, 'fingerprint': {**base['fingerprint'], 'image_id': 'y'}}
        self.assertNotEqual(runner.arm_identity(base), runner.arm_identity(other_image))


if __name__ == '__main__':
    unittest.main()
