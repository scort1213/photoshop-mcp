"""Real rejection and close-with-save cases added after geometry acceptance."""
from boundary_suite import *
from artboard_geometry_cases import CREATE,SNAP
from real_fixtures import resources

def main():
    c=Client('ps');folder=ROOT/('guards-'+str(time.time_ns()));folder.mkdir();results=[]
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            resources()
            target=c.script("return app.documents.add(64,64,72,'BOUNDARY history guards',NewDocumentMode.RGB,DocumentFill.TRANSPARENT).id;",anchor)
            def call(name,args=None,error=False):return c.call('photoshop_'+name,dict(args or {},document_id=target),error=error)
            call('create_layer',{'name':'History guard'})
            for name in ('undo','redo'):
                for steps in (1.5,10000):
                    before=call('get_history')
                    error=call(name,{'steps':steps},error=True)
                    assert 'invalid' in str(error).lower(),error
                    assert call('get_history')==before,'Rejected history call changed history'
                    # Read-only history proves the call made no partial history move.
                    recover(c)
            call('close_document',{'save':False})
            target=c.script(CREATE,anchor)
            c.script("app.activeDocument.layerSets[0].artLayers[0].visible=false;return true;",target)
            before=c.script(SNAP,target)
            error=call('merge_visible_layers',error=True)
            assert 'unsupported_artboard_mutation' in str(error),error
            # Preflight refusal must leave the document readable and unchanged.
            assert c.script(SNAP,target)==before
            path=folder/f'{iteration}-close-save.psd'
            call('save_document',{'path':str(path),'format':'PSD'});call('close_document',{'save':False})
            target=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',anchor)
            call('rename_layer',{'name':'Saved through close'})
            before=c.script(SNAP,target)
            call('close_document',{'save':True})
            target=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',anchor)
            assert c.script(SNAP,target)==before
            assert c.script('return app.activeDocument.activeLayer.name;',target)=='Saved through close'
            call('close_document',{'save':False})
            results.append({'round':iteration+1,'history_rejections':4,'hidden_descendant_refused':True,'artboard_close_save_reopen':True})
            (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,'history / artboard guards',flush=True)
    finally:c.close()

if __name__=='__main__':main()
