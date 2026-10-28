#!/usr/bin/env python3
"""Summarize task artifacts without treating missing or failed jobs as successes."""
import argparse
from collections import Counter
import json
from pathlib import Path


def aggregate(root, expected):
    records, missing, duplicate = [], [], []
    seen = set()
    for index in expected:
        path = Path(root) / f'swe-lite-dev-{index}' / 'result.json'
        if not path.is_file():
            missing.append(index)
            continue
        row = json.loads(path.read_text())
        iid = row['instance_id']
        if iid in seen:
            duplicate.append(iid)
        seen.add(iid)
        diagnosis = None
        diagnosis_path = path.with_name('diagnosis.json')
        if diagnosis_path.is_file():
            try:
                value = json.loads(diagnosis_path.read_text())
                if isinstance(value, dict):
                    diagnosis = {'category': value.get('category'),
                                 'eligible_for_candidate': value.get('eligible_for_candidate'),
                                 'codes': [finding.get('code') for finding in value.get('findings', [])
                                           if isinstance(finding, dict)][:20]}
            except (OSError, ValueError):
                diagnosis = {'error': 'invalid diagnosis'}
        records.append({**row, 'diagnosis': diagnosis} if diagnosis else row)
    return {'expected': len(expected), 'recorded': len(records), 'missing_indices': missing,
            'duplicate_instances': duplicate, 'counts': dict(Counter(r['status'] for r in records)),
            'diagnosis_categories': dict(Counter(r['diagnosis']['category'] for r in records
                                                 if r.get('diagnosis') and r['diagnosis'].get('category'))),
            'results': records}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('root')
    parser.add_argument('--indices', required=True, help='JSON array')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = aggregate(args.root, json.loads(args.indices))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'results'}, ensure_ascii=False))
    if report['missing_indices'] or report['duplicate_instances'] or any(
        row['status'] not in ('resolved', 'unresolved') for row in report['results']
    ):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
