"""Real export checks: pixels, source preservation, collisions and failed paths."""
from boundary_suite import *
from real_fixtures import resources
from PIL import Image

SNAP = '''var d=app.activeDocument;return {id:d.id,width:d.width.as('px'),height:d.height.as('px'),layers:d.layers.length,history:d.historyStates.length,historyName:d.activeHistoryState.name,layer:d.activeLayer.id};'''

def main():
    c=Client('ps');folder=ROOT/('export-web-'+str(time.time_ns()));folder.mkdir();results=[]
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            resources()
            target=c.script("var d=app.documents.add(128,96,72,'BOUNDARY export',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);d.selection.select([[32,24],[96,24],[96,72],[32,72]]);var color=new SolidColor();color.rgb.red=180;color.rgb.green=30;color.rgb.blue=20;d.selection.fill(color);d.selection.deselect();return d.id;",anchor)
            def call(name,args,error=False):return c.call('photoshop_'+name,dict(args,document_id=target),error=error)
            before=c.script(SNAP,target)
            outputs=[]
            for name in ('export_as','recipe_prepare_for_web'):
                for fmt in ('PNG','JPEG'):
                    path=folder/f'{iteration}-{name}-中文.{"png" if fmt=="PNG" else "jpg"}'
                    args={'path':str(path),'format':fmt if name=='export_as' else fmt.lower()}
                    if name=='recipe_prepare_for_web':args['max_dimension_px']=64
                    result=call(name,args)
                    with Image.open(path) as im:
                        assert im.format==fmt,(im.format,fmt)
                        assert im.size==((128,96) if name=='export_as' else (64,48)),im.size
                        rgba=im.convert('RGBA');center=rgba.getpixel((im.width//2,im.height//2))
                        assert max(abs(a-b) for a,b in zip(center[:3],(180,30,20)))<=4,center
                        if fmt=='PNG':assert rgba.getpixel((0,0))[3]==0
                    assert c.script(SNAP,target)==before,'Source changed during export'
                    digest=hashlib.sha256(path.read_bytes()).hexdigest()
                    error=call(name,args,error=True)
                    assert 'output_exists' in str(error),error
                    assert hashlib.sha256(path.read_bytes()).hexdigest()==digest
                    assert c.script(SNAP,target)==before
                    outputs.append({'tool':name,'format':fmt,'path':str(path),'collision_refused':True})
                missing=folder/'absent'/f'{iteration}-{name}.png'
                error=call(name,{'path':str(missing),'format':'PNG' if name=='export_as' else 'png'},error=True)
                assert not missing.exists()
                assert c.script(SNAP,target)==before
            mismatch=folder/f'{iteration}-mismatch.jpg'
            error=call('export_as',{'path':str(mismatch),'format':'PNG'},error=True)
            assert 'invalid_arguments' in str(error) and not mismatch.exists(),error
            assert not list(folder.glob('.photoshop-mcp-save-*')),'Staging directory leaked'
            assert c.script(SNAP,target)==before
            call('close_document',{'save':False})
            results.append({'round':iteration+1,'outputs':outputs,'source_unchanged':True,'no_staging_leak':True})
            (folder/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
            print('PASS',iteration+1,'export_as / prepare_for_web',flush=True)
    finally:c.close()

if __name__=='__main__':main()
