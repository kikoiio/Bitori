import io
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import tarfile
import time
import uuid

from contracts import SHA_PATTERN, atomic_json, digest

SOURCE_PATHS = ('src', 'tests', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts', 'eslint.config.js')
CONFIG_PATHS = ('package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts', 'eslint.config.js')
CHECK_COMMANDS = {
    'typecheck': ['node', 'node_modules/typescript/bin/tsc', '--noEmit'],
    'lint': ['node', 'node_modules/eslint/bin/eslint.js', '.'],
    'build': ['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
    'trusted_unit': ['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/unit'],
    'integration': ['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/integration'],
    'security': ['node', 'node_modules/vitest/vitest.mjs', 'run',
                 'tests/unit/tools/permission-engine.test.ts', 'tests/unit/shared/redact.test.ts'],
    'regression': ['node', 'node_modules/vitest/vitest.mjs', 'run', 'tests/unit', 'tests/integration'],
}
GATEWAY_PORT = 8080
GATEWAY_IMAGE = 'node:24-slim'
_NAME = re.compile(r'[a-z0-9][a-z0-9_.-]{0,62}\Z')


def bounded_command(args, timeout=120, cwd=None, env=None, max_bytes=1024 * 1024):
    started = time.monotonic()
    process = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    streams = selectors.DefaultSelector()
    streams.register(process.stdout, selectors.EVENT_READ, 'stdout')
    streams.register(process.stderr, selectors.EVENT_READ, 'stderr')
    data = {'stdout': bytearray(), 'stderr': bytearray()}
    reason = None
    try:
        while streams.get_map():
            if time.monotonic() - started >= timeout:
                reason = 'timeout'
                break
            for key, _ in streams.select(min(0.2, max(0, timeout - (time.monotonic() - started)))):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    streams.unregister(key.fileobj)
                    continue
                data[key.data].extend(chunk)
                if sum(map(len, data.values())) > max_bytes:
                    reason = 'output_limit'
                    break
            if reason:
                break
        if reason:
            os.killpg(process.pid, signal.SIGKILL)
        remaining = max(0.1, timeout - (time.monotonic() - started))
        try:
            process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            reason = 'timeout'
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    finally:
        streams.close()
        process.stdout.close()
        process.stderr.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    return {'returncode': process.returncode, 'reason': reason,
            **{name: bytes(value[:max_bytes]).decode(errors='replace') for name, value in data.items()},
            'duration_seconds': round(time.monotonic() - started, 3)}


def docker(args, timeout=120, env=None):
    result = bounded_command(['docker', *args], timeout=timeout, env=env)
    if result['returncode'] != 0 or result['reason']:
        raise RuntimeError(f'Docker operation failed: {args[0]} ({result["reason"] or result["returncode"]})')
    return result['stdout'].strip()


def resolve_image(image, *, pull=True, timeout=900):
    """Resolve a floating tag to its immutable image ID once per experiment."""
    if not isinstance(image, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./:@-]{0,200}', image):
        raise ValueError('invalid image reference')
    inspection = bounded_command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
                                 timeout=60)
    if (inspection['returncode'] or inspection['reason']) and pull:
        docker(['pull', image], timeout=timeout)
        inspection = bounded_command(['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
                                     timeout=60)
    value = inspection['stdout'].strip()
    if inspection['returncode'] or inspection['reason'] or not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        raise RuntimeError('cannot establish image content identity')
    return value


def _name(value, label):
    if not isinstance(value, str) or not _NAME.fullmatch(value):
        raise ValueError(f'invalid {label}')
    return value


def _absolute(path, label):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink():
        raise ValueError(f'{label} must be an absolute non-symlink path')
    return path


def ensure_internal_network(name):
    """Create or reuse a Docker-internal network; callers verify it has no egress."""
    _name(name, 'network name')
    if name not in docker(['network', 'ls', '--format', '{{.Name}}']).splitlines():
        docker(['network', 'create', '--internal', name])
    if docker(['network', 'inspect', '--format', '{{.Internal}}', name]) != 'true':
        raise RuntimeError('model network is not Docker-internal')
    return name


def _wait_port(container, port, timeout):
    script = (f"const n=require('net');const s=n.connect({port},'127.0.0.1',()=>{{s.end();process.exit(0)}});"
              "s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1000)")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            docker(['exec', container, 'node', '-e', script], timeout=10)
            return
        except RuntimeError:
            time.sleep(0.5)
    raise RuntimeError('model gateway did not become ready')


def start_gateway(*, image, source, dependencies, config, ledger_directory, name, network,
                  environment, port=GATEWAY_PORT, timeout=60):
    """Run the trusted gateway on the default bridge plus an internal network.

    Only the gateway can reach the upstream provider; task containers are attached
    to the internal network exclusively. Secrets are passed by environment name,
    never in argv or the config file.
    """
    _name(name, 'gateway container name')
    _name(network, 'gateway network')
    source = _absolute(source, 'gateway source')
    dependencies = _absolute(dependencies, 'gateway dependencies')
    config = _absolute(config, 'gateway config')
    ledger_directory = _absolute(ledger_directory, 'gateway ledger directory')
    if not source.is_file() or not config.is_file() or not ledger_directory.is_dir():
        raise ValueError('gateway inputs must exist')
    environment = dict(environment)
    if set(environment) != {'RSI_UPSTREAM_KEY', 'RSI_RUN_TOKEN'}:
        raise ValueError('gateway secrets must use the fixed environment names')
    child_env = dict(os.environ, **environment)
    args = ['run', '-d', '--name', name, '--init', '--network', 'bridge',
            '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
            '--memory', '1g', '--cpus', '1', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=64m',
            '--user', f'{os.getuid()}:{os.getgid()}',
            '--mount', f'type=bind,src={source},dst=/opt/gateway/model_gateway.ts,readonly',
            '--mount', f'type=bind,src={dependencies},dst=/opt/gateway/node_modules,readonly',
            '--mount', f'type=bind,src={config},dst=/opt/gateway/config.json,readonly',
            '--mount', f'type=bind,src={ledger_directory},dst=/ledger',
            '--env', 'HOME=/tmp/home', '--env', 'TMPDIR=/tmp',
            '--env', 'RSI_UPSTREAM_KEY', '--env', 'RSI_RUN_TOKEN',
            image, 'node', '/opt/gateway/node_modules/tsx/dist/cli.mjs',
            '/opt/gateway/model_gateway.ts', '--config', '/opt/gateway/config.json']
    docker(args, timeout=timeout, env=child_env)
    try:
        docker(['network', 'connect', network, name])
        _wait_port(name, port, timeout)
    except Exception:
        docker(['rm', '-f', name], timeout=30)
        raise
    return {'url': f'http://{name}:{port}', 'container': name, 'network': network}


def stop_gateway(handle):
    if not isinstance(handle, dict):
        return
    for name in (handle.get('container'),):
        if isinstance(name, str) and _NAME.fullmatch(name):
            docker(['rm', '-f', name], timeout=30)
    network = handle.get('network')
    if isinstance(network, str) and _NAME.fullmatch(network):
        docker(['network', 'rm', network], timeout=30)


def export_source(repo, revision, target, paths=SOURCE_PATHS):
    if not SHA_PATTERN.fullmatch(revision):
        raise ValueError('source revision must be an immutable SHA')
    target = Path(target)
    target.mkdir(parents=True, exist_ok=False)
    archive = subprocess.run(['git', '-C', str(repo), 'archive', revision, '--', *paths], check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError('unsafe archive member')
        tar.extractall(target, filter='data')
    return target


def tree_digest(root):
    root = Path(root)
    rows = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError('snapshot contains a symlink')
        if path.is_file():
            rows.append([path.relative_to(root).as_posix(), digest(path.read_bytes())])
    return digest(rows)


def run_container(image, mounts, command, *, network='none', timeout=900, environment=None, workdir='/workspace', memory='4g'):
    name = f'bitori-rsi-{uuid.uuid4().hex}'
    args = ['run', '--name', name, '--init', '--network', network,
            '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=256',
            '--memory', memory, '--cpus=2', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m',
            '--user', f'{os.getuid()}:{os.getgid()}', '--workdir', workdir, '--env', 'HOME=/tmp/home']
    for source, destination, readonly in mounts:
        source = Path(source).resolve()
        if not source.exists() or ',' in str(source) or ',' in destination:
            raise ValueError('invalid container mount')
        args.extend(['--mount', f'type=bind,src={source},dst={destination}' + (',readonly' if readonly else '')])
    environment = environment or {}
    child_env = dict(os.environ)
    for key, value in environment.items():
        if not key.replace('_', '').isalnum():
            raise ValueError('invalid environment name')
        args.extend(['--env', key])
        child_env[key] = value
    args.extend([image, *command])
    try:
        return bounded_command(['docker', *args], timeout=timeout, env=child_env)
    finally:
        bounded_command(['docker', 'rm', '-f', name], timeout=30)


def prepare_checks(repo, revision, trusted_revision, output, dependencies, new_tests=()):
    output = Path(output)
    source = export_source(repo, revision, output / 'source')
    trusted = export_source(repo, trusted_revision, output / 'trusted')
    for relative in CONFIG_PATHS:
        if (trusted / relative).is_file():
            (source / relative).write_bytes((trusted / relative).read_bytes())
    (source / 'node_modules').symlink_to('/deps/node_modules', target_is_directory=True)
    mounts = [(source, '/workspace', False), (Path(dependencies), '/deps/node_modules', True),
              (source / 'src', '/workspace/src', True), (trusted / 'tests', '/workspace/tests', True)]
    for relative in CONFIG_PATHS:
        if (trusted / relative).is_file():
            mounts.append((trusted / relative, f'/workspace/{relative}', True))
    for relative in new_tests:
        path = Path(relative)
        if path.is_absolute() or '..' in path.parts or not str(relative).startswith('tests/unit/'):
            raise ValueError('new tests must be candidate unit tests')
        candidate = source / path
        if not candidate.is_file() or candidate.is_symlink():
            raise ValueError('declared new test is missing from the candidate snapshot')
        mounts.append((candidate, f'/workspace/{relative}', True))
    return source, mounts


def _receipt(manifest, name, status, result=None, **extra):
    value = {'experiment_id': manifest['experiment_id'], 'base_sha': manifest['base_sha'],
             'head_sha': manifest['head_sha'], 'verifier_sha': manifest['verifier_sha'],
             'policy_sha256': manifest['policy_sha256'], 'config_sha256': manifest['config_sha256'],
             'name': name, 'status': status, 'source': 'trusted_execution',
             'generated_by': 'trusted_executor', 'verified': True, 'scope': manifest['scope'],
             'complete': bool(result is None or not result.get('reason')),
             'stable': True, 'budget_exhausted': False, 'cancelled': False,
             'evidence_sha256': digest(result if result is not None else {'name': name, 'status': status})}
    value.update(extra)
    return value


def build_harness(repo, revision, target, dependencies, *, image, timeout=900):
    """Build the harness from an immutable snapshot, not the caller's checkout."""
    target = Path(target)
    target.mkdir(parents=True, exist_ok=False)
    source = export_source(repo, revision, target / 'source')
    mounts = [(source, '/workspace', False), (Path(dependencies), '/workspace/node_modules', True)]
    result = run_container(image, mounts, ['node', 'node_modules/typescript/bin/tsc',
                                           '-p', 'tsconfig.build.json'], timeout=timeout)
    if result['reason'] or result['returncode'] or not (source / 'dist/bin/bitori.js').is_file():
        raise RuntimeError(f'harness build failed ({result["reason"] or result["returncode"]})')
    return {'root': str(source), 'build': tree_digest(source / 'dist'),
            'dependencies': tree_digest(dependencies),
            'dependencies_root': str(Path(dependencies).resolve())}


def verifier_checks(repo, head_sha, trusted_revision, output, dependencies, *, manifest,
                    changed_paths, new_tests, image, timeout=1200):
    """Run pinned static/regression checks and return caller-authenticated receipts."""
    source, mounts = prepare_checks(repo, head_sha, trusted_revision, Path(output) / 'checks',
                                    dependencies, new_tests)
    receipts = []
    scope = manifest['scope']
    receipts.append(_receipt(manifest, 'scope', 'passed', details={
        'changed_paths': sorted(changed_paths),
        'new_test_paths': sorted(set(changed_paths) & set(new_tests))}))
    for name in ('build', 'typecheck', 'lint', 'trusted_unit', 'integration', 'security', 'regression'):
        result = run_container(image, mounts, CHECK_COMMANDS[name], timeout=timeout)
        status = 'inconclusive' if result['reason'] else 'passed' if result['returncode'] == 0 else 'failed'
        extra = {'kind': 'trusted_regression', 'test_revision': trusted_revision} if name == 'regression' else {}
        receipts.append(_receipt(manifest, name, status, result, **extra))
        atomic_json(Path(output) / f'{name}.json', receipts[-1])
    if new_tests:
        result = run_container(image, mounts, ['node', 'node_modules/vitest/vitest.mjs', 'run', *new_tests],
                               timeout=timeout)
        status = 'inconclusive' if result['reason'] else 'passed' if result['returncode'] == 0 else 'failed'
    else:
        result, status = {'reason': 'no candidate regression test'}, 'failed'
    receipts.append(_receipt(manifest, 'new_tests', status, result))
    atomic_json(Path(output) / 'new_tests.json', receipts[-1])
    return receipts
