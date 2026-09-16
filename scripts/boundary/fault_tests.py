from boundary_suite import *

def main(app):
    c=Client(app); target=json.loads((ROOT/f'{app}-smoke.json').read_text(encoding='utf-8'))['target']
    name='photoshop_execute_script' if app=='ps' else 'run'
    key='document_id' if app=='ps' else 'target_path'
    timeout_key='timeout_ms' if app=='ps' else 'timeout_seconds'
    deadline=150 if app=='ps' else .15
    prefix='return ' if app=='ps' else ''
    evidence=[]
    try:
        assert_test_documents(c)
        for round in range(3):
            assert_test_documents(c)
            if app=='ps': c.script("app.activeDocument.layers[0].name='before';return 'ready';",target)
            else:c.script("app.activeDocument.layers[0].name='before';'ready';",target)
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                active=pool.submit(c.call,name,{'code':"$.sleep(900);app.activeDocument.layers[0].name='late-completion';"+prefix+"'done';",key:target,timeout_key:deadline},True)
                time.sleep(.07)
                queued=c.call(name,{'code':"app.activeDocument.layers[0].name='MUST-NOT-RUN';"+prefix+"'bad';",key:target,timeout_key:deadline},True)
                failed=active.result()
            time.sleep(1.05)
            assert 'queue_timeout' in str(queued),queued
            assert 'outcome_unknown' in str(failed),failed
            blocked=c.call(name,{'code':prefix+"'blocked';",key:target},True)
            assert 'outcome_unknown' in str(blocked),blocked
            recover(c)
            actual=c.script(prefix+'app.activeDocument.layers[0].name;',target)
            assert actual=='late-completion',actual
            partial=c.script("app.activeDocument.layers[0].name='partial';throw new Error('intentional-partial-failure');",target,error=True)
            c.script(prefix+"'retry';",target,error=True)
            recover(c)
            assert c.script(prefix+'app.activeDocument.layers[0].name;',target)=='partial'
            evidence.append({'round':round+1,'active_timeout':failed,'queued_timeout':queued,'late_write_absent':True,'partial_failure_recovered':True})
        (ROOT/f'{app}-faults.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
        print(app,'FAULTS PASS 3 rounds',flush=True)
    finally:c.close()

if __name__=='__main__':main(sys.argv[1])
