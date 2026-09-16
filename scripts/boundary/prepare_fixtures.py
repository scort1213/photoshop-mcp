"""Copy user-selected fixtures; never edit sources. Run in a fresh test directory."""
from boundary_suite import ROOT
from pathlib import Path
import hashlib
import json
import shutil
import sys

def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

records = []
directory = ROOT / 'fixtures'
directory.mkdir(exist_ok=True)
for argument in sys.argv[1:]:
    source = Path(argument).resolve(strict=True)
    if source.suffix.lower() not in ('.psd', '.psb', '.ai'):
        raise ValueError('Only PSD, PSB and AI fixtures are accepted')
    target = directory / source.name
    if target.exists() or source == target:
        raise FileExistsError('Use a fresh run directory; refusing to overwrite an existing fixture')
    before = digest(source)
    shutil.copy2(source, target)
    assert digest(target) == before == digest(source)
    records.append(dict(source=str(source), copy=str(target), sha256=before, bytes=source.stat().st_size))
if not records:
    raise ValueError('Pass one or more source files')
(ROOT / 'fixtures.json').write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
print('Fixture copies and source hashes verified:', len(records))
