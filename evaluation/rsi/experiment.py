#!/usr/bin/env python3
"""Create an auditable, human-reviewed RSI comparison from two experiment runs."""
import argparse
import json
from pathlib import Path
from compare import compare, load


def revision(rows):
    commits = {row.get('commit') for row in rows.values()}
    if len(commits) != 1 or None in commits or 'unknown' in commits:
        raise ValueError('每次实验必须记录唯一的代码提交')
    return commits.pop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--hypothesis', required=True)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if not args.hypothesis.strip():
        raise ValueError('必须提供改进假设')
    baseline, candidate = load(args.baseline), load(args.candidate)
    report = {'hypothesis': args.hypothesis, 'baseline_commit': revision(baseline),
              'candidate_commit': revision(candidate), 'comparison': compare(baseline, candidate),
              'decision': 'pending_human_review'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x') as file:
        json.dump(report, file, ensure_ascii=False, indent=2)
        file.write('\n')
    print(args.output)


if __name__ == '__main__':
    main()
