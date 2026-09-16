"""Verify a queued timeout across two independently running MCP servers."""
from boundary_suite import *


def main(app):
    first, second = Client(app), Client(app)
    results = []
    target = json.loads((ROOT/f'{app}-smoke.json').read_text(encoding='utf-8'))['target']
    tool = 'photoshop_execute_script' if app == 'ps' else 'run'
    target_key = 'document_id' if app == 'ps' else 'target_path'
    timeout_key = 'timeout_ms' if app == 'ps' else 'timeout_seconds'
    timeout = 150 if app == 'ps' else .15
    prefix = 'return ' if app == 'ps' else ''
    try:
        assert first.proc.pid != second.proc.pid
        assert_test_documents(first)
        for round_number in range(1, 4):
            marker = ROOT/f'{app}-dispatch-{time.time_ns()}.txt'
            literal = json.dumps(str(marker).replace('\\', '/'))
            code = ('var f=new File('+literal+');if(!f.open("w"))throw new Error("dispatch_marker_failed");'
                    'f.write("started");f.close();$.sleep(900);'
                    "app.activeDocument.layers[0].name='cross-client-completed';"+prefix+"'done';")
            with concurrent.futures.ThreadPoolExecutor(1) as pool:
                running = pool.submit(first.call, tool, {'code':code, target_key:target, timeout_key:timeout}, True)
                until = time.monotonic()+3
                while not marker.exists() and time.monotonic()<until:
                    time.sleep(.01)
                assert marker.exists(), 'first operation did not reach Adobe'
                queued = second.call(tool, {'code':"app.activeDocument.layers[0].name='MUST-NOT-RUN';"+prefix+"'bad';", target_key:target, timeout_key:timeout}, error=True)
                active = running.result()
            assert 'queue_timeout' in str(queued), queued
            assert 'outcome_unknown' in str(active), active
            time.sleep(1)
            for client in (first, second):
                blocked=client.call(tool, {'code':prefix+"'blocked';",target_key:target}, error=True)
                assert 'outcome_unknown' in str(blocked), blocked
            recover(second)
            assert second.script(prefix+'app.activeDocument.layers[0].name;',target)=='cross-client-completed'
            results.append({'round':round_number,'server_pids':[first.proc.pid,second.proc.pid],
                            'dispatch_confirmed':True,'queued_call_never_executed':True,
                            'both_clients_blocked_until_recovery':True})
            print(app,'CROSS CLIENT PASS',round_number,flush=True)
    finally:
        (ROOT/f'{app}-cross-client.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
        first.close();second.close()


if __name__=='__main__':main(sys.argv[1])
