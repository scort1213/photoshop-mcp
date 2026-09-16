"""Selection/channel/mask/clip tests with exported alpha postconditions."""
from boundary_suite import *
from real_fixtures import resources
from PIL import Image

def main():
    c=Client('ps');folder=ROOT/('selection-masks-'+str(time.time_ns()));folder.mkdir();results=[]
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            resources();passed=[];serial=0
            target=c.script("return app.documents.add(128,96,72,'BOUNDARY masks',NewDocumentMode.RGB,DocumentFill.TRANSPARENT).id;",anchor)
            def call(name,args=None):return c.call('photoshop_'+name,dict(args or {},document_id=target))
            def script(code):return c.script(code,target)
            def pixels():
                nonlocal serial
                serial+=1;p=folder/f'{iteration}-{serial}.png';call('save_document',{'path':str(p),'format':'PNG'})
                with Image.open(p) as im:return im.convert('RGBA')
            call('select_all')
            assert script('var b=app.activeDocument.selection.bounds;return [b[0].as("px"),b[1].as("px"),b[2].as("px"),b[3].as("px")];')==[0,0,128,96]
            passed.append('select_all');call('deselect')
            call('select_rectangle',{'left':32,'top':24,'right':96,'bottom':72})
            call('save_selection',{'channel_name':'选区 "中文"'})
            assert script('return app.activeDocument.channels[app.activeDocument.channels.length-1].name;')=='选区 "中文"'
            passed.append('save_selection')
            call('invert_selection');call('fill_layer',{'red':20,'green':180,'blue':30});call('deselect')
            im=pixels();assert im.getpixel((10,10))==(20,180,30,255) and im.getpixel((64,48))[3]==0;passed.append('invert_selection')
            call('select_all');call('fill_layer',{'red':20,'green':180,'blue':30});call('deselect')
            call('select_rectangle',{'left':32,'top':24,'right':96,'bottom':72});call('create_layer_mask');call('deselect')
            im=pixels();assert im.getpixel((10,10))[3]==0 and im.getpixel((64,48))[3]==255
            call('delete_layer_mask');im=pixels();assert im.getpixel((10,10))[3]==255;passed.append('delete_layer_mask')
            call('select_rectangle',{'left':32,'top':24,'right':96,'bottom':72});call('create_layer_mask');call('deselect')
            call('apply_layer_mask');im=pixels();assert im.getpixel((10,10))[3]==0 and im.getpixel((64,48))[3]==255;passed.append('apply_layer_mask')
            call('create_layer',{'name':'Clip top'});call('fill_layer',{'red':180,'green':30,'blue':20})
            call('create_clipping_mask');assert script('return app.activeDocument.activeLayer.grouped;') is True
            im=pixels();assert im.getpixel((10,10))[3]==0 and im.getpixel((64,48))==(180,30,20,255);passed.append('create_clipping_mask')
            call('release_clipping_mask');assert script('return app.activeDocument.activeLayer.grouped;') is False
            im=pixels();assert im.getpixel((10,10))==(180,30,20,255);passed.append('release_clipping_mask')
            # Hide the base so its pixels cannot conceal a missing gradient alpha.
            script('app.activeDocument.layers[1].visible=false;return true;')
            if iteration % 2: call('create_layer_mask')
            call('apply_gradient_mask',{'direction':'left_to_right','start_pct':0,'end_pct':100})
            im=pixels();alpha=[im.getpixel((x,48))[3] for x in (4,32,64,96,123)]
            assert alpha[-1]-alpha[0]>200 and all(alpha[i]<=alpha[i+1] for i in range(4)),alpha
            assert im.getpixel((96,48))[:3]==(180,30,20)
            passed.append('apply_gradient_mask')
            output=folder/f'{iteration}-masks.psd';call('save_document',{'path':str(output),'format':'PSD'});call('close_document',{'save':False})
            target=c.script('return app.open(new File('+json.dumps(str(output))+')).id;',anchor)
            assert pixels().tobytes()==im.tobytes()
            assert script('return app.activeDocument.channels[app.activeDocument.channels.length-1].name;')=='选区 "中文"'
            call('close_document',{'save':False})
            results.append({'round':iteration+1,'tools':passed,'alpha_samples':alpha,'save_reopen_pixels':True})
            (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,passed,flush=True)
    finally:c.close()

if __name__=='__main__':main()
