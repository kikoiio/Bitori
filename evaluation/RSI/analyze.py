#!/usr/bin/env python3
"""Conservative, offline RSI diagnosis. No log text is executed or treated as policy.

analyze(result, events) is pure. Events are decoded projected trajectory objects
(or legacy TraceEvent objects); None means unavailable and invalid entries mark
corruption. Existing event IDs are retained; otherwise IDs are event:NNNNNN in
input order (physical line order for the CLI). Result-only findings have no event
references. category is a diagnosis, not a replacement for result_status.
"""
import argparse
from collections.abc import Mapping
import json
from pathlib import Path
import re


PROJECTED_TYPES = {'run_header', 'response', 'tool_result', 'request_retry',
                   'context_compacted', 'run_finished'}
PROVIDER_CODES = {'authentication', 'rate_limit', 'network', 'context_limit',
                  'invalid_request', 'provider_error'}
INFRA_CODES = {'infrastructure_error', 'storage_error', 'initialization_error',
               'container_error', 'environment_error'}
READ_TOOLS = {'read', 'read_file', 'readfile', 'glob', 'find_files', 'grep',
              'search_text', 'list_directory', 'list_files'}
ERROR_STATUSES = {'agent_error', 'provider_error', 'infrastructure_error'}


def _object(value):
    return value if isinstance(value, Mapping) else {}


def _text(value):
    return value if isinstance(value, str) else ''


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def _arguments(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, RecursionError):
            return None
    return dict(value) if isinstance(value, Mapping) else None


def _iteration(event):
    return (_text(event.get('iterationId')) or
            (str(event['iteration']) if type(event.get('iteration')) is int else ''))


def _normalize(events, unknowns):
    normalized = []
    used_ids = set()
    for index, raw in enumerate(events or (), 1):
        if not isinstance(raw, Mapping) or not isinstance(raw.get('type'), str):
            unknowns.append(f'Trace entry {index} is corrupt or malformed.')
            continue
        event = dict(raw)
        if event['type'] == 'agent_event':
            inner = _object(event.get('event'))
            if not isinstance(inner.get('type'), str):
                unknowns.append(f'Trace entry {index} has a malformed legacy event.')
                continue
            event = {**event, **inner}
        if event['type'] not in PROJECTED_TYPES:
            # Legacy traces contain deltas, request bodies and domain facts.
            # They are intentionally not interpreted, nor copied to the report.
            if raw.get('v') != 1 and raw.get('type') != 'agent_event':
                unknowns.append(f'Trace entry {index} has an unsupported type.')
            continue
        evidence_id = _text(raw.get('id')) or f'event:{index:06d}'
        if evidence_id in used_ids:
            unknowns.append(f'Trace entry {index} has a duplicate evidence ID.')
        used_ids.add(evidence_id)
        event['id'] = evidence_id
        event['_position'] = index
        if not _text(event.get('runId')):
            unknowns.append(f'Trace entry {index} has no run ID.')
        event['runId'] = _text(event.get('runId'))
        payload = _object(event.get('result'))
        # The collector may retain ToolExecutionResult as the output envelope.
        envelope = _object(event.get('output'))
        if (event['type'] == 'tool_result' and isinstance(envelope.get('status'), str)
                and any(key in envelope for key in ('output', 'partialOutput', 'error'))):
            payload = envelope
            event.pop('output')
        if event['type'] in {'tool_result', 'run_finished'}:
            for key in ('status', 'stopReason', 'output', 'truncation'):
                if key not in event and key in payload:
                    event[key] = payload[key]
            if 'output' not in event and 'partialOutput' in payload:
                event['output'] = payload['partialOutput']
        error = _object(event.get('error')) or _object(payload.get('error'))
        if error:
            event.setdefault('errorCode', error.get('code'))
            event.setdefault('errorMessage', error.get('message'))
        for key in ('status', 'stopReason', 'errorCode', 'errorMessage', 'callId', 'iterationId'):
            if event.get(key) is not None and not isinstance(event[key], str):
                unknowns.append(f'Trace entry {index} has a malformed {key}.')
                event.pop(key)
        normalized.append(event)
    return normalized


def _trace_integrity(result, events, unknowns):
    if not events:
        unknowns.append('Trace is missing or contains no usable events.')
    runs = {event['runId'] for event in events}
    for run in sorted(runs):
        types = {event['type'] for event in events if event['runId'] == run}
        if 'run_header' not in types:
            unknowns.append('Trace is incomplete: a run header is missing.')
        if 'run_finished' not in types:
            unknowns.append('Trace is incomplete: a run_finished event is missing.')
        responses = [event for event in events if event['runId'] == run and event['type'] == 'response']
        numbers = sorted({event['iteration'] for event in responses if type(event.get('iteration')) is int})
        if numbers and (numbers[0] > 1 or any(b - a > 1 for a, b in zip(numbers, numbers[1:]))):
            unknowns.append('Trace is incomplete: response iterations have gaps.')
        reported = _object(result.get('agent')).get('iterations')
        observed = {_iteration(event) for event in responses if _iteration(event)}
        if len(runs) == 1 and type(reported) is int and reported > len(observed):
            unknowns.append('Trace is incomplete: fewer response iterations than the runner reports.')
    if result.get('trace_complete') is False:
        unknowns.append('Collector reports an incomplete trace.')
    for metadata in (result.get('trace'), result.get('trace_integrity'),
                     result.get('trajectory')):
        metadata = _object(metadata)
        if metadata.get('complete') is False or metadata.get('available') is False:
            unknowns.append('Collector reports an incomplete trace.')
        for key in ('dropped_events', 'droppedEvents', 'dropped', 'bad_lines', 'badLines',
                    'malformed_lines', 'corrupt_lines', 'write_errors', 'writeErrors',
                    'serializationErrors', 'missing_terminal', 'missingTerminal', 'truncated'):
            if metadata.get(key):
                unknowns.append(f'Collector reports trace loss: {key}.')


def _join_calls(events, unknowns):
    """Join in two passes: legacy tool results can precede response records."""
    calls = {}
    for event in events:
        if event['type'] != 'response':
            continue
        tool_calls = event.get('toolCalls', [])
        if not isinstance(tool_calls, list):
            unknowns.append('Trace is incomplete: malformed response toolCalls.')
            continue
        for call in tool_calls:
            call = _object(call)
            call_id = _text(call.get('callId'))
            key = (event['runId'], call_id)
            if not call_id or key in calls:
                unknowns.append('Trace is incomplete: missing or duplicate call ID.')
                continue
            calls[key] = (event, call)
    joined = {}
    seen = set()
    for event in events:
        if event['type'] != 'tool_result':
            continue
        key = (event['runId'], _text(event.get('callId')))
        pair = calls.get(key)
        if pair is None:
            unknowns.append('Trace is incomplete: a tool result has no response call.')
            continue
        if key in seen:
            unknowns.append('Trace is incomplete: duplicate tool result.')
        seen.add(key)
        response, call = pair
        iteration = _iteration(response)
        if not iteration or (_iteration(event) and _iteration(event) != iteration):
            unknowns.append('Trace is incomplete: missing or inconsistent iteration identity.')
        joined[event['_position']] = (response, call, iteration)
    if set(calls) - seen:
        unknowns.append('Trace is incomplete: a response call has no tool result.')
    return joined


def _provider_code(record):
    code = _text(record.get('errorCode')).lower()
    if code in PROVIDER_CODES:
        return code
    # Only structured error messages, never assistant text or tool output.
    message = _text(record.get('errorMessage'))
    match = re.match(r'^\s*(?:HTTP\s+)?(401|403|413|429|5\d\d)\b', message, re.I)
    http = str(record.get('statusCode', ''))
    if match:
        http = match.group(1)
    if code in {'401', '403', '413', '429'}:
        http = code
    if http in {'401', '403'}:
        return 'authentication'
    if http == '429':
        return 'rate_limit'
    if http == '413':
        return 'context_limit'
    if re.fullmatch(r'5\d\d', http):
        return 'provider_error'
    return None


def _bounded_or_redacted(value):
    if isinstance(value, str):
        return any(marker in value for marker in ('<truncated>', '<redacted>',
                   '<sensitive content omitted>', '<unsupported value>'))
    if isinstance(value, Mapping):
        return any(_bounded_or_redacted(item) for item in value.values())
    if isinstance(value, list):
        return any(_bounded_or_redacted(item) for item in value)
    return False


def _repetition(events, joined):
    """Find stagnant tails, not proven loops; successful opaque tools are barriers.

    JSON formatting/key order are normalized, but string values are not. A
    changed result, context compaction, or successful non-read-only tool clears
    all pending repetitions in that run. Counts use distinct iterations.
    """
    states = {}
    for event in events:
        run = event['runId']
        state = states.setdefault(run, {})
        if event['type'] == 'context_compacted':
            state.clear()
        if event['type'] != 'tool_result':
            continue
        if event.get('errorCode') == 'agent_loop_limit':
            continue
        pair = joined.get(event['_position'])
        if pair is None:
            state.clear()
            continue
        response, call, iteration = pair
        name = _text(call.get('name')).strip().lower()
        arguments = _arguments(call.get('arguments', call.get('argumentsText')))
        # Shell/agent/unknown tool effects cannot be determined from log text.
        if event.get('status') == 'success' and name not in READ_TOOLS:
            state.clear()
            continue
        if (not name or arguments is None or not iteration or
                'output' not in event or event.get('output') is None or
                not _text(event.get('status')) or
                _object(event.get('truncation')).get('truncated') or
                event.get('truncated') or _bounded_or_redacted(arguments) or
                _bounded_or_redacted(event['output'])):
            state.clear()
            continue
        signature = (name, _canonical(arguments))
        output = _canonical([event.get('status'), event['output'],
                             event.get('errorCode'), event.get('errorMessage')])
        previous = state.get(signature)
        if previous is not None and previous['output'] != output:
            state.clear()
        entry = state.setdefault(signature, {'output': output, 'iterations': {},
                                             'position': event['_position']})
        entry['iterations'].setdefault(iteration, [response['id'], event['id']])
    candidates = []
    for state in states.values():
        for entry in state.values():
            if len(entry['iterations']) >= 3:
                evidence = [eid for ids in list(entry['iterations'].values())[:3] for eid in ids]
                candidates.append((entry['position'], evidence))
    return sorted(candidates)


def _test_failed(event, call):
    if event.get('errorCode') in {'test_failure', 'tests_failed'}:
        return True
    arguments = _arguments(call.get('arguments', call.get('argumentsText'))) or {}
    name = _text(call.get('name')).strip().lower()
    command = _text(arguments.get('command'))
    # Recognize only a test invocation, not mentions in arbitrary prose/commands.
    is_test = name in {'run_tests', 'test'} or (name in {'run_command', 'bash', 'shell'} and
        re.match(r'^\s*(?:(?:python(?:3(?:\.\d+)?)?\s+-m\s+)?(?:pytest|unittest)\b|'
                 r'(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|cargo\s+test\b|go\s+test\b)', command))
    output = _object(event.get('output'))
    exit_code = output.get('exitCode', output.get('exit_code'))
    return bool(is_test and type(exit_code) is int and exit_code != 0)


def analyze(result, events):
    """Return a JSON-ready schema-v1 diagnosis without mutating either input.

    Findings use high/medium confidence and event-ID evidence (empty for facts
    found only in result). unknowns are strings. Eligibility means evidence may
    support a candidate investigation, never authorization to modify or merge.
    Incomplete traces, unverified gold, provider/infra faults and unknown causes
    are ineligible. Iteration-limit alone does not establish a root cause.
    """
    if not isinstance(result, Mapping):
        raise ValueError('result must be a JSON object')
    unknowns = []
    normalized = _normalize(events, unknowns)
    agent = _object(result.get('agent'))
    target_run = _text(result.get('run_id') or result.get('runId') or agent.get('runId'))
    if target_run:
        normalized = [event for event in normalized if event['runId'] == target_run]
    _trace_integrity(result, normalized, unknowns)
    joined = _join_calls(normalized, unknowns)
    trace_incomplete = bool(unknowns)
    findings = []
    diagnoses = []
    blockers = []

    def add(code, summary, evidence=(), confidence='high'):
        findings.append({'code': code, 'confidence': confidence,
                         'evidence': list(dict.fromkeys(evidence)), 'summary': summary})

    status = result.get('status')
    if status not in ERROR_STATUSES | {'resolved', 'unresolved'}:
        unknowns.append('Result status is missing or unsupported.')
    stage = _text(result.get('failure_stage')).lower()
    gold_failed = (_object(result.get('gold_report')).get('resolved') is False or
                   stage in {'gold', 'gold_verification', 'gold_check'})
    if gold_failed:
        add('gold_failure', 'Gold verification failed; investigate the environment/gold check before agent changes.')
        blockers.append((-2, 'gold_failure'))
    elif result.get('gold_verified') is not True:
        unknowns.append('Gold/environment verification is not established.')
    if status == 'infrastructure_error':
        add('infrastructure_error', 'Runner reports an infrastructure failure; investigate its failure stage, not agent algorithms.')
        # Collection/grading follows the agent; otherwise trust the runner's
        # earlier infrastructure classification when timing is unavailable.
        late = stage in {'grading', 'candidate_grading', 'patch_collection',
                         'trace_collection', 'artifact_collection', 'cleanup'}
        blockers.append((float('inf') if late else -1, 'infrastructure_error'))
    elif (_text(agent.get('stopReason')) in INFRA_CODES or
          _text(agent.get('errorCode')) in INFRA_CODES):
        add('infrastructure_error', 'Runner records a runtime/storage failure; investigate infrastructure before agent algorithms.')
        blockers.append((float('inf'), 'infrastructure_error'))
    for event in normalized:
        if event['type'] not in {'response', 'request_retry', 'run_finished'}:
            continue
        provider = _provider_code(event)
        infra = event.get('errorCode') in INFRA_CODES or event.get('stopReason') in INFRA_CODES
        if infra:
            add('infrastructure_error', 'A structured infrastructure failure was recorded; investigate runtime/storage availability.', [event['id']])
            blockers.append((event['_position'], 'infrastructure_error'))
        elif provider:
            add(provider, 'A provider failure/retry was recorded; investigate provider access, limits or availability, not agent algorithms.', [event['id']])
            blockers.append((event['_position'], 'provider_error'))
    provider = _provider_code(agent) or _provider_code(result)
    if provider or status == 'provider_error':
        add(provider or 'provider_error', 'Runner reports a provider failure; resolve provider/configuration issues before considering a candidate.')
        blockers.append((float('inf'), 'provider_error'))
    if status == 'agent_error':
        add('agent_error', 'Runner agent_error is preserved; a partial patch is not an unresolved grading result.')
    for event in normalized:
        if event['type'] != 'tool_result':
            continue
        code = event.get('errorCode')
        if code in {'unknown_tool', 'invalid_arguments', 'invalid_tool_call', 'tool_unavailable_in_mode'}:
            finding_code = 'unknown_tool' if code == 'unknown_tool' else 'invalid_tool_call'
            add(finding_code, 'A structured tool rejection was recorded; inspect tool selection, arguments and availability.', [event['id']])
            diagnoses.append((event['_position'], finding_code))
        pair = joined.get(event['_position'])
        if _test_failed(event, pair[1] if pair else event):
            add('test_failure', 'A test invocation failed; this is an observation, not proof of an agent root cause.', [event['id']])
            diagnoses.append((event['_position'], 'test_failure'))
    if not trace_incomplete and status != 'resolved':
        repeated = _repetition(normalized, joined)
        if repeated:
            position, evidence = repeated[0]
            add('suspected_repetition', 'The same normalized call and observed result recur across at least three iterations without observed progress. Suspected repetition only, not proof of a loop or its cause.', evidence, 'medium')
            diagnoses.append((position, 'suspected_repetition'))
            unknowns.append('Identical bounded results do not prove identical full outputs or a causal loop.')
    stops = [event for event in normalized if event.get('stopReason') == 'iteration_limit']
    if agent.get('stopReason') == 'iteration_limit' or stops:
        add('iteration_limit', 'The iteration budget was exhausted; this stop reason alone does not identify a root cause.', [event['id'] for event in stops])
    if agent.get('stopReason') == 'unknown_tool_limit':
        add('unknown_tool', 'Runner stopped at the unknown-tool limit; inspect tool selection and availability.')
        diagnoses.append((float('inf'), 'unknown_tool'))
    # Never infer an empty patch/test failure from unresolved alone. These are
    # optional explicit collector facts; absence of a patch field is unknown.
    patch = _object(result.get('patch'))
    empty_patch = (result.get('patch_empty') is True or patch.get('empty') is True or
                   any(isinstance(result.get(key), str) and not result[key].strip()
                       for key in ('solution_patch', 'patch')))
    if empty_patch:
        add('empty_patch', 'The collected solution patch is explicitly empty; inspect editing and patch collection.')
        diagnoses.append((float('inf'), 'empty_patch'))
    if (result.get('tests_passed') is False or
            _object(result.get('candidate_report')).get('resolved') is False or
            _object(result.get('test_report')).get('resolved') is False):
        add('test_failure', 'The candidate grading/test report explicitly reports failure; its underlying cause remains unproven.')
        diagnoses.append((float('inf'), 'test_failure'))
    if trace_incomplete:
        add('trace_incomplete', 'Missing, malformed or unmatched trace evidence limits diagnosis; do not infer an unobserved root cause.')
    if status == 'resolved':
        category = 'success'
        add('success', 'Runner reports the task resolved; no improvement candidate is requested.')
    elif blockers:
        category = min(blockers, key=lambda item: item[0])[1]
    elif diagnoses:
        category = min(diagnoses, key=lambda item: item[0])[1]
    else:
        category = 'unknown'
        unknowns.append('Root cause is unknown; the available result/trajectory does not establish it.')
        if status == 'unresolved':
            unknowns.append('Without explicit patch/grading evidence, empty patch and test failure cannot be distinguished.')
    eligible = (status in {'unresolved', 'agent_error'} and result.get('gold_verified') is True
                and not blockers and not trace_incomplete and bool(diagnoses))
    return {'schema_version': 1, 'result_status': status, 'category': category,
            'eligible_for_candidate': eligible, 'findings': findings,
            'unknowns': list(dict.fromkeys(unknowns))}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('--trajectory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    if args.output.resolve() in {args.result.resolve(), args.trajectory.resolve()}:
        parser.error('Output must not overwrite result or trajectory input.')
    try:
        result = json.loads(args.result.read_text(encoding='utf-8'))
        if not isinstance(result, dict):
            raise ValueError('result must be a JSON object')
    except (OSError, UnicodeError, ValueError) as error:
        parser.error(f'Cannot read result JSON ({type(error).__name__}).')
    # Invalid lines retain their positions without copying their contents into
    # diagnosis. No subprocesses, imports, or file paths come from log payloads.
    events = []
    try:
        with args.trajectory.open('rb') as stream:
            for index, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                try:
                    event = json.loads(line.decode('utf-8'))
                except (ValueError, UnicodeError, RecursionError):
                    event = None
                if isinstance(event, dict):
                    event.setdefault('id', f'event:{index:06d}')
                events.append(event)
    except FileNotFoundError:
        events = None
    except OSError:
        events.append(None)
    diagnosis = analyze(result, events)
    args.output.write_text(json.dumps(diagnosis, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
