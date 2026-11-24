/* Sync engine: pull what changed, merge, push what is new, per record. No DOM, no deps. */
(function(root){
'use strict';

const PAGE=200, ROUNDS=4;

/* JSON with sorted keys, so the same value always compares equal whatever order it was built in */
function canon(x){
  if(Array.isArray(x)) return '['+x.map(canon).join(',')+']';
  if(x&&typeof x==='object') return '{'+Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>JSON.stringify(k)+':'+canon(x[k])).join(',')+'}';
  return JSON.stringify(x);
}

/* state {since, vers, sent} is filled in and updated in place, so a caller that persists it
   after a failed run keeps whatever progress was made. */
function create({api,session,core,state,rooms}){
  const J=rooms||root.JBRooms;
  const st=state||{};
  if(typeof st.since!=='number') st.since=0;
  if(!st.vers||typeof st.vers!=='object') st.vers={};
  if(!st.sent||typeof st.sent!=='object') st.sent={};
  const s={room:session.room,token:session.token}, key=session.key;

  /* every record after st.since, decrypted to [{rid,k,v,ver}] */
  async function pullAll(){
    const out=[];
    for(;;){
      const r=await api.pull(s,st.since);
      const recs=r.records||[];
      for(const rec of recs){
        const x=await J.decrypt(key,rec.blob);
        out.push({rid:rec.rid,k:x.k,v:x.v,ver:rec.ver});
        st.vers[rec.rid]=rec.ver;
        st.sent[rec.rid]=canon({k:x.k,v:x.v});
      }
      if(recs.length) st.since=Math.max(st.since,recs[recs.length-1].seq);
      if(!r.more||!recs.length) break;
    }
    return out;
  }

  async function run(doc){
    doc=core.merge(core.newDoc(),doc||core.newDoc()); // merged form up front, so what we push equals what a later pull merges back
    let pulled=0, pushed=0;
    for(let round=0;round<ROUNDS;round++){
      const got=await pullAll();
      if(got.length){ pulled+=got.length; doc=core.merge(doc,core.implode(got.map(g=>({k:g.k,v:g.v})))); }
      const todo=[];
      for(const r of core.explode(doc)){
        const rid=await J.rid(key,r.k), c=canon({k:r.k,v:r.v});
        if(st.sent[rid]!==c) todo.push({rid,c,k:r.k,v:r.v});
      }
      if(!todo.length) break;
      let refused=0;
      for(let i=0;i<todo.length;i+=PAGE){
        const chunk=todo.slice(i,i+PAGE);
        const items=[];
        for(const t of chunk) items.push({rid:t.rid,ver:st.vers[t.rid]||0,blob:await J.encrypt(key,{k:t.k,v:t.v})});
        const res=await api.push(s,items);
        const byRid={}; for(const x of res.results||[]) byRid[x.rid]=x;
        for(const t of chunk){
          const x=byRid[t.rid];
          if(x&&x.ok){ st.vers[t.rid]=x.ver; st.sent[t.rid]=t.c; pushed++; }
          else refused++;
        }
      }
      if(!refused) break;
    }
    return {doc,state:JSON.parse(JSON.stringify(st)),pulled,pushed};
  }

  return {run,state:st};
}

root.JBSync={create};
})(typeof window!=='undefined'?window:globalThis);
