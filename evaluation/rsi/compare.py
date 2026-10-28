#!/usr/bin/env python3
"""Compare two complete sets of benchmark result.json files."""
import argparse
import json
from pathlib import Path

KEYS = ('dataset', 'dataset_revision', 'split', 'model', 'provider', 'protocol')


def load(directory):
    rows = [json.loads(path.read_text()) for path in Path(directory).rglob('result.json')]
    if not rows:
        raise ValueError(f'没有结果: {directory}')
    indexed = {row['instance_id']: row for row in rows}
    if len(indexed) != len(rows):
        raise ValueError('任务 ID 重复')
    return indexed


def compare(baseline, candidate):
    if baseline.keys() != candidate.keys():
        raise ValueError('两次任务集合不同，不能比较')
    first = next(iter(baseline.values()))
    for instance_id in baseline:
        a, b = baseline[instance_id], candidate[instance_id]
        if any(a.get(key) != b.get(key) or a.get(key) != first.get(key) for key in KEYS):
            raise ValueError(f'{instance_id} 的实验配置不匹配')
        if a.get('environment_adjustments', []) != b.get('environment_adjustments', []):
            raise ValueError(f'{instance_id} 的任务环境调整不匹配')
        if a['status'] not in ('resolved', 'unresolved') or b['status'] not in ('resolved', 'unresolved'):
            raise ValueError(f'{instance_id} 存在未完成或基础设施错误')
    changes = {iid: {'baseline': baseline[iid]['status'], 'candidate': candidate[iid]['status']}
               for iid in baseline if baseline[iid]['status'] != candidate[iid]['status']}
    return {'tasks': len(baseline), 'baseline_resolved': sum(x['status'] == 'resolved' for x in baseline.values()),
            'candidate_resolved': sum(x['status'] == 'resolved' for x in candidate.values()), 'changes': changes}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('baseline')
    parser.add_argument('candidate')
    args = parser.parse_args()
    print(json.dumps(compare(load(args.baseline), load(args.candidate)), indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
