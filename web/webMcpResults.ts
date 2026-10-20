/** WebMCP-only snapshots. Command/bridge results never pass through this cache. */
type Kind = 'object' | 'array' | 'string' | 'scalar';
type Primitive = string | number | boolean | null;
type Ref = { ref: string; kind: Kind; total_count: number };
type Cell = Primitive | Ref;
type Node = { kind: Kind; value: unknown; total: number };
type Snapshot = { nodes: Node[]; created: number; charge: number };
export type ResultOutcome = 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface ResultOptions { signal?: AbortSignal; outcome?: ResultOutcome }
export interface ResultLimits { maxSnapshots: number; snapshotUnits: number; totalUnits: number; ttlMs: number }
const CAPACITY = Symbol('capacity');
const DEFAULTS: ResultLimits = { maxSnapshots: 16, snapshotUnits: 4194304, totalUnits: 8388608, ttlMs: 300000 };

export function legacyWebMcpResult(payload: unknown): {content: {type:'text';text:string}[];isError?:true} {
  return {content:[{type:'text',text:JSON.stringify(payload)}], ...(isError(payload) ? {isError:true as const} : {})};
}
function isError(value: unknown): boolean { return !!value && typeof value === 'object' && (value as Record<string, unknown>)['isError'] === true; }
function fits(value: unknown): boolean { return JSON.stringify(value).length <= 1500 && JSON.stringify(legacyWebMcpResult(value)).length <= 1500; }
function error(code: string, text: string): Record<string, unknown> { return {isError:true,error:text,code,retryable:false}; }
function preview(value: string): string { return Array.from(value).slice(0,80).join(''); }

export class WebMcpResults {
  private snapshots = new Map<string, Snapshot>();
  private serial = 0;
  private readonly namespace = Math.random().toString(36).slice(2,14);
  constructor(private readonly now: () => number = () => performance.now(), private readonly limits: ResultLimits = DEFAULTS) {}
  clear(): void { this.snapshots.clear(); }

  format(tool: string, value: unknown, options: ResultOptions = {}): unknown {
    const base: Record<string,unknown> = {bounded:true,tool:tool.slice(0,30),outcome:options.outcome ?? 'completed',summary:{}};
    try {
      base['outcome'] = options.outcome ?? (isError(value) ? 'failed' : 'completed');
      Object.assign(base,this.summary(value));
      if (options.signal?.aborted) return this.trim({...base,...error('CANCELLED','Delivery was cancelled; this does not establish rollback.'),cursor:null});
      const json = JSON.stringify(value);
      if (json === undefined) return null;
      if (options.signal?.aborted) return this.trim({...base,...error('CANCELLED','Delivery was cancelled; this does not establish rollback.'),cursor:null});
      const captured: unknown = JSON.parse(json);
      if (fits(captured)) return value;
      if (json.length > Math.min(this.limits.snapshotUnits,this.limits.totalUnits)) return this.unretained(base,'RESULT_TOO_LARGE');
      const id = `${this.namespace}-${++this.serial}`;
      const nodes: Node[] = [];
      const charge = this.index(captured,nodes,id);
      if (options.signal?.aborted) return this.trim({...base,...error('CANCELLED','Delivery was cancelled; this does not establish rollback.'),cursor:null});
      this.expire();
      while (this.snapshots.size >= this.limits.maxSnapshots || this.charge() + charge > this.limits.totalUnits) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(id,{nodes,charge,created:this.now()});
      const result: Record<string, unknown> = {...base,cursor:`${id}.0.0`,expires_in_ms:this.limits.ttlMs};
      if (isError(value)) Object.assign(result,error('ACTION_FAILED','The action failed; read retained details.'),{code:preview(String((value as Record<string,unknown>)['code'] ?? 'ACTION_FAILED')),error:preview(String((value as Record<string,unknown>)['error'] ?? 'The action failed.')),retryable:(value as Record<string,unknown>)['retryable'] === true});
      return this.trim(result);
    } catch (err) { return this.unretained(base,err === CAPACITY ? 'RESULT_TOO_LARGE' : 'RESULT_NOT_SERIALIZABLE'); }
  }

  read(cursor: unknown, signal?: AbortSignal): unknown {
    if (signal?.aborted) return error('CANCELLED','Reading was cancelled; retained details were not changed.');
    if (typeof cursor !== 'string' || cursor.length > 96 || !/^[a-z0-9-]+\.\d+\.\d+$/.test(cursor)) return error('INVALID_CURSOR','Use an exact cursor supplied by a previous large result.');
    this.expire();
    const [id, nodeId, start] = cursor.split('.');
    const snapshot = this.snapshots.get(id!);
    const node = snapshot?.nodes[Number(nodeId)];
    const offset = Number(start);
    if (!node || !Number.isSafeInteger(offset) || offset < 0 || offset > node.total) return error('RESULT_UNAVAILABLE','Retained details expired or were evicted; this read did not repeat the action.');
    const next = (end: number): string | null => end < node.total ? `${id}.${nodeId}.${end}` : null;
    if (node.kind === 'scalar') return {kind:'scalar',value:node.value,page_size:1,total_count:1,next_cursor:null};
    const values = node.value as Cell[];
    const key = node.kind === 'object' ? 'entries' : node.kind === 'array' ? 'items' : 'text';
    const chars = node.kind === 'string' ? Array.from(node.value as string) : null;
    const page: Record<string,unknown> = {kind:node.kind,[key]:chars ? '' : [],...(chars ? {offset} : {}),page_size:0,total_count:node.total,next_cursor:next(offset)};
    for (let end = offset + 1; end <= Math.min(node.total,offset + (chars ? 512 : 20)); end++) {
      const candidate = {...page,[key]:chars ? chars.slice(offset,end).join('') : values.slice(offset,end),page_size:end-offset,next_cursor:next(end)};
      if (!fits(candidate)) break;
      Object.assign(page,candidate);
    }
    return page;
  }

  private index(value: unknown, nodes: Node[], id: string): number {
    type Visit = {value:unknown;assign:(cell:Cell)=>void;root?:boolean;key?:boolean};
    const jobs: Visit[] = [{value,assign:()=>{},root:true}];
    let units=0;
    while (jobs.length) {
      const job=jobs.pop()!;
      const v=job.value;
      const compound=v !== null && typeof v === 'object';
      const kind:Kind=typeof v === 'string' ? 'string' : Array.isArray(v) ? 'array' : compound ? 'object' : 'scalar';
      const keys=kind === 'object' ? Object.keys(v as object) : [];
      const total=kind === 'string' ? Array.from(v as string).length : kind === 'array' ? (v as unknown[]).length : kind === 'object' ? keys.length : 1;
      const json=compound ? '' : JSON.stringify(v);
      if (!compound && json === undefined) throw new Error('Not a JSON value');
      if (!job.key) units+=compound ? 2+Math.max(0,total-1) : json.length;
      if (!job.root && !compound && json.length<=80) job.assign(v as Primitive);
      else {
        const node:Node={kind,total,value:compound ? [] : v};
        job.assign({ref:`${id}.${nodes.length}.0`,kind,total_count:total});
        nodes.push(node);
        if (compound) {
          const entries=node.value as unknown[];
          for(let i=total-1;i>=0;i--) {
            if(kind === 'array') jobs.push({value:(v as unknown[])[i],assign:cell=>{entries[i]=cell;}});
            else {
              const key=keys[i]!; units+=JSON.stringify(key).length+1;
              const entry: {key?:Cell;value?:Cell}={};entries[i]=entry;
              jobs.push({value:(v as Record<string,unknown>)[key],assign:cell=>{entry.value=cell;}});
              jobs.push({value:key,key:true,assign:cell=>{entry.key=cell;}});
            }
          }
        }
      }
      if (units+nodes.length*128>Math.min(this.limits.snapshotUnits,this.limits.totalUnits)) throw CAPACITY;
    }
    return units+nodes.length*128;
  }
  private charge(): number { let total=0; for (const s of this.snapshots.values()) total+=s.charge; return total; }
  private expire(): void { const now=this.now(); for (const [id,s] of this.snapshots) if (now-s.created >= this.limits.ttlMs) this.snapshots.delete(id); }
  private trim(result: Record<string,unknown>): unknown {
    const summary=result['summary'] as Record<string,unknown>;
    while (!fits(result) && Object.keys(summary).length) {delete summary[Object.keys(summary).at(-1)!];result['summary_truncated']=true;}
    for (const key of ['error','code']) while (!fits(result) && typeof result[key] === 'string' && (result[key] as string).length>1) result[key]=Array.from(result[key] as string).slice(0,-1).join('');
    return result;
  }
  private unretained(base: object, code: string): unknown { return this.trim({...base,...error(code,code === 'RESULT_TOO_LARGE' ? 'Full details exceed retention capacity and cannot be read with a cursor. The producing-action outcome is unchanged.' : 'Full details could not be serialized. The producing-action outcome is unchanged.'),cursor:null}); }
  private summary(value: unknown): {summary:Record<string,unknown>;summary_truncated?:true} {
    const record=(v:unknown):Record<string,unknown>=>v && typeof v === 'object' ? v as Record<string,unknown> : {};
    const result=record(value);
    const state=record(result['state']);
    // Paused eval and debug summaries use a display location; PageState uses an object.
    const location=(v:unknown):Record<string,unknown>=> {
      if (typeof v !== 'string') return record(v);
      const match=/^(.*):(\d+)$/.exec(v);
      return match ? {file:match[1],line:Number(match[2])} : {};
    };
    const combined={...location(state['location']),...location(result['location']),...location(result['at']),...state,...result,...record(state['context']),...record(result['context'])};
    const summary: Record<string,unknown>={};
    let truncated=false;
    const strings=new Set(['runId','file','name','id','status','text','error','code']);
    const integers=new Set(['step','frame','line','rows','row','revision','savedVersion','loadedVersion','exitCode']);
    const booleans=new Set(['moved','running','paused','on','open','retryable','liveExecutionChanged']);
    const nullable=new Set(['step','file','line','row']);
    for (const key of ['source','runId','step','frame','file','line','moved','running','paused','exitCode','name','rows','row','id','revision','status','open','savedVersion','loadedVersion','liveExecutionChanged','totalMs','on','text','error','code','retryable']) {
      const v=combined[key];
      if ((key === 'source' && (v === 'live' || v === 'recording')) ||
          (nullable.has(key) && v === null) ||
          (strings.has(key) && typeof v === 'string') ||
          (integers.has(key) && typeof v === 'number' && Number.isSafeInteger(v)) ||
          (booleans.has(key) && typeof v === 'boolean') ||
          (key === 'totalMs' && typeof v === 'number' && Number.isFinite(v))) {
        summary[key]=typeof v === 'string' ? preview(v) : v;
        if(summary[key] !== v)truncated=true;
      }
    }
    for(const [key,name] of Object.entries({errors:'error_count',changes:'changes_count',watches:'watches_count',scratchpads:'scratchpads_count',history:'history_count'})) if(Array.isArray(combined[key]))summary[name]=(combined[key] as unknown[]).length;
    return {summary,...(truncated?{summary_truncated:true as const}:{})};
  }
}
