"""Batch output counts/pixels, duplicate basenames and stop-after-failure."""
from boundary_suite import *
from PIL import Image

def main():
    folder=ROOT/('batch-recipes-'+str(time.time_ns()));folder.mkdir()
    os.environ['PHOTOSHOP_MCP_HOME']=str(folder/'mcp-home')
    c=Client('ps');results=[];assets=folder/'assets';assets.mkdir()
    Image.new('RGB',(128,96),(180,30,20)).save(assets/'same.png')
    Image.new('RGB',(128,96),(20,160,30)).save(assets/'same.jpg',quality=100)
    logo=folder/'logo.png';Image.new('RGBA',(4,4),'white').save(logo)
    hashes={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in assets.iterdir()}
    broken=folder/'broken';broken.mkdir()
    Image.new('RGB',(128,96),(20,160,30)).save(broken/'a-good.png')
    (broken/'b-broken.png').write_bytes(b'not an image')
    Image.new('RGB',(128,96),(180,30,20)).save(broken/'c-must-not-run.png')
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            args={'assets_dir':str(assets),'logo_path':str(logo),'scale_pct':20,'margin_px':4,'opacity':100,'document_id':anchor}
            ids={d['id'] for d in c.state()['details']['documents']}
            result=c.call('photoshop_recipe_batch_watermark',args)
            assert len(set(result['output_paths']))==2
            for output in result['output_paths']:
                with Image.open(output) as im:
                    assert im.size==(128,96)
                    assert min(im.getpixel((110,80)))>245,'Missing watermark'
                    assert max(im.getpixel((5,5)))-min(im.getpixel((5,5)))>100
            current=c.state()['details']['documents']
            assert ids.issubset({d['id'] for d in current})
            assert not any(d['path'] and Path(d['path']).parent==assets for d in current),'Batch source leaked'
            target=c.script("return app.documents.add(128,96,72,'BOUNDARY mockup',NewDocumentMode.RGB,DocumentFill.TRANSPARENT).id;",anchor)
            c.call('photoshop_place_image',{'document_id':target,'filePath':str(assets/'same.png')})
            c.call('photoshop_rename_layer',{'document_id':target,'name':'Design'})
            result=c.call('photoshop_recipe_batch_mockup_replace',{'document_id':target,'smart_object_layer_name':'Design','assets_dir':str(assets)})
            assert len(set(result['output_paths']))==2
            for output,expected in zip(result['output_paths'],[(20,160,30),(180,30,20)]):
                with Image.open(output) as im:assert max(abs(a-b) for a,b in zip(im.getpixel((64,48)),expected))<=3
            c.call('photoshop_undo',{'document_id':target,'steps':1})
            p=folder/f'{iteration}-undo.png';c.call('photoshop_save_document',{'document_id':target,'path':str(p),'format':'PNG'})
            with Image.open(p) as im:assert im.convert('RGB').getpixel((64,48))==(180,30,20)
            c.call('photoshop_close_document',{'document_id':target,'save':False})
            before=set((folder/'mcp-home'/'exports').glob('*.jpg'))
            error=c.call('photoshop_recipe_batch_watermark',dict(args,assets_dir=str(broken)),error=True)
            assert 'partial_completion' in str(error),error
            after=set((folder/'mcp-home'/'exports').glob('*.jpg'));new=after-before
            assert len(new)==1 and 'a-good' in next(iter(new)).name,new
            current=c.state()['details']['documents']
            assert ids.issubset({d['id'] for d in current})
            assert not any(d['path'] and Path(d['path']).parent==broken for d in current),'Failed batch source leaked'
            recover(c)
            assert {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in assets.iterdir()}==hashes
            results.append({'round':iteration+1,'watermark_pixels':True,'mockup_variant_pixels':True,'unique_same_basename_outputs':True,'failure_stops_next_job':True,'original_hashes_unchanged':True})
            (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,'batch recipes and partial failure',flush=True)
    finally:c.close()

if __name__=='__main__':main()
