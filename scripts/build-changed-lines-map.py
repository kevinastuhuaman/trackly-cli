#!/usr/bin/env python3
"""Build the trusted changed-line map for the Claude review gate.

Reads a unified diff and writes a JSON object keyed by path whose values are
[start, end] line ranges. Right-side (new file) hunk ranges are recorded under
the new path and left-side (old file) hunk ranges under the old path, so a
finding may cite either an added/changed line or a deleted line. File headers
are honored only between a `diff --git` line and the first hunk, so an added
content line rendered as `+++ ...` can never forge a changed path.
"""
import json
import re
import sys

HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')


ESCAPES = {'a': 7, 'b': 8, 't': 9, 'n': 10, 'v': 11, 'f': 12, 'r': 13, '"': 34, '\\': 92}


def unquote_git_path(target):
    """Decode a git C-style quoted path (core.quotePath) into its plain form."""
    if len(target) < 2 or not (target.startswith('"') and target.endswith('"')):
        return target
    raw = bytearray()
    body = target[1:-1]
    index = 0
    while index < len(body):
        character = body[index]
        if character != '\\':
            raw.extend(character.encode('utf-8'))
            index += 1
            continue
        index += 1
        if index >= len(body):
            raise ValueError('unterminated escape in quoted diff path')
        escape = body[index]
        octal = re.match(r'[0-7]{3}', body[index:index + 3])
        if octal:
            raw.append(int(octal.group(0), 8))
            index += 3
        elif escape in ESCAPES:
            raw.append(ESCAPES[escape])
            index += 1
        else:
            raise ValueError('unknown escape in quoted diff path')
    return raw.decode('utf-8')


def header_path(line, prefix):
    target = line[4:].rstrip('\n').rstrip('\t')
    if target == '/dev/null':
        return None
    return re.sub('^' + re.escape(prefix), '', unquote_git_path(target), count=1)


def hunk_range(start, count):
    start = int(start)
    count = 1 if count is None else int(count)
    return [start, start + count - 1] if count > 0 else None


def build_changed_lines(lines):
    changed = {}
    in_header = False
    old_path = None
    new_path = None
    for line in lines:
        if line.startswith('diff --git '):
            in_header = True
            old_path = None
            new_path = None
            continue
        if in_header and line.startswith('--- '):
            old_path = header_path(line, 'a/')
            continue
        if in_header and line.startswith('+++ '):
            new_path = header_path(line, 'b/')
            for path in (old_path, new_path):
                if path is not None:
                    changed.setdefault(path, [])
            continue
        hunk = HUNK.match(line)
        if hunk and (old_path is not None or new_path is not None):
            in_header = False
            left = hunk_range(hunk.group(1), hunk.group(2))
            right = hunk_range(hunk.group(3), hunk.group(4))
            if old_path is not None and left is not None:
                changed[old_path].append(left)
            if new_path is not None and right is not None and (new_path != old_path or right != left):
                changed[new_path].append(right)
    return changed


def main(argv):
    diff_file, out_file = argv[1:3]
    with open(diff_file, encoding='utf-8', errors='replace') as handle:
        changed = build_changed_lines(handle)
    with open(out_file, 'w', encoding='utf-8') as handle:
        json.dump(changed, handle)


if __name__ == '__main__':
    main(sys.argv)
