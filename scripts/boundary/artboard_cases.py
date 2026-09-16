"""Managed artboard edits on a real private PSD copy; never touches business docs."""
from boundary_suite import *
from real_fixtures import resources

SNAPSHOT = '''
var d=app.activeDocument;
function walk(container){var a=[];for(var i=0;i<container.layers.length;i++){var l=container.layers[i];if(l.name.indexOf('BOUNDARY_ART_')===0)continue;var o={id:l.id,name:l.name,visible:l.visible,opacity:l.opacity};if(l.typename==='LayerSet')o.children=walk(l);a.push(o);}return a;}
var r=new ActionReference();r.putProperty(stringIDToTypeID('property'),stringIDToTypeID('artboards'));r.putIdentifier(stringIDToTypeID('document'),d.id);
var art=executeActionGet(r).getObjectValue(stringIDToTypeID('artboards'));
return {width:d.width.as('px'),height:d.height.as('px'),autoSize:art.getBoolean(stringIDToTypeID('autoExpandEnabled')),layers:walk(d)};
'''

def main():
    c=Client('ps');evidence=[]
    output_dir=ROOT/'artboard-research'/('acceptance-'+str(time.time_ns()))
    output_dir.mkdir(parents=True)
    try:
        resources()
        state=c.state()['details'];previous=state['active_document_id']
        # Caller prepares a disposable copy in this directory before running.
        path=ROOT/'artboard-research'/'probe.psd'
        assert path.is_file()
        target=next((d['id'] for d in state['documents'] if d.get('path')==str(path)),None)
        if target is not None:
            c.call('photoshop_close_document',{'document_id':target,'save':False})
        anchor=next(d['id'] for d in c.state()['details']['documents'])
        target=c.script('return app.open(new File('+json.dumps(str(path))+')).id;',anchor)
        before=c.script(SNAPSHOT,target)
        assert isinstance(before,dict),before
        for i in range(3):
            resources()
            c.call('photoshop_create_layer',{'document_id':target,'name':f'BOUNDARY_ART_empty_{i}'})
            text=f'BOUNDARY_ART_中文 "引号" {i}'
            c.call('photoshop_create_text_layer',{'document_id':target,'text':text,'x':100,'y':150,'fontSize':28})
            name=f'BOUNDARY_ART_text_{i}'
            c.call('photoshop_rename_layer',{'document_id':target,'name':name})
            c.call('photoshop_select_layer_by_name',{'document_id':target,'name':name})
            c.call('photoshop_set_layer_opacity',{'document_id':target,'opacity':70})
            c.call('photoshop_set_layer_blend_mode',{'document_id':target,'blendMode':'MULTIPLY'})
            c.call('photoshop_set_layer_visibility',{'document_id':target,'visible':False})
            assert c.call('photoshop_get_state',{'document_id':target})['activeLayer']['visible'] is False
            c.call('photoshop_set_layer_visibility',{'document_id':target,'visible':True})
            c.call('photoshop_set_layer_locked',{'document_id':target,'locked':True})
            assert c.call('photoshop_get_state',{'document_id':target})['activeLayer']['locked'] is True
            c.call('photoshop_set_layer_locked',{'document_id':target,'locked':False})
            text+=' updated'
            c.call('photoshop_update_text_content',{'document_id':target,'text':text})
            font=c.script('return app.activeDocument.activeLayer.textItem.font;',target)
            c.call('photoshop_set_text_font',{'document_id':target,'fontName':font,'fontSize':36})
            c.call('photoshop_set_text_color',{'document_id':target,'red':32,'green':64,'blue':128})
            c.call('photoshop_set_text_alignment',{'document_id':target,'alignment':'CENTER'})
            observed=c.script("var l=app.activeDocument.activeLayer,t=l.textItem;return {name:l.name,opacity:l.opacity,blend:String(l.blendMode),text:t.contents,font:t.font,size:t.size.as('pt'),color:[Math.round(t.color.rgb.red),Math.round(t.color.rgb.green),Math.round(t.color.rgb.blue)],alignment:String(t.justification)};",target)
            assert observed['name']==name and abs(observed['opacity']-70)<0.5 and observed['blend']=='BlendMode.MULTIPLY',observed
            assert observed['text']==text and observed['font']==font and observed['size']==36 and observed['color']==[32,64,128] and observed['alignment']=='Justification.CENTER',observed
            assert c.script(SNAPSHOT,target)==before, 'original layers or dimensions changed'
            output=output_dir/f'round-{i+1}.psd'
            assert not output.exists()
            c.call('photoshop_save_document',{'document_id':target,'path':str(output),'format':'PSD'})
            c.call('photoshop_close_document',{'document_id':target,'save':False})
            target=c.script('return app.open(new File('+json.dumps(str(output))+')).id;',anchor)
            assert c.script(SNAPSHOT,target)==before, 'saved/reopened original structure changed'
            assert c.script('return app.activeDocument.activeLayer.textItem.contents;',target)==text
            c.call('photoshop_get_preview',{'document_id':target,'max_dimension_px':1000})
            evidence.append({'round':i+1,'source_layers_unchanged':True,'canvas':[before['width'],before['height']],'auto_size_restored':True,'editable_text':text,'properties':observed,'save_close_reopen':True,'output':str(output)})
            (ROOT/'ps-artboard-edit-regression.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
            print('ARTBOARD ROUND',i+1,'PASS',flush=True)
        c.call('photoshop_close_document',{'document_id':target,'save':False})
        if previous in {d['id'] for d in c.state()['details']['documents']}:
            c.call('photoshop_set_active_document',{'document_id':previous})
    finally:c.close()

if __name__=='__main__':main()
