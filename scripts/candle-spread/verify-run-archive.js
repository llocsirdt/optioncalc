#!/usr/bin/env node
'use strict';
/**
 * verify-run-archive.js — prove the off-instance archive actually recovers a real session.
 *
 * Reproduces the 2026-09-29 20:11 ET failure end to end against REAL records from the local archive:
 *   PHASE 1  a session's records are written through store.writeRun (local disk + archive)
 *   PHASE 2  the local store is wiped — an instance replacement handing the app a fresh EBS volume
 *   PHASE 3  restoreDay rehydrates, and the recovered book is compared against the pre-loss book
 *
 * It ships as a MANUAL tool rather than a unit test because it needs candle-spread-archive/ (~967 MB,
 * local-only). The unit coverage in server/tests/unit/candle-spread-run-archive.test.js is the portable
 * version; this is the one that proves it on a real 80-variant day.
 *
 * S3 is stubbed in-process, so this touches no network and needs no credentials — it validates the
 * store/archive/restore wiring, not AWS itself. For a real bucket, seed it with
 * scripts/seed-run-archive-s3.js and check /health -> candleRunArchive.
 *
 * Usage:  node scripts/candle-spread/verify-run-archive.js [--date YYYY-MM-DD]
 */
const fs=require('fs'), os=require('os'), path=require('path');
const R=require('path').join(__dirname,'..','..');
const DATE=(()=>{const i=process.argv.indexOf('--date');return i>=0&&process.argv[i+1]?process.argv[i+1]:'2026-09-29';})();
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-'));
const STORE=path.join(tmp,'candle-spread-runs');

// fake S3 standing in for the bucket
const Module=require('module'); const _l=Module._load;
const s3=new Map();
Module._load=function(req){ if(req==='@aws-sdk/client-s3') return FAKE; return _l.apply(this,arguments); };
const FAKE={ S3Client:class{async send(c){
    if(c._k==='put'){s3.set(c.i.Key,String(c.i.Body));return {};}
    if(c._k==='get'){ if(!s3.has(c.i.Key)){const e=new Error('NoSuchKey');e.name='NoSuchKey';throw e;} const b=s3.get(c.i.Key); return {Body:{transformToString:async()=>b}};}
    if(c._k==='list'){const ks=[...s3.keys()].filter(k=>k.startsWith(c.i.Prefix||'')).sort();
      const st=c.i.ContinuationToken?Number(c.i.ContinuationToken):0; const pg=ks.slice(st,st+500);
      const done=st+500>=ks.length; return {Contents:pg.map(k=>({Key:k})),IsTruncated:!done,NextContinuationToken:done?null:String(st+500)};}
  }},
  PutObjectCommand:class{constructor(i){this.i=i;this._k='put';}},
  GetObjectCommand:class{constructor(i){this.i=i;this._k='get';}},
  ListObjectsV2Command:class{constructor(i){this.i=i;this._k='list';}} };

process.env.CANDLE_SPREAD_RUNS_DIR=STORE;
process.env.CANDLE_SPREAD_S3_BUCKET='fake-bucket';
const store=require(R+'/server/src/candle-spread/store');
const A=require(R+'/server/src/candle-spread/run-archive');

(async()=>{
// ── PHASE 1: a normal session. Copy real 09-29 records in and write them through the store.
const src=R+'/candle-spread-archive';
const real=fs.readdirSync(src).filter(f=>f.includes(DATE)).slice(0,80);
if(!real.length){console.error(`no records for ${DATE} in ${src} — pass --date with a day the archive has.`);process.exit(2);}
fs.mkdirSync(STORE,{recursive:true});
let written=0;
for(const f of real){
  const rec=JSON.parse(fs.readFileSync(path.join(src,f),'utf8'));
  store.writeRun(rec); written++;
}
await new Promise(r=>setTimeout(r,400));   // fire-and-forget ships settle
const onDisk=fs.readdirSync(STORE).filter(f=>f.endsWith('.json')).length;
console.log(`PHASE 1  session ran: ${written} records written, ${onDisk} on local disk, ${s3.size} in the archive`);
const sampleId=`NDX_${DATE}_${DATE}_v7-10`;
const beforeBody=fs.readFileSync(path.join(STORE,sampleId+'.json'),'utf8');
const beforeRec=JSON.parse(beforeBody);
const bookBefore={pos:(beforeRec.state.positions||[]).length, realized:beforeRec.state.realizedPnl,
  settled:(beforeRec.events||[]).some(e=>e.type==='eod_settlement')};
console.log(`         v7-10 book: ${bookBefore.pos} positions, realized $${bookBefore.realized}, settled ${bookBefore.settled}`);

// ── PHASE 2: INSTANCE REPLACEMENT. Fresh EBS volume => the store directory is empty.
fs.rmSync(STORE,{recursive:true,force:true});
fs.mkdirSync(STORE,{recursive:true});          // what ensureDir() does on the new volume
console.log(`\nPHASE 2  instance replaced: local store now has ${fs.readdirSync(STORE).length} files (this is the instance-replacement failure)`);

// ── PHASE 3: boot rehydrate.
const res=await A.restoreDay(DATE,STORE);
console.log(`\nPHASE 3  rehydrate: restored ${res.restored}, skipped ${res.skippedPresent}, failed ${res.failed}, ${Math.round(res.bytes/1e6)} MB`);
const afterBody=fs.readFileSync(path.join(STORE,sampleId+'.json'),'utf8');
const afterRec=JSON.parse(afterBody);
const bookAfter={pos:(afterRec.state.positions||[]).length, realized:afterRec.state.realizedPnl,
  settled:(afterRec.events||[]).some(e=>e.type==='eod_settlement')};
console.log(`         v7-10 book: ${bookAfter.pos} positions, realized $${bookAfter.realized}, settled ${bookAfter.settled}`);

const ok=[];
ok.push([`all ${written} records recovered`, res.restored===written]);
ok.push(['byte-identical to pre-loss', afterBody===beforeBody]);
ok.push(['position count preserved', bookAfter.pos===bookBefore.pos && bookBefore.pos>0]);
ok.push(['realized P&L preserved', bookAfter.realized===bookBefore.realized]);
ok.push(['settlement preserved', bookAfter.settled===bookBefore.settled && bookBefore.settled]);
// and the store can now READ it through its own API, which is what the engine does
const viaStore=store.readRun(sampleId);
ok.push(['store.readRun sees the restored book', !!viaStore && (viaStore.state.positions||[]).length===bookBefore.pos]);
// a second rehydrate must be a no-op, never a clobber
const again=await A.restoreDay(DATE,STORE);
ok.push(['second rehydrate is a no-op', again.restored===0 && again.skippedPresent===written]);

console.log();
let bad=0;
for(const [m,c] of ok){ console.log((c?'  OK   ':'  FAIL ')+m); if(!c)bad++; }
fs.rmSync(tmp,{recursive:true,force:true});
console.log(bad? `\n${bad} FAILED` : '\nALL CHECKS PASSED — a real session survives an instance replacement.');
process.exit(bad?1:0);
})();
