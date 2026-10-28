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
        if ((a.get('comparison_config') or b.get('comparison_config'))
                and a.get('comparison_config') != b.get('comparison_config')):
            raise ValueError(f'{instance_id} 缺少或具有不一致的可比性指纹')
        if a.get('environment_adjustments', []) != b.get('environment_adjustments', []):
            raise ValueError(f'{instance_id} 的任务环境调整不匹配')
        if a['status'] not in ('resolved', 'unresolved') or b['status'] not in ('resolved', 'unresolved'):
            raise ValueError(f'{instance_id} 存在未完成或基础设施错误')
    changes = {iid: {'baseline': baseline[iid]['status'], 'candidate': candidate[iid]['status']}
               for iid in baseline if baseline[iid]['status'] != candidate[iid]['status']}
    return {'tasks': len(baseline), 'baseline_resolved': sum(x['status'] == 'resolved' for x in baseline.values()),
            'candidate_resolved': sum(x['status'] == 'resolved' for x in candidate.values()), 'changes': changes}


def compare_reliability(baseline, candidate):
    if not baseline or baseline.keys() != candidate.keys():
        raise ValueError('两次任务集合必须完整且相同')
    for iid in baseline:
        a, b = baseline[iid], candidate[iid]
        if any(a.get(key) != b.get(key) for key in KEYS):
            raise ValueError(f'{iid} 的实验配置不匹配')
        if not a.get('comparison_config') or a['comparison_config'] != b.get('comparison_config'):
            raise ValueError(f'{iid} 缺少或具有不一致的可比性指纹')
        if a.get('environment_adjustments', []) != b.get('environment_adjustments', []):
            raise ValueError(f'{iid} 的任务环境调整不匹配')
        if any(row.get('status') not in ('resolved', 'unresolved', 'agent_error') or not row.get('gold_verified') for row in (a, b)):
            raise ValueError(f'{iid} 的环境、供应商或结果不完整')
    counts = lambda rows, status: sum(row['status'] == status for row in rows.values())
    regressions = [iid for iid in baseline if (baseline[iid]['status'] == 'resolved' and candidate[iid]['status'] != 'resolved') or (baseline[iid]['status'] != 'agent_error' and candidate[iid]['status'] == 'agent_error')]
    improvements = [iid for iid in baseline if (baseline[iid]['status'] == 'agent_error' and candidate[iid]['status'] != 'agent_error') or (baseline[iid]['status'] != 'resolved' and candidate[iid]['status'] == 'resolved')]
    totals = lambda rows, key: sum((row.get('agent') or {}).get(key, 0) or 0 for row in rows.values())
    return {'tasks': len(baseline), 'comparable': True,
            'baseline_agent_errors': counts(baseline, 'agent_error'), 'candidate_agent_errors': counts(candidate, 'agent_error'),
            'baseline_resolved': counts(baseline, 'resolved'), 'candidate_resolved': counts(candidate, 'resolved'),
            'regressions': regressions, 'improvements': improvements,
            'baseline_tokens': totals(baseline, 'inputTokens') + totals(baseline, 'outputTokens'),
            'candidate_tokens': totals(candidate, 'inputTokens') + totals(candidate, 'outputTokens'),
            'score_comparison_complete': counts(baseline, 'agent_error') == counts(candidate, 'agent_error') == 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('baseline')
    parser.add_argument('candidate')
    args = parser.parse_args()
    print(json.dumps(compare(load(args.baseline), load(args.candidate)), indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
