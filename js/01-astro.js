
/* ╔══════════════════════════════════════════════════════════════════╗
   ║  MODULE · ErrorTrap — on-screen diagnostics for the lab terminal  ║
   ║  Surfaces uncaught errors / rejections with file:line so failures ║
   ║  are never reduced to an opaque "Script error." in the console.   ║
   ╚══════════════════════════════════════════════════════════════════╝ */
(function(){
  let box=null,n=0;
  function show(msg){
    try{
      if(!box){
        box=document.createElement('div');
        box.id='err-trap';
        box.style.cssText='position:fixed;left:10px;bottom:44px;z-index:9999;max-width:560px;max-height:180px;overflow:auto;'+
          'background:rgba(7,7,7,.95);border:1px solid #d66e6e;box-shadow:0 0 22px rgba(214,110,110,.4);'+
          'font:10px "IBM Plex Mono",monospace;color:#d66e6e;padding:8px 10px;white-space:pre-wrap;';
        const x=document.createElement('div');
        x.textContent='✕ DISMISS';
        x.style.cssText='cursor:pointer;color:#d66e6e;font-weight:bold;margin-bottom:4px;letter-spacing:1px;';
        x.onclick=()=>{box.remove();box=null;n=0;};
        box.appendChild(x);
        document.body.appendChild(box);
      }
      if(++n>6) return;
      const d=document.createElement('div');
      d.style.cssText='border-top:1px solid rgba(214,110,110,.3);padding:3px 0;';
      d.textContent='⚠ '+msg;
      box.appendChild(d);
    }catch(e){}
  }
  window.reportRuntimeError=function(msg,err){
    if(benign(msg)) return;
    show(msg+(err&&err.stack?'\n'+String(err.stack).split('\n').slice(1,3).join('\n'):''));
  };
  /* benign browser notices that carry no stack and break nothing — never surface */
  const BENIGN=[/ResizeObserver loop/i];
  function benign(msg){return BENIGN.some(re=>re.test(msg||''));}
  window.addEventListener('error',e=>{
    if(benign(e.message)){e.stopImmediatePropagation&&e.stopImmediatePropagation();return;}
    const src=(e.filename||'').split('/').pop();
    show((e.message||'Script error')+(src?'  @ '+src+':'+e.lineno+':'+e.colno:'')+
      (e.error&&e.error.stack?'\n'+String(e.error.stack).split('\n').slice(0,3).join('\n'):''));
  });
  window.addEventListener('unhandledrejection',e=>{
    const r=e.reason;
    show('UNHANDLED PROMISE: '+(r&&r.message?r.message:String(r))+
      (r&&r.stack?'\n'+String(r.stack).split('\n').slice(0,3).join('\n'):''));
  });
})();
'use strict';
/* ════════════════════════════════════════════════════════════
   CONSTANTS & GLOBALS
════════════════════════════════════════════════════════════ */
const MU_E=398600.4418,WE=7.2921150e-5,RE_KM=6378.137;
const F_WGS=1/298.257223563,E2_WGS=F_WGS*(2-F_WGS);

let SITE={lat_deg:40.7945,lon_deg:-77.8616,h_m:354,tz:'America/New_York',tzOffsetMin:-240};
const NUM_REVS=5;
let currentTLE=null,currentPasses=null,currentData=null;
let propagationTime=null;       // Date when last full propagation ran
let propagationGMST0=null;      // GMST (rad) at propagation start — for ECI Earth rotation
let markerTimer=null;
let trajTimer=null;
let lastPasses=[];

/* ════ CLOCK ════ */
const padZ=n=>String(n).padStart(2,'0');
function fmtUTCTime(d){return padZ(d.getUTCHours())+':'+padZ(d.getUTCMinutes())+':'+padZ(d.getUTCSeconds());}
function fmtUTCShort(d){return padZ(d.getUTCHours())+':'+padZ(d.getUTCMinutes())+':'+padZ(d.getUTCSeconds());}
function fmtDateUTC(d){return d.getUTCFullYear()+'-'+padZ(d.getUTCMonth()+1)+'-'+padZ(d.getUTCDate())+' '+padZ(d.getUTCHours())+':'+padZ(d.getUTCMinutes());}

/* Robust local time formatting.
   Uses Intl with hour12:false but normalises the '24:xx' midnight quirk.
   Falls back to manual UTC-offset arithmetic if the IANA tz string is invalid. */
function fmtLocalTime(d, tz){
  // Primary: Intl (works when tz is a valid IANA string)
  try{
    let fmt=new Intl.DateTimeFormat('en-GB',{   // en-GB always gives HH:MM:SS, no AM/PM
      timeZone:tz,
      hour:'2-digit',minute:'2-digit',second:'2-digit',
      hour12:false
    });
    let str=fmt.format(d);
    // Normalise rare '24:xx:xx' -> '00:xx:xx'
    if(str.startsWith('24')) str='00'+str.slice(2);
    return str;
  }catch(e){}
  // Fallback: apply stored numeric offset (minutes)
  let local=new Date(d.getTime()+SITE.tzOffsetMin*60000);
  return padZ(local.getUTCHours())+':'+padZ(local.getUTCMinutes())+':'+padZ(local.getUTCSeconds());
}

/* Short version (HH:MM only) for pass table / meta strip */
function fmtLocalShort(d, tz){
  return fmtLocalTime(d,tz).slice(0,5);
}

function updateClocks(){
  let now=new Date();
  document.getElementById('utc-clock').textContent=fmtUTCTime(now)+' UTC';
  document.getElementById('local-clock').textContent=fmtLocalTime(now,SITE.tz);
}
setInterval(updateClocks,1000);updateClocks();

function updateLocalTZLabel(){
  try{
    let now=new Date();
    // Recompute offset in case DST changed
    SITE.tzOffsetMin=computeTZOffsetMin(SITE.tz);
    let parts=new Intl.DateTimeFormat('en-GB',{timeZone:SITE.tz,timeZoneName:'short'}).formatToParts(now);
    let tzAbbr=parts.find(p=>p.type==='timeZoneName')?.value||SITE.tz;
    // Also show UTC offset for clarity e.g.  "EDT (UTC-4)"
    let offH=Math.round(SITE.tzOffsetMin/60);
    let offStr='UTC'+(offH>=0?'+':'')+offH;
    document.getElementById('local-tz-label').textContent='LOCAL ('+tzAbbr+' '+offStr+')';
    document.getElementById('site-tz-display').textContent='TZ: '+SITE.tz+'  '+offStr;
    document.getElementById('sky-site-label').textContent='AZ/EL · '+SITE.lat_deg.toFixed(2)+'°N '+Math.abs(SITE.lon_deg).toFixed(2)+'°'+(SITE.lon_deg>=0?'E':'W');
  }catch(e){
    document.getElementById('local-tz-label').textContent='LOCAL (UTC)';
  }
}

/* ════ TIMEZONE LOOKUP ════ */
async function lookupTimezone(lat,lon){
  // 1) timeapi.io — most reliable free API
  try{
    let r=await fetch(`https://timeapi.io/api/timezone/coordinate?latitude=${lat}&longitude=${lon}`,
      {signal:fetchTimeoutSignal(5000)});
    if(r.ok){
      let j=await r.json();
      if(j.timeZone && j.timeZone.includes('/')) return j.timeZone;
    }
  }catch(e){}
  // 2) BigDataCloud reverse geocode (has timezone field)
  try{
    let r=await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`,
      {signal:fetchTimeoutSignal(4000)});
    if(r.ok){
      let j=await r.json();
      // BDC returns 'timezone' at top level since 2023
      if(j.timezone && j.timezone.name) return j.timezone.name;
      if(j.countryCode){
        // Try to get offset from localityInfo
        let off=j.localityInfo?.informative?.find(x=>x.isoName==='UTC Offset');
        if(off) {/* fall through to offset calc */}
      }
    }
  }catch(e){}
  // 3) Fallback: estimate offset from longitude (±15° per hour)
  //    NOTE: Etc/GMT sign is INVERTED vs normal convention
  let offsetHr=Math.round(lon/15);
  // Clamp to ±12
  offsetHr=Math.max(-12,Math.min(12,offsetHr));
  // Etc/GMT-5 = UTC+5, Etc/GMT+5 = UTC-5  (POSIX convention, opposite of intuition)
  let etcSign=offsetHr>=0?'-':'+';
  return 'Etc/GMT'+etcSign+Math.abs(offsetHr);
}

/* Compute tzOffsetMin for a given IANA tz string (used as fallback in fmtLocalTime) */
function computeTZOffsetMin(tz){
  try{
    let now=new Date();
    // Get local time parts in the target tz
    let fmt=new Intl.DateTimeFormat('en-GB',{timeZone:tz,
      year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    let parts=fmt.formatToParts(now);
    let get=t=>parseInt(parts.find(p=>p.type===t).value);
    let localMs=Date.UTC(get('year'),get('month')-1,get('day'),get('hour'),get('minute'),get('second'));
    return Math.round((localMs-now.getTime())/60000);
  }catch(e){return 0;}
}

/* ════ JULIAN DATE & GMST ════ */
function julianDate(dt){
  let y=dt.getUTCFullYear(),mo=dt.getUTCMonth()+1,d=dt.getUTCDate();
  let h=dt.getUTCHours(),mn=dt.getUTCMinutes(),s=dt.getUTCSeconds()+dt.getUTCMilliseconds()/1e3;
  if(mo<=2){y--;mo+=12;}
  let A=Math.floor(y/100),B=2-A+Math.floor(A/4);
  return Math.floor(365.25*(y+4716))+Math.floor(30.6001*(mo+1))+d+B-1524.5+(h+mn/60+s/3600)/24;
}
function gmst_from_jd(JD){
  let T=(JD-2451545.0)/36525.0;
  let s=67310.54841+(876600*3600+8640184.812866)*T+0.093104*T*T-6.2e-6*T*T*T;
  return((s%86400+86400)%86400)/240*Math.PI/180;
}

/* ════ TLE PARSE ════ */
function parseTleSci(s){
  let m=s.slice(0,6).replace(/ /g,'+');
  let sign=m[0]==='-'?-1:1;
  let mant=sign*(parseFloat(m.substring(1))/1e5);
  return mant*Math.pow(10,parseInt(s.slice(6,8),10)||0);
}
function parseTLE(name,l1,l2){
  if(!l1||!l2||l1.length<69||l2.length<69||l1[0]!=='1'||l2[0]!=='2') return null;
  try{
    /* Alpha-5 catalog numbers (above 99999): a leading letter A..Z, skipping I and O, stands for 10..33 */
    const f5=l1.slice(2,7).trim();
    let satnum=/^[A-HJ-NP-Z]\d{4}$/.test(f5)?('ABCDEFGHJKLMNPQRSTUVWXYZ'.indexOf(f5[0])+10)*10000+parseInt(f5.slice(1),10):parseInt(f5,10);
    let yr2=parseInt(l1.slice(18,20));
    let doy=parseFloat(l1.slice(20,32));
    let bstar=0;try{bstar=parseTleSci(l1.slice(53,61));}catch(e){}
    let yr=yr2>=57?1900+yr2:2000+yr2;
    let epoch=new Date(Date.UTC(yr,0,1,0,0,0,0)+(doy-1)*86400000);
    let inc=parseFloat(l2.slice(8,16));
    let raan=parseFloat(l2.slice(17,25));
    let ecc=parseFloat('0.'+l2.slice(26,33).trim());
    let argp=parseFloat(l2.slice(34,42));
    let M=parseFloat(l2.slice(43,51));
    let n=parseFloat(l2.slice(52,63));
    if(isNaN(n)||n<=0) return null;
    let n_rad=n*2*Math.PI/86400;
    let a=Math.pow(MU_E/(n_rad*n_rad),1/3);
    let T_s=86400/n;
    let alt=a-RE_KM;
    let orbitType='LEO';
    if(ecc>0.25&&T_s>43200&&inc>50) orbitType='MOLNIYA';
    else if(ecc>0.15) orbitType='HEO';
    else if(T_s>80000) orbitType='GEO';
    else if(T_s>20000) orbitType='MEO';
    else orbitType='LEO';
    let fp_rad=Math.acos(RE_KM/(RE_KM+alt))*180/Math.PI;
    let fp_km=RE_KM*fp_rad*Math.PI/180;
    // Build SGP4 satrec — used for propagation
    let satrec=null;
    try{if(typeof satellite!=='undefined') satrec=satellite.twoline2satrec(l1,l2);}catch(e){}
    return{name,satnum,epoch,bstar,inc,raan,ecc,argp,M,n,n_rad,a,T_s,alt_km:alt,orbitType,fp_km,satrec};
  }catch(e){return null;}
}

/* TLE age in days relative to the sim epoch. Element sets older than
   TLE_STALE_D are shown dimmed and counted separately: SGP4 error grows
   quickly with age, and very old sets are usually decayed or lost objects. */
const TLE_STALE_D=30;
function tleAgeDays(t){return t&&t.epoch?(EPOCH.ms()-t.epoch.getTime())/86400000:0;}

/* ════ ORBITAL MECHANICS ════ */
function trueFromMean(M,e){
  M=((M%(2*Math.PI))+2*Math.PI)%(2*Math.PI);
  let E=e>0.8?Math.PI:M;
  for(let k=0;k<60;k++){let dE=-(E-e*Math.sin(E)-M)/(1-e*Math.cos(E));E+=dE;if(Math.abs(dE)<1e-13)break;}
  return((2*Math.atan2(Math.sqrt(1+e)*Math.sin(E/2),Math.sqrt(1-e)*Math.cos(E/2)))+2*Math.PI)%(2*Math.PI);
}
function dcmPQW2ECI(Om,inc,w){
  let cO=Math.cos(Om),sO=Math.sin(Om),ci=Math.cos(inc),si=Math.sin(inc),cw=Math.cos(w),sw=Math.sin(w);
  return[cO*cw-sO*sw*ci,-cO*sw-sO*cw*ci,sO*si,sO*cw+cO*sw*ci,-sO*sw+cO*cw*ci,-cO*si,sw*si,cw*si,ci];
}
function mv3(M,v){return[M[0]*v[0]+M[1]*v[1]+M[2]*v[2],M[3]*v[0]+M[4]*v[1]+M[5]*v[2],M[6]*v[0]+M[7]*v[1]+M[8]*v[2]];}
function twoBP(x){
  let rx=x[0],ry=x[1],rz=x[2],rn=Math.sqrt(rx*rx+ry*ry+rz*rz),c=-MU_E/(rn*rn*rn);
  return[x[3],x[4],x[5],c*rx,c*ry,c*rz];
}
function rk4(x,dt){
  let k1=twoBP(x),x2=x.map((v,i)=>v+.5*dt*k1[i]);
  let k2=twoBP(x2),x3=x.map((v,i)=>v+.5*dt*k2[i]);
  let k3=twoBP(x3),x4=x.map((v,i)=>v+dt*k3[i]);
  let k4=twoBP(x4);
  return x.map((v,i)=>v+(dt/6)*(k1[i]+2*k2[i]+2*k3[i]+k4[i]));
}
function geo2ecef(lat,lon,h_m){
  let p=lat*Math.PI/180,l=lon*Math.PI/180,h=h_m/1000;
  let s=Math.sin(p),c=Math.cos(p),N=RE_KM/Math.sqrt(1-E2_WGS*s*s);
  return[(N+h)*c*Math.cos(l),(N+h)*c*Math.sin(l),(N*(1-E2_WGS)+h)*s];
}
function topoRotm(lat,lon){
  let p=lat*Math.PI/180,l=lon*Math.PI/180,sp=Math.sin(p),cp=Math.cos(p),sl=Math.sin(l),cl=Math.cos(l);
  return[-sl,cl,0,-sp*cl,-sp*sl,cp,cp*cl,cp*sl,sp];
}

/* ════ SGP4 PROPAGATOR — adaptive sampling ════
   Uses satellite.js (SGP4/SDP4) for physics.
   Step size adapts to altitude: dense near perigee, sparse at apogee.
   Falls back to two-body RK4 if satrec is unavailable.              */

function adaptiveStep(altKm, T_s){
  // Near perigee: short steps to capture sharp curvature
  // At apogee / GEO: long steps, motion is slow and nearly linear
  // Floor: 10s  Ceiling: min(T_s/60, 300s)
  let ceiling=Math.min(T_s/60, 300);
  let step=Math.max(10, Math.min(ceiling, altKm/30));
  return step;
}

function sgp4ECI(satrec, date){
  // Returns {r:[x,y,z], v:[vx,vy,vz]} in km, km/s ECI  — or null on error
  let m=(date.getTime()-Date.UTC(1970,0,1))/60000; // minutes since Unix epoch
  // satellite.js wants minutes since epoch
  let minutesSinceEpoch=(date-satrec.jdsatepoch_ms)/60000;
  // Use propagateFromMinutesAfterEpoch if available, otherwise propagate with date
  let pv;
  try{
    pv=satellite.propagate(satrec, date);
  }catch(e){return null;}
  if(!pv||!pv.position||pv.position===true) return null;
  return{r:[pv.position.x,pv.position.y,pv.position.z],
         v:[pv.velocity.x,pv.velocity.y,pv.velocity.z]};
}


/* ╔══════════════════════════════════════════════════════════════════╗
   ║  MODULE · EpochClock — synchronous global sim-time pipeline       ║
   ║  One master clock drives BOTH computation frameworks in lockstep: ║
   ║  SGP4 satellite positions (tracker + catalog) and the Horizons/   ║
   ║  Standish planetary ephemerides (solar-system map, charts).       ║
   ╚══════════════════════════════════════════════════════════════════╝ */
/* robust fetch timeout: AbortSignal.timeout() is unavailable on older lab
   browsers — every network failure traced back to this. Polyfill-safe helper. */
/* Network routing.
   CelesTrak and OrbitSmith allow direct browser requests. JPL's SSD APIs
   (Horizons, Horizons Lookup, SBDB) do not, so the browser blocks their
   responses. The free public proxies this page used to rely on (corsproxy.io,
   allorigins) no longer serve production sites. JPL requests therefore go
   through the lab's own relay: proxy/jpl-proxy-worker.js in this repo.
   Set JPL_PROXY_DEFAULT to the deployed Worker URL, or open the page once
   with ?proxy=<url> (remembered in this browser). */
const JPL_PROXY_DEFAULT='https://ssa-jpl.roshanthomase.workers.dev/';
const JPL_PROXY=(()=>{
  try{
    const q=new URLSearchParams(location.search);
    if(q.has('proxy')){const v=q.get('proxy').trim();
      if(v) localStorage.setItem('ssa.jplProxy',v); else localStorage.removeItem('ssa.jplProxy');}
    return localStorage.getItem('ssa.jplProxy')||JPL_PROXY_DEFAULT;
  }catch(e){return JPL_PROXY_DEFAULT;}
})();
const NEEDS_RELAY=/^https:\/\/(ssd|ssd-api)\.jpl\.nasa\.gov\//;
function urlChain(u){
  if(NEEDS_RELAY.test(u)) return JPL_PROXY?[JPL_PROXY+(JPL_PROXY.includes('?')?'&':'?')+'url='+encodeURIComponent(u)]:[u];
  return [u];
}
const JPL_BLOCKED_MSG='JPL Horizons does not accept requests made directly from web pages, so this tab needs the lab relay. See proxy/README.md in the repository.';
document.addEventListener('DOMContentLoaded',()=>{const n=document.getElementById('eph-relay-note');
  if(n&&!JPL_PROXY) n.textContent='Note: no JPL relay is configured, so requests to Horizons will be blocked by the browser. See proxy/README.md.';});
function fetchTimeoutSignal(ms){
  try{if(typeof AbortSignal!=='undefined'&&AbortSignal.timeout) return AbortSignal.timeout(ms);}catch(e){}
  try{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;}catch(e){return undefined;}
}

/* full public catalog (every tracked object CelesTrak publishes) with download
   progress; tries TLE-format GP dump first, then the classic catalog file. */
async function fetchFullCatalog(onProgress){
  const bases=['https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
               'https://celestrak.org/pub/TLE/catalog.txt'];
  /* catalog.txt is the strict superset (payloads + R/B + debris, ~28k);
     try it FIRST, fall back to the active GP group */
  bases.reverse();
  for(const base of bases){
    const urls=urlChain(base);
    for(const u of urls){
      try{
        const r=await fetch(u,{cache:'no-store',signal:fetchTimeoutSignal(60000)});
        if(!r.ok) continue;
        let txt='';
        if(r.body&&r.body.getReader){
          const rd=r.body.getReader(),dec=new TextDecoder();
          let got=0;
          for(;;){
            const{done,value}=await rd.read();
            if(done) break;
            got+=value.length;txt+=dec.decode(value,{stream:true});
            if(onProgress) onProgress(got);
          }
          txt+=dec.decode();
        } else txt=await r.text();
        if(/^1 \d{5}/m.test(txt)&&/^2 \d{5}/m.test(txt)&&!/<html/i.test(txt.slice(0,400))&&txt.length>50000) return txt;
      }catch(e){}
    }
  }
  return null;
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  MODULE · OrbitSmith public static data client                    ║
   ║  Static JSON snapshots (no API key) — serves three roles here:     ║
   ║   1. full ~34.6k catalog with object_type for the type filter     ║
   ║   2. offline / fallback catalog source when CelesTrak is blocked   ║
   ║   3. reentry-watch + active-catalog statistics for DISCOVERY       ║
   ║  Non-operational data — display & triage only (per OrbitSmith).    ║
   ╚══════════════════════════════════════════════════════════════════╝ */
const OS={
  BASE:'https://orbitsmith.net/data/orbitsmith',

  attribution:'OrbitSmith · Space-Track/18 SDS · CelesTrak',
  /* direct fetch first (CORS-open static host), then public proxies */
  async _json(url,ms){
    for(const u of urlChain(url)){
      try{
        const r=await fetch(u,{cache:'no-store',signal:fetchTimeoutSignal(ms||15000)});
        if(!r.ok) continue;
        const j=await r.json();
        if(j&&typeof j==='object') return j;
      }catch(e){}
    }
    return null;
  },
  /* small bounded-concurrency map so 35 shards don't fire 35 sockets at once */
  async _pool(items,worker,conc){
    const out=new Array(items.length);let idx=0;
    const run=async()=>{ while(idx<items.length){const i=idx++;out[i]=await worker(items[i],i);} };
    await Promise.all(Array.from({length:Math.min(conc||6,items.length)},run));
    return out;
  },
  _normType(s){
    if(!s) return 'UNKNOWN';
    s=String(s).toUpperCase();
    if(s.indexOf('PAYLOAD')>=0) return 'PAYLOAD';
    if(s.indexOf('ROCKET')>=0||s==='R/B') return 'RB';
    if(s.indexOf('DEBRIS')>=0) return 'DEBRIS';
    return 'UNKNOWN';
  },
  /* FULL CATALOG → array of parseTLE objects tagged with objType/orbitClass/rcs.
     Returns null only if every shard (direct + proxied) is unreachable. */
  async fetchCatalog(onProgress,onPartial){
    let idx=await this._json(this.BASE+'/gp/index/latest.json',20000);
    let shardUrls=null;
    if(idx&&Array.isArray(idx.shards)&&idx.shards.length){
      shardUrls=idx.shards.map(s=>s.url||(this.BASE+'/'+s.path));
    }else{
      /* index unreachable → derive the 35 known shard paths 000..034 */
      shardUrls=[];for(let i=0;i<35;i++) shardUrls.push(this.BASE+'/gp/shards/'+String(i).padStart(3,'0')+'.json');
    }
    const total=shardUrls.length;let done=0,gotAny=false;
    const byNorad=new Map();
    await this._pool(shardUrls,async(u)=>{
      const j=await this._json(u,30000);
      done++;
      if(onProgress) onProgress(done,total,byNorad.size);
      if(!j||!Array.isArray(j.records)) return;
      gotAny=true;
      for(const rec of j.records){
        if(byNorad.has(rec.norad_id)) continue;
        const t=parseTLE(rec.name||('OBJ '+rec.norad_id),rec.tle_line1,rec.tle_line2);
        if(!t||!t.satrec) continue;
        t.objType=this._normType(rec.object_type);
        t.orbitClass=rec.orbit_class||t.orbitType;
        t.rcs=rec.rcs_size||null;
        t.rawL1=rec.tle_line1;t.rawL2=rec.tle_line2;
        byNorad.set(rec.norad_id,t);
      }
      if(onPartial) onPartial(byNorad);
    },6);
    if(!gotAny) return null;
    return [...byNorad.values()];
  },
  fetchReentry(){ return this._json(this.BASE+'/reentry/latest.json',15000); },
  fetchStatsToday(){ return this._json(this.BASE+'/statistics/today.json',12000); },
  fetchStatsRecent(){ return this._json(this.BASE+'/statistics/recent.json',15000); }
};
