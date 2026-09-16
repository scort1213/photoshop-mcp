from boundary_suite import *

def main(app):
    c=Client(app); target=json.loads((ROOT/f'{app}-smoke.json').read_text(encoding='utf-8'))['target']
    prefix='return ' if app=='ps' else ''
    try:
        assert_test_documents(c)
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            pending=pool.submit(c.script,"$.sleep(1500);app.activeDocument.layers[0].name='after-MCP-exit';"+prefix+"'done';",target)
            time.sleep(.5);c.proc.terminate()
            try:pending.result(timeout=10)
            except Exception:pass
        c.close();time.sleep(2);c=Client(app)
        c.state()
        c.script(prefix+"'must-block';",target,error=True)
        recover(c)
        assert c.script(prefix+'app.activeDocument.layers[0].name;',target)=='after-MCP-exit'
        assert_test_documents(c)
        # Close only the enumerated test documents before forcibly stopping the application.
        if app=='ps':
            for d in c.state()['details']['documents']:c.call('photoshop_close_document',{'document_id':d['id'],'save':False})
            assert c.state()['details']['count']==0
        else:
            for d in c.state()['documents']:c.script('app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);',d['path'])
            assert len(c.state()['documents'])==0
        c.close()
        name='Photoshop' if app=='ps' else 'Illustrator'
        command=f"Get-Process -Name {name} | Where-Object {{$_.MainWindowHandle -ne 0}} | Select-Object Id,Path,MainWindowTitle | ConvertTo-Json -Compress"
        result=subprocess.run(['powershell','-NoProfile','-Command',command],capture_output=True,text=True,encoding='utf-8',errors='replace',check=True)
        proc=json.loads(result.stdout);assert isinstance(proc,dict),proc
        expected=SETTINGS['photoshop'].get('env',{}).get('PHOTOSHOP_PATH') if app=='ps' else os.environ.get('ADOBE_BOUNDARY_ILLUSTRATOR_EXE')
        if not expected: raise RuntimeError('Set ADOBE_BOUNDARY_ILLUSTRATOR_EXE before application termination tests')
        assert proc['Path'].lower()==expected.lower(),proc
        subprocess.run(['powershell','-NoProfile','-Command',f"Stop-Process -Id {int(proc['Id'])} -Force"],check=True,capture_output=True)
        time.sleep(2)
        c=Client(app)
        if app=='ps':
            # list_documents triggers the normal connection launch path without an edit.
            assert c.state()['details']['count']==0
            target=c.script('return app.open(new File('+json.dumps(str(ROOT/'ps-synthetic.psd').replace('\\','/'))+')).id;')
        else:
            assert c.state()['documents']==[]
            c.script('app.open(new File('+json.dumps(target)+'));"opened";')
        record=json.loads((ROOT/f'{app}-smoke.json').read_text(encoding='utf-8'));record['target']=target
        (ROOT/f'{app}-smoke.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
        (ROOT/f'{app}-lifecycle.json').write_text(json.dumps({'mcp_exit_inflight':'passed','unknown_outcome_block':'passed','application_termination_with_zero_documents':'passed','relaunch_and_reopen':'passed','pid_before':proc['Id']}),encoding='utf-8')
        print(app,'LIFECYCLE PASS',flush=True)
    finally:
        if c.proc.poll() is None:c.close()

if __name__=='__main__':main(sys.argv[1])
