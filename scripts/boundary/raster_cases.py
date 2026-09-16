"""Small synthetic raster tests with pixel and structure postconditions."""
from boundary_suite import *
from real_fixtures import resources
from PIL import Image

def main():
    c=Client('ps'); evidence=[]
    folder=ROOT/('raster-'+str(time.time_ns()));folder.mkdir()
    try:
        initial=c.state()['details'];previous=initial['active_document_id']
        for iteration in range(3):
            resources();passed=[]
            before={d['id'] for d in c.state()['details']['documents']}
            c.call('photoshop_create_document',{'width':128,'height':96,'resolution':72,'colorMode':'RGB'})
            new=[d for d in c.state()['details']['documents'] if d['id'] not in before]
            assert len(new)==1 and new[0]['width']==128 and new[0]['height']==96,new
            target=new[0]['id'];passed.append('create_document')
            def call(name,args=None):return c.call('photoshop_'+name,dict(args or {},document_id=target))
            def script(code):
                # This helper is only used for read-only postconditions.
                deadline=time.monotonic()+30
                while True:
                    try:return c.script(code,target)
                    except AssertionError as error:
                        if 'application_busy' not in str(error) or time.monotonic()>=deadline:raise
                        time.sleep(1)
            def state():return call('get_state')
            serial=0
            def pixels():
                nonlocal serial
                serial+=1;p=folder/f'{iteration}-{serial}.png'
                call('save_document',{'path':str(p),'format':'PNG'})
                with Image.open(p) as im:return im.convert('RGBA')
            call('save_document',{'path':str(folder/f'working-{iteration}.psd'),'format':'PSD'})
            call('create_layer',{'name':'Pixel square'})
            call('select_rectangle',{'left':20,'top':20,'right':60,'bottom':50})
            call('fill_layer',{'red':32,'green':64,'blue':128});call('deselect')
            im=pixels();assert im.getpixel((30,30))[:3]==(32,64,128);passed+=['fill_layer','deselect']
            call('duplicate_layer',{'newName':'Duplicate'})
            assert state()['activeLayer']['name']=='Duplicate' and state()['document']['layerCount']==3
            passed.append('duplicate_layer')
            call('delete_layer');assert state()['document']['layerCount']==2;passed.append('delete_layer')
            call('move_layer',{'deltaX':10,'deltaY':5})
            b=state()['activeLayer']['bounds'];assert b=={'left':30,'top':25,'right':70,'bottom':55},b;passed.append('move_layer')
            call('scale_layer',{'scalePercent':50,'centerAnchor':False})
            b=state()['activeLayer']['bounds'];assert b['right']-b['left']==20 and b['bottom']-b['top']==15,b;passed.append('scale_layer')
            call('rotate_layer',{'degrees':90})
            b=state()['activeLayer']['bounds'];assert abs((b['right']-b['left'])-15)<=1 and abs((b['bottom']-b['top'])-20)<=1,b;passed.append('rotate_layer')
            x=int((b['left']+b['right'])/2);y=int((b['top']+b['bottom'])/2)
            call('invert');im=pixels();assert all(abs(a-b)<=1 for a,b in zip(im.getpixel((x,y))[:3],(223,191,127)));passed.append('invert')
            call('desaturate');im=pixels();p=im.getpixel((x,y));assert p[0]==p[1]==p[2] and 0<p[0]<255;passed.append('desaturate')
            call('apply_gaussian_blur',{'radius':2});blurred=pixels();assert blurred.getpixel((int(b['left']),y))!=im.getpixel((int(b['left']),y));passed.append('apply_gaussian_blur')
            call('select_ellipse',{'left':20,'top':20,'right':60,'bottom':60})
            bounds=call('get_selection_bounds');assert '20' in str(bounds) and '60' in str(bounds),bounds;passed+=['select_ellipse','get_selection_bounds']
            call('expand_selection',{'pixels':4}); expanded=script('var b=app.activeDocument.selection.bounds;return [b[0].as("px"),b[1].as("px"),b[2].as("px"),b[3].as("px")];')
            assert expanded==[16,16,64,64],expanded;passed.append('expand_selection')
            call('contract_selection',{'pixels':4}); contracted=script('var b=app.activeDocument.selection.bounds;return [b[0].as("px"),b[1].as("px"),b[2].as("px"),b[3].as("px")];')
            assert contracted==[20,20,60,60],contracted;passed.append('contract_selection')
            call('feather_selection',{'pixels':3})
            call('create_layer',{'name':'Feathered'});call('fill_layer',{'red':255,'green':0,'blue':0});call('deselect')
            im=pixels();edge=im.getpixel((20,40));assert 0<edge[1]<255,edge;passed.append('feather_selection')
            call('merge_visible_layers');assert state()['document']['layerCount']==1;passed.append('merge_visible_layers')
            call('create_layer',{'name':'To flatten'});call('flatten_image');assert state()['document']['layerCount']==1 and state()['activeLayer']['isBackground'];passed.append('flatten_image')
            call('resize_image',{'width':64,'height':48});assert pixels().size==(64,48);passed.append('resize_image')
            call('crop_document',{'left':4,'top':4,'right':60,'bottom':44});assert pixels().size==(56,40);passed.append('crop_document')
            output=folder/f'final-{iteration}.psd';call('save_document',{'path':str(output),'format':'PSD'});call('close_document',{'save':False})
            anchor=c.state()['details']['documents'][0]['id']; reopened=c.script('return app.open(new File('+json.dumps(str(output))+')).id;',anchor)
            check=c.call('photoshop_get_state',{'document_id':reopened});assert check['document']['width']==56 and check['document']['height']==40 and check['document']['layerCount']==1
            c.call('photoshop_close_document',{'document_id':reopened,'save':False})
            evidence.append({'round':iteration+1,'tools':passed,'pixels_and_structure':True,'save_reopen':True,'output':str(output)})
            (ROOT/'ps-raster-regression.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8');print('RASTER PASS',iteration+1,passed,flush=True)
        if previous in {d['id'] for d in c.state()['details']['documents']}:c.call('photoshop_set_active_document',{'document_id':previous})
    finally:c.close()

if __name__=='__main__':main()
