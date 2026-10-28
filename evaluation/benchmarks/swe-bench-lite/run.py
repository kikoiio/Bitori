#!/usr/bin/env python3
"""Run one pinned SWE-bench Lite development instance in an ephemeral container."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

DATASET = 'SWE-bench/SWE-bench_Lite'
REVISION = 'b0dde1093fe417d83b7184254edf8199c1f0dff5'
ROOT = Path(__file__).resolve().parents[3]


def command(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def image_for(instance):
    return (instance.get('image_name') or instance.get('docker_image') or
            f"docker.io/swebench/sweb.eval.x86_64.{instance['instance_id'].replace('__', '_1776_')}:latest").lower()


def grade(dataset, instance_id, predictions, run_id):
    from swebench.harness.constants import RUN_EVALUATION_LOG_DIR
    command([sys.executable, '-m', 'swebench.harness.run_evaluation',
             '--dataset_name', str(dataset), '--split', 'dev', '--instance_ids', instance_id,
             '--predictions_path', str(predictions), '--run_id', run_id,
             '--max_workers', '1', '--timeout', '900'])
    reports = list(Path(RUN_EVALUATION_LOG_DIR).glob(f'{run_id}/*/{instance_id}/report.json'))
    if len(reports) != 1:
        raise RuntimeError(f'官方评分器未生成唯一报告: {run_id}/{instance_id}')
    report = json.loads(reports[0].read_text())[instance_id]
    if run_id == 'gold' and not report['resolved']:
        logfile = reports[0].parent / 'run_instance.log'
        if logfile.is_file():
            report['log_tail'] = logfile.read_text(errors='replace')[-6000:].replace(os.environ.get('BITORI_API_KEY', ''), '[redacted]')
        test_output = reports[0].parent / 'test_output.txt'
        if test_output.is_file():
            report['test_output_tail'] = test_output.read_text(errors='replace')[-6000:].replace(os.environ.get('BITORI_API_KEY', ''), '[redacted]')
    return report


def repair_pvlib_image(instance):
    """Repair an upstream NumPy 2 incompatibility; caller must re-run the gold check."""
    image = image_for(instance)
    container = command(['docker', 'create', image, 'tail', '-f', '/dev/null'], capture_output=True).stdout.strip()
    try:
        command(['docker', 'start', container], capture_output=True)
        command(['docker', 'exec', container, '/opt/miniconda3/envs/testbed/bin/python', '-m', 'pip', 'install', 'numpy==1.26.4'], capture_output=True)
        command(['docker', 'commit', container, image], capture_output=True)
    finally:
        subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--index', type=int, required=True)
    parser.add_argument('--output', type=Path, default=Path('evaluation-output'))
    args = parser.parse_args()
    from datasets import load_dataset

    instances = sorted(load_dataset(DATASET, revision=REVISION, split='dev'), key=lambda item: item['instance_id'])
    if len(instances) != 23 or not 0 <= args.index < len(instances):
        raise ValueError('固定开发集必须有 23 题，索引必须在 0–22 内')
    instance = instances[args.index]
    iid = instance['instance_id']
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    dataset = out / 'instance.json'
    dataset.write_text(json.dumps([instance]))
    started = time.monotonic()
    result = {'instance_id': iid, 'dataset': DATASET, 'dataset_revision': REVISION,
              'split': 'dev', 'model': os.environ['BITORI_MODEL'],
              'provider': os.environ['BITORI_PROVIDER'], 'commit': os.environ.get('GITHUB_SHA', 'unknown'),
              'status': 'infrastructure_error', 'gold_verified': False}
    container = None
    try:
        gold = grade(dataset, iid, 'gold', 'gold')
        if not gold['resolved'] and instance.get('repo') == 'pvlib/pvlib-python' and 'np.Inf' in gold.get('test_output_tail', ''):
            repair_pvlib_image(instance)
            result['environment_adjustments'] = ['pvlib: numpy==1.26.4']
            gold = grade(dataset, iid, 'gold', 'gold-repaired')
        if not gold['resolved']:
            result['gold_report'] = gold
            raise RuntimeError('官方答案未通过评分，不能信任此任务的环境')
        result['gold_verified'] = True
        mounts = []
        for source, target in [(ROOT / 'dist', '/opt/bitori/dist'),
                               (ROOT / 'node_modules', '/opt/bitori/node_modules'),
                               (ROOT / 'package.json', '/opt/bitori/package.json'),
                               (Path(os.environ['BITORI_NODE']).resolve(), '/opt/bitori/node')]:
            mounts += ['--mount', f'type=bind,src={source},dst={target},readonly']
        container = command(['docker', 'run', '-d', '--init', *mounts, image_for(instance),
                             'tail', '-f', '/dev/null'], capture_output=True).stdout.strip()
        # Only the task container sees the model credential; never record its output.
        setup = "mkdir -p /tmp/bitori-home/.bitori /testbed/.bitori; touch /tmp/bitori-home/.bitori/.env; printf 'mode: bypass\\n' > /testbed/.bitori/permissions.local.yaml; cat > /tmp/bitori-home/.bitori/config.yaml"
        config = ('profiles:\n  - name: bench\n    protocol: openai-chat\n'
                  f'    model: {json.dumps(os.environ["BITORI_MODEL"])}\n'
                  f'    base_url: {json.dumps(os.environ["BITORI_BASE_URL"])}\n'
                  '    api_key: ${BITORI_API_KEY}\n    context_window: 131072\n')
        command(['docker', 'exec', '-i', container, 'sh', '-c', setup], input=config, capture_output=True)
        run = subprocess.run(['docker', 'exec', '-e', 'HOME=/tmp/bitori-home',
                              '-e', 'BITORI_API_KEY', '-e', 'BITORI_BASE_URL', '-e', 'BITORI_MODEL',
                              '-w', '/testbed', container, '/opt/bitori/node', '/opt/bitori/dist/bin/bitori.js',
                              'exec', '--profile', 'bench', '--task', instance['problem_statement'],
                              '--workspace', '/testbed', '--max-iterations', '30', '--json'],
                             capture_output=True, text=True, timeout=1800)
        try:
            summary = json.loads(run.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            raise RuntimeError('Bitori 未返回有效 JSON') from None
        result['agent'] = {key: summary.get(key) for key in ('status', 'stopReason', 'iterations', 'inputTokens', 'outputTokens')}
        if run.returncode != 0:
            result['status'] = 'agent_error'
            result['agent']['errorCode'] = summary.get('errorCode')
            message = str(summary.get('errorMessage') or summary.get('error') or '')
            result['agent']['errorMessage'] = message.replace(os.environ['BITORI_API_KEY'], '[redacted]')[:500]
            raise RuntimeError('Bitori 执行失败；请检查模型和任务运行状态')
        # Include new files in the patch but never include Bitori's own workspace data.
        command(['docker', 'exec', '-w', '/testbed', container, 'git', 'add', '-N', '--', '.', ':(exclude).bitori'])
        patch = command(['docker', 'exec', '-w', '/testbed', container, 'git', 'diff', 'HEAD', '--', '.', ':(exclude).bitori'], capture_output=True).stdout
        if not patch.strip():
            result['status'] = 'unresolved'
            return
        predictions = out / 'prediction.json'
        predictions.write_text(json.dumps([{'instance_id': iid, 'model_name_or_path': 'bitori', 'model_patch': patch}]))
        candidate = grade(dataset, iid, predictions, 'candidate')
        result['status'] = 'resolved' if candidate['resolved'] else 'unresolved'
    except (OSError, subprocess.SubprocessError, RuntimeError, ValueError) as error:
        result['error'] = str(error)[:500]
    finally:
        if container:
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        result['duration_seconds'] = round(time.monotonic() - started, 2)
        (out / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    if result['status'] in ('infrastructure_error', 'agent_error'):
        sys.exit(1)


if __name__ == '__main__':
    main()
