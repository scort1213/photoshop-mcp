"""Synthetic portrait pipeline structure, original pixels, undo and reopening."""
from boundary_suite import *
from PIL import Image,ImageChops

def main():
    c=Client('ps');folder=ROOT/('enhance-portrait-'+str(time.time_ns()));folder.mkdir();results=[]
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration,intensity in enumerate(['low','medium','high']):
            target=c.script("var d=app.documents.add(128,96,72,'BOUNDARY enhance',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);var col=new SolidColor();col.rgb.red=40;col.rgb.green=100;col.rgb.blue=180;d.selection.selectAll();d.selection.fill(col);d.selection.deselect();return d.id;",anchor)
            def call(name,args=None):return c.call('photoshop_'+name,dict(args or {},document_id=target))
            def render(label):
                path=folder/f'{iteration}-{label}.png';call('save_document',{'path':str(path),'format':'PNG'})
                with Image.open(path) as im:return im.convert('RGBA')
            before=render('before');call('recipe_enhance_portrait',{'intensity':intensity,'use_neural_skin':False})
            assert c.script('return app.activeDocument.layerSets[0].layers.length;',target)==3
            after=render('after');assert any(hi>5 for lo,hi in ImageChops.difference(before,after).getextrema())
            call('undo',{'steps':1});assert render('undo').tobytes()==before.tobytes()
            assert c.script('return app.activeDocument.layers.length;',target)==1
            call('redo',{'steps':1});assert render('redo').tobytes()==after.tobytes()
            c.script('app.activeDocument.layerSets[0].visible=false;return true;',target)
            assert render('original').tobytes()==before.tobytes()
            c.script('app.activeDocument.layerSets[0].visible=true;return true;',target)
            path=folder/f'{iteration}.psd';call('save_document',{'path':str(path),'format':'PSD'});call('close_document',{'save':False})
            target=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',anchor)
            assert render('reopen').tobytes()==after.tobytes();call('close_document',{'save':False})
            results.append({'round':iteration+1,'intensity':intensity,'three_layer_pipeline':True,'original_pixels':True,'undo_redo_reopen':True})
            (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,intensity,flush=True)
    finally:c.close()

if __name__=='__main__':main()
