"""Interleaved layer kinds must not change compositing when organized."""
from boundary_suite import *
from PIL import Image

CREATE="""var d=app.documents.add(128,96,72,'BOUNDARY organize',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);
function fill(red,green,blue){var col=new SolidColor();col.rgb.red=red;col.rgb.green=green;col.rgb.blue=blue;d.selection.selectAll();d.selection.fill(col);d.selection.deselect();}
fill(20,40,180);var text=d.artLayers.add();text.kind=LayerKind.TEXT;text.textItem.contents='A';text.textItem.size=40;text.textItem.position=[40,60];
var top=d.artLayers.add();fill(180,30,20);return d.id;"""
def main():
    c=Client('ps');folder=ROOT/('organize-'+str(time.time_ns()));folder.mkdir();results=[]
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            target=c.script(CREATE,anchor)
            def call(name,args=None):return c.call('photoshop_'+name,dict(args or {},document_id=target))
            def render(label):
                path=folder/f'{iteration}-{label}.png';call('save_document',{'path':str(path),'format':'PNG'})
                with Image.open(path) as im:return im.convert('RGBA')
            before=render('before');original_ids=c.script('return [app.activeDocument.layers[0].id,app.activeDocument.layers[1].id,app.activeDocument.layers[2].id];',target)
            result=call('recipe_organize_layers',{'auto_group':True})
            after=render('after');assert after.tobytes()==before.tobytes(),'Grouping changed compositing'
            scan="var ids=[];function walk(p){for(var i=0;i<p.layers.length;i++){var l=p.layers[i];if(l.typename=='LayerSet')walk(l);else ids.push(l.id);}}walk(app.activeDocument);return ids;"
            assert c.script(scan,target)==original_ids
            call('undo',{'steps':1});assert render('undo').tobytes()==before.tobytes()
            assert c.script('return app.activeDocument.layers.length;',target)==3
            call('redo',{'steps':1});assert render('redo').tobytes()==after.tobytes()
            path=folder/f'{iteration}.psd';call('save_document',{'path':str(path),'format':'PSD'});call('close_document',{'save':False})
            target=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',anchor)
            assert render('reopen').tobytes()==after.tobytes();assert c.script(scan,target)==original_ids
            call('close_document',{'save':False})
            results.append({'round':iteration+1,'pixel_identity':True,'layer_order_ids':original_ids,'undo_redo_reopen':True})
            (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,'organize',flush=True)
    finally:c.close()

if __name__=='__main__':main()
