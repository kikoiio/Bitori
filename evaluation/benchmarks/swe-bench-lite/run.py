#!/usr/bin/env python3
"""Run one pinned SWE-bench Lite development instance; export only safe evidence."""
import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
import uuid

DATASET = 'SWE-bench/SWE-bench_Lite'
REVISION = 'b0dde1093fe417d83b7184254edf8199c1f0dff5'
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'evaluation' / 'RSI'))
from contracts import SCHEMA_VERSION, atomic_json, digest, project_trace, sanitize, write_evidence
try:
    from analyze import analyze
except ImportError:
    analyze = None

MAX_OUTPUT = 1024 * 1024
MAX_PATCH = 8 * 1024 * 1024
MAX_TRACE = 8 * 1024 * 1024
MAX_EVENTS = 1000  # write_evidence's list bound; never silently drop projected events.
SAFE_ID = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')
SHA = re.compile(r'^[0-9a-f]{40}(?:[0-9a-f]{24})?$')
ERROR_STATUSES = {'infrastructure_error', 'agent_error', 'provider_error'}
RESOURCE_FLAGS = ['--cap-drop=ALL', '--security-opt=no-new-privileges:true',
                  '--pids-limit=256', '--memory=4g', '--memory-swap=4g', '--cpus=2']


def command(args, *, input=None, env=None, cwd=None, timeout=120,
            max_output=MAX_OUTPUT, check=True):
    """Drain both pipes with bounded memory; never inherit command output.

    Timeout exceptions also contain only bounded output. Do not print these
    exceptions: their argv/input may include task text or private file paths.
    """
    if env is None:
        env = {key: value for key, value in os.environ.items()
               if not re.search(r'(?i)(key|token|password|secret)', key)}
    with tempfile.TemporaryFile() as stdin:
        if input is not None:
            stdin.write(input.encode() if isinstance(input, str) else input)
        stdin.seek(0)
        with subprocess.Popen(args, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=env, cwd=cwd, start_new_session=True) as process:
            buffers = {'stdout': bytearray(), 'stderr': bytearray()}
            truncated = {'stdout': False, 'stderr': False}
            deadline = time.monotonic() + timeout
            timed_out = False
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
                selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
                try:
                    while selector.get_map():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            timed_out = True
                            break
                        for key, _ in selector.select(min(remaining, 0.2)):
                            data = os.read(key.fileobj.fileno(), 65536)
                            if not data:
                                selector.unregister(key.fileobj)
                                continue
                            name = key.data
                            room = max_output - len(buffers[name])
                            buffers[name].extend(data[:room])
                            truncated[name] |= len(data) > room
                    if not timed_out:
                        try:
                            process.wait(timeout=max(0.001, deadline - time.monotonic()))
                        except subprocess.TimeoutExpired:
                            timed_out = True
                finally:
                    if process.poll() is None or timed_out:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                    process.wait()
            stdout = bytes(buffers['stdout']).decode('utf-8', errors='replace')
            stderr = bytes(buffers['stderr']).decode('utf-8', errors='replace')
            if timed_out:
                raise subprocess.TimeoutExpired(args, timeout, output=stdout, stderr=stderr)
            completed = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
            completed.stdout_truncated = truncated['stdout']
            completed.stderr_truncated = truncated['stderr']
            if check and completed.returncode:
                raise subprocess.CalledProcessError(completed.returncode, args, stdout, stderr)
            return completed


def image_for(instance):
    return (instance.get('image_name') or instance.get('docker_image') or
            f"docker.io/swebench/sweb.eval.x86_64.{instance['instance_id'].replace('__', '_1776_')}:latest").lower()


def provider_settings(environment):
    protocol = environment.get('BITORI_PROTOCOL', 'openai-chat')
    if protocol not in ('anthropic', 'openai-chat', 'openai-responses'):
        raise ValueError(f'不支持的模型协议: {protocol}')
    base_url = environment['BITORI_BASE_URL']
    normalized = base_url.rstrip('/')
    if protocol == 'openai-responses' and normalized.endswith('/responses'):
        base_url = normalized.removesuffix('/responses')
    return protocol, base_url


def read_bounded(path, limit, *, tail=False):
    with Path(path).open('rb') as file:
        if tail:
            file.seek(max(0, os.fstat(file.fileno()).st_size - limit))
        data = file.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Private file exceeds size limit')
    return data.decode('utf-8', errors='replace')


def grade(dataset, instance_id, predictions, run_id):
    """All official grader files (including gold and real predictions) stay private."""
    from swebench.harness.constants import RUN_EVALUATION_LOG_DIR
    private = Path(dataset).parent
    log_root = Path(RUN_EVALUATION_LOG_DIR)
    if log_root.is_absolute() or '..' in log_root.parts:
        raise ValueError('Grader log directory must be relative to private working directory')
    command([sys.executable, '-m', 'swebench.harness.run_evaluation',
             '--dataset_name', str(dataset), '--split', 'dev', '--instance_ids', instance_id,
             '--predictions_path', str(predictions), '--run_id', run_id,
             '--max_workers', '1', '--timeout', '900'], cwd=private, timeout=1200)
    reports = list((private / log_root).glob(f'{run_id}/*/{instance_id}/report.json'))
    if len(reports) != 1:
        raise RuntimeError('Official grader did not produce a unique report')
    report = json.loads(read_bounded(reports[0], MAX_OUTPUT))[instance_id]
    if not isinstance(report, dict) or type(report.get('resolved')) is not bool:
        raise ValueError('Official grader report has no boolean outcome')
    if predictions == 'gold' and not report['resolved']:
        output = reports[0].parent / 'test_output.txt'
        if output.is_file():
            report['test_output_tail'] = read_bounded(output, 6000, tail=True)
    return report


def image_id(image, *, pull=False):
    inspection = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image], check=False)
    if inspection.returncode and pull:
        command(['docker', 'pull', image], timeout=900)
        inspection = command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image])
    value = inspection.stdout.strip()
    if inspection.returncode or not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        raise RuntimeError('Cannot establish image content identity')
    return value


def repair_pvlib_image(instance):
    """Keep the existing NumPy repair policy; caller must re-run gold verification."""
    image = image_for(instance)
    container = f'bitori-repair-{uuid.uuid4().hex}'
    try:
        command(['docker', 'create', '--name', container, *RESOURCE_FLAGS,
                 image, 'tail', '-f', '/dev/null'])
        command(['docker', 'start', container])
        command(['docker', 'exec', container, '/opt/miniconda3/envs/testbed/bin/python',
                 '-m', 'pip', 'install', 'numpy==1.26.4'], timeout=600)
        command(['docker', 'commit', container, image], timeout=300)
    finally:
        command(['docker', 'rm', '-f', container], check=False)


def file_digest(path):
    hasher = hashlib.sha256()
    with Path(path).open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def tree_digest(directory):
    """Hash actual mounted content, not a claimed build manifest or lockfile alone."""
    directory = Path(directory).resolve(strict=True)
    records = []
    for path in sorted(directory.rglob('*')):
        relative = path.relative_to(directory).as_posix()
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            path.resolve(strict=True).relative_to(directory)  # no host dependency links
            records.append((relative, 'symlink', os.readlink(path)))
        elif stat.S_ISREG(mode):
            records.append((relative, stat.S_IMODE(mode), file_digest(path)))
        elif not stat.S_ISDIR(mode):
            raise ValueError('Non-regular build input')
    return digest(records)


# Copy just one regular session file through a bounded pipe, never docker cp a
# directory/config/database. O_NOFOLLOW also prevents FIFO/device/symlink reads.
TRACE_READER = r'''
import base64, json, os, re, stat, sys
session, cap = sys.argv[1], int(sys.argv[2])
safe = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
try:
    for part in ('tmp', 'bitori-home', '.bitori', 'traces'):
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = child
    if not session:
        names = []
        with os.scandir(fd) as entries:
            for number, entry in enumerate(entries):
                if number >= 64:
                    raise ValueError('ambiguous trace directory')
                if entry.name.endswith('.jsonl') and safe.fullmatch(entry.name[:-6]):
                    names.append(entry.name[:-6])
        if len(names) != 1:
            raise ValueError('missing or ambiguous session')
        session = names[0]
    if not safe.fullmatch(session):
        raise ValueError('invalid session ID')
    source = os.open(session + '.jsonl', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(source, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('not a regular trace')
        data = file.read(cap + 1)
    print(json.dumps({'sessionId': session, 'bytes': len(data[:cap]),
                      'truncated': len(data) > cap or info.st_size > cap,
                      'data': base64.b64encode(data[:cap]).decode('ascii')}))
finally:
    os.close(fd)
'''


def without_internal(value):
    if isinstance(value, dict):
        return {key: without_internal(item) for key, item in value.items()
                if key.replace('_', '').lower() not in
                {'thinking', 'providerstate', 'reasoning', 'reasoningcontent', 'requestbody', 'requestcontext'}}
    if isinstance(value, list):
        return [without_internal(item) for item in value]
    return value


def collect_trace(container, summary, private, secrets):
    session = summary.get('sessionId')
    run_id = summary.get('runId')
    for value in (session, run_id):
        if value is not None and (not isinstance(value, str) or not SAFE_ID.fullmatch(value)):
            raise ValueError('Unsafe trace identity')
    copied = command(['docker', 'exec', container, '/opt/miniconda3/envs/testbed/bin/python',
                      '-c', TRACE_READER, session or '', str(MAX_TRACE)],
                     max_output=MAX_TRACE * 2, timeout=30)
    if copied.stdout_truncated:
        raise ValueError('Trace copy exceeds bound')
    envelope = json.loads(copied.stdout)
    selected = envelope['sessionId']
    if not isinstance(selected, str) or not SAFE_ID.fullmatch(selected) or (session and session != selected):
        raise ValueError('Trace session mismatch')
    data = base64.b64decode(envelope['data'], validate=True)
    if len(data) > MAX_TRACE:
        raise ValueError('Trace copy exceeds bound')
    raw = private / 'session.jsonl'
    raw.write_bytes(data)
    raw.chmod(0o600)
    lines = data.decode('utf-8', errors='replace').splitlines()
    if run_id is None:
        runs = set()
        for line in lines:
            try:
                event = json.loads(line)
                if isinstance(event, dict) and event.get('type') == 'agent_event':
                    event = event.get('event')
                if isinstance(event, dict) and event.get('type') == 'run_header':
                    identity = event.get('runId')
                    if isinstance(identity, str) and SAFE_ID.fullmatch(identity):
                        runs.add(identity)
            except (ValueError, TypeError):
                pass
        if len(runs) != 1:
            raise ValueError('Missing or ambiguous run identity')
        run_id = runs.pop()
    stats = summary.get('trace')
    if not isinstance(stats, dict) or any(type(stats.get(key)) is not int or stats[key] < 0
                                         for key in ('written', 'dropped', 'writeErrors', 'serializationErrors')):
        stats = None
    events, integrity = project_trace(lines, run_id=run_id, writer_stats=stats,
                                      secrets=secrets, max_events=MAX_EVENTS)
    integrity.update(available=True, bytes=len(data), session_id=selected, run_id=run_id)
    if envelope.get('truncated') or b'\xef\xbf\xbd' in data or '\ufffd' in data.decode('utf-8', errors='replace'):
        integrity.update(complete=False, truncated=True)
    return without_internal(events), integrity


def collect_patch(container):
    command(['docker', 'exec', '-w', '/testbed', container, 'git', 'add', '-N', '--', '.',
             ':(exclude).bitori'])
    result = command(['docker', 'exec', '-w', '/testbed', container, 'git', '-c',
                      'core.quotePath=true', 'diff', '--no-ext-diff', '--no-textconv',
                      'HEAD', '--', '.', ':(exclude).bitori'], max_output=MAX_PATCH)
    if result.stdout_truncated:
        raise ValueError('Solution diff exceeds grading bound')
    return result.stdout


def parse_summary(run):
    if run.stdout_truncated:
        raise ValueError('Agent output exceeds JSON bound')
    summary = json.loads(run.stdout.strip().splitlines()[-1],
                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite JSON')))
    if not isinstance(summary, dict) or not isinstance(summary.get('status'), str):
        raise ValueError('Agent did not return a structured result')
    return summary


def arm_identity(result):
    """Facts that must match for two arms to be comparable; excludes candidate SHA/build."""
    fingerprint = result.get('fingerprint') or {}
    return {
        'dataset': DATASET, 'dataset_revision': REVISION, 'split': 'dev',
        'instance_id': result.get('instance_id'),
        'model': result.get('model'), 'provider': result.get('provider'),
        'protocol': result.get('protocol'), 'model_access': result.get('model_access'),
        'endpoint': fingerprint.get('endpoint'),
        'max_iterations': fingerprint.get('max_iterations'),
        'timeout_seconds': fingerprint.get('timeout_seconds'),
        'context_window': fingerprint.get('context_window'),
        'image_id': fingerprint.get('image_id'),
        'image_base_id': fingerprint.get('image_base_id'),
        'environment_adjustments': result.get('environment_adjustments', []),
        'dependencies': fingerprint.get('dependencies'), 'node': fingerprint.get('node'),
        'runner': fingerprint.get('runner'),
        'swebench_version': fingerprint.get('swebench_version'),
        'datasets_version': fingerprint.get('datasets_version'),
    }


def failure(result, stage, error, *, status='infrastructure_error'):
    # Never stringify arbitrary exceptions: CalledProcessError carries argv,
    # provider errors carry credentials, and grader errors can contain gold.
    if result['failure_stage'] is None:
        result.update(status=status, failure_stage=stage,
                      error=f'{stage} failed ({type(error).__name__})')


def run_instance(args, environment=None):
    """Return a finalized, sanitized result even when initialization fails."""
    environment = dict(os.environ if environment is None else environment)
    started = time.monotonic()
    nonce = uuid.uuid4().hex
    result = {'schema_version': SCHEMA_VERSION, 'attempt_id': args.attempt_id or nonce,
              'instance_id': None, 'index': args.index, 'dataset': DATASET,
              'dataset_revision': REVISION, 'split': 'dev', 'status': 'infrastructure_error',
              'gold_verified': False, 'failure_stage': None, 'session_id': None, 'run_id': None,
              'agent_sha': args.agent_sha, 'source_sha': args.agent_sha, 'harness_sha': args.harness_sha,
              'commit': args.agent_sha or environment.get('GITHUB_SHA', 'unknown'),
              'model_access': 'gateway' if args.gateway_url else 'direct',
              'usage_source': 'unavailable', 'fingerprint': {},
              'trace_integrity': {'available': False, 'complete': False},
              'patch': {'present': False, 'collected': False, 'empty': None, 'replayable': False},
              'grading': {'attempted': False}, 'collection_errors': {}}
    secrets = [value for key, value in environment.items()
               if value and re.search(r'(?i)(key|token|password|secret)', key)]
    secrets += [environment.get('BITORI_BASE_URL', '')]
    out, private_context, private, container = None, None, None, None
    instance, summary, events, patch = None, {}, [], None
    diagnosis = None
    eligible = False
    stage = 'initialization'
    try:
        output = args.output.resolve()
        output.mkdir(parents=True, exist_ok=True)
        if any(output.iterdir()):
            raise ValueError('Attempt output must be empty; never overwrite earlier evidence')
        out = output
        private_context = tempfile.TemporaryDirectory(prefix='bitori-grading-')
        private = Path(private_context.name)
        stage = 'configuration'
        if not SAFE_ID.fullmatch(result['attempt_id']):
            raise ValueError('Invalid attempt ID')
        for sha in (args.agent_sha, args.harness_sha):
            if sha is not None and not SHA.fullmatch(sha):
                raise ValueError('Invalid revision SHA')
        if args.max_iterations < 1 or args.timeout < 1:
            raise ValueError('Budgets must be positive')
        provider_env = dict(environment)
        credential_name = 'BITORI_API_KEY'
        network = args.network or 'bridge'
        if args.gateway_url:
            parsed = urlsplit(args.gateway_url)
            if (parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or
                    parsed.password or parsed.query or parsed.fragment):
                raise ValueError('Invalid gateway URL')
            if not args.network or network in {'host', 'bridge', 'default', 'none'}:
                raise ValueError('Gateway mode requires an explicit isolated network')
            provider_env['BITORI_BASE_URL'] = args.gateway_url
            credential_name = 'BITORI_RUN_TOKEN'
        elif network == 'host' or network.startswith('container:'):
            raise ValueError('Host/shared container networking is not allowed')
        credential = environment[credential_name]
        if not credential:
            raise ValueError('Missing model credential')
        protocol, base_url = provider_settings(provider_env)
        # In gateway mode the URL is a per-run container address, so callers pin a
        # stable upstream identity digest instead; both arms must match on it.
        endpoint = environment.get('BITORI_ENDPOINT_ID') or digest(base_url)
        if not re.fullmatch(r'[0-9a-f]{64}', endpoint):
            raise ValueError('Invalid upstream endpoint identity')
        result.update(model=environment['BITORI_MODEL'], provider=environment['BITORI_PROVIDER'], protocol=protocol)
        result['fingerprint'].update(endpoint=endpoint, max_iterations=args.max_iterations,
                                     timeout_seconds=args.timeout, context_window=131072,
                                     dataset_revision=REVISION)
        stage = 'build'
        agent_root = args.agent_root.resolve(strict=True)
        dependencies = Path(args.dependencies or agent_root / 'node_modules').resolve(strict=True)
        mounts = []
        for source, destination in ((agent_root / 'dist', '/opt/bitori/dist'),
                                    (agent_root / 'package.json', '/opt/bitori/package.json'),
                                    (dependencies, '/opt/bitori/node_modules')):
            source.resolve(strict=True)
            if source.is_symlink() or ',' in str(source):
                raise ValueError('Unsafe build mount')
            mounts += ['--mount', f'type=bind,src={source},dst={destination},readonly']
        if not (agent_root / 'dist/bin/bitori.js').is_file() or not dependencies.is_dir():
            raise ValueError('Missing agent build entrypoint or dependencies')
        node = Path(environment['BITORI_NODE']).resolve(strict=True)
        if not node.is_file() or ',' in str(node):
            raise ValueError('Invalid Node binary')
        mounts += ['--mount', f'type=bind,src={node},dst=/opt/bitori/node,readonly']
        result['fingerprint'].update(source_sha=args.agent_sha, harness_sha=args.harness_sha,
                                     build=digest({'dist': tree_digest(agent_root / 'dist'),
                                                   'package': file_digest(agent_root / 'package.json')}),
                                     dependencies=tree_digest(dependencies),
                                     node=file_digest(node), runner=file_digest(Path(__file__)))
        for package in ('swebench', 'datasets'):
            try:
                result['fingerprint'][package + '_version'] = importlib.metadata.version(package)
            except importlib.metadata.PackageNotFoundError:
                result['fingerprint'][package + '_version'] = None
        stage = 'dataset'
        from datasets import load_dataset
        instances = sorted(load_dataset(DATASET, revision=REVISION, split='dev'), key=lambda item: item['instance_id'])
        if len(instances) != 23 or not 0 <= args.index < len(instances):
            raise ValueError('Pinned development split must have 23 tasks and index 0-22')
        instance = dict(instances[args.index])
        iid = instance['instance_id']
        if not isinstance(iid, str) or not SAFE_ID.fullmatch(iid):
            raise ValueError('Unsafe instance identity')
        result['instance_id'] = iid
        secrets.extend(value for key in ('patch', 'test_patch') if isinstance(value := instance.get(key), str) and value)
        result['fingerprint']['dataset'] = digest({'dataset': DATASET, 'revision': REVISION,
                                                   'split': 'dev', 'instance': instance})
        dataset = private / 'instance.json'
        atomic_json(dataset, [instance])
        stage = 'image'
        image = image_for(instance)
        pinned_image = image_id(image, pull=True)
        result['fingerprint'].update(image_id=pinned_image, image_source='upstream')
        stage = 'gold_verification'
        gold = grade(dataset, iid, 'gold', f'gold-{nonce}')
        if (gold.get('resolved') is False and instance.get('repo') == 'pvlib/pvlib-python'
                and 'np.Inf' in gold.get('test_output_tail', '')):
            repair_pvlib_image(instance)
            result['environment_adjustments'] = ['pvlib: numpy==1.26.4']
            result['fingerprint']['image_base_id'] = pinned_image
            pinned_image = image_id(image)
            result['fingerprint'].update(image_id=pinned_image, image_source='derived')
            gold = grade(dataset, iid, 'gold', f'gold-repaired-{nonce}')
        if gold.get('resolved') is not True:
            raise RuntimeError('Gold verification failed')
        if image_id(image) != pinned_image:
            raise RuntimeError('Gold image identity changed')
        result['gold_verified'] = True
        stage = 'container'
        if args.gateway_url:
            internal = command(['docker', 'network', 'inspect', '--format', '{{json .Internal}}', network])
            if internal.stdout.strip() != 'true':
                raise ValueError('Gateway network must be Docker-internal')
        container = f'bitori-eval-{nonce}'
        command(['docker', 'run', '-d', '--name', container, '--init', '--user=0:0',
                 *RESOURCE_FLAGS, '--network', network,
                 '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g,mode=1777', *mounts,
                 pinned_image, 'tail', '-f', '/dev/null'])
        stage = 'agent_setup'
        # Root only prepares this disposable filesystem. The agent runs as uid
        # 1000, with no capabilities, no privilege escalation, no host home/socket.
        setup = ("mkdir -p /tmp/bitori-home/.bitori /testbed/.bitori; "
                 "touch /tmp/bitori-home/.bitori/.env; "
                 "printf 'mode: bypass\\n' > /testbed/.bitori/permissions.local.yaml; "
                 "cat > /tmp/bitori-home/.bitori/config.yaml; "
                 "chmod -R a+rwX /tmp/bitori-home /testbed")
        config = (f'profiles:\n  - name: bench\n    protocol: {json.dumps(protocol)}\n'
                  f'    model: {json.dumps(environment["BITORI_MODEL"])}\n'
                  f'    base_url: {json.dumps(base_url)}\n'
                  f'    api_key: ${{{credential_name}}}\n    context_window: 131072\n')
        secrets.append(config)
        command(['docker', 'exec', '-i', container, 'sh', '-ec', setup], input=config)
        agent_env = {key: value for key, value in environment.items()
                     if not re.search(r'(?i)(key|token|password|secret|BITORI_BASE_URL|BITORI_ENDPOINT_ID)', key)}
        agent_env[credential_name] = credential
        stage = 'agent_execution'
        run = command(['docker', 'exec', '--user=1000:1000', '-e', 'HOME=/tmp/bitori-home',
                       '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory',
                       '-e', 'GIT_CONFIG_VALUE_0=/testbed', '-e', credential_name, '-w', '/testbed', container,
                       'sh', '-ec', 'printf "%s" "$$" > /tmp/bitori-agent.pid; exec "$@"', 'agent',
                       'timeout', '--signal=TERM', '--kill-after=10', str(args.timeout),
                       '/opt/bitori/node', '/opt/bitori/dist/bin/bitori.js',
                       'exec', '--profile', 'bench', '--task', instance['problem_statement'],
                       '--workspace', '/testbed', '--max-iterations', str(args.max_iterations), '--json'],
                      env=agent_env, timeout=args.timeout + 20, check=False)
        if run.returncode in (124, 137):
            raise subprocess.TimeoutExpired('agent', args.timeout)
        stage = 'agent_json'
        summary = parse_summary(run)
        result['agent'] = sanitize({key: summary.get(key) for key in
                                   ('status', 'stopReason', 'iterations', 'inputTokens', 'outputTokens',
                                    'errorCode', 'errorMessage')}, secrets, limit=500)
        for key, field in (('sessionId', 'session_id'), ('runId', 'run_id')):
            identity = summary.get(key)
            if isinstance(identity, str) and SAFE_ID.fullmatch(identity):
                result[field] = identity
        if all(type(summary.get(key)) is int and summary[key] >= 0 for key in ('inputTokens', 'outputTokens')):
            result['usage_source'] = 'agent_reported'
        message = str(summary.get('errorMessage') or summary.get('error') or '')
        eligible = (run.returncode == 0 and summary.get('status') in {'idle', 'completed'}
                    and summary.get('stopReason') == 'natural_completion' and not message
                    and not summary.get('errorCode'))
        if not eligible:
            provider_error = (summary.get('errorCode') in {'authentication', 'rate_limit'}
                              or message.startswith(('401 ', '403 ', '413 ', '429 ')))
            failure(result, 'agent_execution', RuntimeError(),
                    status='provider_error' if provider_error else 'agent_error')
    except (Exception, KeyboardInterrupt) as error:
        status = 'agent_error' if stage in {'agent_execution', 'agent_json'} else 'infrastructure_error'
        failure(result, 'agent_timeout' if isinstance(error, subprocess.TimeoutExpired) and stage == 'agent_execution' else stage,
                error, status=status)
    finally:
        # Neither execution errors nor failed collection can skip the other
        # collector or container cleanup. Raw data never enters the output dir.
        try:
            if container:
                try:
                    command(['docker', 'exec', '--user=1000:1000', container,
                             '/opt/miniconda3/envs/testbed/bin/python', '-c',
                             "import os,signal; p=open('/tmp/bitori-agent.pid').read(32); "
                             "pid=int(p); os.killpg(pid, signal.SIGKILL) if pid>1 else None"],
                            check=False, timeout=15)
                except Exception as error:
                    result['collection_errors']['agent_stop'] = type(error).__name__
                    eligible = False
                    failure(result, 'agent_stop', error)
                try:
                    patch = collect_patch(container)
                    result['patch'] = {'present': bool(patch), 'collected': True,
                                       'empty': not patch.strip(), 'bytes': len(patch.encode()),
                                       'sha256': digest(patch.encode()), 'replayable': False}
                    result['patch_empty'] = not patch.strip()
                except Exception as error:
                    result['collection_errors']['patch_collection'] = type(error).__name__
                    failure(result, 'patch_collection', error)
                try:
                    events, integrity = collect_trace(container, summary, private, secrets)
                    result['trace_integrity'] = integrity
                    result['session_id'], result['run_id'] = integrity['session_id'], integrity['run_id']
                except Exception as error:
                    result['collection_errors']['trace_collection'] = type(error).__name__
                    result['trace_integrity'].update(error='Trace unavailable or invalid')
            if eligible and result['failure_stage'] is None and patch is not None:
                if not patch.strip():
                    result['status'] = 'unresolved'
                    result['grading']['skipped'] = 'empty_patch'
                else:
                    try:
                        if image_id(image) != pinned_image:
                            raise RuntimeError('Grading image identity changed')
                        predictions = private / 'prediction.json'
                        atomic_json(predictions, [{'instance_id': iid, 'model_name_or_path': 'bitori', 'model_patch': patch}])
                        result['grading']['attempted'] = True
                        candidate = grade(dataset, iid, predictions, f'candidate-{nonce}')
                        if type(candidate.get('resolved')) is not bool:
                            raise ValueError('Missing grading outcome')
                        if image_id(image) != pinned_image:
                            raise RuntimeError('Grading image identity changed')
                        result['candidate_report'] = {'resolved': candidate['resolved']}
                        result['status'] = 'resolved' if candidate['resolved'] else 'unresolved'
                    except Exception as error:
                        failure(result, 'candidate_grading', error)
            if not result['grading']['attempted']:
                result['grading'].setdefault('skipped', 'not_normal_completion')
            result['duration_seconds'] = round(time.monotonic() - started, 2)
            if out is not None:
                result['comparison_config'] = arm_identity(result)
                diagnosis = None
                if analyze is not None:
                    try:
                        diagnosis = json.dumps(sanitize(analyze(result, events), secrets),
                                               indent=2, sort_keys=True) + '\n'
                    except Exception as error:
                        result['collection_errors']['diagnosis'] = type(error).__name__
                metadata = dict(result['patch'])
                result = write_evidence(out, result, events, secrets=secrets, patch=patch,
                                        extra={'diagnosis.json': diagnosis} if diagnosis else None)
                result['patch'] = {**metadata, **result['patch']}
        except (Exception, KeyboardInterrupt) as error:
            failure(result, 'artifact_export', error)
            result['evidence_error'] = 'Safe evidence export failed'
        finally:
            if container:
                try:
                    cleanup = command(['docker', 'rm', '-f', container], check=False, timeout=30)
                    if cleanup.returncode:
                        raise RuntimeError('Container cleanup failed')
                except Exception as error:
                    result['collection_errors']['cleanup'] = type(error).__name__
                    failure(result, 'cleanup', error)
            if private_context is not None:
                try:
                    private_context.cleanup()
                except Exception as error:
                    failure(result, 'private_cleanup', error)
        result['duration_seconds'] = round(time.monotonic() - started, 2)
        result = sanitize(result, secrets)
        if out is not None:
            result['comparison_config'] = arm_identity(result)
            try:
                result = write_evidence(out, result, events, secrets=secrets, patch=patch,
                                        extra={'diagnosis.json': diagnosis} if diagnosis else None)
            except Exception as error:
                failure(result, 'artifact_export', error)
                result['evidence_error'] = 'Safe evidence export failed'
                try:
                    atomic_json(out / 'result.json', sanitize(result, secrets))
                except Exception:
                    pass  # Caller sees a failing result; missing artifacts cannot pass verification.
        print(json.dumps(sanitize(result, secrets), allow_nan=False))
    return result


def argument_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', type=int, required=True)
    parser.add_argument('--output', type=Path, default=Path('evaluation-output'))
    parser.add_argument('--agent-root', type=Path, default=ROOT)
    parser.add_argument('--dependencies', type=Path,
                        help='trusted node_modules; defaults to <agent-root>/node_modules')
    parser.add_argument('--agent-sha')
    parser.add_argument('--harness-sha')
    parser.add_argument('--attempt-id')
    parser.add_argument('--network')
    parser.add_argument('--gateway-url')
    parser.add_argument('--max-iterations', type=int, default=30)
    parser.add_argument('--timeout', type=int, default=1800, help='Agent wall-clock budget in seconds')
    return parser


def main(argv=None):
    result = run_instance(argument_parser().parse_args(argv))
    return 1 if result['status'] in ERROR_STATUSES or result.get('evidence_error') else 0


if __name__ == '__main__':
    raise SystemExit(main())
