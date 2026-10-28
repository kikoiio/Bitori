import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('compare', Path(__file__).parents[1] / 'rsi' / 'compare.py')
compare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare)


def row(status):
    return {'dataset': 'test', 'dataset_revision': 'sha', 'split': 'dev',
            'model': 'model', 'provider': 'provider', 'status': status}


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


if __name__ == '__main__':
    unittest.main()
