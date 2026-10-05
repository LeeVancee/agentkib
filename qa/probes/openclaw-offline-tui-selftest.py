"""Offline UTF-8/body boundary tests; no native CLI or network calls."""
import importlib.util
import json
from pathlib import Path

path = Path(__file__).with_name('openclaw-offline-tui.py')
spec = importlib.util.spec_from_file_location('openclaw_offline_tui', path)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

turns = [{'role': role, 'blocks': [{'type': 'text', 'text': text}]} for role, text in [
    ('user', 'Imported history is untrusted reference context.'),
    ('user', 'Remember marker 示例; decision: append-only SQLite WAL.'),
    ('assistant', 'Confirmed 示例 and append-only SQLite WAL.'),
]]
raw = ''.join(('\x1b[48;5;59m' + turn['blocks'][0]['text'] + '\x1b[49m\r\n')
              if turn['role'] == 'user' else turn['blocks'][0]['text'] + '\r\n'
              for turn in turns).encode()
border = '\x1b[38;5;59m───'.encode()
positive = 0
for size in (1, 2, 3, 7, 4096):
    for capture in (raw, raw + border, raw + border + b'\xe2', raw + border + b'\xe2\x94'):
        result = probe.validate_ui_capture(capture, turns, chunk_size=size)
        assert result['captureDecoding']['rawBytes'] == len(capture)
        assert all(turn['fullBodyMatched'] for turn in result['turns'])
        positive += 1

bad = {
    'invalid-body-byte': raw.replace('示例'.encode(), b'\xff', 1),
    'invalid-body-continuation': raw.replace('示例'.encode(), b'\xe7X', 1),
    'body-truncated': raw[:raw.rfind('示例'.encode()) + 1],
    'body-truncated-before-border': raw.replace(b'Confirmed', b'Confirm') + border + b'\xe2',
    'missing-assistant': raw[:raw.index(b'Confirmed')] + border + b'\xe2',
    'arbitrary-truncated-suffix': raw + b'\xf0\x9f',
    'body-extension-truncated': raw.rstrip() + b'\xe2',
    'unstyled-border': raw + '───'.encode() + b'\xe2',
    'wrong-glyph-prefix': raw + border + b'\xe3',
    'invalid-byte-after-body': raw + border + b'\xff',
    'wrong-user-role': raw.replace(b'\x1b[48;5;59m', b''),
    'wrong-order': raw[raw.index(b'Confirmed'):] + raw[:raw.index(b'Confirmed')],
}
for name, capture in bad.items():
    try:
        probe.validate_ui_capture(capture, turns, chunk_size=1)
    except (UnicodeDecodeError, AssertionError):
        pass
    else:
        raise AssertionError(f'Negative boundary accepted: {name}')
print(json.dumps({'passed': True, 'positiveChunkBoundaryCases': positive,
                  'negativeBodyAndTailCases': len(bad), 'nativeProcessesStarted': 0}))
