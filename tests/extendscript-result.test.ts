import { describe, expect, it } from 'vitest';
import { parseExtendScriptPayload } from '../src/utils/extendscript-result.js';

describe('native multiline ExtendScript data', () => {
  it('preserves literal CRs inside a Photoshop toSource object string', () => {
    const source = '({id:42,text:"First line\rSecond line\rThird line",editable:true})';
    expect(parseExtendScriptPayload(source)).toEqual({
      id: 42, text: 'First line\rSecond line\rThird line', editable: true,
    });
  });

  it('parses nested Chinese multiline text and mixed escaped characters without normalizing them', () => {
    const source = '({layers:[{name:"标题",text:"第一行\r第二行\\n第三行\\t缩进",style:{font:"字体",size:24}},{name:\'注释\',text:\'中文\r末行\'}],saved:false})';
    expect(parseExtendScriptPayload(source)).toEqual({
      layers: [
        { name: '标题', text: '第一行\r第二行\n第三行\t缩进', style: { font: '字体', size: 24 } },
        { name: '注释', text: '中文\r末行' },
      ],
      saved: false,
    });
  });

  it.each([0, 9, 10, 11, 12, 14, 31])('still refuses unsupported raw control character %s', (code) => {
    const source = '({text:"first' + String.fromCharCode(code) + 'second"})';
    expect(parseExtendScriptPayload(source)).toBe(source);
  });

  it.each([
    '({text:"first\rsecond",run:(globalThis.__psMultilineParserExecuted=true)})',
    '({text:"first\rsecond",run:(function(){globalThis.__psMultilineParserExecuted=true;return 1;})()})',
    '({text:"first\rsecond",get run(){globalThis.__psMultilineParserExecuted=true;return 1;}})',
    '({text:"first\rsecond"});globalThis.__psMultilineParserExecuted=true',
    '({text:"first\rsecond",run:Function("globalThis.__psMultilineParserExecuted=true")()})',
  ])('leaves executable fragments as unparsed text without running them', (source) => {
    const globals = globalThis as Record<string, unknown>;
    delete globals.__psMultilineParserExecuted;
    expect(parseExtendScriptPayload(source)).toBe(source);
    expect(globals.__psMultilineParserExecuted).toBeUndefined();
  });

  it('keeps prototype-looking properties inert with multiline strings', () => {
    const parsed = parseExtendScriptPayload('({text:"first\rsecond",__proto__:{polluted:true}})') as Record<string, unknown>;
    expect(parsed.text).toBe('first\rsecond');
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
