import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('compare', Path(__file__).parents[1] / 'rsi' / 'compare.py')
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)
aggregate_spec = importlib.util.spec_from_file_location('aggregate', Path(__file__).parents[1] / 'rsi' / 'aggregate.py')
aggregate = importlib.util.module_from_spec(aggregate_spec)
aggregate_spec.loader.exec_module(aggregate)
runner_spec = importlib.util.spec_from_file_location('runner', Path(__file__).parents[1] / 'benchmarks' / 'swe-bench-lite' / 'run.py')
runner = importlib.util.module_from_spec(runner_spec)
runner_spec.loader.exec_module(runner)


def row(status):
    return {'dataset': 'test', 'dataset_revision': 'sha', 'split': 'dev',
            'model': 'model', 'provider': 'provider', 'protocol': 'openai-chat', 'status': status}


class ComparisonTests(unittest.TestCase):
    def test_reports_changes(self):
        report = compare.compare({'a': row('unresolved')}, {'a': row('resolved')})
        self.assertEqual(report['candidate_resolved'], 1)
        self.assertEqual(report['changes']['a']['baseline'], 'unresolved')

    def test_refuses_incomplete_and_incompatible_runs(self):
        with self.assertRaises(ValueError):
            compare.compare({'a': row('unresolved')}, {'a': row('infrastructure_error')})
        with self.assertRaises(ValueError):
            compare.compare({'a': row('resolved')}, {'b': row('resolved')})
        changed = row('resolved')
        changed['model'] = 'other'
        with self.assertRaises(ValueError):
            compare.compare({'a': row('resolved')}, {'a': changed})
        changed['model'] = 'model'
        changed['protocol'] = 'openai-responses'
        with self.assertRaises(ValueError):
            compare.compare({'a': row('resolved')}, {'a': changed})

    def test_experiment_records_commits_and_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for folder, status, commit in [('base', 'unresolved', 'abc'), ('candidate', 'resolved', 'def')]:
                directory = root / folder
                directory.mkdir()
                (directory / 'result.json').write_text(json.dumps({**row(status), 'instance_id': 'a', 'commit': commit}))
            output = root / 'report.json'
            subprocess.run([sys.executable, str(Path(__file__).parents[1] / 'rsi' / 'experiment.py'),
                            '--hypothesis', 'test hypothesis', '--baseline', str(root / 'base'),
                            '--candidate', str(root / 'candidate'), '--output', str(output)], check=True, capture_output=True)
            result = json.loads(output.read_text())
            self.assertEqual((result['baseline_commit'], result['candidate_commit']), ('abc', 'def'))
            self.assertEqual(result['decision'], 'pending_human_review')
            self.assertEqual(result['comparison']['candidate_resolved'], 1)

    def test_aggregate_marks_missing_and_duplicate_tasks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for index in (0, 1):
                directory = root / f'swe-lite-dev-{index}'
                directory.mkdir()
                (directory / 'result.json').write_text(json.dumps({'instance_id': 'same', 'status': 'resolved'}))
            result = aggregate.aggregate(root, [0, 1, 2])
            self.assertEqual(result['missing_indices'], [2])
            self.assertEqual(result['duplicate_instances'], ['same'])


class ProviderSettingsTests(unittest.TestCase):
    def test_normalizes_complete_responses_endpoint(self):
        for url in ('https://example.com/v1/responses', 'https://example.com/v1/responses/'):
            with self.subTest(url=url):
                self.assertEqual(runner.provider_settings({
                    'BITORI_PROTOCOL': 'openai-responses', 'BITORI_BASE_URL': url,
                }), ('openai-responses', 'https://example.com/v1'))
        self.assertEqual(runner.provider_settings({
            'BITORI_PROTOCOL': 'openai-responses', 'BITORI_BASE_URL': 'https://example.com/v1',
        }), ('openai-responses', 'https://example.com/v1'))

    def test_defaults_to_chat_without_trimming_url(self):
        self.assertEqual(runner.provider_settings({
            'BITORI_BASE_URL': 'https://example.com/v1/responses',
        }), ('openai-chat', 'https://example.com/v1/responses'))

    def test_rejects_unknown_protocol(self):
        with self.assertRaises(ValueError):
            runner.provider_settings({'BITORI_PROTOCOL': 'unknown', 'BITORI_BASE_URL': 'https://example.com'})


if __name__ == '__main__':
    unittest.main()
