import sys,json
from pathlib import Path
from boundary_suite import *
directory=Path(sys.argv[1]).resolve()
target=int(sys.argv[2])
assert directory.is_relative_to(ROOT) and directory.name.startswith('acl-save-')
c=Client('ps');results=[]
try:
    assert any(d['id']==target and Path(d.get('path') or '').resolve().is_relative_to(ROOT) for d in c.state()['details']['documents'])
    for iteration in range(3):
        output=directory/f'round-{iteration+1}.psd'
        result=c.call('photoshop_save_document',{'document_id':target,'path':str(output),'format':'PSD'},error=True)
        assert any(code in str(result) for code in ('EPERM','EACCES')),result
        assert not output.exists() and not list(directory.iterdir())
        results.append(dict(round=iteration+1,is_error=True,permission_failure=True,no_partial_files=True,response=result))
    (ROOT/'ps-readonly-save.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Permission-denied save: three rounds, no output files.',flush=True)
finally:c.close()
