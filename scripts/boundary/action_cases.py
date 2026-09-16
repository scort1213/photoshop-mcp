"""Execute the inspected installed default grayscale action on a synthetic copy."""
from boundary_suite import *
from PIL import Image

def main():
    c=Client('ps');folder=ROOT/('actions-'+str(time.time_ns()));folder.mkdir();results=[]
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            target=c.script("var d=app.documents.add(128,96,72,'BOUNDARY action',NewDocumentMode.RGB,DocumentFill.WHITE);var col=new SolidColor();col.rgb.red=40;col.rgb.green=100;col.rgb.blue=180;d.selection.selectAll();d.selection.fill(col);d.selection.deselect();return d.id;",anchor)
            def call(name,args):return c.call('photoshop_'+name,dict(args,document_id=target))
            call('play_action',{'actionName':'自定义 RGB 到灰度','actionSetName':'默认动作'})
            p=folder/f'{iteration}.png';call('save_document',{'path':str(p),'format':'PNG'})
            with Image.open(p) as im:
                rgb=im.convert('RGB');v=rgb.getpixel((64,48));assert max(v)-min(v)<=1,v
            psd=folder/f'{iteration}.psd';call('save_document',{'path':str(psd),'format':'PSD'});call('close_document',{'save':False})
            target=c.script('return app.open(new File('+json.dumps(str(psd))+')).id;',anchor)
            p=folder/f'{iteration}-reopen.png';call('save_document',{'path':str(p),'format':'PNG'})
            with Image.open(p) as im:assert im.convert('RGB').tobytes()==rgb.tobytes()
            call('close_document',{'save':False})
            results.append({'round':iteration+1,'installed_action':'custom RGB to grayscale','actual_gray_pixels':v,'reopen_exact':True})
            (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,'default action',flush=True)
    finally:c.close()

if __name__=='__main__':main()
