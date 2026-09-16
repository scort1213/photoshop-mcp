"""Recipe structure, pixels, one-step undo and PSD reopen checks."""
from boundary_suite import *
from PIL import Image,ImageChops

def main():
    c=Client('ps');folder=ROOT/('recipe-layers-'+str(time.time_ns()));folder.mkdir();results=[]
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            for recipe in ('dodge_burn','gradient_fade','apply_color_grade','frequency_separation'):
                target=c.script("var d=app.documents.add(128,96,72,'BOUNDARY recipe',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);var col=new SolidColor();col.rgb.red=40;col.rgb.green=100;col.rgb.blue=180;d.selection.selectAll();d.selection.fill(col);d.selection.deselect();return d.id;",anchor)
                def call(name,args=None):return c.call('photoshop_'+name,dict(args or {},document_id=target))
                def render(label):
                    path=folder/f'{iteration}-{recipe}-{label}.png';call('save_document',{'path':str(path),'format':'PNG'})
                    with Image.open(path) as im:return im.convert('RGBA')
                before=render('before')
                params={'direction':'left_to_right'} if recipe=='gradient_fade' else {}
                call('recipe_'+recipe,params)
                after=render('after')
                if recipe=='gradient_fade':
                    assert after.getpixel((5,48))[3]<30 and after.getpixel((123,48))[3]>230
                    assert after.getpixel((100,48))[:3]==(40,100,180)
                elif recipe in ('dodge_burn','frequency_separation'):
                    assert all(hi<=2 for lo,hi in ImageChops.difference(before,after).getextrema())
                    if recipe=='dodge_burn':assert c.script('return String(app.activeDocument.activeLayer.blendMode);',target)=='BlendMode.OVERLAY'
                    else:assert c.script('return app.activeDocument.layerSets[0].layers.length;',target)==2
                else:
                    assert any(hi>5 for lo,hi in ImageChops.difference(before,after).getextrema())
                    assert c.script('return app.activeDocument.layerSets[0].layers.length;',target)==1
                call('undo',{'steps':1})
                assert render('undo').tobytes()==before.tobytes()
                assert c.script('return app.activeDocument.layers.length;',target)==1
                call('redo',{'steps':1})
                assert render('redo').tobytes()==after.tobytes()
                path=folder/f'{iteration}-{recipe}.psd';call('save_document',{'path':str(path),'format':'PSD'});call('close_document',{'save':False})
                target=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',anchor)
                assert render('reopen').tobytes()==after.tobytes()
                call('close_document',{'save':False})
                results.append({'round':iteration+1,'tool':'photoshop_recipe_'+recipe,'pixels':True,'one_step_undo_redo':True,'reopen_exact':True})
                (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,recipe,flush=True)
    finally:c.close()

if __name__=='__main__':main()
