"""PS23 lacks the dataset DOM used by this implementation; reject honestly."""
from boundary_suite import *
import tempfile

def main():
    c=Client('ps');folder=ROOT/('dataset-rejection-'+str(time.time_ns()));folder.mkdir();results=[]
    csv=folder/'中文.csv';csv.write_text('name\n"中文, \\\"quoted\\\""\n',encoding='utf8')
    xml=folder/'input.xml';xml.write_text('<variables/>',encoding='utf8')
    try:
        anchor=c.state()['details']['active_document_id']
        for iteration in range(3):
            target=c.script("return app.documents.add(64,64,72,'BOUNDARY dataset rejection',NewDocumentMode.RGB,DocumentFill.TRANSPARENT).id;",anchor)
            before=c.call('photoshop_get_state',{'document_id':target})
            for name,args in [('list_datasets',{}),('import_datasets',{'xml_path':str(xml)}),('generate_from_datasets',{'output_dir':str(folder/'output'),'dataset_names':['one']}),('recipe_csv_to_cards',{'csv_path':str(csv),'output_dir':str(folder/'output')})]:
                temps=set(Path(tempfile.gettempdir()).glob('photoshop-mcp-datasets-*'))
                error=c.call('photoshop_'+name,dict(args,document_id=target),error=True)
                assert 'unsupported' in str(error).lower(),error
                assert c.call('photoshop_get_state',{'document_id':target})==before
                assert not (folder/'output').exists()
                assert set(Path(tempfile.gettempdir()).glob('photoshop-mcp-datasets-*'))==temps
                recover(c)
            c.call('photoshop_close_document',{'document_id':target,'save':False})
            results.append({'round':iteration+1,'four_tools_refused':True,'unchanged':True,'no_output_or_temp_leaks':True})
            (folder/'results.json').write_text(json.dumps(results,indent=2),encoding='utf8');print('PASS',iteration+1,'dataset rejection only',flush=True)
    finally:c.close()

if __name__=='__main__':main()
