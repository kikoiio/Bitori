"""Offline end-to-end tests for the bounded RSI loop with fake arms and checks."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'evaluation' / 'RSI'))
import loop
from contracts import atomic_json, digest

GATEWAY_USAGE = {'requests': 1, 'chargedTokens': 100, 'reservedTokens': 0, 'totalTokens': 100}


class LoopTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        files = {
            'src/agent/runner.ts': 'export const runner = 1;\nexport const extra = 2;\n',
            'src/prompt/builder.ts': 'export const builder = 1;\n',
            'src/compact/compact.ts': 'export const compact = 1;\n',
            'tests/unit/agent/existing.test.ts': 'export const existing = 1;\n',
            'package.json': '{}\n',
            'package-lock.json': '{}\n',
            'tsconfig.json': '{}\n',
            'tsconfig.build.json': '{}\n',
            'vitest.config.ts': 'export default {};\n',
            'eslint.config.js': 'export default [];\n',
        }
        for name, text in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('add', '-A')
        self.git('commit', '-q', '-m', 'fixture baseline')
        self.base = self.git('rev-parse', 'HEAD')
        self.deps = self.root / 'deps'
        (self.deps / 'typescript' / 'bin').mkdir(parents=True)
        (self.deps / 'typescript' / 'bin' / 'tsc').write_text('')
        self.calls = []
        self.gateway_calls = []
        self.verifier_calls = []
        self.proposer_calls = []
        self.check_status = 'passed'
        self._patch_loop()

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def config(self, *, dev=(0,), scope='smoke', max_requests=10, max_candidates=1,
               experiment_id='loop-test'):
        raw = {
            'schema_version': 1, 'experiment_id': experiment_id, 'scope': scope,
            'dev_indices': list(dev), 'holdout_indices': [16, 17, 18, 19, 20, 21, 22],
            'max_candidates': max_candidates, 'protocol': 'openai-chat', 'provider': 'fake',
            'allowed_paths': ['src/agent/runner.ts', 'tests/unit/agent/runner.rsi.test.ts'],
            'agent': {'max_iterations': 5}, 'improver': {'max_iterations': 3},
            'budget': {'wall_seconds': 3600, 'max_requests': max_requests, 'max_tokens': 100000,
                       'max_output_tokens': 1000, 'per_agent_timeout': 60},
            'objective': {'kind': 'reliability', 'min_pairs': len(dev), 'min_improvement': 0.01,
                          'max_regression': {'reliability': 0, 'score': 0, 'cost': 2000000}},
        }
        path = self.root / f'config-{scope}-{max_requests}.json'
        atomic_json(path, raw)
        config = loop.load_config(path)
        config['dependencies'] = str(self.deps)
        return config

    def environment(self):
        return {'LLM_API_KEY': 'test-api-key', 'LLM_BASE_URL': 'https://example.invalid/v1',
                'LLM_MODEL': 'fake-model'}

    def experiment(self, config, output):
        return loop.Experiment(config, self.repo, self.base, output,
                               environment=self.environment())

    # -- fakes -------------------------------------------------------------
    def _patch_loop(self):
        def fake_resolve_image(image, **_kwargs):
            return 'sha256:' + digest({'image': image})

        def fake_build_harness(repo, revision, target, dependencies, **_kwargs):
            source = Path(target) / 'source'
            (source / 'dist' / 'bin').mkdir(parents=True)
            (source / 'dist' / 'bin' / 'bitori.js').write_text('// built\n')
            return {'root': str(source), 'build': digest({'build': revision}),
                    'dependencies': digest({'deps': str(dependencies)}),
                    'dependencies_root': str(dependencies)}

        def fake_start_gateway(*, image, source, dependencies, config, ledger_directory,
                               name, network, timeout, environment):
            self.gateway_calls.append(name)
            options = json.loads(Path(config).read_text())
            ledger = Path(ledger_directory) / Path(options['ledgerPath']).name
            ledger.write_text(json.dumps({'usage': GATEWAY_USAGE}) + '\n')
            return {'url': f'http://{name}:8080', 'container': name, 'network': network}

        def fake_verifier_checks(repo, head_sha, trusted_revision, output, dependencies, *,
                                 manifest, changed_paths, new_tests, image, timeout=None):
            self.verifier_calls.append(head_sha)

            def receipt(name, status, **extra):
                value = {'experiment_id': manifest['experiment_id'],
                         'base_sha': manifest['base_sha'], 'head_sha': manifest['head_sha'],
                         'verifier_sha': manifest['verifier_sha'],
                         'policy_sha256': manifest['policy_sha256'],
                         'config_sha256': manifest['config_sha256'], 'name': name,
                         'status': status, 'source': 'trusted_execution',
                         'generated_by': 'trusted_executor', 'verified': True,
                         'scope': manifest['scope'], 'complete': True, 'stable': True,
                         'budget_exhausted': False, 'cancelled': False,
                         'evidence_sha256': digest({'name': name, 'status': status,
                                                    'extra': extra})}
                value.update(extra)
                return value

            receipts = [receipt('scope', 'passed', details={
                'changed_paths': sorted(changed_paths),
                'new_test_paths': sorted(set(changed_paths) & set(new_tests))})]
            for name in ('build', 'typecheck', 'lint', 'trusted_unit', 'integration', 'security'):
                receipts.append(receipt(name, self.check_status))
            receipts.append(receipt('regression', self.check_status,
                                    kind='trusted_regression',
                                    test_revision=manifest['verifier_sha']))
            receipts.append(receipt('new_tests', self.check_status if new_tests else 'failed'))
            return receipts

        def fake_run_arm(**kwargs):
            self.calls.append((kwargs['side'], kwargs['index']))
            baseline = kwargs['side'] == 'baseline'
            status = 'agent_error' if baseline else 'resolved'
            result = {'status': status, 'instance_id': f'task-{kwargs["index"]}',
                      'dataset': 'SWE-bench/SWE-bench_Lite', 'dataset_revision': 'revision',
                      'split': 'dev', 'model': 'fake-model', 'provider': 'fake',
                      'protocol': 'openai-chat', 'gold_verified': True,
                      'failure_stage': 'agent_execution' if baseline else None,
                      'comparison_config': {'pair': True}, 'usage_source': 'agent_reported',
                      'agent': {'stopReason': 'unknown_tool_limit' if baseline else 'natural_completion',
                                'inputTokens': 10, 'outputTokens': 10},
                      'trace_integrity': {'available': True, 'complete': True},
                      'run_id': 'run-1', 'patch_empty': baseline,
                      'patch': {'present': not baseline, 'empty': baseline}}
            output = Path(kwargs['output'])
            output.mkdir(parents=True)
            atomic_json(output / 'result.json', result)
            events = [{'runId': 'run-1', 'type': 'run_header'},
                      {'runId': 'run-1', 'type': 'run_finished'}]
            (output / 'trajectory.jsonl').write_text(
                ''.join(json.dumps(event) + '\n' for event in events))
            return {**result, '_directory': str(output), '_attempt_id': kwargs['attempt_id']}

        def fake_run_proposer(**kwargs):
            self.proposer_calls.append(kwargs['workspace'])
            source = Path(kwargs['workspace']) / 'src' / 'agent' / 'runner.ts'
            source.write_text(source.read_text() + '// bounded harness improvement\n')
            test = Path(kwargs['workspace']) / 'tests' / 'unit' / 'agent' / 'runner.rsi.test.ts'
            test.parent.mkdir(parents=True, exist_ok=True)
            test.write_text("import { describe, expect, it } from 'vitest';\n"
                            "describe('rsi regression', () => { it('holds', () => { expect(1).toBe(1); }); });\n")
            hypothesis = {'hypothesis': 'Unknown-tool limit suggests clearer tool feedback.',
                          'evidence_codes': ['unknown_tool'],
                          'verification_plan': 'Run the pinned regression suite.'}
            atomic_json(Path(kwargs['out']) / 'hypothesis.json', hypothesis)
            return {'status': 'completed'}

        for name, fake in (('resolve_image', fake_resolve_image),
                           ('build_harness', fake_build_harness),
                           ('start_gateway', fake_start_gateway),
                           ('verifier_checks', fake_verifier_checks),
                           ('run_arm', fake_run_arm),
                           ('run_proposer', fake_run_proposer)):
            patcher = unittest.mock.patch.object(loop, name, fake)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, fake in (('stop_gateway', lambda handle: None),
                           ('ensure_internal_network', lambda name: name),
                           ('docker', lambda args, **kwargs: '')):
            patcher = unittest.mock.patch.object(loop, name, fake)
            patcher.start()
            self.addCleanup(patcher.stop)

    # -- tests -------------------------------------------------------------
    def test_no_candidate_stops_without_proposing(self):
        self.calls.clear()

        def resolved_arm(**kwargs):
            result = {'status': 'resolved', 'gold_verified': True, 'comparison_config': {},
                      'agent': {'inputTokens': 1, 'outputTokens': 1}}
            output = Path(kwargs['output'])
            output.mkdir(parents=True)
            atomic_json(output / 'result.json', result)
            return {**result, '_directory': str(output)}

        with unittest.mock.patch.object(loop, 'run_arm', resolved_arm):
            report = self.experiment(self.config(), self.root / 'out').execute()
        self.assertEqual(report['terminal'], 'no_candidate')
        self.assertEqual(self.proposer_calls, [])
        self.assertEqual(self.calls, [])

    def test_merge_loop_reaches_pending_review(self):
        config = self.config(dev=(0, 1), scope='merge')
        report = self.experiment(config, self.root / 'out').execute()
        self.assertEqual(report['terminal'], 'verified_pending_review')
        candidate = report['candidates']['c1']
        self.assertEqual(candidate['verdict'], 'passed')
        self.assertTrue(candidate['comparison']['complete'])
        self.assertEqual(candidate['comparison']['reliability']['improvements'], [0, 1])
        self.assertEqual(candidate['comparison']['reliability']['candidate_resolved'], 2)
        self.assertFalse(candidate['comparison']['reliability']['score_comparison_complete'])
        self.assertIn('error', candidate['comparison']['score'])
        self.assertFalse(report['merge_authorized'])
        self.assertTrue(report['human_review_required'])
        self.assertEqual(report['usage'], {'requests': 5, 'tokens': 500})
        self.assertEqual(sorted(report['outcomes'][0].keys()),
                         ['candidate_id', 'head_sha', 'outcome', 'paired', 'pairs'])
        self.assertTrue((self.root / 'out' / 'report.json').is_file())
        self.assertTrue((self.root / 'out' / 'candidates' / 'c1' / 'verification.json').is_file())
        branch = self.git('for-each-ref', '--format=%(refname)', 'refs/heads/rsi/')
        self.assertIn('refs/heads/rsi/loop-test/c1', branch)
        self.assertEqual(len(self.calls), 4)

    def test_smoke_scope_cannot_claim_merge_proof(self):
        report = self.experiment(self.config(), self.root / 'out').execute()
        self.assertEqual(report['terminal'], 'smoke_complete')
        self.assertEqual(report['candidates']['c1']['verdict'], 'inconclusive')
        self.assertFalse(report['merge_authorized'])
        self.assertFalse(report['human_review_required'])

    def test_resume_after_interruption_does_not_repeat_work(self):
        original = loop.run_proposer
        interrupted = {'done': False}

        def crash(**kwargs):
            if not interrupted['done']:
                interrupted['done'] = True
                raise KeyboardInterrupt()
            return original(**kwargs)

        output = self.root / 'out'
        with unittest.mock.patch.object(loop, 'run_proposer', crash):
            with self.assertRaises(KeyboardInterrupt):
                self.experiment(self.config(dev=(0, 1), scope='merge'), output).execute()
        baseline_calls = list(self.calls)
        gateway_count = len(self.gateway_calls)
        self.assertEqual(baseline_calls, [('baseline', 0), ('baseline', 1)])
        state = json.loads((output / 'state.json').read_text())
        self.assertIsNone(state['terminal'])
        report = self.experiment(self.config(dev=(0, 1), scope='merge'), output).execute()
        self.assertEqual(report['terminal'], 'verified_pending_review')
        self.assertEqual(self.calls[:2], baseline_calls)
        self.assertEqual(len(self.calls), 4)
        self.assertGreater(len(self.gateway_calls), gateway_count)

    def test_checks_failure_is_terminal_and_resume_reuses_receipts(self):
        output = self.root / 'out'
        self.check_status = 'failed'
        report = self.experiment(self.config(), output).execute()
        self.assertEqual(report['terminal'], 'checks_failed')
        self.assertEqual(report['outcomes'][0]['outcome'], 'checks_failed')
        verifier_calls, arm_calls = len(self.verifier_calls), len(self.calls)
        self.check_status = 'passed'
        resumed = self.experiment(self.config(), output).execute()
        self.assertEqual(resumed['terminal'], 'checks_failed')
        self.assertEqual(len(self.verifier_calls), verifier_calls)
        self.assertEqual(len(self.calls), arm_calls)

    def test_budget_exhaustion_stops_before_next_arm(self):
        report = self.experiment(self.config(max_requests=1), self.root / 'out').execute()
        self.assertEqual(report['terminal'], 'budget_exhausted')
        self.assertEqual(report['usage'], {'requests': 1, 'tokens': 100})
        self.assertEqual(self.calls, [('baseline', 0)])

    def test_config_change_on_resume_is_rejected(self):
        output = self.root / 'out'
        self.experiment(self.config(max_requests=5), output).execute()
        with self.assertRaises(loop.StageConflict):
            self.experiment(self.config(max_requests=6), output).execute()

    def test_config_validation_rejects_unsafe_shapes(self):
        cases = [
            {'experiment_id': 'bad.id'},
            {'dev_indices': [0], 'scope': 'merge'},
            {'allowed_paths': ['tests/unit/agent/existing.test.ts']},
            {'allowed_paths': ['src/agent/runner.ts', 'src/agent/runner.ts']},
            {'dev_indices': [0, 0]},
            {'holdout_indices': [0]},
            {'objective': {'kind': 'speed'}},
            {'objective': {'kind': 'reliability', 'min_pairs': 2}},
            {'max_candidates': 0},
            {'budget': {'wall_seconds': 3600, 'max_requests': 10, 'max_tokens': 1000,
                        'max_output_tokens': 5000, 'per_agent_timeout': 60}},
        ]
        base = {
            'schema_version': 1, 'experiment_id': 'validation', 'scope': 'smoke',
            'dev_indices': [0], 'holdout_indices': [],
            'allowed_paths': ['src/agent/runner.ts'],
            'agent': {'max_iterations': 5}, 'improver': {'max_iterations': 3},
            'budget': {'wall_seconds': 3600, 'max_requests': 10, 'max_tokens': 100000,
                       'max_output_tokens': 1000, 'per_agent_timeout': 60},
            'objective': {'kind': 'reliability', 'min_pairs': 1},
        }
        for index, change in enumerate(cases):
            raw = {**base, **change}
            path = self.root / f'invalid-{index}.json'
            atomic_json(path, raw)
            with self.subTest(change=change), self.assertRaises(ValueError):
                loop.load_config(path)


if __name__ == '__main__':
    unittest.main()

