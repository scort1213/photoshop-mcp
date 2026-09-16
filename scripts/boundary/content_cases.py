"""Bounded functional cases on a 256px synthetic document; not a load test."""
from boundary_suite import *

def main():
    c=Client('ps');created=None;passed=[];complete=False;failure=None
    try:
        assert_test_documents(c)
        state=c.state()['details'];anchor=state['active_document_id']
        created=c.script("var d=app.documents.add(256,256,72,'Boundary functional',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);d.activeLayer.name='PixelBase';var color=new SolidColor();color.rgb.red=255;color.rgb.green=0;color.rgb.blue=0;d.selection.selectAll();d.selection.fill(color);d.selection.deselect();return d.id;",anchor)
        c.call('photoshop_select_rectangle',{'document_id':created,'left':0,'top':0,'right':128,'bottom':128})
        c.call('photoshop_create_layer_mask',{'document_id':created})
        image_path=ROOT/'mask-functional.png'
        c.call('photoshop_save_document',{'document_id':created,'path':str(image_path),'format':'PNG','overwrite':True})
        # Pillow is installed in the Illustrator venv; use that interpreter for pixel assertions.
        check="from PIL import Image;im=Image.open("+repr(str(image_path))+").convert('RGBA');assert im.size==(256,256);assert im.getpixel((64,64))==(255,0,0,255);assert im.getpixel((200,200))[3]==0;print('mask pixels verified')"
        subprocess.run([AI_PY,'-c',check],check=True,capture_output=True)
        passed.append('selection-mask-PNG-alpha-pixels')
        c.script("var d=app.activeDocument;d.artLayers.add().name='duplicate';var g=d.layerSets.add();g.name='Nested';g.artLayers.add().name='duplicate';return d.activeLayer.id;",created)
        before=c.call('photoshop_get_state',{'document_id':created})['activeLayer']['id']
        c.call('photoshop_select_layer_by_name',{'document_id':created,'name':'duplicate'},error=True)
        assert c.call('photoshop_get_state',{'document_id':created})['activeLayer']['id']==before
        recover(c);passed.append('duplicate-layer-no-retarget')
        c.call('photoshop_select_layer_by_name',{'document_id':created,'name':'PixelBase'})
        c.call('photoshop_set_layer_locked',{'document_id':created,'locked':True})
        c.call('photoshop_apply_gaussian_blur',{'document_id':created,'radius':2},error=True)
        recover(c)
        assert c.call('photoshop_get_state',{'document_id':created})['activeLayer']['locked']
        c.call('photoshop_set_layer_locked',{'document_id':created,'locked':False})
        c.call('photoshop_set_layer_visibility',{'document_id':created,'visible':False})
        assert not c.call('photoshop_get_state',{'document_id':created})['activeLayer']['visible']
        c.call('photoshop_set_layer_visibility',{'document_id':created,'visible':True})
        c.call('photoshop_convert_to_smart_object',{'document_id':created})
        assert c.call('photoshop_get_state',{'document_id':created})['activeLayer']['kind']=='LayerKind.SMARTOBJECT'
        passed.append('locked-hidden-smart-object')
        before=c.call('photoshop_get_state',{'document_id':created})['document']['layerCount']
        c.call('photoshop_create_text_layer',{'document_id':created,'text':'must not create','fontName':'MCP_FONT_DOES_NOT_EXIST'},error=True)
        assert c.call('photoshop_get_state',{'document_id':created})['document']['layerCount']==before
        recover(c)
        text='中文 🧪 "引号"\r第二行'
        c.call('photoshop_create_text_layer',{'document_id':created,'text':text,'x':0,'y':0,'fontSize':24})
        assert c.script('return app.activeDocument.activeLayer.textItem.contents;',created)==text
        # PS 23.0 can reject textItem.position on this multiline/emoji layer.
        # Compare rendered bounds of identical text at x=0 and x=100 instead.
        zero_left=c.call('photoshop_get_state',{'document_id':created})['activeLayer']['bounds']['left']
        c.call('photoshop_create_text_layer',{'document_id':created,'text':text,'x':100,'y':0,'fontSize':24})
        shifted_left=c.call('photoshop_get_state',{'document_id':created})['activeLayer']['bounds']['left']
        assert abs(shifted_left-zero_left-100)<.01,(zero_left,shifted_left)
        passed.append('missing-font-no-orphan-and-Unicode-zero-position')
        for mode in ['CMYK','RGB']:
            c.script("app.activeDocument.changeMode(ChangeMode."+mode+");app.activeDocument.bitsPerChannel=BitsPerChannelType.SIXTEEN;return String(app.activeDocument.bitsPerChannel);",created)
            output=ROOT/f'functional-{mode}-16.psd'
            c.call('photoshop_save_document',{'document_id':created,'path':str(output),'format':'PSD','overwrite':True})
            c.call('photoshop_close_document',{'document_id':created,'save':False});created=None
            created=c.script('return app.open(new File('+json.dumps(str(output).replace('\\','/'))+')).id;',anchor)
            assert c.script('return String(app.activeDocument.bitsPerChannel);',created)=='BitsPerChannelType.SIXTEEN'
            assert c.script('return String(app.activeDocument.mode);',created)=='DocumentMode.'+mode
        passed.append('CMYK-RGB-16bit-save-reopen')
        complete=True
        print('CONTENT PASS',passed,flush=True)
    except Exception as error:
        failure=str(error)
        raise
    finally:
        (ROOT/'ps-content-cases.json').write_text(json.dumps({'passed':passed,'complete':complete,'failure':failure},ensure_ascii=False,indent=2),encoding='utf-8')
        try:
            if created is not None:
                # Never close a different document by falling back to the active tab.
                recover(c)
                c.call('photoshop_close_document',{'document_id':created,'save':False})
        finally:c.close()

if __name__=='__main__':main()
