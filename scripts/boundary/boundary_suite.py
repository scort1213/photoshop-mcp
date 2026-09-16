"""Real stdio MCP acceptance runner. Logs assertions separately from transport success."""
from pathlib import Path
import base64, concurrent.futures, hashlib, json, os, queue, subprocess, sys, threading, time

import tomllib
CONFIG=Path(os.environ.get('ADOBE_BOUNDARY_CONFIG', str(Path.home()/'.codex/config.toml')))
SETTINGS=tomllib.loads(CONFIG.read_text(encoding='utf-8-sig'))['mcp_servers']
ROOT=Path(os.environ.get('ADOBE_BOUNDARY_RUN', 'D:/codex/Adobe-MCP-boundary-tests/current')).resolve()
if len(ROOT.parts)<3: raise ValueError('Use a dedicated test directory, not a drive root')
ROOT.mkdir(parents=True,exist_ok=True)
INSTALL=Path(SETTINGS['photoshop']['args'][0]).resolve().parent.parent.parent
NODE=SETTINGS['photoshop']['command']
AI_PY=SETTINGS['illustrator']['command']
TRACE=ROOT/'calls.jsonl'
trace_lock=threading.Lock()

class Client:
    def __init__(self, app):
        self.app=app; self.seq=0; self.waiters={}; self.lock=threading.Lock()
        config=SETTINGS['photoshop' if app=='ps' else 'illustrator']
        env={**os.environ, **{key:str(value) for key,value in config.get('env',{}).items()}}
        command=[config['command'],*config.get('args',[])]
        self.log=(ROOT/f'{app}-{time.time_ns()}.stderr.log').open('w',encoding='utf-8')
        self.proc=subprocess.Popen(command,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True,encoding='utf-8',creationflags=subprocess.CREATE_NO_WINDOW)
        threading.Thread(target=self.reader,daemon=True).start()
        self.request('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'boundary-acceptance','version':'1.0'}})
        self.notify('notifications/initialized',{})
        self.tools=self.request('tools/list',{})['tools']
        (ROOT/f'{app}-tools.json').write_text(json.dumps(self.tools,ensure_ascii=False,indent=2),encoding='utf-8')
    def reader(self):
        for line in self.proc.stdout:
            try: response=json.loads(line)
            except Exception: response={'error':{'message':'non-protocol stdout: '+line}}
            waiter=self.waiters.get(response.get('id'))
            if waiter: waiter.put(response)
        for waiter in list(self.waiters.values()): waiter.put({'error':{'message':'server exited'}})
    def notify(self,method,params):
        self.proc.stdin.write(json.dumps(dict(jsonrpc='2.0',method=method,params=params))+'\n');self.proc.stdin.flush()
    def request(self,method,params,timeout=150):
        with self.lock:
            self.seq+=1; seq=self.seq; waiter=queue.Queue();self.waiters[seq]=waiter
            self.proc.stdin.write(json.dumps(dict(jsonrpc='2.0',id=seq,method=method,params=params),ensure_ascii=False)+'\n'); self.proc.stdin.flush()
        try:
            response=waiter.get(timeout=timeout)
            if 'error' in response: raise RuntimeError(response['error'])
            return response['result']
        finally: self.waiters.pop(seq,None)
    def call(self,name,args=None,error=False):
        started=time.time(); result=self.request('tools/call',dict(name=name,arguments=args or {}))
        logged=json.loads(json.dumps(result))
        for i,c in enumerate(logged.get('content',[])):
            if c.get('type')=='image':
                path=ROOT/f'{self.app}-{time.time_ns()}-{i}.png';path.write_bytes(base64.b64decode(c.pop('data')));c['saved_image']=str(path)
        with trace_lock:
            with TRACE.open('a',encoding='utf-8') as f:f.write(json.dumps(dict(at=started,seconds=time.time()-started,app=self.app,name=name,args=args,result=logged),ensure_ascii=False)+'\n')
        if bool(result.get('isError'))!=error: raise AssertionError(f'{name}: expected isError={error}: {str(result)[:1800]}')
        texts=[c['text'] for c in result.get('content',[]) if c.get('type')=='text']
        text='\n'.join(texts)
        try:return json.loads(text)
        except Exception:return text
    def script(self,code,target=None,error=False):
        args={'code':code}
        if target is not None:args['document_id' if self.app=='ps' else 'target_path']=target
        result=self.call('photoshop_execute_script' if self.app=='ps' else 'run',args,error)
        if isinstance(result,str) and '\nResult: ' in result:
            result=result.split('\nResult: ',1)[1]
            try:return json.loads(result)
            except Exception:return result
        return result
    def state(self):return self.call('photoshop_list_documents' if self.app=='ps' else 'get_state')
    def close(self):
        self.proc.stdin.close()
        try:self.proc.wait(timeout=6)
        except subprocess.TimeoutExpired:self.proc.terminate();self.proc.wait(timeout=6)
        self.log.close()

def inspect():
    for app in ('ps','ai'):
        c=Client(app)
        try:print(app,json.dumps(c.state(),ensure_ascii=False),flush=True)
        finally:c.close()

def recover(c):
    c.state()
    c.call('photoshop_recover_connection' if c.app=='ps' else 'recover_connection',{'acknowledge':True})

def assert_test_documents(c):
    if c.app=='ai': rows=c.state()['documents']
    else:
        rows=c.state()['details']['documents']
    allowed=[str(ROOT).lower()]
    for row in rows:
        path=(row.get('path') or '').replace('/','\\').lower()
        assert path and any(path.startswith(prefix+'\\') for prefix in allowed),f'BUSINESS_DOCUMENT: {row}'

def prepare(c):
    assert_test_documents(c)
    if c.app=='ps':
        for d in c.state()['details']['documents']:c.call('photoshop_close_document',{'document_id':d['id'],'save':False})
        assert c.state()['details']['count']==0
        id=c.script("var d=app.documents.add(640,400,72,'Boundary 中文',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);d.saveAs(new File("+json.dumps(str(ROOT/'ps-working.psd').replace('\\','/'))+"),new PhotoshopSaveOptions(),false);var t=d.artLayers.add();t.kind=LayerKind.TEXT;t.textItem.contents='中文边界测试';t.textItem.size=24;t.textItem.position=[30,100];return d.id;")
        assert isinstance(id,int),id
        return id
    for row in c.state()['documents']: c.script('app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);',row['path'])
    assert len(c.state()['documents'])==0
    path=str(ROOT/'ai-synthetic.ai').replace('\\','/')
    c.script("var d=app.documents.add(DocumentColorSpace.RGB,640,400);var t=d.textFrames.add();t.contents='中文边界测试';t.position=[30,300];t.textRange.characterAttributes.size=24;d.saveAs(new File("+json.dumps(path)+"));'created';")
    return path

def smoke(app):
    c=Client(app); target=prepare(c); passed=[]
    try:
        if app=='ps':
            before=c.call('photoshop_get_state',{'document_id':target})
            for bad in [0,-1,1.5,'1',None,9007199254740992]:
                c.call('photoshop_create_layer',{'name':'must-not-exist','document_id':bad},error=True)
            assert c.call('photoshop_get_state',{'document_id':target})==before
            passed.append('invalid-document-id-no-mutation')
            c.call('photoshop_resize_image',{'width':-1,'height':10,'document_id':target},error=True)
            second=c.script("return app.documents.add(200,100,72,'Boundary second').id;",target)
            c.call('photoshop_create_layer',{'name':'wrong-doc'},error=True);recover(c)
            c.call('photoshop_create_layer',{'name':'指定中文图层','document_id':target})
            assert c.script("return app.activeDocument.layers[0].name;",target)=='指定中文图层'
            assert c.script('return app.activeDocument.layers.length;',second)==1
            c.call('photoshop_close_document',{'document_id':second,'save':False})
            c.call('photoshop_create_layer',{'document_id':second},error=True);recover(c)
            passed.append('multiple-and-stale-documents')
            saved=ROOT/'ps-synthetic.psd'
            c.call('photoshop_save_document',{'document_id':target,'path':str(saved),'format':'PSD','overwrite':True})
            before=hashlib.sha256(saved.read_bytes()).hexdigest()
            c.call('photoshop_save_document',{'document_id':target,'path':str(saved),'format':'PSD'},error=True)
            assert before==hashlib.sha256(saved.read_bytes()).hexdigest()
            c.call('photoshop_save_document',{'document_id':target,'path':str(ROOT/'wrong.png'),'format':'PSD'},error=True)
            c.call('photoshop_save_document',{'document_id':target,'path':str(ROOT/'missing'/'test.png'),'format':'PNG'},error=True)
            c.call('photoshop_close_document',{'document_id':target,'save':False})
            target=c.script('return app.open(new File('+json.dumps(str(saved).replace('\\','/'))+')).id;')
            assert c.script('return app.activeDocument.layers[0].name;',target)=='指定中文图层'
            passed.append('save-reopen-and-no-clobber')
            caps=c.call('photoshop_get_capabilities');assert not caps['features']['generative_fill'],caps
            c.call('photoshop_get_preview',{'document_id':target,'max_dimension_px':640})
        else:
            before=c.state()
            c.call('run',{'code':''},error=True);recover(c)
            assert c.state()==before
            c.script("app.documents.add(DocumentColorSpace.RGB,100,100);'added';",target)
            c.script('app.activeDocument.layers.add();',error=True);recover(c)
            c.script("app.activeDocument.layers.add().name='指定中文图层';'changed';",target)
            assert c.script('app.activeDocument.layers[0].name;',target)=='指定中文图层'
            c.script("for(var i=app.documents.length-1;i>=0;i--){var d=app.documents[i];if(d.name!==app.activeDocument.name)d.close(SaveOptions.DONOTSAVECHANGES);} 'closed second';",target)
            c.script('app.activeDocument.save();app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);"closed";',target)
            c.script('app.open(new File('+json.dumps(target)+'));"opened";')
            assert c.script('app.activeDocument.layers[0].name;',target)=='指定中文图层'
            passed.extend(['multiple-document-target','save-reopen-chinese'])
            c.call('view')
        (ROOT/f'{app}-smoke.json').write_text(json.dumps({'passed':passed,'target':target},ensure_ascii=False,indent=2),encoding='utf-8')
        print(app,'SMOKE PASS',passed,flush=True)
    finally:c.close()

def soak(app,seconds=3600):
    c=Client(app)
    target=json.loads((ROOT/f'{app}-smoke.json').read_text(encoding='utf-8'))['target']
    started=time.monotonic(); count=0; reconnects=0
    try:
        from real_fixtures import resources
        while time.monotonic()-started < seconds:
            resources()
            assert_test_documents(c)
            if (ROOT/f'{app}-stop').exists(): raise RuntimeError('operator_stop: soak is incomplete')
            value=f'稳定运行 {count} 中文 "引号"'
            if app=='ps':
                result=c.script('var d=app.activeDocument;d.activeLayer=d.layers[0];d.activeLayer.name='+json.dumps(value)+';return {name:d.activeLayer.name,id:d.id,layers:d.layers.length};',target)
                assert result['name']==value and result['id']==target,result
                c.call('photoshop_get_state',{'document_id':target})
                if count%12==0:c.call('photoshop_get_preview',{'document_id':target,'max_dimension_px':480})
                if count%30==0:c.call('photoshop_save_document',{'document_id':target,'path':str(ROOT/'ps-soak.psd'),'format':'PSD','overwrite':True})
            else:
                result=c.script('var d=app.activeDocument;d.layers[0].name='+json.dumps(value)+';d.textFrames[0].contents='+json.dumps(value)+';d.layers[0].name;',target)
                assert result==value,result
                c.state()
                if count%12==0:c.call('view')
                if count%30==0:c.script('app.activeDocument.save();"saved";',target)
            count+=1
            if reconnects<10 and count%6==0:
                c.close();c=Client(app);reconnects+=1
            status={'app':app,'elapsed_seconds':time.monotonic()-started,'cycles':count,'reconnects':reconnects,'complete':False,'last_ok':time.time()}
            (ROOT/f'{app}-soak-status.json').write_text(json.dumps(status),encoding='utf-8')
            time.sleep(5)
        status['complete']=True;status['elapsed_seconds']=time.monotonic()-started
        (ROOT/f'{app}-soak-status.json').write_text(json.dumps(status),encoding='utf-8')
        print(app,'SOAK PASS',status,flush=True)
    except Exception as error:
        status={'app':app,'elapsed_seconds':time.monotonic()-started,'cycles':count,'reconnects':reconnects,'complete':False,'halted_reason':str(error)}
        (ROOT/f'{app}-soak-status.json').write_text(json.dumps(status),encoding='utf-8')
        raise
    finally:c.close()

if __name__=='__main__':
    action=sys.argv[1] if len(sys.argv)>1 else 'inspect'
    if action=='inspect':inspect()
    elif action=='smoke':smoke(sys.argv[2])
    elif action=='soak':soak(sys.argv[2],int(sys.argv[3]) if len(sys.argv)>3 else 3600)
