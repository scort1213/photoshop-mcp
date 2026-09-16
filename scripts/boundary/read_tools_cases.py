"""Read/target tool acceptance against an explicitly owned open test document."""
from boundary_suite import *

def main(target):
    c=Client('ps');evidence=[]
    try:
        state=c.state()['details']; previous=state['active_document_id']
        row=next(d for d in state['documents'] if d['id']==target)
        assert Path(row['path']).resolve().is_relative_to(ROOT)
        for i in range(3):
            actual=c.call('photoshop_get_state',{'document_id':target})
            results={}
            for name in ['ping','get_version','get_document_info','get_layers','list_fonts']:
                result=c.call('photoshop_'+name,{'document_id':target})
                results[name]=result
                if i==0: print(name,str(result)[:900],flush=True)
            assert results['ping']=='Successfully connected to Photoshop'
            assert results['get_version']=='Photoshop version: '+c.script('return app.version;',target)
            assert json.loads(results['get_document_info'].split('\n',1)[1])==actual
            layers=json.loads(results['get_layers'].split('\n',1)[1])
            assert layers['context']==actual
            assert layers['layerCount']==actual['document']['layerCount']
            assert actual['activeLayer']['id'] in {l['id'] for l in layers['layers']}
            font_result=json.loads(results['list_fonts'].split('Result: ',1)[1]);fonts=font_result['fonts']
            assert 'AdobeHeitiStd-Regular' in {f['postScriptName'] for f in fonts}
            assert font_result['total']==c.script('return app.fonts.length;',target)
            assert len(fonts)==min(200,font_result['total'])
            assert font_result['truncated']==(font_result['total']>200)
            assert c.call('photoshop_get_state',{'document_id':target})==actual
            c.call('photoshop_set_active_document',{'document_id':previous})
            assert c.state()['details']['active_document_id']==previous
            c.call('photoshop_set_active_document',{'document_id':target})
            assert c.state()['details']['active_document_id']==target
            evidence.append({'round':i+1,'tools':list(results)+['set_active_document'],'document_unchanged':True,'actual_target_verified':True})
            (ROOT/'ps-read-tools-regression.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
        c.call('photoshop_set_active_document',{'document_id':previous})
    finally:c.close()

if __name__=='__main__':main(int(sys.argv[1]))
