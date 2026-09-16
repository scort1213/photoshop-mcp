"""Three-round PS PNG/JPEG export + Adobe reopen, only on a test target."""
from boundary_suite import *
from PIL import Image, ImageChops, ImageStat

def main(target):
    c=Client('ps');results=[]
    directory=ROOT/f'ps-flat-export-{time.time_ns()}'
    directory.mkdir()
    try:
        # Waiting for readiness only retries read-only calls that Adobe has
        # explicitly rejected. No edit/open/save/close operation is retried.
        ready_deadline=time.monotonic()+60
        while True:
            try:
                initial=c.state()['details']
                break
            except AssertionError as error:
                if 'application_busy' not in str(error) or time.monotonic()>=ready_deadline:
                    raise
                time.sleep(3)
        previous=initial['active_document_id']
        source=next(d for d in initial['documents'] if d['id']==target)
        assert Path(source.get('path') or '').resolve().is_relative_to(ROOT)
        baseline=c.call('photoshop_get_state',{'document_id':target})
        for iteration in range(3):
            paths={kind:directory/f'round-{iteration+1}.{extension}' for kind,extension in [('PNG','png'),('JPEG','jpg')]}
            for kind,path in paths.items():
                c.call('photoshop_save_document',{'document_id':target,'path':str(path),'format':kind,'quality':8})
                with Image.open(path) as image:
                    image.load()
                    assert image.size==(int(source['width']),int(source['height'])),image.size
                    assert image.format==kind,image.format
                opened=c.script('return app.open(new File('+json.dumps(path.as_posix())+')).id;',target)
                assert isinstance(opened,int) and opened!=target
                state=c.call('photoshop_get_state',{'document_id':opened})
                assert Path(state['document']['path']).resolve()==path.resolve()
                assert state['document']['width']==source['width'] and state['document']['height']==source['height']
                c.call('photoshop_close_document',{'document_id':opened,'save':False})
            with Image.open(paths['PNG']) as png,Image.open(paths['JPEG']) as jpeg:
                rgba=png.convert('RGBA')
                extrema=rgba.getchannel('A').getextrema()
                assert extrema==(0,255),extrema
                expected=Image.alpha_composite(Image.new('RGBA',rgba.size,'white'),rgba).convert('RGB')
                actual=jpeg.convert('RGB')
                error=ImageStat.Stat(ImageChops.difference(expected,actual)).mean
                assert max(error)<5,error
                assert min(low for low,high in actual.getextrema())<128, 'JPEG unexpectedly blank'
            after=c.call('photoshop_get_state',{'document_id':target})
            assert after==baseline, 'source document state changed during export/reopen'
            results.append(dict(round=iteration+1,paths={k:str(v) for k,v in paths.items()},alpha_extrema=extrema,
                                jpeg_mean_absolute_error=error,adobe_reopen=True,source_state_unchanged=True))
            (ROOT/'ps-flat-exports.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
        current=c.state()['details']
        if current['active_document_id']==target and previous in {d['id'] for d in current['documents']}:
            c.call('photoshop_set_active_document',{'document_id':previous})
        print('PNG/JPEG export and Adobe reopen passed three rounds.',flush=True)
    finally:c.close()

if __name__=='__main__':main(int(sys.argv[1]))
