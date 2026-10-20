import { describe, expect, it } from 'vitest';
import { WebMcpResults, legacyWebMcpResult } from '../../web/webMcpResults';

function bounded(value: unknown): any {
  expect(JSON.stringify(value).length).toBeLessThanOrEqual(1500);
  const legacy = legacyWebMcpResult(value);
  expect(JSON.stringify(legacy).length).toBeLessThanOrEqual(1500);
  expect(JSON.parse(legacy.content[0]!.text)).toEqual(value);
  return value;
}
function readAll(cache: WebMcpResults, cursor: string): any {
  let page = bounded(cache.read(cursor));
  if (page.kind === 'scalar') return page.value;
  if (page.kind === 'string') {
    let text = '';
    do { text += page.text; page = page.next_cursor ? bounded(cache.read(page.next_cursor)) : null; } while (page);
    return text;
  }
  const result: any = page.kind === 'array' ? [] : {};
  const expand = (value: any): any => value && typeof value === 'object' && value.ref ? readAll(cache, value.ref) : value;
  do {
    if (page.kind === 'array') result.push(...page.items.map(expand));
    else for (const entry of page.entries) Object.defineProperty(result, expand(entry.key), {value: expand(entry.value), enumerable: true, writable: true});
    expect(page.page_size).toBe(page.kind === 'array' ? page.items.length : page.entries.length);
    page = page.next_cursor ? bounded(cache.read(page.next_cursor)) : null;
  } while (page);
  return result;
}

describe('bounded WebMCP results', () => {
  it('preserves small raw results and structured legacy errors', () => {
    const cache = new WebMcpResults();
    const result = {step: 2, context: {source: 'recording'}, text: 'small'};
    expect(cache.format('pyokka_state', result)).toBe(result);
    const error = {isError: true, error: 'bad input', code: 'INVALID', retryable: false};
    expect(bounded(cache.format('pyokka_state', error))).toEqual(error);
    expect(legacyWebMcpResult(error).isError).toBe(true);
  });

  it('reconstructs immutable collections, long keys, nested user refs and escaped Unicode exactly', () => {
    const cache = new WebMcpResults();
    const key = '"\\😀\n'.repeat(200);
    const original = {context: {source:'live',runId:'r1',step:4,frame:0,file:'/x.py',line:8}, locals: Array.from({length:35}, (_,i)=>({name:`n${i}`,value:i})), [key]: '"\\😀\n\ud800'.repeat(600), ref: {ref:'authored data'}, empty: [], object: {}};
    const expected = JSON.parse(JSON.stringify(original));
    const envelope = bounded(cache.format('pyokka_debug',original));
    expect(envelope.summary).toMatchObject({source:'live',runId:'r1',step:4,line:8});
    original.locals[0]!.name = 'changed';
    expect(readAll(cache,envelope.cursor)).toEqual(expected);
    expect(cache.read(envelope.cursor)).toEqual(cache.read(envelope.cursor));
  });

  it('bounds large error details while retaining producing-action failure', () => {
    const cache = new WebMcpResults();
    const error = {isError:true,error:'\\"'.repeat(6000),code:'RUN_FAILED',retryable:false};
    const envelope = bounded(cache.format('pyokka_run',error));
    expect(envelope).toMatchObject({isError:true,outcome:'failed',code:'RUN_FAILED',retryable:false});
    expect(readAll(cache,envelope.cursor)).toEqual(error);
  });
});

it('expires absolutely, evicts oldest and clears snapshots at registration teardown', () => {
  let now=0;
  const cache=new WebMcpResults(()=>now,{maxSnapshots:2,snapshotUnits:20000,totalUnits:40000,ttlMs:100});
  const a=bounded(cache.format('pyokka_state',{text:'a'.repeat(2000)}));
  now=30;
  const b=bounded(cache.format('pyokka_state',{text:'b'.repeat(2000)}));
  expect(cache.read(a.cursor)).toMatchObject({kind:'object'});
  const c=bounded(cache.format('pyokka_state',{text:'c'.repeat(2000)}));
  expect(cache.read(a.cursor)).toMatchObject({code:'RESULT_UNAVAILABLE'});
  now=130;
  expect(cache.read(b.cursor)).toMatchObject({code:'RESULT_UNAVAILABLE'});
  expect(cache.read(c.cursor)).toMatchObject({code:'RESULT_UNAVAILABLE'});
  const d=bounded(cache.format('pyokka_state',{text:'d'.repeat(2000)}));
  cache.clear();
  expect(cache.read(d.cursor)).toMatchObject({code:'RESULT_UNAVAILABLE'});
});

it('rejects oversized insertion without evicting retained data and bounds summaries on every error', () => {
  const cache=new WebMcpResults(()=>0,{maxSnapshots:2,snapshotUnits:5000,totalUnits:6000,ttlMs:100});
  const saved=bounded(cache.format('pyokka_state',{text:'a'.repeat(2000)}));
  const huge=bounded(cache.format('pyokka_run',{file:'\\"'.repeat(5000),text:'x'.repeat(10000)}));
  expect(huge).toMatchObject({code:'RESULT_TOO_LARGE',outcome:'completed',cursor:null});
  expect(cache.read(saved.cursor)).toMatchObject({kind:'object'});
  const cycle: any={file:'\\"'.repeat(5000)}; cycle.loop=cycle;
  expect(bounded(cache.format('pyokka_run',cycle))).toMatchObject({code:'RESULT_NOT_SERIALIZABLE',outcome:'completed',cursor:null});
});

it('accounts for metadata and aggregate retention rather than text alone', () => {
  const cache=new WebMcpResults(()=>0,{maxSnapshots:16,snapshotUnits:6000,totalUnits:6500,ttlMs:100});
  const a=bounded(cache.format('pyokka_state',{text:'a'.repeat(3000)}));
  const b=bounded(cache.format('pyokka_state',{text:'b'.repeat(3000)}));
  expect(cache.read(a.cursor)).toMatchObject({code:'RESULT_UNAVAILABLE'});
  expect(cache.read(b.cursor)).toMatchObject({kind:'object'});
  expect(bounded(cache.format('pyokka_state',{items:Array.from({length:1000},()=>({}))}))).toMatchObject({code:'RESULT_TOO_LARGE'});
});

it('cancels delivery and reads without revoking existing cursors or claiming rollback', () => {
  const cache=new WebMcpResults();
  const result=bounded(cache.format('pyokka_debug',{text:'a'.repeat(2000)}));
  const controller=new AbortController();controller.abort();
  expect(bounded(cache.read(result.cursor,controller.signal))).toMatchObject({code:'CANCELLED'});
  expect(cache.read(result.cursor)).toMatchObject({kind:'object'});
  expect(bounded(cache.format('pyokka_run',{text:'b'.repeat(2000)},{signal:controller.signal,outcome:'unknown'}))).toMatchObject({code:'CANCELLED',outcome:'unknown',cursor:null});
});

it('rejects malformed and foreign cursors without consuming valid pages', () => {
  const cache=new WebMcpResults();const other=new WebMcpResults();
  const result=bounded(cache.format('pyokka_state',{text:'a'.repeat(2000)}));
  expect(cache.read('wrong cursor')).toMatchObject({code:'INVALID_CURSOR'});
  expect(other.read(result.cursor)).toMatchObject({code:'RESULT_UNAVAILABLE'});
  expect(cache.read(result.cursor+'.oops')).toMatchObject({code:'INVALID_CURSOR'});
  expect(cache.read(result.cursor)).toMatchObject({kind:'object'});
});

it('indexes supported deep JSON and resolves a normalization depth failure as a structured error', () => {
  const cache=new WebMcpResults();
  let deep: any='bottom';for(let i=0;i<1000;i++)deep={child:deep};
  const result=bounded(cache.format('pyokka_why',deep));
  expect(result.code).toBeUndefined();
  let cursor=result.cursor;
  for(let i=0;i<1000;i++) {
    const page=bounded(cache.read(cursor));
    if(i===999)expect(page.entries[0]).toEqual({key:'child',value:'bottom'});
    else cursor=page.entries[0].value.ref;
  }
  for(let i=0;i<11000;i++)deep={child:deep};
  expect(bounded(cache.format('pyokka_why',deep))).toMatchObject({code:'RESULT_NOT_SERIALIZABLE',outcome:'completed',cursor:null});
});

it('never bypasses a throwing toJSON RangeError and retains normal JSON conversion semantics', () => {
  const cache=new WebMcpResults();
  const throwing=Object.defineProperty({text:'x'.repeat(2000)},'toJSON',{value(){throw new RangeError('not a depth error');}});
  expect(bounded(cache.format('pyokka_state',throwing))).toMatchObject({code:'RESULT_NOT_SERIALIZABLE',cursor:null});
  const original={text:'x'.repeat(2000),date:new Date('2026-10-19T10:00:00Z'),absent:undefined,values:[undefined,NaN]};
  const result=bounded(cache.format('pyokka_state',original));
  expect(readAll(cache,result.cursor)).toEqual(JSON.parse(JSON.stringify(original)));
});

it('projects bounded eval text and its actual paused location', () => {
  const cache=new WebMcpResults();
  const result=bounded(cache.format('pyokka_eval',{text:'captured value '.repeat(200),at:'/tmp/paused.py:24'}));
  expect(result).toMatchObject({summary_truncated:true,summary:{text:'captured value '.repeat(200).slice(0,80),file:'/tmp/paused.py',line:24}});
});

it('omits malformed summary field types and source domains without losing the captured details', () => {
  const cache=new WebMcpResults();
  const original={context:{source:'authored',runId:23,step:'999',frame:false,file:7,line:'4'},paused:2,running:'yes',revision:1.5,open:1,text:'x'.repeat(2000)};
  const result=bounded(cache.format('pyokka_state',original));
  expect(result.summary).not.toHaveProperty('source');
  for(const key of ['runId','step','frame','file','line','paused','running','revision','open'])expect(result.summary).not.toHaveProperty(key);
  expect(readAll(cache,result.cursor)).toEqual(original);
});

it('turns throwing getters and BigInt into bounded errors instead of escaping the adapter', () => {
  const cache=new WebMcpResults();
  expect(bounded(cache.format('pyokka_state',{get context(){throw new Error('getter')}}))).toMatchObject({code:'RESULT_NOT_SERIALIZABLE'});
  expect(bounded(cache.format('pyokka_state',{value:1n}))).toMatchObject({code:'RESULT_NOT_SERIALIZABLE'});
});

it('bounds control-heavy error codes and previews as well as successful summaries', () => {
  const cache=new WebMcpResults();
  const result=bounded(cache.format('pyokka_run',{isError:true,error:'\u0000'.repeat(2000),code:'\u0000'.repeat(2000),file:'\\"'.repeat(2000)}));
  expect(result).toMatchObject({isError:true,outcome:'failed'});
  expect(readAll(cache,result.cursor)).toMatchObject({error:'\u0000'.repeat(2000)});
});

it('marks shortened summaries and projects actual location, nested state and collection counts', () => {
  const cache=new WebMcpResults();
  const result=bounded(cache.format('pyokka_step',{moved:true,state:{context:{source:'recording',runId:'r1',step:5,frame:0,file:'/'.repeat(100)},location:{line:8}},changes:Array.from({length:30},()=>({text:'x'.repeat(100)}))}));
  expect(result).toMatchObject({summary_truncated:true,summary:{source:'recording',runId:'r1',step:5,line:8,moved:true,changes_count:30}});
});

it('checks cancellation after serialization and preserves explicit known action outcome', () => {
  const cache=new WebMcpResults();
  const controller=new AbortController();
  const result=bounded(cache.format('pyokka_run',{toJSON(){controller.abort();return {text:'small'};}},{signal:controller.signal,outcome:'completed'}));
  expect(result).toMatchObject({code:'CANCELLED',outcome:'completed',cursor:null});
});

it('uses the escaped legacy wrapper to decide whether an otherwise small native result needs paging', () => {
  const cache=new WebMcpResults();
  const original={text:'\\"'.repeat(220)};
  expect(JSON.stringify(original).length).toBeLessThan(1500);
  expect(JSON.stringify(legacyWebMcpResult(original)).length).toBeGreaterThan(1500);
  const result=bounded(cache.format('pyokka_eval',original));
  expect(result.bounded).toBe(true);
  expect(readAll(cache,result.cursor)).toEqual(original);
});
