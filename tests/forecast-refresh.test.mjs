import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('  let forecastRequest = 0;'),end=html.indexOf('  const refreshRec',start);
const now=Date.parse('2026-11-11T18:30:00Z');
const snapshot=(offset=0)=>({v:2,built:new Date(now+offset).toISOString(),past:[],fut:[[now+1800000,10000,1000,500,3]]});
function harness(previous=null){
 const pending=[],renders=[];
 const ctx={S:{data:{fc:previous}},Date:{now:()=>now,parse:Date.parse},renderForecast(){renders.push({data:ctx.S.data.fc,error:ctx.S.data.fcRefreshError});},updateStatus(){},getJSON(url,timeout,options){return new Promise((resolve,reject)=>pending.push({url,timeout,options,resolve,reject}));}};
 vm.createContext(ctx);vm.runInContext(html.slice(start,end)+'globalThis.refresh=refreshFc;',ctx);
 return {...ctx,pending,renders};
}
test('forecast checks use a five-minute cache key and bypass the browser HTTP cache',async()=>{
 const h=harness(),p=h.refresh();assert(h.pending[0].url.endsWith('v='+Math.floor(now/300000)));assert.equal(h.pending[0].options.cache,'no-store');h.pending[0].resolve(snapshot());await p;assert.equal(h.S.data.fcRefreshError,false);
});
test('an older in-flight forecast cannot replace a later successful refresh',async()=>{
 const h=harness(),a=h.refresh(),b=h.refresh();h.pending[1].resolve(snapshot());await b;h.pending[0].resolve(snapshot(-3600000));await a;assert.equal(h.S.data.fc.built,snapshot().built);assert.equal(h.renders.length,1);
});
test('an old request failure cannot mark a newer successful forecast as delayed',async()=>{
 const h=harness(),a=h.refresh(),b=h.refresh();h.pending[1].resolve(snapshot());await b;h.pending[0].reject(new Error('Old timeout'));await a;assert.equal(h.S.data.fcRefreshError,false);
});
test('a regressed server snapshot retains the newest known outlook and flags the refresh problem',async()=>{
 const previous=snapshot(),h=harness(previous),p=h.refresh();h.pending[0].resolve(snapshot(-3600000));await p;assert.equal(h.S.data.fc,previous);assert.equal(h.S.data.fcRefreshError,true);
});
test('temporary failure retains the previous graph, then recovery clears the refresh warning',async()=>{
 const previous=snapshot(-1800000),h=harness(previous),a=h.refresh();h.pending[0].reject(new Error('Source offline'));await a;assert.equal(h.S.data.fc,previous);assert.equal(h.S.data.fcRefreshError,true);const b=h.refresh();h.pending[1].resolve(snapshot());await b;assert.equal(h.S.data.fcRefreshError,false);assert.equal(h.S.data.fc.built,snapshot().built);
});
test('invalid forecast responses cannot clear a useful saved outlook',async()=>{
 for(const bad of [null,{}, {built:'invalid',past:[],fut:[]},{...snapshot(),fut:[[now,null,null,null,3]]}]){const previous=snapshot(),h=harness(previous),p=h.refresh();h.pending[0].resolve(bad);await p;assert.equal(h.S.data.fc,previous);assert.equal(h.S.data.fcRefreshError,true);}
});

const builder=fs.readFileSync(new URL('../scripts/build-data.mjs',import.meta.url),'utf8');
const stage=builder.slice(builder.indexOf('// Start the larger generation download'),builder.indexOf('// bump VERSION'));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const runStage=new AsyncFunction('deps','const {step,get,E,sday,now,DAY,rows,embeddedForecast,demandUpdate,windForecast,windOutturn,r0,meta,write,assembleOutlook,readJSON,snapshotFromElexon}=deps;'+stage);
function buildHarness(){
 let resolveGeneration,rejectGeneration,notifyForecast;
 const generation=new Promise((resolve,reject)=>{resolveGeneration=resolve;rejectGeneration=reject;});
 const forecastWritten=new Promise(resolve=>notifyForecast=resolve),files=[],errors=[];
 const deps={now,DAY:86400000,E:'https://example.invalid',sday:()=>'',rows:x=>x,r0:Math.round,meta:{built:new Date(now).toISOString()},
   get:()=>generation,embeddedForecast:async()=>[],demandUpdate:async()=>[],windForecast:async()=>[],windOutturn:async()=>[],
   step:async(name,fn)=>{try{return await fn();}catch(e){errors.push(name);return null;}},
   write:async(name,value)=>{files.push({name,value});if(name==='forecast.json')notifyForecast();},
   assembleOutlook:()=>snapshot(),readJSON:async()=>null,snapshotFromElexon:()=>({v:1,hh:[]})};
 return {deps,files,errors,forecastWritten,resolveGeneration,rejectGeneration};
}
test('the actual builder writes the outlook while the large generation request is still pending',{timeout:5000},async()=>{
 const h=buildHarness(),running=runStage(h.deps);await h.forecastWritten;assert.deepEqual(h.files.map(f=>f.name),['forecast.json']);h.resolveGeneration([]);await running;assert(h.files.some(f=>f.name==='generation.json'));
});
test('failure of the large generation request cannot prevent an outlook update',{timeout:5000},async()=>{
 const h=buildHarness(),running=runStage(h.deps);await h.forecastWritten;h.rejectGeneration(new Error('Generation timeout'));await running;assert(h.files.some(f=>f.name==='forecast.json'));assert(h.errors.includes('generationOutturn'));
});
