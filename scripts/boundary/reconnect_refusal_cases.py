"""Ten fresh MCP connections and three rounds of PS23 generative refusals."""
from boundary_suite import *


def main():
    results = []
    initial = None
    for iteration in range(10):
        c = Client('ps')
        try:
            documents = c.state()['details']['documents']
            if initial is None:
                initial = [{k: d[k] for k in ('id', 'name', 'saved', 'width', 'height', 'path')} for d in documents]
                target = next(d['id'] for d in documents if d['name'].startswith('BOUNDARY'))
            current = [{k: d[k] for k in ('id', 'name', 'saved', 'width', 'height', 'path')} for d in documents]
            assert current == initial, 'document inventory changed; stop for inspection'
            before = c.call('photoshop_get_state', {'document_id': target})
            codes = {}
            if iteration < 3:
                cases = {
                    'generate_image': {'prompt': 'boundary test'},
                    'generative_fill': {'prompt': 'boundary test'},
                    'generative_remove': {},
                    'generative_expand': {'direction': 'all'},
                    'generative_upscale': {'target_scale': 2},
                }
                for name, args in cases.items():
                    result = c.call('photoshop_' + name, dict(args, document_id=target), error=True)
                    assert result['code'] == 'version_unsupported', result
                    codes[name] = result['code']
                assert c.call('photoshop_get_state', {'document_id': target}) == before
            results.append({'connection': iteration + 1, 'target': target, 'read_success': True, 'refusals': codes})
            (ROOT / 'reconnect-refusal-results.json').write_text(json.dumps(results, indent=2), encoding='utf8')
            print('PASS connection', iteration + 1, 'refusals', len(codes), flush=True)
        finally:
            c.close()


if __name__ == '__main__':
    main()
