"""Export recipe sizes, ordering, pixels, source state and Adobe reopening."""
from boundary_suite import *
from export_web_cases import SNAP
from PIL import Image,ImageDraw

def main():
    folder=ROOT/('recipe-exports-'+str(time.time_ns()));folder.mkdir()
    os.environ['PHOTOSHOP_MCP_HOME']=str(folder/'mcp-home')
    c=Client('ps');results=[]
    panorama=folder/'panorama.png';im=Image.new('RGB',(192,64));d=ImageDraw.Draw(im)
    colors=[(180,30,20),(20,160,30),(20,40,180)]
    for i,color in enumerate(colors):d.rectangle((i*64,0,(i+1)*64-1,63),fill=color)
    im.save(panorama)
    bottle=folder/'bottle.png';im=Image.new('RGB',(256,256),'white');d=ImageDraw.Draw(im);d.rounded_rectangle((88,65,168,226),radius=15,fill=(20,60,160));d.rectangle((112,30,144,85),fill=(20,60,160));d.rectangle((109,25,147,42),fill=(20,20,20));im.save(bottle)
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            for name,args in [('split_carousel',{'slides':3,'format':'png'}),('export_social_variants',{'platforms':['instagram_post','youtube_thumbnail']}),('passport_photo',{'spec':'us_2x2','make_sheet':True})]:
                source=bottle if name=='passport_photo' else panorama
                digest=hashlib.sha256(source.read_bytes()).hexdigest()
                target=c.script('return app.open(new File('+json.dumps(str(source))+')).id;',anchor)
                before=c.script(SNAP,target);ids={x['id'] for x in c.state()['details']['documents']}
                result=c.call('photoshop_recipe_'+name,dict(args,document_id=target))
                assert c.script(SNAP,target)==before,'Source state changed'
                assert {x['id'] for x in c.state()['details']['documents']}==ids,'Temporary document leaked'
                paths=list(map(Path,result['output_paths']))
                expected_sizes=[(64,64)]*3 if name=='split_carousel' else [(1080,1080),(1280,720)] if name=='export_social_variants' else [(600,600),(1200,1800)]
                assert len(paths)==len(expected_sizes)
                for index,(path,size) in enumerate(zip(paths,expected_sizes)):
                    assert path.is_relative_to(folder),path
                    with Image.open(path) as output:
                        assert output.size==size,(path,output.size)
                        rgb=output.convert('RGB')
                        if name!='passport_photo':
                            expected=colors[index] if name=='split_carousel' else colors[1]
                            assert max(abs(a-b) for a,b in zip(rgb.getpixel((size[0]//2,size[1]//2)),expected))<=3
                        else:
                            assert tuple(round(x) for x in output.info['dpi'])==(300,300)
                            assert min(rgb.getpixel((5,5)))>=250
                            if index==0:assert rgb.getpixel((300,360))[2]>rgb.getpixel((300,360))[0]+70
                            else:
                                for x in (300,900):
                                    for y in (360,960,1560):assert rgb.getpixel((x,y))[2]>rgb.getpixel((x,y))[0]+70
                    opened=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',target)
                    info=c.call('photoshop_get_state',{'document_id':opened})['document'];assert (info['width'],info['height'])==size
                    c.call('photoshop_close_document',{'document_id':opened,'save':False})
                assert hashlib.sha256(source.read_bytes()).hexdigest()==digest
                c.call('photoshop_close_document',{'document_id':target,'save':False})
                results.append({'round':iteration+1,'tool':'photoshop_recipe_'+name,'outputs':list(map(str,paths)),'dimensions_pixels':True,'source_unchanged':True,'adobe_reopen':True})
                (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,name,flush=True)
    finally:c.close()

if __name__=='__main__':main()
