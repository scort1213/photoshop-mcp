"""Three real rounds of angle overrides, alpha measurements, and PSD reopen."""
from boundary_suite import *
from PIL import Image
import math


def main():
    c = Client('ps')
    folder = ROOT / ('gradient-angles-' + str(time.time_ns()))
    folder.mkdir()
    results = []
    try:
        anchor = c.state()['details']['active_document_id']
        # Photoshop's mask gradient has a tone curve, not linear alpha. Measure
        # the unchanged horizontal behavior as the independent spatial baseline.
        baseline = c.script("var d=app.documents.add(200,100,72,'BOUNDARY angle baseline',NewDocumentMode.RGB,DocumentFill.WHITE);d.activeLayer.isBackgroundLayer=false;return d.id;", anchor)
        c.call('photoshop_apply_gradient_mask', {'document_id': baseline, 'direction': 'left_to_right'})
        baseline_path = folder / 'horizontal-baseline.png'
        c.call('photoshop_save_document', {'document_id': baseline, 'path': str(baseline_path), 'format': 'PNG'})
        with Image.open(baseline_path) as image:
            alpha = image.convert('RGBA')
            curve = [alpha.getpixel((x, 50))[3] for x in range(200)]
        assert curve[0] < 5 and curve[-1] > 250
        assert all(curve[i+1] >= curve[i]-2 for i in range(199))
        c.call('photoshop_close_document', {'document_id': baseline, 'save': False})
        for iteration in range(3):
            for tool in ('apply_gradient_mask', 'recipe_gradient_fade'):
                for angle in (0, 45, 90, 180, -90, 22.5):
                    target = c.script("var d=app.documents.add(200,100,72,'BOUNDARY angle',NewDocumentMode.RGB,DocumentFill.TRANSPARENT);var color=new SolidColor();color.rgb.red=40;color.rgb.green=100;color.rgb.blue=180;d.selection.selectAll();d.selection.fill(color);d.selection.deselect();return d.id;", anchor)
                    def call(name, args=None):
                        return c.call('photoshop_' + name, dict(args or {}, document_id=target))
                    label = f'{iteration}-{tool}-{angle}'
                    call(tool, {'direction': 'bottom_to_top', 'angle_deg': angle})
                    png = folder / (label + '.png')
                    call('save_document', {'path': str(png), 'format': 'PNG'})
                    with Image.open(png) as image:
                        actual = image.convert('RGBA')
                    dx, dy = math.cos(math.radians(angle)), -math.sin(math.radians(angle))
                    span = abs(200 * dx) + abs(100 * dy)
                    for x, y in ((10, 10), (190, 10), (10, 90), (190, 90), (100, 50)):
                        offset = 0.5 + ((x-100)*dx + (y-50)*dy)/span
                        expected = curve[max(0, min(199, round(200*offset)))]
                        assert abs(actual.getpixel((x, y))[3]-expected) <= 6, (tool, angle, x, y, actual.getpixel((x, y)), expected)
                    psd = folder / (label + '.psd')
                    call('save_document', {'path': str(psd), 'format': 'PSD'})
                    call('close_document', {'save': False})
                    target = c.script('return app.open(new File(' + json.dumps(str(psd)) + ')).id;', anchor)
                    reopened = folder / (label + '-reopen.png')
                    call('save_document', {'path': str(reopened), 'format': 'PNG'})
                    with Image.open(reopened) as image:
                        assert image.convert('RGBA').tobytes() == actual.tobytes()
                    call('close_document', {'save': False})
                    results.append({'round': iteration + 1, 'tool': tool, 'angle': angle, 'alpha': True, 'reopen': True})
                    (folder / 'results.json').write_text(json.dumps(results, indent=2), encoding='utf8')
                    print('PASS', label, flush=True)
    finally:
        c.close()


if __name__ == '__main__':
    main()
