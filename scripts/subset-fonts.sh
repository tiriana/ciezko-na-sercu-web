#!/usr/bin/env bash
# Regeneruje odchudzone fonty (Inter i Anton) do zakresu znaków używanego na stronie.
# Wymaga fontTools i brotli w venv: python3 -m venv .venv-fonts && .venv-fonts/bin/pip install fonttools brotli
set -euo pipefail
cd "$(dirname "$0")/.."

PYFTSUBSET="${PYFTSUBSET:-pyftsubset}"
PYTHON="${PYTHON:-python3}"
CHARSET='U+0000-00FF,U+0100-017F,U+0180-024F,U+2000-206F,U+20A0-20BF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+25A0-25FF,U+2600-27BF'

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

for font in inter anton; do
  target="public/fonts/${font}-pl.woff2"
  cp "$target" "$work/${font}-source.woff2"
  "$PYFTSUBSET" "$work/${font}-source.woff2" \
    --output-file="$work/${font}-subset.woff2" \
    --unicodes="$CHARSET" \
    --layout-features='*' \
    --flavor=woff2
  cp "$work/${font}-subset.woff2" "$target"
done

if [ -n "$(find dist -name '*.html' -print -quit 2>/dev/null)" ]; then
  "$PYTHON" - "$work" <<'PY'
import glob
import sys

from fontTools.ttLib import TTFont

work = sys.argv[1]
used = set()
for path in glob.glob('dist/**/*.html', recursive=True):
    with open(path, encoding='utf-8') as file:
        used |= set(file.read())
used = {ord(char) for char in used if ord(char) not in (9, 10, 13)}

def cmap(path):
    font = TTFont(path)
    points = set()
    for table in font['cmap'].tables:
        points |= set(table.cmap)
    return points

failed = False
for name in ('inter', 'anton'):
    source = cmap(f'{work}/{name}-source.woff2')
    subset = cmap(f'public/fonts/{name}-pl.woff2')
    regressions = sorted(used & source - subset)
    already = sorted(used - source)
    print(f'{name}: {len(subset)} glifów, brakujące już w źródle: {len(already)}, regresje: {len(regressions)}')
    if regressions:
        failed = True
        print('  brakuje: ' + ', '.join(f'U+{cp:04X}' for cp in regressions))
if failed:
    sys.exit(1)
PY
else
  echo 'Brak dist/ — pomijam weryfikację pokrycia znaków (zrób build i uruchom ponownie).'
fi
