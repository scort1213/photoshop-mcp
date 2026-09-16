"""RGB/8-bit filter acceptance with deterministic pixels and save/reopen checks."""
from boundary_suite import *
from real_fixtures import resources
from PIL import Image, ImageChops, ImageStat

CASES={
 'apply_sharpen':{'amount':150,'radius':2,'threshold':0},
 'apply_noise':{'amount':20,'distribution':'UNIFORM','monochromatic':True},
 'apply_motion_blur':{'angle':0,'radius':12},
 'apply_high_pass':{'radius':4},
 'apply_smart_blur':{'radius':5,'threshold':50},
 'adjust_brightness_contrast':{'brightness':40,'contrast':0},
 'adjust_hue_saturation':{'hue':0,'saturation':-100,'lightness':0},
 'auto_levels':{},'auto_contrast':{},'adjust_curves':{'preset':'auto_tone'},
 'adjust_vibrance':{'vibrance':50,'saturation':20},
 'adjust_exposure':{'exposure':1,'offset':0,'gamma':1},
 'apply_photo_filter':{'red':236,'green':138,'blue':0,'density':50},
 'apply_gradient_map':{'reverse':False},
}

def main():
    folder=ROOT/('filter-colors-'+str(time.time_ns()));folder.mkdir()
    source=folder/'known-pixels.png';im=Image.new('RGB',(128,96))
    for y in range(96):
        for x in range(128):
            n=((x*13+y*17)%13)-6
            im.putpixel((x,y),(50+x+n,60+y+n,80+(x//16)*8+n))
    im.save(source)
    c=Client('ps');results=[]
    try:
        anchor=c.state()['details']['active_document_id']
        selected=sys.argv[1:] or list(CASES)
        for iteration in range(3):
            for name in selected:
                resources()
                target=c.script('return app.open(new File('+json.dumps(str(source))+')).id;',anchor)
                c.script('app.activeDocument.activeLayer.isBackgroundLayer=false;return app.activeDocument.activeLayer.id;',target)
                def call(tool,args=None):return c.call('photoshop_'+tool,dict(args or {},document_id=target))
                before=folder/f'{iteration}-{name}-before.png'
                call('save_document',{'path':str(before),'format':'PNG'})
                call(name,CASES[name])
                after=folder/f'{iteration}-{name}-after.png'
                call('save_document',{'path':str(after),'format':'PNG'})
                with Image.open(before) as f:a=f.convert('RGB')
                with Image.open(after) as f:b=f.convert('RGB')
                assert a.size==b.size==(128,96)
                diff=ImageChops.difference(a,b)
                assert diff.getbbox(),f'{name}: no pixel changes'
                if name in ('adjust_brightness_contrast','adjust_exposure'):
                    assert sum(ImageStat.Stat(b).mean)>sum(ImageStat.Stat(a).mean)
                if name in ('adjust_hue_saturation','apply_gradient_map'):
                    for p in [(10,10),(60,45),(110,80)]:assert max(b.getpixel(p))-min(b.getpixel(p))<=1
                state=call('get_state');assert state['document']['width']==128 and state['document']['height']==96
                psd=folder/f'{iteration}-{name}.psd'
                call('save_document',{'path':str(psd),'format':'PSD'});call('close_document',{'save':False})
                target=c.script('return app.open(new File('+json.dumps(str(psd))+')).id;',anchor)
                reopened=folder/f'{iteration}-{name}-reopened.png'
                call('save_document',{'path':str(reopened),'format':'PNG'})
                with Image.open(reopened) as f:
                    reopened_diff=ImageChops.difference(f.convert('RGB'),b)
                    reopened_max=max(high for low,high in reopened_diff.getextrema())
                    assert reopened_max<=1,(name,reopened_diff.getextrema())
                call('close_document',{'save':False})
                results.append({'round':iteration+1,'tool':name,'target':target,'scope':'RGB8','changed_pixels_bbox':diff.getbbox(),'mean_change':ImageStat.Stat(diff).mean,'save_reopen_max_channel_delta':reopened_max,'folder':str(folder)})
                (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8')
                print('PASS',iteration+1,name,flush=True)
    finally:c.close()

if __name__=='__main__':main()
