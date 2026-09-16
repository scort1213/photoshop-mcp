"""Sky must cover the upper image and preserve the lower landscape."""
from boundary_suite import *
from PIL import Image

def main():
    c=Client('ps');folder=ROOT/('sky-blend-'+str(time.time_ns()));folder.mkdir();results=[]
    sky=folder/'sky.png';Image.new('RGB',(128,96),(20,80,200)).save(sky)
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            target=c.script("var d=app.documents.add(128,96,72,'BOUNDARY sky blend',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);var col=new SolidColor();col.rgb.red=30;col.rgb.green=150;col.rgb.blue=40;d.selection.selectAll();d.selection.fill(col);d.selection.deselect();return d.id;",anchor)
            def call(name,args):return c.call('photoshop_'+name,dict(args,document_id=target))
            call('recipe_sky_blend',{'sky_image_path':str(sky),'use_native_sky':False,'horizon_pct':50,'feather_pct':15})
            def render(label):
                path=folder/f'{iteration}-{label}.png';call('save_document',{'path':str(path),'format':'PNG'})
                with Image.open(path) as im:return im.convert('RGB')
            im=render('after');assert im.getpixel((64,5))==(20,80,200),im.getpixel((64,5))
            assert im.getpixel((64,90))==(30,150,40),im.getpixel((64,90))
            call('undo',{'steps':1});assert c.script('return app.activeDocument.layers.length;',target)==1
            call('redo',{'steps':1});assert render('redo').tobytes()==im.tobytes()
            path=folder/f'{iteration}.psd';call('save_document',{'path':str(path),'format':'PSD'});call('close_document',{'save':False})
            target=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',anchor)
            assert render('reopen').tobytes()==im.tobytes();call('close_document',{'save':False})
            results.append({'round':iteration+1,'upper_sky_lower_landscape':True,'undo_redo_reopen':True})
            (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,'sky blend',flush=True)
    finally:c.close()

if __name__=='__main__':main()
