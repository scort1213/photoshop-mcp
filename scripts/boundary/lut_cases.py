"""A known invert cube must affect actual pixels, not merely create a layer."""
from boundary_suite import *
from PIL import Image

def main():
    c=Client('ps');folder=ROOT/('lut-'+str(time.time_ns()));folder.mkdir();results=[]
    lut=folder/'invert.cube'
    lut.write_text('TITLE "Boundary invert"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n'+'\n'.join(f'{1-r} {1-g} {1-b}' for b in (0,1) for g in (0,1) for r in (0,1)),encoding='ascii')
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            target=c.script("var d=app.documents.add(64,64,72,'BOUNDARY LUT',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);var color=new SolidColor();color.rgb.red=40;color.rgb.green=100;color.rgb.blue=180;d.selection.selectAll();d.selection.fill(color);d.selection.deselect();return d.id;",anchor)
            def call(name,args):return c.call('photoshop_'+name,dict(args,document_id=target))
            refusing='--expect-refusal' in sys.argv
            if refusing:
                error=c.call('photoshop_apply_lut',{'lut':str(lut),'document_id':target},error=True)
                assert 'partial_completion' in str(error),error
                state=c.call('photoshop_get_state',{'document_id':target})
                assert state['document']['layerCount']==2
                blocked=c.call('photoshop_rename_layer',{'document_id':target,'name':'MUST NOT RUN'},error=True)
                assert 'outcome_unknown' in str(blocked) or 'recovery' in str(blocked),blocked
                recover(c)
            else:call('apply_lut',{'lut':str(lut)})
            def render(label):
                p=folder/f'{iteration}-{label}.png';call('save_document',{'path':str(p),'format':'PNG'})
                with Image.open(p) as im:return im.convert('RGB')
            im=render('result');pixel=im.getpixel((32,32))
            expected=(40,100,180) if refusing else (215,155,75)
            assert max(abs(a-b) for a,b in zip(pixel,expected))<=2,pixel
            assert c.script('return app.activeDocument.layers.length;',target)==2
            path=folder/f'{iteration}.psd';call('save_document',{'path':str(path),'format':'PSD'});call('close_document',{'save':False})
            target=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',anchor)
            assert render('reopen').tobytes()==im.tobytes()
            call('close_document',{'save':False})
            results.append({'round':iteration+1,'pixel':pixel,'reopen_exact':True,'refusal_only':refusing})
            (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,'LUT refusal only' if refusing else 'LUT rendering',pixel,flush=True)
    finally:c.close()

if __name__=='__main__':main()
