"""Destructive artboard tools must produce a verified current-state recovery copy."""
from boundary_suite import *
from real_fixtures import resources
import re
from PIL import Image, ImageChops

SNAP='''var doc=app.activeDocument;var boards=[];for(var i=0;i<doc.layerSets.length;i++){var l=doc.layerSets[i],r=new ActionReference();r.putIdentifier(charIDToTypeID('Lyr '),l.id);var d=executeActionGet(r);if(d.hasKey(stringIDToTypeID('artboard'))){var q=d.getObjectValue(stringIDToTypeID('artboard')).getObjectValue(stringIDToTypeID('artboardRect'));boards.push([l.id,q.getDouble(stringIDToTypeID('left')),q.getDouble(stringIDToTypeID('top')),q.getDouble(stringIDToTypeID('right')),q.getDouble(stringIDToTypeID('bottom'))]);}}return {width:doc.width.as('px'),height:doc.height.as('px'),layers:doc.layers.length,boards:boards};'''
CREATE='''var doc=app.documents.add(320,200,72,'BOUNDARY artboard geometry',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);
function board(name,left,right){var d=new ActionDescriptor(),r=new ActionReference();r.putClass(stringIDToTypeID('artboardSection'));d.putReference(charIDToTypeID('null'),r);d.putString(charIDToTypeID('Nm  '),name);var rect=new ActionDescriptor();rect.putDouble(stringIDToTypeID('top'),0);rect.putDouble(stringIDToTypeID('left'),left);rect.putDouble(stringIDToTypeID('bottom'),200);rect.putDouble(stringIDToTypeID('right'),right);d.putObject(stringIDToTypeID('artboardRect'),stringIDToTypeID('classFloatRect'),rect);executeAction(charIDToTypeID('Mk  '),d,DialogModes.NO);var group=doc.activeLayer;var layer=group.artLayers.add();doc.activeLayer=layer;var color=new SolidColor();color.rgb.red=left?20:160;color.rgb.green=80;color.rgb.blue=left?200:40;doc.selection.select([[left,0],[right,0],[right,200],[left,200]]);doc.selection.fill(color);doc.selection.deselect();layer.name='UNSAVED recovery content';}
board('First',0,320);board('Second',400,720);return doc.id;'''

def main():
    c=Client('ps'); results=[];folder=ROOT/('artboard-geometry-'+str(time.time_ns()));folder.mkdir()
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            for name,args in [('resize_image',{'width':360,'height':100}),('crop_document',{'left':20,'top':20,'right':700,'bottom':180}),('merge_visible_layers',{}),('flatten_image',{})]:
                resources()
                target=c.script(CREATE,anchor)
                before=c.script(SNAP,target)
                assert before['width']>=720 and before['height']==200 and len(before['boards'])==2,before
                original_png=folder/f'{iteration}-{name}-before.png'
                c.call('photoshop_save_document',{'document_id':target,'path':str(original_png),'format':'PNG'})
                with Image.open(original_png) as im: original_pixels=im.convert('RGBA')
                response=c.call('photoshop_'+name,dict(args,document_id=target))
                match=re.search(r'Verified recovery backup: ([^\r\n]+)',str(response));assert match,response
                backup=Path(match.group(1));assert backup.is_file()
                after=c.script(SNAP,target)
                expected=(360,100) if name=='resize_image' else (680,160) if name=='crop_document' else (before['width'],before['height'])
                assert (after['width'],after['height'])==expected,after
                if name in ('merge_visible_layers','flatten_image'):assert after['layers']==1 and not after['boards'],after
                else:assert len(after['boards'])==2,after
                restored=c.script('return app.open(new File('+json.dumps(str(backup))+')).id;',target)
                assert c.script(SNAP,restored)==before
                assert c.script('return app.activeDocument.layerSets[0].artLayers[0].name;',restored)=='UNSAVED recovery content'
                c.call('photoshop_close_document',{'document_id':restored,'save':False})
                output=folder/f'{iteration}-{name}.psd'
                c.call('photoshop_save_document',{'document_id':target,'path':str(output),'format':'PSD'})
                c.call('photoshop_close_document',{'document_id':target,'save':False})
                opened=c.script('return app.open(new File('+json.dumps(str(output))+')).id;',anchor)
                assert c.script(SNAP,opened)==after
                result_png=folder/f'{iteration}-{name}-after.png'
                c.call('photoshop_save_document',{'document_id':opened,'path':str(result_png),'format':'PNG'})
                with Image.open(result_png) as im: result_pixels=im.convert('RGBA')
                expected_pixels=original_pixels
                if name=='resize_image': expected_pixels=original_pixels.resize(expected,Image.Resampling.NEAREST)
                elif name=='crop_document': expected_pixels=original_pixels.crop((20,20,700,180))
                elif name=='flatten_image':
                    expected_pixels=Image.new('RGBA',original_pixels.size,'white')
                    expected_pixels.alpha_composite(original_pixels)
                assert result_pixels.size==expected_pixels.size,(result_pixels.size,expected_pixels.size)
                if name=='resize_image':
                    # Compare interior patches; PS resampling can differ at edges.
                    for x,y in [(10,25),(30,60),(170,50),(230,75),(320,40)]:
                        assert max(abs(a-b) for a,b in zip(result_pixels.getpixel((x,y)),expected_pixels.getpixel((x,y))))<=1
                else:
                    difference=ImageChops.difference(result_pixels,expected_pixels)
                    assert all(high<=1 for low,high in difference.getextrema()),difference.getextrema()
                c.call('photoshop_get_preview',{'document_id':opened,'max_dimension_px':720})
                c.call('photoshop_close_document',{'document_id':opened,'save':False})
                results.append({'round':iteration+1,'tool':name,'before':before,'after':after,'backup':str(backup),'unsaved_content_recovered':True,'save_reopen':True,'pixels_checked':True})
                (ROOT/'artboard-geometry-results.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
                print('PASS',iteration+1,name,flush=True)
    finally:c.close()

if __name__=='__main__':main()
