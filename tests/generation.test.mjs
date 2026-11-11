import test from 'node:test';
import assert from 'node:assert/strict';
import {FUELS, HH, HOUR, DAY, midnight, snapshotFromElexon, recentSeries, dailySeries, mergeGenerationDays} from '../scripts/generation-series.mjs';
const now=Date.parse('2026-11-11T12:00:00Z');
const fuelRows=t=>['CCGT','NUCLEAR','BIOMASS','WIND','NPSHYD','PS','OTHER'].map(f=>({startTime:new Date(t).toISOString(),publishTime:new Date(t+HH/2).toISOString(),fuelType:f,generation:f==='PS'?-500:2000}));
const embedded=t=>({t,act:true,wind:100,solar:200});
const mw=dom=>Object.fromEntries(['dom',...FUELS].map(f=>[f,f==='dom'?dom:dom/FUELS.length]));
test('generation excludes imports and charging, while retaining embedded wind and solar',()=>{
 const t=now-HH, rows=[...fuelRows(t),{...fuelRows(t)[0],fuelType:'INTFR',generation:5000}];
 const s=snapshotFromElexon(rows,[embedded(t)],now), row=s.hh[0];
 assert.equal(row[1],12300);assert.equal(row[2+FUELS.indexOf('storage')],0);assert.equal(row[2+FUELS.indexOf('wind')],2100);
 assert.equal(row.slice(2).reduce((a,b)=>a+b,0),row[1]);
});
test('newest revisions replace older readings; forecast embedded values retain provenance',()=>{
 const t=now-HH,rows=fuelRows(t), revision={...rows[0],generation:4000,publishTime:new Date(now).toISOString()};
 const s=snapshotFromElexon([revision,...rows],[{...embedded(t),act:false}],now);
 assert.equal(s.hh[0][1],14300);assert.deepEqual(s.estimates,[t]);
 assert.equal(recentSeries(s,24,now).at(-1).estimated,true);
});
test('missing fuel readings, invalid solar and incomplete current periods cannot become valid output',()=>{
 const t=now-HH;
 assert.throws(()=>snapshotFromElexon(fuelRows(t).slice(1),[embedded(t)],now));
 assert.throws(()=>snapshotFromElexon(fuelRows(t),[{...embedded(t),solar:null}],now));
 assert.throws(()=>snapshotFromElexon(fuelRows(now),[embedded(now)],now));
});
function snapshot(hours=168){return {v:1,built:new Date(now).toISOString(),latest:new Date(now-HH).toISOString(),fuels:FUELS,hh:Array.from({length:hours*2},(_,i)=>[now-hours*HOUR+i*HH,10000+i,...FUELS.map(()=> (10000+i)/FUELS.length)])};}
test('24 hours preserves 48 half-hours; missing periods stay gaps',()=>{
 const s=snapshot(24);s.hh.splice(10,1);const p=recentSeries(s,24,now);
 assert.equal(p.length,48);assert.equal(p[10].total,null);assert.equal(p[11].t-p[10].t,HH);
 assert.equal(p.meta.coverage,47/48);
});
test('7 days has 168 hourly averages and preserves half-hourly extremes',()=>{
 const p=recentSeries(snapshot(),168,now);
 assert.equal(p.length,168);assert(Math.abs(p[0].total-10.0005)<1e-10);assert.equal(p[0].lo,10);assert.equal(p[0].hi,10.001);
 const s=snapshot();s.hh.splice(2,1);assert.equal(recentSeries(s,168,now)[1].total,null);
});
function daysBefore(endKey,count){return Array.from({length:count},(_,i)=>{const d=new Date(Date.parse(endKey+'T12:00:00Z')-(count-i)*DAY).toISOString().slice(0,10);const next=new Date(Date.parse(d+'T12:00:00Z')+DAY).toISOString().slice(0,10);return {d,n:(midnight(next)-midnight(d))/HH,mw:mw(10000+i*10)};});}
test('30-day view uses complete UK dates and the 25-hour autumn day has 50 readings',()=>{
 const days=daysBefore('2026-11-11',30),p=dailySeries({built:new Date(now).toISOString(),days},720,now);
 assert.equal(p.length,30);assert.equal(p.meta.coverage,1);assert.equal(p.find(p=>p.expected===50).n,50);
 assert.equal(p.at(-1).end,midnight('2026-11-11'));
});
test('last year covers 365 complete days in 53 weighted buckets, including both DST changes',()=>{
 const days=daysBefore('2026-11-11',365),p=dailySeries({built:new Date(now).toISOString(),days},8760,now);
 assert.equal(p.length,53);assert.equal(p.at(-1).expected,48);assert.equal(p.meta.coverage,1);
 const mean=days.reduce((s,d)=>s+d.mw.dom*d.n,0)/days.reduce((s,d)=>s+d.n,0)/1000;
 assert(Math.abs(p.meta.avgTotal-mean)<1e-10);assert(days.some(d=>d.n===46));assert(days.some(d=>d.n===50));
});
test('missing calendar dates remain blank; incomplete daily data has explicit coverage',()=>{
 const days=daysBefore('2026-11-11',30);days.splice(12,1);days[0].n=24;
 const p=dailySeries({built:new Date(now).toISOString(),days},720,now);
 assert.equal(p[12].total,null);assert.equal(p[0].n,24);assert(p.meta.coverage<1);
});
test('recent current-source days extend a delayed historic feed without damaging a fuller historic day',()=>{
 const days=daysBefore('2026-11-05',10),s=snapshot(168),merged=mergeGenerationDays(days,s,now);
 assert.equal(merged.days.at(-1).d,'2026-11-10');assert.equal(merged.days.find(d=>d.d==='2026-11-04').n,48);
 assert(!merged.days.some(d=>d.d==='2026-11-11'));
});

test('forecast provenance survives daily and weekly aggregation',()=>{const s=snapshot(168),t=midnight('2026-11-11')-HH;s.estimates=[t];const d=mergeGenerationDays(daysBefore('2026-11-05',365),s,now);assert.equal(d.days.find(r=>r.d==='2026-11-10').estimated,true);assert.equal(dailySeries(d,720,now).at(-1).estimated,true);assert.equal(dailySeries(d,8760,now).at(-1).estimated,true);});
