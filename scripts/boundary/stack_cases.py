"""Known-color statistical stacks with original-file hashes and PSD reopening."""
from boundary_suite import *
from PIL import Image

def main():
    c=Client('ps');folder=ROOT/('stack-'+str(time.time_ns()));folder.mkdir();results=[]
    files=[]
    for i,color in enumerate([(20,40,60),(100,120,140),(180,200,220)]):
        p=folder/f'输入-{i}.png';Image.new('RGB',(64,48),color).save(p);files.append(p)
    hashes=[hashlib.sha256(p.read_bytes()).hexdigest() for p in files]
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            for mode,expected in [('mean',(100,120,140)),('median',(100,120,140)),('minimum',(20,40,60)),('maximum',(180,200,220))]:
                ids={d['id'] for d in c.state()['details']['documents']}
                c.call('photoshop_image_stack',{'document_id':anchor,'files':list(map(str,files)),'mode':mode})
                rows=c.state()['details']['documents'];new=[d for d in rows if d['id'] not in ids];assert len(new)==1,new
                target=new[0]['id']
                def call(name,args):return c.call('photoshop_'+name,dict(args,document_id=target))
                def render(label):
                    path=folder/f'{iteration}-{mode}-{label}.png';call('save_document',{'path':str(path),'format':'PNG'})
                    with Image.open(path) as im:return im.convert('RGB')
                pixels=render('result');assert max(abs(a-b) for a,b in zip(pixels.getpixel((32,24)),expected))<=1,(mode,pixels.getpixel((32,24)))
                assert c.script('return String(app.activeDocument.activeLayer.kind);',target)=='LayerKind.SMARTOBJECT'
                path=folder/f'{iteration}-{mode}.psd';call('save_document',{'path':str(path),'format':'PSD'});call('close_document',{'save':False})
                target=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',anchor)
                assert render('reopen').tobytes()==pixels.tobytes();call('close_document',{'save':False})
                assert [hashlib.sha256(p.read_bytes()).hexdigest() for p in files]==hashes
                results.append({'round':iteration+1,'mode':mode,'expected':expected,'source_hashes_unchanged':True,'reopen_exact':True})
                (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,mode,flush=True)
    finally:c.close()

if __name__=='__main__':main()
