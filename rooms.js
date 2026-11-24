/* Rooms client: encoding, encryption, invite links, HTTP api, encrypted doc store. No DOM, no deps. */
(function(root){
'use strict';

class RoomError extends Error{
  constructor(status,code,extra){ super(code); this.name='RoomError'; this.status=status; this.code=code; if(extra&&extra.ver!==undefined) this.ver=extra.ver; }
}

/* ---------- base64url, no padding ---------- */
const b64u={
  enc(bytes){
    let bin=''; for(let i=0;i<bytes.length;i+=0x8000) bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
    return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  },
  dec(s){
    s=String(s).replace(/-/g,'+').replace(/_/g,'/'); while(s.length%4) s+='=';
    const bin=atob(s), out=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
    return out;
  }
};
const rand=n=>b64u.enc(root.crypto.getRandomValues(new Uint8Array(n)));
const newKey=()=>rand(32);

/* ---------- AES-GCM over JSON: "v1." + iv + "." + ciphertext ---------- */
const keyErr=()=>new RoomError(0,'key');
/* two subkeys from the room key (HKDF-SHA256): one for AES-GCM, one for the record-id HMAC */
async function subkey(key,info,alg,use){
  const base=await root.crypto.subtle.importKey('raw',b64u.dec(key),'HKDF',false,['deriveKey']);
  return root.crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(0),info:new TextEncoder().encode(info)},base,alg,false,[use]);
}
const importKey=(k,use)=>subkey(k,'rooms-enc-v1',{name:'AES-GCM',length:256},use);
async function encrypt(key,obj){
  const iv=root.crypto.getRandomValues(new Uint8Array(12));
  const ck=await importKey(key,'encrypt');
  const ct=await root.crypto.subtle.encrypt({name:'AES-GCM',iv},ck,new TextEncoder().encode(JSON.stringify(obj)));
  return 'v1.'+b64u.enc(iv)+'.'+b64u.enc(new Uint8Array(ct));
}
async function decrypt(key,str){
  try{
    const p=String(str).split('.');
    if(p.length!==3||p[0]!=='v1') throw 0;
    const iv=b64u.dec(p[1]); if(iv.length!==12) throw 0;
    const ck=await importKey(key,'decrypt');
    const pt=await root.crypto.subtle.decrypt({name:'AES-GCM',iv},ck,b64u.dec(p[2]));
    return JSON.parse(new TextDecoder().decode(pt));
  }catch(e){ throw keyErr(); }
}

/* ---------- invite links: base#j=room.invite.key ---------- */
const NAME_MAX=24;
function makeLink(base,{room,invite,key,name}){
  const n=Array.from(String(name||'')).slice(0,NAME_MAX).join('');
  return base+'#j='+room+'.'+invite+'.'+key+(n?'&n='+encodeURIComponent(n):'');
}
const LINK_RE=/(?:^|[#?&\s])j=([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])(?:&n=([^&\s#]*))?/;
function parseLink(s){
  if(typeof s!=='string') return null;
  const m=s.match(LINK_RE);
  if(!m) return null;
  let name=''; try{ name=decodeURIComponent(m[4]||''); }catch(e){ name=''; }
  return {room:m[1],invite:m[2],key:m[3],name:Array.from(name).slice(0,NAME_MAX).join('')};
}

/* ---------- HTTP api ---------- */
function api(base,fetchImpl,opts){
  base=String(base).replace(/\/+$/,'');
  // A stalled request (a weak Wi-Fi link can hold one for minutes) is given up as offline, so the
  // one-at-a-time sync is never stuck behind it; the caller retries like any offline failure.
  const limit=(opts&&opts.timeoutMs)||30000; // a full page (600 KB push, 500-record pull) fits in 30 s even at ~20 KB/s
  const doFetch=(u,o)=>(fetchImpl||root.fetch)(u,o);
  async function send(method,path,s,body,signal){
    const headers={};
    if(s) headers.Authorization='Bearer '+s.token;
    const opt={method,headers};
    if(signal) opt.signal=signal;
    if(body!==undefined){ headers['Content-Type']='application/json'; opt.body=JSON.stringify(body); }
    let res;
    try{ res=await doFetch(base+'/v1'+path,opt); }catch(e){ throw new RoomError(0,'offline'); }
    let data=null;
    if(res.status!==204){ try{ data=await res.json(); }catch(e){ if(signal&&signal.aborted) throw new RoomError(0,'offline'); data=null; } }
    if(!res.ok) throw new RoomError(res.status,(data&&data.error)||'http',data||undefined);
    return data;
  }
  function call(method,path,s,body){
    if(!root.setTimeout) return send(method,path,s,body,null);
    const ac=root.AbortController?new root.AbortController():null;
    let timer;
    const late=new Promise((res,rej)=>{ timer=root.setTimeout(()=>{ if(ac) ac.abort(); rej(new RoomError(0,'offline')); },limit); });
    return Promise.race([send(method,path,s,body,ac&&ac.signal),late]).finally(()=>root.clearTimeout(timer));
  }
  const r=s=>'/rooms/'+s.room;
  return {
    createRoom:label=>call('POST','/rooms',null,{label}),
    invite:s=>call('POST',r(s)+'/invites',s),
    revokeInvites:s=>call('DELETE',r(s)+'/invites',s),
    join:(room,invite,label)=>call('POST','/rooms/'+room+'/join',null,{invite,label}),
    pull:(s,since)=>call('GET',r(s)+'/records?since='+(since|0),s),
    push:(s,records)=>call('POST',r(s)+'/records',s,{records}),
    devices:s=>call('GET',r(s)+'/devices',s),
    revoke:(s,id)=>call('DELETE',r(s)+'/devices/'+id,s),
    end:s=>call('DELETE',r(s),s)
  };
}

/* ---------- record id: HMAC of a name under the room key, so the server never sees names ---------- */
async function rid(key,name){
  const ck=await subkey(key,'rooms-rid-v1',{name:'HMAC',hash:'SHA-256',length:256},'sign');
  const sig=await root.crypto.subtle.sign('HMAC',ck,new TextEncoder().encode(String(name)));
  return b64u.enc(new Uint8Array(sig)).slice(0,22);
}

root.JBRooms={b64u,rand,newKey,encrypt,decrypt,makeLink,parseLink,RoomError,api,rid};
})(typeof window!=='undefined'?window:globalThis);
