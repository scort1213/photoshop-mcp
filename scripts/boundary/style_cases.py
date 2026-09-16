"""Layer-effect descriptors and actual rendered pixels survive PSD reopen."""
from boundary_suite import *
from real_fixtures import resources
from PIL import Image,ImageChops

def main():
    c=Client('ps');folder=ROOT/('styles-'+str(time.time_ns()));folder.mkdir();results=[]
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            for style,key in [('drop_shadow','dropShadow'),('outer_glow','outerGlow'),('stroke','frameFX'),('bevel_emboss','bevelEmboss')]:
                resources()
                target=c.script("var d=app.documents.add(128,96,72,'BOUNDARY style',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);d.selection.select([[32,24],[96,24],[96,72],[32,72]]);var col=new SolidColor();col.rgb.red=180;col.rgb.green=30;col.rgb.blue=20;d.selection.fill(col);d.selection.deselect();return d.id;",anchor)
                def call(name,args):return c.call('photoshop_'+name,dict(args,document_id=target))
                def render(label):
                    p=folder/f'{iteration}-{style}-{label}.png';call('save_document',{'path':str(p),'format':'PNG'})
                    with Image.open(p) as im:return im.convert('RGBA')
                before=render('before')
                call('apply_layer_style',{'style':style,'size':8,'distance':8,'angle':45,'opacity':80,'red':0,'green':160,'blue':255})
                check="var r=new ActionReference();r.putEnumerated(charIDToTypeID('Lyr '),charIDToTypeID('Ordn'),charIDToTypeID('Trgt'));var fx=executeActionGet(r).getObjectValue(stringIDToTypeID('layerEffects'));return fx.hasKey(stringIDToTypeID("+json.dumps(key)+"));"
                assert c.script(check,target) is True
                after=render('after');diff=ImageChops.difference(before,after)
                assert any(high>10 for low,high in diff.getextrema()),style
                assert after.getpixel((64,48))==(180,30,20,255)
                path=folder/f'{iteration}-{style}.psd';call('save_document',{'path':str(path),'format':'PSD'});call('close_document',{'save':False})
                target=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',anchor)
                assert c.script(check,target) is True
                assert render('reopen').tobytes()==after.tobytes()
                call('close_document',{'save':False})
                results.append({'round':iteration+1,'style':style,'descriptor':key,'render_changed':True,'reopen_exact':True})
                (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,style,flush=True)
    finally:c.close()

if __name__=='__main__':main()
