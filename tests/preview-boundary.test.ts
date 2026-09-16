import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { ExtendScriptSnippets } from '../src/api/extendscript.js';
import { jpegDimensions } from '../src/utils/jpeg-dimensions.js';

it('reads actual JPEG dimensions past metadata segments', () => {
  const data=Buffer.from([255,216,255,225,0,4,0,0,255,192,0,8,8,0,240,1,224,0,255,217]);
  expect(jpegDimensions(data)).toEqual({width:480,height:240});
});
it.each([Buffer.from([]),Buffer.from([255,216,255,217]),Buffer.from([255,216,255,225,255,255,255,217])])('rejects malformed/truncated JPEG metadata', data => {
  expect(()=>jpegDimensions(data)).toThrow('invalid_preview');
});
it.each([false,true])('flattens artboards before resizing and cleans up duplicate on save failure=%s', fail => {
  const unit=(value:number)=>({as:()=>value});
  const operations:string[]=[];
  let removed=false;
  const duplicate={
    width:unit(100),height:unit(200),resolution:72,mode:'CMYK',bitsPerChannel:'16',xmpMetadata:{rawData:'large ancestry'},
    flatten(){operations.push('flatten');this.width=unit(12000);this.height=unit(3000);},
    changeMode(mode:string){this.mode=mode;},
    resizeImage(w:{as:()=>number},h:{as:()=>number}){operations.push('resize');this.width=w;this.height=h;},
    saveAs(){operations.push('save');if(fail)throw new Error('ENOSPC');},
    close(){operations.push('close');},
  };
  const doc={width:unit(100),height:unit(200),mode:'CMYK',xmpMetadata:{rawData:'original ancestry'},duplicate:()=>duplicate};
  const app={activeDocument:doc,documents:[doc]};
  const context={app,Folder:{temp:{fsName:'temp'}},
    File:function(path:string){return{fsName:path,exists:true,remove(){removed=true;}};},
    UnitValue:unit,JPEGSaveOptions:function(){},
    DocumentMode:{RGB:'RGB'},ChangeMode:{RGB:'RGB'},BitsPerChannelType:{EIGHT:'8'},
    ResampleMethod:{BICUBIC:'bicubic'},FormatOptions:{STANDARDBASELINE:'baseline'},SaveOptions:{DONOTSAVECHANGES:'discard'},
  };
  const run=()=>runInNewContext('(function(){'+ExtendScriptSnippets.exportPreview(480,8)+'})()',context);
  if(fail)expect(run).toThrow('ENOSPC');
  else expect(run()).toMatchObject({width:480,height:120,mimeType:'image/jpeg'});
  expect(operations).toEqual(['flatten','resize','save','close']);
  expect(duplicate.xmpMetadata.rawData).toBe('');
  expect(doc.xmpMetadata.rawData).toBe('original ancestry');
  expect(doc.mode).toBe('CMYK');
  expect(app.activeDocument).toBe(doc);
  expect(removed).toBe(fail);
});
