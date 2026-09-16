"""Real Illustrator cases, run after soak and only on dedicated copies."""
import json
import sys
from pathlib import Path
from PIL import Image

from boundary_suite import Client, ROOT, assert_test_documents, recover
from real_fixtures import resources

def literal(path):
    return json.dumps(str(path).replace('\\','/'))

def main():
    resources()
    c=Client('ai')
    passed=[]
    report={'passed':passed,'complete':False}
    case=ROOT/('ai-content-round-'+(sys.argv[1] if len(sys.argv)>1 else '1'))
    case.mkdir(exist_ok=False)
    target=case/'多画板 中文测试.ai'
    linked=case/'链接图片 中文🧪.png'
    displaced=case/'链接图片 temporarily-unavailable.png'
    text='中文 🧪 "引号"\r第二行'
    if target.exists() or linked.exists() or displaced.exists():
        c.close()
        raise FileExistsError('Use fresh content fixture names; refusing to overwrite')
    Image.new('RGB',(32,32),(20,100,220)).save(linked)
    try:
        assert_test_documents(c)
        anchor=json.loads((ROOT/'ai-smoke.json').read_text(encoding='utf-8'))['target']
        c.script('var d=app.documents.add(DocumentColorSpace.RGB,320,240);d.saveAs(new File('+literal(target)+'));"created";',anchor)
        c.script('''var d=app.activeDocument;
            d.artboards.add([320,240,640,0]);
            var layer=d.layers[0]; layer.name='内容测试';
            var group=layer.groupItems.add();group.name='剪切组';
            var shape=group.pathItems.ellipse(200,40,100,100);shape.name='圆形';
            var color=new RGBColor();color.red=20;color.green=100;color.blue=220;
            shape.filled=true;shape.fillColor=color;shape.stroked=false;
            var mask=group.pathItems.rectangle(190,50,70,70);mask.name='剪切路径';mask.clipping=true;group.clipped=true;
            var t=layer.textFrames.add();t.name='可编辑中文';t.contents='''+json.dumps(text)+''';t.position=[20,60];
            var placed=layer.placedItems.add();placed.name='外部链接';placed.file=new File('''+literal(linked)+''');placed.position=[180,200];
            d.artboards.setActiveArtboardIndex(0);d.save();'prepared';''',str(target))
        assert c.script('app.activeDocument.textFrames[0].contents;',str(target))==text
        assert c.script('String(app.activeDocument.artboards.length)+","+String(app.activeDocument.groupItems[0].clipped);',str(target))=='2,true'
        passed.append('multiple-artboards-clipping-group-editable-Unicode')
        counts=c.script('var d=app.activeDocument;[d.layers.length,d.pageItems.length,d.textFrames.length,d.artboards.length].join(",");',str(target))
        c.script('app.textFonts.getByName("BOUNDARY_FONT_DOES_NOT_EXIST");',str(target),error=True)
        recover(c)
        assert c.script('var d=app.activeDocument;[d.layers.length,d.pageItems.length,d.textFrames.length,d.artboards.length].join(",");',str(target))==counts
        passed.append('missing-font-error-no-new-object')
        # Only rename the synthetic link created above, never user assets.
        assert linked.resolve().is_relative_to(ROOT.resolve())
        linked.rename(displaced)
        try:
            state=c.state()
            doc=next(d for d in state['documents'] if Path(d['path']).resolve()==target.resolve())
            assert doc['linked_items'][0]['status'] in ('missing','missing_or_unavailable'),doc
        finally:
            displaced.rename(linked)
        state=c.state()
        doc=next(d for d in state['documents'] if Path(d['path']).resolve()==target.resolve())
        assert doc['linked_items'][0]['status']=='available',doc
        passed.append('missing-linked-image-detected-and-restored')
        png=case/'内容导出.png'
        jpg=case/'内容导出.jpg'
        assert not png.exists() and not jpg.exists()
        c.script('var d=app.activeDocument;var p=new ExportOptionsPNG24();p.artBoardClipping=true;p.transparency=true;p.horizontalScale=100;p.verticalScale=100;d.exportFile(new File('+literal(png)+'),ExportType.PNG24,p);var j=new ExportOptionsJPEG();j.artBoardClipping=true;j.qualitySetting=80;j.horizontalScale=100;j.verticalScale=100;d.exportFile(new File('+literal(jpg)+'),ExportType.JPEG,j);"exported";',str(target))
        with Image.open(png) as im:
            assert im.size==(320,240),im.size
            assert im.convert('RGBA').getpixel((0,0))[3]==0
        with Image.open(jpg) as im:
            assert im.size==(320,240),im.size
            assert im.mode=='RGB',im.mode
        passed.append('PNG-alpha-and-JPEG-dimensions')
        c.script('app.activeDocument.save();app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);"closed";',str(target))
        c.script('app.open(new File('+literal(target)+'));"opened";',anchor)
        assert c.script('app.activeDocument.textFrames[0].contents;',str(target))==text
        assert c.script('var d=app.activeDocument;[d.layers.length,d.pageItems.length,d.textFrames.length,d.artboards.length].join(",");',str(target))==counts
        assert c.script('String(app.activeDocument.groupItems[0].clipped);',str(target)) is True
        passed.append('AI-save-close-reopen-content-preserved')
        if '--skip-preview' in sys.argv:
            report['preview']='not_verified'
        else:
            c.call('view')
            report['preview']='passed'
        c.script('app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);"closed";',str(target))
        report['complete']=True
        print('AI CONTENT PASS',passed,flush=True)
    except Exception as error:
        report['failure']=str(error)
        raise
    finally:
        (case/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        c.close()

if __name__=='__main__':main()
