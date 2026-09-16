"""Kill only the owned MCP child after dispatch; recover stale script directories."""
from boundary_suite import *
import tempfile


def main():
    target=json.loads((ROOT/'ai-smoke.json').read_text(encoding='utf-8'))['target']
    root=Path(SETTINGS['illustrator'].get('env',{}).get('ILLUSTRATOR_SCRIPT_DIR',str(Path(tempfile.gettempdir())/'illustrator-mcp-scripts')))
    rows=[]
    for round_number in range(1,4):
        first=Client('ai');second=None
        try:
            assert_test_documents(first)
            before=set(root.glob('call-*'))
            marker=ROOT/f'ai-cleanup-dispatch-{time.time_ns()}.txt'
            code='var f=new File('+json.dumps(str(marker).replace('\\','/'))+');f.open("w");f.write("started");f.close();$.sleep(1200);app.activeDocument.layers[0].name="after-cleanup-exit";"done";'
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                pending=pool.submit(first.script,code,target)
                until=time.monotonic()+5
                while not marker.exists() and time.monotonic()<until:time.sleep(.01)
                assert marker.exists(),'Adobe dispatch was not observed'
                orphaned=set(root.glob('call-*'))-before
                assert len(orphaned)==1,orphaned
                owner=json.loads((next(iter(orphaned))/'owner.json').read_text())
                first.proc.terminate()
                try:pending.result(timeout=10)
                except Exception:pass
            first.close()
            second=Client('ai')
            assert_test_documents(second)
            second.script('"must remain blocked";',target,error=True)
            result=second.call('recover_connection',{'acknowledge':True})
            assert result['removed_stale_script_directories']>=1,result
            assert not any(p.exists() for p in orphaned)
            assert second.script('app.activeDocument.layers[0].name;',target)=='after-cleanup-exit'
            rows.append({'round':round_number,'server_pid':first.proc.pid,'script_owner_pid':owner['pid'],'recovered_directories':result['removed_stale_script_directories'],'partial_result_checked':True})
            print('AI CRASH CLEANUP PASS',round_number,flush=True)
        finally:
            if first.proc.poll() is None:first.close()
            if second:second.close()
            (ROOT/'ai-script-cleanup.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')


if __name__=='__main__':main()
