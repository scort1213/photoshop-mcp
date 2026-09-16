"""Smart-object independence, explicit ordering and history regression."""
from boundary_suite import *
from real_fixtures import resources
from PIL import Image

def main():
    folder=ROOT/('objects-history-'+str(time.time_ns()));folder.mkdir()
    red=folder/'原图 中文.png';green=folder/'替换素材.png'
    Image.new('RGB',(64,32),(180,30,20)).save(red)
    Image.new('RGB',(64,32),(20,180,30)).save(green)
    hashes={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in (red,green)}
    c=Client('ps');results=[]
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            resources();passed=[]
            ids={d['id'] for d in c.state()['details']['documents']}
            c.call('photoshop_open_image',{'filePath':str(red)})
            opened=[d['id'] for d in c.state()['details']['documents'] if d['id'] not in ids]
            assert len(opened)==1
            opened=opened[0]
            assert c.call('photoshop_get_state',{'document_id':opened})['document']['width']==64
            c.call('photoshop_close_document',{'document_id':opened,'save':False});passed.append('open_image')
            target=c.script("return app.documents.add(128,96,72,'BOUNDARY objects',NewDocumentMode.RGB,DocumentFill.TRANSPARENT).id;",anchor)
            def call(name,args=None):return c.call('photoshop_'+name,dict(args or {},document_id=target))
            def script(code):return c.script(code,target)
            def state():return call('get_state')
            call('place_image',{'filePath':str(red),'x':0,'y':0})
            first=state()['activeLayer']['id'];assert 'SMARTOBJECT' in state()['activeLayer']['kind'];passed.append('place_image')
            call('rename_layer',{'name':'Original 中文 "A"'})
            call('create_smart_object_via_copy')
            second=state()['activeLayer']['id'];assert first!=second;passed.append('create_smart_object_via_copy')
            call('rename_layer',{'name':'Independent copy'})
            call('replace_smart_object_contents',{'file_path':str(green)})
            assert state()['activeLayer']['id']==second;passed.append('replace_smart_object_contents')
            # Opening both embedded contents verifies independence, dimensions and pixel colors.
            for name,expected in [('Independent copy',(20,180,30)),('Original 中文 "A"',(180,30,20))]:
                old_ids={d['id'] for d in c.state()['details']['documents']}
                call('edit_smart_object_contents',{'layer_name':name})
                child=[d['id'] for d in c.state()['details']['documents'] if d['id'] not in old_ids]
                assert len(child)==1,child
                p=folder/f'{iteration}-{child[0]}-embedded.png'
                c.call('photoshop_save_document',{'document_id':child[0],'path':str(p),'format':'PNG'})
                with Image.open(p) as im:
                    assert im.size==(64,32)
                    assert im.convert('RGB').getpixel((32,16))==expected
                c.call('photoshop_close_document',{'document_id':child[0],'save':False})
            passed.append('edit_smart_object_contents')
            call('select_layer_by_name',{'name':'Independent copy'})
            call('fit_layer_to_document',{'fillDocument':False})
            b=state()['activeLayer']['bounds'];assert abs(b['right']-b['left']-128)<=1 and abs(b['bottom']-b['top']-64)<=1,b
            passed.append('fit_layer_to_document')
            call('rasterize_layer');assert 'NORMAL' in state()['activeLayer']['kind'];passed.append('rasterize_layer')
            psd=folder/f'{iteration}-objects.psd';call('save_document',{'path':str(psd),'format':'PSD'})
            layer_ids=script('var a=[];for(var i=0;i<app.activeDocument.layers.length;i++)a.push(app.activeDocument.layers[i].id);return a;')
            call('close_document',{'save':False});target=c.script('return app.open(new File('+json.dumps(str(psd))+')).id;',anchor)
            assert script('var a=[];for(var i=0;i<app.activeDocument.layers.length;i++)a.push(app.activeDocument.layers[i].id);return a;')==layer_ids
            call('close_document',{'save':False})
            target=c.script("return app.documents.add(128,96,72,'BOUNDARY history',NewDocumentMode.RGB,DocumentFill.TRANSPARENT).id;",anchor)
            for name in ['A','B','C']:call('create_layer',{'name':name})
            def names():return script('var a=[];for(var i=0;i<app.activeDocument.layers.length;i++)a.push(app.activeDocument.layers[i].name);return a;')
            baseline=names();history=json.loads(call('get_history').split('\n',1)[1])
            assert history['totalStates']==script('return app.activeDocument.historyStates.length;')
            assert history['canUndo'] and not history['canRedo'];passed.append('get_history')
            call('rename_layer',{'name':'Changed C'})
            call('undo');assert names()==baseline;passed.append('undo')
            call('redo');assert names()==['Changed C',*baseline[1:]];passed.append('redo')
            call('rename_layer',{'name':'C'})
            call('select_layer_by_name',{'name':'B'})
            call('move_layer_to_top');assert names()==['B','C','A',baseline[-1]];passed.append('move_layer_to_top')
            call('move_layer_down');assert names()==['C','B','A',baseline[-1]];passed.append('move_layer_down')
            call('move_layer_up');assert names()==['B','C','A',baseline[-1]];passed.append('move_layer_up')
            call('move_layer_to_bottom');assert names()==['C','A',baseline[-1],'B'];passed.append('move_layer_to_bottom')
            call('move_layer_to_position',{'targetLayerName':'A','position':'ABOVE'});assert names()==['C','B','A',baseline[-1]];passed.append('move_layer_to_position')
            call('close_document',{'save':False})
            for p,sha in hashes.items():assert hashlib.sha256(p.read_bytes()).hexdigest()==sha
            results.append({'round':iteration+1,'tools':passed,'source_hashes_unchanged':True,'embedded_pixels_verified':True,'save_reopen_layer_ids':True})
            (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,passed,flush=True)
    finally:c.close()

if __name__=='__main__':main()
