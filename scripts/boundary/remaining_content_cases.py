"""Remaining content-aware repair and subject masks on synthetic inputs."""
from boundary_suite import *
from PIL import Image,ImageDraw

def main():
    c=Client('ps');folder=ROOT/('content-'+str(time.time_ns()));folder.mkdir();results=[]
    repair=folder/'repair.png';im=Image.new('RGB',(256,192),(40,100,180));ImageDraw.Draw(im).rectangle((115,83,141,109),fill=(200,20,10));im.save(repair)
    subject=folder/'bottle.png';im=Image.new('RGB',(256,256),'white');d=ImageDraw.Draw(im);d.rounded_rectangle((88,65,168,226),radius=15,fill=(20,60,160));d.rectangle((112,30,144,85),fill=(20,60,160));d.rectangle((109,25,147,42),fill=(20,20,20));im.save(subject)
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            for name in ('content_aware_fill','recipe_remove_distraction','select_subject','recipe_remove_background'):
                path=repair if name in ('content_aware_fill','recipe_remove_distraction') else subject
                target=c.script('var d=app.open(new File('+json.dumps(str(path))+'));d.activeLayer.isBackgroundLayer=false;return d.id;',anchor)
                def call(name,args=None):return c.call('photoshop_'+name,dict(args or {},document_id=target))
                if path==repair:call('select_rectangle',{'left':110,'top':78,'right':147,'bottom':115})
                result=call(name,{'use_generative':False} if name=='recipe_remove_distraction' else {})
                if name=='select_subject':call('create_layer_mask')
                call('deselect')
                out=folder/f'{iteration}-{name}.png';call('save_document',{'path':str(out),'format':'PNG'})
                with Image.open(out) as output:actual=output.convert('RGBA')
                if path==repair:
                    for point in [(128,96),(120,88),(140,105),(5,5)]:
                        assert max(abs(a-b) for a,b in zip(actual.getpixel(point),(40,100,180,255)))<=2,(name,point,actual.getpixel(point))
                else:
                    assert actual.getpixel((5,5))[3]==0 and actual.getpixel((128,150))[3]>250
                    assert actual.getpixel((128,150))[:3]==(20,60,160)
                psd=folder/f'{iteration}-{name}.psd';call('save_document',{'path':str(psd),'format':'PSD'});call('close_document',{'save':False})
                target=c.script('return app.open(new File('+json.dumps(str(psd))+')).id;',anchor)
                reopened=folder/f'{iteration}-{name}-reopen.png';call('save_document',{'path':str(reopened),'format':'PNG'})
                with Image.open(reopened) as output:assert output.convert('RGBA').tobytes()==actual.tobytes()
                call('close_document',{'save':False})
                results.append({'round':iteration+1,'tool':'photoshop_'+name,'pixel_postconditions':True,'reopen_exact':True})
                (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,name,flush=True)
    finally:c.close()

if __name__=='__main__':main()
