"""Count what every session spent today, from Claude Code's transcripts, into cost-guard.

cost-guard keeps today's total as it goes, so on the day it is installed it only
counts from then, and its cost line says so ("counted since 11:55"). This script
reads every transcript written today, of any size, prices each model response
the way cost-guard does, and writes the whole day into cost-guard's store.

    python backfill-today.py           show what it would write
    python backfill-today.py --write   write it (the old store is kept as .bak)

Options:
    --store PATH   cost-guard's store file, when there is more than one
                   (<config>/plugins/store/cost-guard_*.json)

Run it between messages: a message in progress when it runs is counted here and
then again by cost-guard when it finishes. Python 3.8 or later, nothing to install.
"""

import argparse
import datetime as dt
import glob
import json
import os
import re
import shutil
import sys

# API list prices per million tokens (input, cache read, output), as in
# hooks/estimate.ts; cost-guard's calibration then scales them per model.
PRICES = [
    (re.compile('fable|mythos', re.I), (10, 0.25, 50)),
    (re.compile('opus', re.I), (4, 0.2, 20)),
    (re.compile('sonnet', re.I), (2, 0.1, 10)),
    (re.compile('haiku', re.I), (0.1, 0.01, 0.5)),
]
OPUS = PRICES[1][1]


def model_key(model):
    """The model id without a context tag or a date, as cost-guard keys its calibration."""
    return re.sub(r'-\d{8}$', '', re.sub(r'\[.*?\]', '', model.lower())).strip()


def config_dir():
    return os.environ.get('CLAUDE_CONFIG_DIR') or os.path.join(os.path.expanduser('~'), '.claude')


def find_store(path):
    if path:
        return path
    found = sorted(glob.glob(os.path.join(config_dir(), 'plugins', 'store', 'cost-guard_*.json')))
    installed = [f for f in found if os.path.basename(f).startswith('cost-guard_claude-mods-')]
    if len(installed) == 1:
        return installed[0]
    if len(found) == 1:
        return found[0]
    sys.exit('Found %s cost-guard stores; name one with --store:\n  %s' % (len(found) or 'no', '\n  '.join(found)))


def write_multiplier(store):
    """The cache write price over the input price: 2 for a 1-hour cache, 1.25 for 5 minutes."""
    options = store.get('options') or {}
    ttl = options.get('cacheTtl') if options.get('cacheTtl') in ('5m', '1h') else store.get('measuredTtl')
    return 1.25 if ttl == '5m' else 2


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--write', action='store_true', help="write today's record into cost-guard's store")
    parser.add_argument('--store', help="cost-guard's store file")
    args = parser.parse_args()

    store_path = find_store(args.store)
    store = json.load(open(store_path, encoding='utf-8'))
    calibration = store.get('priceCalibration') or {}
    multiplier = write_multiplier(store)

    def usd(model, usage):
        found = next((p for pattern, p in PRICES if pattern.search(model or '')), OPUS)
        ratio = (calibration.get(model_key(model or '')) or {}).get('ratio', 1)
        price_in, price_read, price_out = (p * ratio for p in found)
        return (usage.get('input_tokens', 0) * price_in
                + usage.get('cache_read_input_tokens', 0) * price_read
                + usage.get('cache_creation_input_tokens', 0) * price_in * multiplier
                + usage.get('output_tokens', 0) * price_out) / 1e6

    midnight = dt.datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    projects = os.path.join(config_dir(), 'projects')
    sessions = {}

    for path in glob.glob(os.path.join(projects, '*', '**', '*.jsonl'), recursive=True):
        if os.path.getmtime(path) < midnight.timestamp():
            continue
        parts = os.path.relpath(path, projects).replace('\\', '/').split('/')
        # <project>/<session>.jsonl, or <project>/<session>/subagents/<agent>.jsonl,
        # whose cost is its session's.
        session = parts[1][:-len('.jsonl')] if len(parts) == 2 else parts[1]
        seen = set()
        with open(path, encoding='utf-8', errors='replace') as f:
            for line in f:
                if '"assistant"' not in line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                message = row.get('message') or {}
                usage = message.get('usage')
                if row.get('type') != 'assistant' or not usage or not row.get('timestamp'):
                    continue
                if dt.datetime.fromisoformat(row['timestamp'].replace('Z', '+00:00')) < midnight:
                    continue
                # A response written in several rows repeats its usage on each.
                if message.get('id') in seen:
                    continue
                seen.add(message.get('id'))
                sessions[session] = sessions.get(session, 0) + usd(message.get('model'), usage)

    total = sum(sessions.values())
    for session, spent in sorted(sessions.items(), key=lambda item: -item[1]):
        print('%8.2f  %s' % (spent, session))
    print('%8.2f  today, %d session(s), since %s' % (total, len(sessions), midnight.strftime('%Y-%m-%d %H:%M %z')))

    previous = store.get('spentToday')
    if isinstance(previous, dict) and previous.get('day') == midnight.strftime('%Y-%m-%d'):
        print('%8.2f  what cost-guard has counted today' % previous.get('usd', 0))

    if not args.write:
        print('Nothing written; --write writes it.')
        return

    shutil.copy(store_path, store_path + '.bak')
    # The whole day, with no `since`: the cost line drops "counted since".
    store['spentToday'] = {'day': midnight.strftime('%Y-%m-%d'), 'usd': total, 'sessions': sessions}
    with open(store_path, 'w', encoding='utf-8') as f:
        json.dump(store, f)
    print('Written to %s (the old one is %s.bak).' % (store_path, os.path.basename(store_path)))


if __name__ == '__main__':
    main()
