"""Opt-in PS soak beside explicitly listed documents; never closes any document.

Usage: coexist_soak.py <test document ID> <seconds> <allowed other IDs...>
Use '*' instead of IDs only with authorization to coexist with changing work.
Only use after the operator authorizes coexistence. Manual UI edits are not
serialized by MCP locks; this checks document metadata, not pixel immutability.
The normal fault/lifecycle safety guard is deliberately unchanged.
"""
from boundary_suite import *
from real_fixtures import resources


def signature(row):
    return {k: row.get(k) for k in ('id', 'name', 'path', 'saved', 'width', 'height', 'resolution')}


def main(target, seconds, allowed):
    c = Client('ps')
    started = time.monotonic()
    status = dict(app='ps', mode='authorized_coexistence', complete=False,
                  cycles=0, reconnects=0, preview_successes=0,
                  target=target, allowed_other_ids=sorted(allowed) if allowed is not None else 'authorized changing work')
    output = ROOT/'ps-soak-status.json'
    if output.exists():
        archive = ROOT/f'ps-soak-before-coexist-{time.time_ns()}.json'
        archive.write_bytes(output.read_bytes())
    def rows():
        result = c.state()['details']['documents']
        ids = {r['id'] for r in result}
        assert target in ids, 'test document closed; no automatic reopen'
        if allowed is not None:
            assert ids <= allowed | {target}, 'new document outside authorized IDs'
        test = next(r for r in result if r['id'] == target)
        path = Path(test.get('path') or '').resolve()
        assert path.is_relative_to(ROOT), 'test target outside run directory'
        return result
    def call(name, args):
        before = rows()
        previous = next((r['id'] for r in before if r.get('is_active')), None)
        result = c.call(name, dict(args, document_id=target))
        after = rows()
        # Never restore after failed/unknown writes, nor override a tab switch
        # already observed after the call. A manual switch in this tiny gap is
        # still outside the MCP mutex, hence not a UI-concurrency guarantee.
        active = next((r['id'] for r in after if r.get('is_active')), None)
        if previous != target and previous in {r['id'] for r in after} and active == target:
            c.call('photoshop_set_active_document', {'document_id': previous})
        before_other = [signature(r) for r in before if r['id'] != target]
        after_other = [signature(r) for r in after if r['id'] != target]
        assert before_other == after_other, 'other document changed during call; stop for attribution'
        if name == 'photoshop_execute_script' and isinstance(result, str) and '\nResult: ' in result:
            result = json.loads(result.split('\nResult: ', 1)[1])
        return result
    try:
        baseline = rows()
        (ROOT/'ps-coexist-baseline.json').write_text(json.dumps(baseline, ensure_ascii=False, indent=2), encoding='utf-8')
        while time.monotonic()-started < seconds:
            resources()
            if (ROOT/'ps-stop').exists():
                raise RuntimeError('operator_stop: incomplete soak')
            count = status['cycles']
            value = f'稳定运行 {count} 中文 "引号"'
            result = call('photoshop_execute_script', {'code':
                'var d=app.activeDocument;d.layers[0].name='+json.dumps(value)+
                ';return {id:d.id,name:d.layers[0].name};'})
            assert result['id'] == target and result['name'] == value, result
            call('photoshop_get_state', {})
            if count % 12 == 0:
                call('photoshop_get_preview', {'max_dimension_px':480})
                status['preview_successes'] += 1
            if count % 30 == 0:
                call('photoshop_save_document', {'path':str(ROOT/'ps-coexist-soak.psd'), 'format':'PSD', 'overwrite':True})
            status['cycles'] += 1
            if status['reconnects'] < 10 and status['cycles'] % 6 == 0:
                c.close(); c = Client('ps'); status['reconnects'] += 1
            status.update(elapsed_seconds=time.monotonic()-started, last_ok=time.time())
            output.write_text(json.dumps(status), encoding='utf-8')
            time.sleep(5)
        status['complete'] = True
    except Exception as error:
        status['halted_reason'] = str(error)
        raise
    finally:
        status['elapsed_seconds'] = time.monotonic()-started
        output.write_text(json.dumps(status), encoding='utf-8')
        c.close()
    print(json.dumps(status), flush=True)


if __name__ == '__main__':
    main(int(sys.argv[1]), int(sys.argv[2]), None if sys.argv[3:] == ['*'] else {int(v) for v in sys.argv[3:]})
