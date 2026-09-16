from boundary_suite import *
import shutil, ctypes

def resources():
    class Memory(ctypes.Structure):
        _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(x,ctypes.c_ulonglong) for x in ['total','free','page','freepage','virtual','freevirtual','extended']]
    m=Memory();m.length=ctypes.sizeof(m);assert ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
    assert m.free>=4*1024**3,'RAM safety threshold'
    assert shutil.disk_usage('C:/').free>=15*1024**3,'C: safety threshold'
    assert shutil.disk_usage('D:/').free>=30*1024**3,'D: safety threshold'
    return {'free_memory':m.free,'c_free':shutil.disk_usage('C:/').free,'d_free':shutil.disk_usage('D:/').free}

def main(app):
    c=Client(app);target=json.loads((ROOT/f'{app}-smoke.json').read_text(encoding='utf-8'))['target']; evidence=[]
    try:
        assert_test_documents(c)
        for fixture in json.loads((ROOT/'fixtures.json').read_text(encoding='utf-8')):
            path=fixture['copy'];extension=Path(path).suffix
            if (app=='ai')!=(extension=='.ai'):continue
            before_resources=resources();started=time.time()
            safe_path=json.dumps(path.replace('\\','/'))
            if app=='ps':
                opened=c.script('return app.open(new File('+safe_path+')).id;',target)
                baseline=c.script("var d=app.activeDocument;var names=[];function scan(ls){for(var i=0;i<ls.length;i++){var l=ls[i];names.push([l.name,l.typename]);if(l.typename==='LayerSet')scan(l.layers);}}scan(d.layers);return {names:names,width:d.width.as('px'),height:d.height.as('px'),mode:String(d.mode),bits:String(d.bitsPerChannel)};",opened)
                artboard=c.script("var groups=app.activeDocument.layerSets;for(var i=0;i<groups.length;i++){var r=new ActionReference();r.putIdentifier(charIDToTypeID('Lyr '),groups[i].id);if(executeActionGet(r).hasKey(stringIDToTypeID('artboard')))return true;}return false;",opened)
                response=c.call('photoshop_create_text_layer',{'document_id':opened,'text':'边界验收副本','x':30,'y':60,'fontSize':20},error=artboard)
                if artboard:
                    assert 'unsupported_artboard_mutation' in str(response),response
                    recover(c)
                c.script("if(app.activeDocument.fullName.fsName.indexOf('Adobe-MCP-boundary-tests')<0)throw new Error('unsafe path');app.activeDocument.save();return app.activeDocument.saved;",opened)
                c.call('photoshop_get_preview',{'document_id':opened,'max_dimension_px':480})
                c.call('photoshop_close_document',{'document_id':opened,'save':False})
                opened=c.script('return app.open(new File('+safe_path+')).id;',target)
                after=c.script("var d=app.activeDocument;var names=[];var testText='';function scan(ls){for(var i=0;i<ls.length;i++){var l=ls[i];if(l.name==='边界验收副本')testText=l.textItem.contents;if(l.name!=='边界验收副本')names.push([l.name,l.typename]);if(l.typename==='LayerSet')scan(l.layers);}}scan(d.layers);return {names:names,width:d.width.as('px'),height:d.height.as('px'),mode:String(d.mode),bits:String(d.bitsPerChannel),testText:testText};",opened)
                assert after.pop('testText')==('' if artboard else '边界验收副本')
                assert after==baseline,'PSD/PSB structure changed unexpectedly'
                c.call('photoshop_close_document',{'document_id':opened,'save':False})
            else:
                c.script('app.open(new File('+safe_path+'));"opened";',target)
                baseline=c.script("var d=app.activeDocument;[d.layers.length,d.textFrames.length,d.pageItems.length,d.artboards.length].join(',');",path)
                c.script("var d=app.activeDocument;var l=d.layers.add();l.name='边界验收副本';var t=l.textFrames.add();t.contents='边界验收副本';t.position=[30,60];d.save();'saved';",path)
                c.call('view')
                c.script('app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);"closed";',path)
                c.script('app.open(new File('+safe_path+'));"opened";',target)
                assert c.script('app.activeDocument.layers[0].textFrames[0].contents;',path)=='边界验收副本'
                after=c.script("var d=app.activeDocument;[d.layers.length-1,d.textFrames.length-1,d.pageItems.length-1,d.artboards.length].join(',');",path)
                assert after==baseline,(baseline,after)
                c.script('app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);"closed";',path)
            with open(fixture['source'],'rb') as source:assert hashlib.file_digest(source,'sha256').hexdigest()==fixture['sha256']
            evidence.append({'file':Path(path).name,'bytes':fixture['bytes'],'seconds':time.time()-started,'before_resources':before_resources,'save_reopen_structure':'passed','edit_boundary':'unsupported_artboard_rejected' if app=='ps' and artboard else 'editable_text_passed','original_hash':'unchanged'})
            (ROOT/f'{app}-real-fixtures.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
            print(app,'REAL FIXTURE PASS',Path(path).name,flush=True)
    finally:c.close()

if __name__=='__main__':main(sys.argv[1])
