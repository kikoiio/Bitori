import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

SCHEMA_VERSION = 1
SHA_PATTERN = re.compile(r'^[0-9a-f]{40}(?:[0-9a-f]{24})?$')
PUBLIC_FILES = ('result.json', 'trajectory.jsonl', 'diagnosis.json', 'solution.patch', 'artifacts.json')
PRIVATE_KEYS = re.compile(r'(?i)(api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|cookie)')
CREDENTIAL_TEXT = re.compile(r'(?i)(authorization\s*[:=]|(?:api[_-]?key|password|secret|access[_-]?token)\s*[=:]|(?:\.env\b|id_rsa\b|credentials\.json\b))')
URL_CREDENTIALS = re.compile(r'(?i)https?://[^\s"<>]*[?@][^\s"<>]*')


def digest(value):
    data = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return hashlib.sha256(data).hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(value, file, ensure_ascii=False, indent=2, allow_nan=False)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def sanitize(value, secrets=(), limit=4000):
    secrets = sorted({secret for secret in secrets if secret}, key=len, reverse=True)
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, '<redacted>')
        if CREDENTIAL_TEXT.search(value):
            return '<sensitive content omitted>'
        value = URL_CREDENTIALS.sub('<credential-bearing URL omitted>', value)
        return value[:limit] + ('<truncated>' if len(value) > limit else '')
    if isinstance(value, dict):
        return {sanitize(str(key), secrets, 128): '<redacted>' if PRIVATE_KEYS.search(str(key)) else sanitize(item, secrets, limit)
                for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(item, secrets, limit) for item in value[:1000]]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return '<unsupported value>'


def project_trace(lines, run_id=None, writer_stats=None, secrets=(), max_events=10000):
    events, corrupt, truncated = [], 0, False
    saw_start, saw_end = False, False
    consumed = 0
    for number, line in enumerate(lines, 1):
        size = len(line.encode())
        consumed += size
        if number > max_events * 20 or size > 2 * 1024 * 1024 or consumed > 16 * 1024 * 1024:
            truncated = True
            break
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
            if not isinstance(raw, dict):
                raise ValueError('event must be an object')
            event = raw.get('event', {}) if raw.get('type') == 'agent_event' else raw
            if not isinstance(event, dict):
                raise ValueError('event must be an object')
        except (ValueError, TypeError, RecursionError):
            corrupt += 1
            continue
        if run_id and event.get('runId') != run_id:
            continue
        kind = event.get('type')
        projected = {key: event[key] for key in ('runId', 'iterationId', 'iteration', 'at') if key in event}
        projected.update(id=f'{event.get("runId", "unknown")}:{number}', type=kind)
        if kind == 'run_header':
            saw_start = True
            projected.update({key: event.get(key) for key in ('model', 'protocol', 'mode')})
        elif kind == 'response':
            projected.update({key: event.get(key) for key in ('text', 'usage', 'finishReason', 'errorCode', 'errorMessage', 'durationMs')})
            projected['toolCalls'] = [{key: call.get(key) for key in ('callId', 'name', 'argumentsText')} for call in event.get('toolCalls', []) if isinstance(call, dict)]
        elif kind == 'tool_result':
            result = event.get('result') or {}
            projected.update(callId=event.get('callId'), status=result.get('status'), output=result)
        elif kind == 'run_finished':
            saw_end = True
            result = event.get('result') or {}
            projected.update(stopReason=result.get('stopReason'), status=result.get('status'), usage=result.get('usage'))
        elif kind == 'request_retry':
            projected.update({key: event.get(key) for key in ('attempt', 'delayMs', 'errorCode', 'errorMessage')})
        elif kind == 'context_compacted':
            projected.update({key: event.get(key) for key in ('beforeTokens', 'afterTokens', 'reason')})
        else:
            continue
        events.append(sanitize(projected, secrets))
        if len(events) >= max_events:
            truncated = True
            break
    counters = {key: (writer_stats or {}).get(key) for key in ('written', 'dropped', 'writeErrors', 'serializationErrors')}
    complete = saw_start and saw_end and not truncated and not corrupt and bool(writer_stats) and all(counters[key] == 0 for key in ('dropped', 'writeErrors', 'serializationErrors'))
    return events, {'complete': complete, 'corrupt_lines': corrupt, 'truncated': truncated, 'started': saw_start, 'finished': saw_end, **counters}


def write_evidence(output, result, events, secrets=(), patch=None, extra=None):
    output = Path(output)
    cleaned = sanitize(result, secrets)
    cleaned_events = [sanitize(event, secrets) for event in events]
    payloads = {'trajectory.jsonl': ''.join(json.dumps(event, ensure_ascii=False, allow_nan=False) + '\n' for event in cleaned_events)}
    if patch:
        cleaned_patch = sanitize(patch, secrets, limit=256 * 1024)
        cleaned['patch'] = {**(cleaned.get('patch') or {}), 'present': True, 'sha256': digest(patch.encode()), 'replayable': cleaned_patch == patch}
        payloads['solution.patch'] = cleaned_patch
    for name, text in (extra or {}).items():
        if name not in ('diagnosis.json',) or not isinstance(text, str):
            raise ValueError('unsupported evidence extra')
        payloads[name] = sanitize(text, secrets, limit=256 * 1024)
    payloads['result.json'] = json.dumps(cleaned, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    for text in payloads.values():
        if any(secret and secret in text for secret in secrets):
            raise ValueError('evidence secret scan failed')
    output.mkdir(parents=True, exist_ok=True)
    for name, text in payloads.items():
        (output / name).write_text(text)
    atomic_json(output / 'artifacts.json', {'schema_version': SCHEMA_VERSION, 'files': {name: {'sha256': digest(text.encode()), 'bytes': len(text.encode())} for name, text in payloads.items()}})
    return cleaned
