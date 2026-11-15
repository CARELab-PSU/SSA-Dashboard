const EPHSVC={
  mem:{},            /* in-memory packet cache  cmd|window → pack */
  _db:null,_dbFail:false,

  /* ───── IndexedDB layer (graceful in-memory fallback) ───── */
  idb(){
    if(this._db||this._dbFail) return Promise.resolve(this._db);
    return new Promise(res=>{
      try{
        const rq=indexedDB.open('ssa-ephem-cache',1);
        rq.onupgradeneeded=()=>rq.result.createObjectStore('vectors');
        rq.onsuccess=()=>{this._db=rq.result;res(this._db);};
        rq.onerror=()=>{this._dbFail=true;res(null);};
      }catch(e){this._dbFail=true;res(null);}
    });
  },
  async idbGet(key){
    const db=await this.idb();if(!db)return null;
    return new Promise(res=>{
      try{
        const rq=db.transaction('vectors').objectStore('vectors').get(key);
        rq.onsuccess=()=>res(rq.result||null);rq.onerror=()=>res(null);
      }catch(e){res(null);}
    });
  },
  async idbPut(key,val){
    const db=await this.idb();if(!db)return;
    try{db.transaction('vectors','readwrite').objectStore('vectors').put(val,key);}catch(e){}
  },

  async fetchText(url){
    const urls=urlChain(url);
    for(const u of urls){
      try{
        const r=await fetch(u,{signal:fetchTimeoutSignal(20000)});
        if(!r.ok) continue;
        const t=await r.text();
        if(t.length>50) return t;
      }catch(e){}
    }
    return null;
  },

  /* major solar-system bodies are NOT in the Small-Body Database — resolve
     them locally against the Horizons major-body command table first */
  MAJORS:[
    {n:'Sun',c:'10'},{n:'Moon (Luna)',c:'301'},{n:'Mercury',c:'199'},{n:'Venus',c:'299'},
    {n:'Mars',c:'499'},{n:'Jupiter',c:'599'},{n:'Saturn',c:'699'},{n:'Uranus',c:'799'},
    {n:'Neptune',c:'899'},{n:'Pluto',c:'999'},
    {n:'Phobos (Mars I)',c:'401'},{n:'Deimos (Mars II)',c:'402'},
    {n:'Io (Jupiter I)',c:'501'},{n:'Europa (Jupiter II)',c:'502'},
    {n:'Ganymede (Jupiter III)',c:'503'},{n:'Callisto (Jupiter IV)',c:'504'},
    {n:'Mimas (Saturn I)',c:'601'},{n:'Enceladus (Saturn II)',c:'602'},
    {n:'Titan (Saturn VI)',c:'606'},{n:'Iapetus (Saturn VIII)',c:'608'},
    {n:'Titania (Uranus III)',c:'703'},{n:'Triton (Neptune I)',c:'801'},
    {n:'Charon (Pluto I)',c:'901'}
  ],
  majorLookup(q){
    const s=q.toLowerCase().replace(/[^a-z0-9 ]/g,'');
    if(s.length<2) return null;
    const hits=this.MAJORS.filter(m=>m.n.toLowerCase().includes(s));
    if(hits.length===1) return{ok:true,cmd:hits[0].c,name:hits[0].n,kind:'major',orbitClass:'MAJOR BODY'};
    if(hits.length>1) return{multi:hits.slice(0,8).map(m=>({cmd:m.c,name:m.n}))};
    return null;
  },

  /* ───── Universal search ─────
     1. local major-body table (instant)
     2. Horizons Lookup API: spacecraft, planets, moons, asteroids, comets,
        including aliases ("Integrity" → Artemis II). It matches whole words, so
        a run-together retry is made ("john junkins" → "johnjunkins").
     3. SBDB as a last resort for provisional designations.
     Returns {ok:true,cmd,name,kind,orbitClass} | {multi:[…]} | {none:true} | {err:true} */
  hzItem(r){
    const type=(r.type||'').toLowerCase(),name=(r.name||r.pdes||'').trim();
    let cmd,kind;
    if(type.includes('spacecraft')){cmd=String(r.spkid);kind='sc';}
    else if(type.includes('comet')){cmd='DES='+r.pdes+';CAP';kind='small';}
    else if(type.includes('asteroid')){
      const m=name.match(/^(\d+)\s/);
      cmd=m?m[1]+';':'DES='+r.pdes+';';kind='small';
    } else {cmd=String(r.spkid);kind='major';}
    return{cmd,name,kind,type:r.type||'',alias:(r.alias||[]).filter(a=>/[a-z]/i.test(a)).slice(0,3)};
  },
  async hzLookup(q){
    const txt=await this.fetchText('https://ssd.jpl.nasa.gov/api/horizons_lookup.api?sstr='+encodeURIComponent(q));
    if(!txt) return null;
    try{const j=JSON.parse(txt);return Array.isArray(j.result)?j.result:[];}catch(e){return null;}
  },
  async sbdbLookup(q){
    const mj=this.majorLookup(q);
    if(mj) return mj;
    let res=await this.hzLookup(q);
    const squashed=q.replace(/[\s_-]+/g,'');
    if(res&&!res.length&&squashed!==q) res=await this.hzLookup(squashed);
    if(res&&res.length){
      const items=res.map(r=>this.hzItem(r));
      if(items.length===1) return{ok:true,...items[0],orbitClass:items[0].type};
      return{multi:items.slice(0,12)};
    }
    /* SBDB fallback (provisional designations, partial matches) */
    const txt=await this.fetchText('https://ssd-api.jpl.nasa.gov/sbdb.api?sstr='+encodeURIComponent(q));
    if(!txt) return res===null?{err:true,q}:{none:true,q};
    let j;try{j=JSON.parse(txt);}catch(e){return{err:true,q};}
    if(j.object){
      const des=j.object.des||j.object.spkid;
      const cmd=j.object.kind&&j.object.kind[0]==='c'?'DES='+des+';CAP':des+';';
      return{ok:true,cmd,name:(j.object.fullname||des).trim(),kind:'small',
             orbitClass:j.object.orbit_class?j.object.orbit_class.name:null};
    }
    if(j.code==='300'&&j.list&&j.list.length){
      return{multi:j.list.slice(0,8).map(o=>({cmd:o.pdes?o.pdes+';':'DES='+o.name+';CAP',name:o.name||o.pdes,kind:'small',type:''}))};
    }
    return{none:true,q};
  },

  /* Horizons answers a request outside a target's data span with one line:
     No ephemeris for target "X" after A.D. 2026-APR-10 23:54:22.8576 TDB
     (or "prior to"). Parse it so the UI can say so and re-aim the window. */
  coverage(txt){
    const m=txt&&txt.match(/No ephemeris for target "([^"]+)" (after|prior to) A\.D\. (\d{4})-([A-Z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if(!m) return null;
    const MON={JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11};
    /* TDB is ~69 s ahead of UTC; a minute's margin keeps the retry inside the span */
    const d=new Date(Date.UTC(+m[3],MON[m[4]],+m[5],+m[6],+m[7],+m[8])-69000);
    return{name:m[1],side:m[2]==='after'?'end':'start',date:d};
  },
  /* geocentric ICRF state vectors in km, N equal steps over [t0,t1] */
  async geoVectors(cmd,t0,t1,n){
    const fmt=d=>"'"+d.toISOString().slice(0,19).replace('T',' ')+"'";
    const p=new URLSearchParams({
      format:'text',COMMAND:"'"+cmd+"'",OBJ_DATA:'NO',MAKE_EPHEM:'YES',
      EPHEM_TYPE:'VECTORS',CENTER:"'500@399'",REF_PLANE:'FRAME',
      START_TIME:fmt(t0),STOP_TIME:fmt(t1),STEP_SIZE:"'"+(n||400)+"'",
      VEC_TABLE:'2',OUT_UNITS:'KM-S',CSV_FORMAT:'YES',VEC_LABELS:'NO'});
    const txt=await this.fetchText('https://ssd.jpl.nasa.gov/api/horizons.api?'+p.toString());
    if(!txt) return{err:'network'};
    const cov=this.coverage(txt);
    if(cov) return{cov};
    const pack=this.parseVectors(txt);
    if(!pack) return{err:(txt.match(/API ERROR[^\n]*|Cannot[^\n]*|No [^\n]*/)||['Unexpected Horizons response'])[0]};
    return{pack};
  },
  /* trajectory around the sim epoch; if Horizons has no data there, slide the
     window onto the edge of the target's coverage and report it */
  async trajectory(cmd,spanDays){
    /* Each "No ephemeris after/prior to" answer gives one edge of the target's
       data span. Clamp the window to every edge learned so far; short
       missions (Artemis II: 8 days) can report both. */
    const now=EPOCH.ms(),span=spanDays*86400000;
    let lo=-Infinity,hi=Infinity,t0=now-span/2,t1=now+span/2,r=null;
    for(let k=0;k<4;k++){
      r=await this.geoVectors(cmd,new Date(t0),new Date(t1));
      if(!r.cov) break;
      if(r.cov.side==='end') hi=Math.min(hi,r.cov.date.getTime()-300000);
      else lo=Math.max(lo,r.cov.date.getTime()+300000);
      if(hi<lo) return{err:'no data'};
      if(t1>hi){t1=hi;t0=Math.max(lo,t1-span);}
      if(t0<lo){t0=lo;t1=Math.min(hi,t0+span);}
    }
    if(!r||!r.pack) return{err:(r&&r.err)||'no data'};
    let cov=null;
    if(now>hi) cov={side:'end',date:new Date(hi+300000)};
    else if(now<lo) cov={side:'start',date:new Date(lo-300000)};
    return{pack:r.pack,t0:new Date(t0),t1:new Date(t1),cov};
  },

  /* ───── state-vector packets (heliocentric ecliptic J2000, AU & AU/d) ───── */
  async getVectors(cmd,spanDays=16,stepH=6){
    const day=new Date().toISOString().slice(0,10);
    const key=cmd+'|'+day+'|'+spanDays+'|'+stepH;
    if(this.mem[key]) return this.mem[key];
    const stored=await this.idbGet(key);
    if(stored){this.mem[key]=stored;return stored;}
    const t0=new Date(Date.now()-2*86400000);
    const t1=new Date(t0.getTime()+spanDays*86400000);
    const fmt=d=>"'"+d.toISOString().slice(0,16).replace('T',' ')+"'";
    const p=new URLSearchParams({
      format:'text',COMMAND:"'"+cmd+"'",OBJ_DATA:'NO',MAKE_EPHEM:'YES',
      EPHEM_TYPE:'VECTORS',CENTER:"'500@10'",REF_PLANE:'ECLIPTIC',
      START_TIME:fmt(t0),STOP_TIME:fmt(t1),STEP_SIZE:"'"+stepH+" h'",
      VEC_TABLE:'2',OUT_UNITS:'AU-D',CSV_FORMAT:'YES',VEC_LABELS:'NO'});
    const txt=await this.fetchText('https://ssd.jpl.nasa.gov/api/horizons.api?'+p.toString());
    if(!txt) return null;
    const pack=this.parseVectors(txt);
    if(pack){this.mem[key]=pack;this.idbPut(key,pack);}
    return pack;
  },
  /* CSV rows: JDTDB, Cal, X, Y, Z, VX, VY, VZ */
  parseVectors(txt){
    const i0=txt.indexOf('$$SOE'),i1=txt.indexOf('$$EOE');
    if(i0<0||i1<0) return null;
    const jd=[],P=[],V=[];
    txt.slice(i0+5,i1).split('\n').forEach(l=>{
      const c=l.trim().split(',').map(s=>s.trim());
      if(c.length<8) return;
      const j=parseFloat(c[0]);if(!isFinite(j)) return;
      jd.push(j);
      P.push([+c[2],+c[3],+c[4]]);
      V.push([+c[5],+c[6],+c[7]]);
    });
    if(jd.length<2) return null;
    return{jd0:jd[0],jd1:jd[jd.length-1],h:jd[1]-jd[0],jd,P,V};
  },

  /* ───── cubic Hermite interpolation over a vector packet ─────
     p(s)=h00·p0+h10·h·v0+h01·p1+h11·h·v1 — C¹ continuous because the
     segment endpoints share exact JPL velocities. */
  posAt(pack,jd){
    if(!pack||jd<pack.jd0||jd>pack.jd1) return null;
    let i=Math.min(pack.jd.length-2,Math.max(0,Math.floor((jd-pack.jd0)/pack.h)));
    while(i>0&&jd<pack.jd[i]) i--;
    while(i<pack.jd.length-2&&jd>pack.jd[i+1]) i++;
    const h=pack.jd[i+1]-pack.jd[i];
    const s=(jd-pack.jd[i])/h,s2=s*s,s3=s2*s;
    const h00=2*s3-3*s2+1,h10=s3-2*s2+s,h01=-2*s3+3*s2,h11=s3-s2;
    const p0=pack.P[i],p1=pack.P[i+1],v0=pack.V[i],v1=pack.V[i+1];
    const out=[0,0,0];
    for(let k=0;k<3;k++) out[k]=h00*p0[k]+h10*h*v0[k]+h01*p1[k]+h11*h*v1[k];
    return out;
  },
  velAt(pack,jd){ /* AU/day, analytic Hermite derivative */
    if(!pack||jd<pack.jd0||jd>pack.jd1) return null;
    let i=Math.min(pack.jd.length-2,Math.max(0,Math.floor((jd-pack.jd0)/pack.h)));
    while(i>0&&jd<pack.jd[i]) i--;
    while(i<pack.jd.length-2&&jd>pack.jd[i+1]) i++;
    const h=pack.jd[i+1]-pack.jd[i];
    const s=(jd-pack.jd[i])/h;
    const d00=(6*s*s-6*s)/h,d10=(3*s*s-4*s+1),d01=(-6*s*s+6*s)/h,d11=(3*s*s-2*s);
    const p0=pack.P[i],p1=pack.P[i+1],v0=pack.V[i],v1=pack.V[i+1];
    const out=[0,0,0];
    for(let k=0;k<3;k++) out[k]=d00*p0[k]+d10*v0[k]+d01*p1[k]+d11*v1[k];
    return out;
  }
};

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  MODULE · FrameBridge — unified scene transformation layer        ║
   ║  Maps both tracking classes into ONE world space (heliocentric    ║
   ║  ecliptic J2000, AU):                                             ║
   ║    deep-space:  already heliocentric ecliptic       → identity    ║
   ║    satellites:  ECI equatorial km → rotate by −ε about X into     ║
   ║                 ecliptic, ÷AU, + Earth's heliocentric position    ║
   ╚══════════════════════════════════════════════════════════════════╝ */
const BRIDGE={
  EPS:23.439291*Math.PI/180,
  eqToEcl(v){ /* equatorial → ecliptic (rotate about X by −ε) */
    const ce=Math.cos(this.EPS),se=Math.sin(this.EPS);
    return[v[0],ce*v[1]+se*v[2],-se*v[1]+ce*v[2]];
  },
  eclToEq(v){
    const ce=Math.cos(this.EPS),se=Math.sin(this.EPS);
    return[v[0],ce*v[1]-se*v[2],se*v[1]+ce*v[2]];
  },
  earthHelio(jd){return SS.planetPos('Earth',jd);},          /* AU, ecliptic */
  eciKmToHelioAU(rECI,jd){
    const e=this.eqToEcl(rECI);
    const E=this.earthHelio(jd);
    return[E[0]+e[0]/AU_KM,E[1]+e[1]/AU_KM,E[2]+e[2]/AU_KM];
  },
  helioAUToEarthKm(rHel,jd){ /* heliocentric AU → geocentric equatorial km */
    const E=this.earthHelio(jd);
    const g=[(rHel[0]-E[0])*AU_KM,(rHel[1]-E[1])*AU_KM,(rHel[2]-E[2])*AU_KM];
    return this.eclToEq(g);
  }
};

/* ════ V3 · SOLAR SYSTEM ORBIT VIEWER (heliocentric, ecliptic J2000) ════
   Planetary positions from the JPL/Standish mean-element ephemeris
   (Table 1, "Keplerian Elements for Approximate Positions of the Major
   Planets", valid 1800–2050 AD, accuracy ≲ arcminutes). Small-body orbits
   come live from JPL Horizons osculating ELEMENTS queries.                 */
const SS={
  three:null,inited:false,
  get jd(){return EPOCH.jd();},      /* lockstep: solar-system epoch = global clock */
  follow:null,                       /* body name the camera is focused on */
  pExp:0.42,K:230,trueScale:false,   /* display radius D(r)=K·r^pExp (compact) or linear (true) */
  bodies:[],smalls:[],orbitLines:[],gridGrp:null,
  _ray:null,_mouse:null,_mouseEv:null,_hoverLast:0,sel:null,

  /* a(AU), e, I°, L°, ϖ°, Ω°  +  rates per Julian century (Standish 1800–2050) */
  EL:{
    Mercury:[[0.38709927,0.20563593,7.00497902,252.25032350,77.45779628,48.33076593],
             [0.00000037,0.00001906,-0.00594749,149472.67411175,0.16047689,-0.12534081]],
    Venus:  [[0.72333566,0.00677672,3.39467605,181.97909950,131.60246718,76.67984255],
             [0.00000390,-0.00004107,-0.00078890,58517.81538729,0.00268329,-0.27769418]],
    Earth:  [[1.00000261,0.01671123,-0.00001531,100.46457166,102.93768193,0.0],
             [0.00000562,-0.00004392,-0.01294668,35999.37244981,0.32327364,0.0]],
    Mars:   [[1.52371034,0.09339410,1.84969142,-4.55343205,-23.94362959,49.55953891],
             [0.00001847,0.00007882,-0.00813131,19140.30268499,0.44441088,-0.29257343]],
    Jupiter:[[5.20288700,0.04838624,1.30439695,34.39644051,14.72847983,100.47390909],
             [-0.00011607,-0.00013253,-0.00183714,3034.74612775,0.21252668,0.20469106]],
    Saturn: [[9.53667594,0.05386179,2.48599187,49.95424423,92.59887831,113.66242448],
             [-0.00125060,-0.00050991,0.00193609,1222.49362201,-0.41897216,-0.28867794]],
    Uranus: [[19.18916464,0.04725744,0.77263783,313.23810451,170.95427630,74.01692503],
             [-0.00196176,-0.00004397,-0.00242939,428.48202785,0.40805281,0.04240589]],
    Neptune:[[30.06992276,0.00859048,1.77004347,-55.12002969,44.96476227,131.78422574],
             [0.00026291,0.00005105,0.00035372,218.45945325,-0.32241464,-0.00508664]],
    Pluto:  [[39.48211675,0.24882730,17.14001206,238.92903833,224.06891629,110.30393684],
             [-0.00031596,0.00005170,0.00004818,145.20780515,-0.04062942,-0.01183482]]
  },
  STYLE:{
    Mercury:{c:'#e0e0e0',r:5}, Venus:{c:'#e0e0e0',r:7}, Earth:{c:'#d5d5d5',r:7},
    Mars:{c:'#d66e6e',r:6},   Jupiter:{c:'#d6d6d6',r:11},Saturn:{c:'#e0e0e0',r:10},
    Uranus:{c:'#e0e0e0',r:8}, Neptune:{c:'#aeaeae',r:8}, Pluto:{c:'#d9d9d9',r:4}
  },
  CMD:{Mercury:'199',Venus:'299',Mars:'499',Jupiter:'599',Saturn:'699',
       Uranus:'799',Neptune:'899',Pluto:'999',Earth:null},
  /* approximate osculating elements (J2000 ecliptic, epoch ~2026.0) so famous
     minor bodies populate the map immediately; live Horizons fetches refine them */
  PRESET_ELS:{
    '1;':   {name:'1 Ceres',   a:2.7666,e:0.0789,i:10.587,Om:80.27, w:73.74, M0:188.7,epoch:2461000.5},
    '4;':   {name:'4 Vesta',   a:2.3614,e:0.0900,i:7.142, Om:103.81,w:151.66,M0:255.6,epoch:2461000.5},
    '2;':   {name:'2 Pallas',  a:2.7700,e:0.2302,i:34.93, Om:172.91,w:310.87,M0:130.1,epoch:2461000.5},
    '433;': {name:'433 Eros',  a:1.4580,e:0.2227,i:10.828,Om:304.27,w:178.90,M0:55.2, epoch:2461000.5},
    '99942;':{name:'99942 Apophis',a:0.9224,e:0.1914,i:3.34,Om:203.96,w:126.68,M0:215.5,epoch:2461000.5},
    'DES=1P;CAP':{name:'1P/Halley',a:17.93,e:0.9679,i:162.19,Om:59.07,w:112.26,M0:38.8,epoch:2461000.5},
    'DES=2P;CAP':{name:'2P/Encke', a:2.218,e:0.8483,i:11.78,Om:334.56,w:187.34,M0:160.1,epoch:2461000.5}
  },
  presetEls(cmd){
    const p=this.PRESET_ELS[cmd];
    if(!p) return null;
    const n=0.9856076686/Math.pow(p.a,1.5); /* deg/day */
    return{a:p.a,e:p.e,i:p.i*D2R,Om:p.Om*D2R,w:p.w*D2R,M0:p.M0,n,epoch:p.epoch};
  },

  solveKepler(M,e){ /* bisection-safeguarded Newton — f(E)=E−e·sinE−M is monotone, so this always converges, even e→0.99 */
    M=((M%(2*Math.PI))+3*Math.PI)%(2*Math.PI)-Math.PI;
    let lo=-Math.PI,hi=Math.PI,E=e<0.8?M:Math.PI*(M>=0?1:-1)*0.999;
    for(let i=0;i<64;i++){
      const f=E-e*Math.sin(E)-M;
      if(Math.abs(f)<1e-12) break;
      if(f>0) hi=E; else lo=E;
      let En=E-f/(1-e*Math.cos(E));
      if(!(En>lo&&En<hi)) En=(lo+hi)/2;
      E=En;
    }
    return E;
  },
  /* heliocentric ecliptic-J2000 position (AU) from element set at jd */
  posFromEls(a,e,I,om,Om,M){ /* angles rad */
    const E=this.solveKepler(M,e);
    const xp=a*(Math.cos(E)-e), yp=a*Math.sqrt(1-e*e)*Math.sin(E);
    const co=Math.cos(om),so=Math.sin(om),cO=Math.cos(Om),sO=Math.sin(Om),cI=Math.cos(I),sI=Math.sin(I);
    return[
      (co*cO-so*sO*cI)*xp+(-so*cO-co*sO*cI)*yp,
      (co*sO+so*cO*cI)*xp+(-so*sO+co*cO*cI)*yp,
      (so*sI)*xp+(co*sI)*yp];
  },
  planetEls(name,jd){
    const T=(jd-2451545.0)/36525;
    const[e0,e1]=this.EL[name];
    const a=e0[0]+e1[0]*T, e=e0[1]+e1[1]*T, I=(e0[2]+e1[2]*T)*D2R;
    const L=e0[3]+e1[3]*T, vp=e0[4]+e1[4]*T, Om0=e0[5]+e1[5]*T;
    const om=(vp-Om0)*D2R, Om=Om0*D2R;
    let M=((L-vp)%360+540)%360-180;
    return{a,e,I,om,Om,M:M*D2R};
  },
  planetPos(name,jd){
    const k=this.planetEls(name,jd);
    return this.posFromEls(k.a,k.e,k.I,k.om,k.Om,k.M);
  },
  /* display transform: ecliptic AU → scene units (compact compresses radius) */
  disp(v){
    const r=Math.hypot(v[0],v[1],v[2]);
    if(r<1e-9) return new THREE.Vector3(0,0,0);
    const s=(this.trueScale?28*r:this.K*Math.pow(r,this.pExp))/r;
    return new THREE.Vector3(v[0]*s,v[2]*s,-v[1]*s); /* ecliptic plane horizontal */
  },

  /* ---- sprite helpers ---- */
  dotTex(color){
    const cv=document.createElement('canvas');cv.width=cv.height=64;
    const cx=cv.getContext('2d');
    const g=cx.createRadialGradient(32,32,2,32,32,30);
    g.addColorStop(0,'#ffffff');g.addColorStop(0.25,color);g.addColorStop(1,'rgba(0,0,0,0)');
    cx.fillStyle=g;cx.beginPath();cx.arc(32,32,30,0,2*Math.PI);cx.fill();
    return new THREE.CanvasTexture(cv);
  },
  labelTex(txt,color){
    const cv=document.createElement('canvas');
    const cx=cv.getContext('2d');
    cx.font='600 26px "IBM Plex Mono",monospace';
    const w=Math.ceil(cx.measureText(txt.toUpperCase()).width)+18;
    cv.width=w;cv.height=36;
    const c2=cv.getContext('2d');
    c2.font='600 26px "IBM Plex Mono",monospace';
    c2.fillStyle=color;c2.shadowColor='rgba(0,0,0,0.9)';c2.shadowBlur=0;
    c2.fillText(txt.toUpperCase(),9,28);
    const t=new THREE.CanvasTexture(cv);
    return{tex:t,aspect:w/36};
  },
  mkBody(name,color,rPx,clickCmd){
    const grp=new THREE.Group();
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:this.dotTex(color),sizeAttenuation:false,depthTest:false,transparent:true}));
    sp.scale.set(rPx*0.0042,rPx*0.0042,1);
    sp.userData={ssName:name,cmd:clickCmd};
    const lb=this.labelTex(name,color);
    const lab=new THREE.Sprite(new THREE.SpriteMaterial({map:lb.tex,sizeAttenuation:false,depthTest:false,transparent:true,opacity:.92}));
    lab.scale.set(0.035*lb.aspect,0.035,1);
    lab.position.set(0,0.028,0);
    lab.userData={ssName:name,cmd:clickCmd,isLabel:true};
    grp.add(sp);grp.add(lab);
    return{grp,sp,lab};
  },

  orbitPoints(elsFn,n=256){
    /* sample mean anomaly uniformly over one revolution at current epoch */
    const pts=[];
    const k=elsFn();
    for(let i=0;i<=n;i++){
      const M=-Math.PI+2*Math.PI*i/n;
      const p=this.posFromEls(k.a,k.e,k.I,k.om,k.Om,M);
      pts.push(this.disp(p));
    }
    return pts;
  },

  init(){
    if(this.inited) return;
    this.inited=true;
    const container=document.getElementById('ss-wrap');
    const W=container.clientWidth||800,H=container.clientHeight||340;
    const renderer=new THREE.WebGLRenderer({antialias:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.setSize(W,H);renderer.setClearColor(0x010101,1);
    container.appendChild(renderer.domElement);
    const scene=new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff,0.9));
    /* milky way */
    loadSkyTex(tex=>{
      const sky=new THREE.Mesh(new THREE.SphereGeometry(5e4,40,24),
        new THREE.MeshBasicMaterial({map:tex,side:THREE.BackSide,depthWrite:false}));
      sky.rotation.x=1.0; /* galactic band tilted vs ecliptic (~60°) */
      scene.add(sky);
    },()=>{
      const sv=[];
      for(let i=0;i<2400;i++){const th=Math.random()*2*Math.PI,ph=Math.acos(2*Math.random()-1),r=4.6e4;
        sv.push(r*Math.sin(ph)*Math.cos(th),r*Math.cos(ph),r*Math.sin(ph)*Math.sin(th));}
      const sg=new THREE.BufferGeometry();sg.setAttribute('position',new THREE.Float32BufferAttribute(sv,3));
      scene.add(new THREE.Points(sg,new THREE.PointsMaterial({color:0xe0e0e0,size:60,transparent:true,opacity:.5})));
    });
    /* Sun */
    const sun=new THREE.Sprite(new THREE.SpriteMaterial({map:this.dotTex('#e0e0e0'),sizeAttenuation:false,depthTest:false,transparent:true}));
    sun.scale.set(0.085,0.085,1);
    sun.userData={ssName:'Sun',cmd:'10'};
    scene.add(sun);
    const sunGlow=new THREE.Sprite(new THREE.SpriteMaterial({map:this.dotTex('#bbbbbb'),sizeAttenuation:false,depthTest:false,transparent:true,opacity:.35}));
    sunGlow.scale.set(0.22,0.22,1);scene.add(sunGlow);
    this._sunSp=sun;

    const camera=new THREE.PerspectiveCamera(45,W/H,0.5,2e5);
    const ctrl=makeOrbitCtrl(renderer.domElement,camera,{rad:1500,theta:0.6,phi:0.95,minR:60,maxR:2.4e4});
    new ResizeObserver(()=>{requestAnimationFrame(()=>{const w=container.clientWidth,h=container.clientHeight;
      if(w&&h){renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}});}).observe(container);

    this.three={renderer,scene,camera,ctrl,container};
    this._ray=new THREE.Raycaster();this._mouse=new THREE.Vector2();
    const dom=renderer.domElement;
    dom.addEventListener('pointermove',e=>{
      const r=dom.getBoundingClientRect();
      this._mouse.x=((e.clientX-r.left)/r.width)*2-1;
      this._mouse.y=-((e.clientY-r.top)/r.height)*2+1;
      this._mouseEv=e;
    });
    let dXY=null;
    dom.addEventListener('pointerdown',e=>dXY=[e.clientX,e.clientY]);
    dom.addEventListener('pointerup',e=>{
      if(!dXY)return;
      const mv=Math.hypot(e.clientX-dXY[0],e.clientY-dXY[1]);dXY=null;
      if(mv<5) this.clickPick();
    });

    this.buildPlanets();
    this.buildGrid();
    this.buildBelts();
    /* bridge marker: the tracker's primary TLE target mapped into heliocentric space */
    const bm=new THREE.Sprite(new THREE.SpriteMaterial({map:this.dotTex('#cccccc'),sizeAttenuation:false,depthTest:false,transparent:true}));
    bm.scale.set(0.02,0.02,1);bm.visible=false;
    this.three.scene.add(bm);this._bridgeMk=bm;
  },

  /* ── asteroid main belt + Kuiper belt: round-sprite point clouds with
        statistically representative element distributions; the whole cloud
        precesses at the belt's mean motion so it lives, not poses ── */
  buildBelts(){
    if(this.beltGrp){this.three.scene.remove(this.beltGrp);}
    const grp=new THREE.Group();
    const mkCloud=(n,aMin,aMax,iMaxDeg,color,size,op)=>{
      const pts=[];
      for(let k=0;k<n;k++){
        const a=aMin+Math.random()*(aMax-aMin);
        const e=Math.random()*0.16;
        const i=(Math.random()**1.6)*iMaxDeg*D2R;
        const Om=Math.random()*2*Math.PI,w=Math.random()*2*Math.PI,M=Math.random()*2*Math.PI;
        const p=this.posFromEls(a,e,i,w,Om,M);
        pts.push(this.disp(p));
      }
      const g=new THREE.BufferGeometry().setFromPoints(pts);
      const m=new THREE.PointsMaterial({color:new THREE.Color(color),size,map:roundDotTex(),
        transparent:true,opacity:op,alphaTest:0.05,depthWrite:false,sizeAttenuation:false});
      const cloud=new THREE.Points(g,m);
      grp.add(cloud);
      return cloud;
    };
    /* warm dust-amber main belt + icy teal Kuiper — visually distinct from the
       cool-white starfield; clouds are non-pickable so clicks reach labeled bodies */
    this._mainBelt=mkCloud(1700,2.1,3.3,16,'#b2b2b2',2.4,0.6);
    this._kuiper=mkCloud(900,32,48,22,'#c1c1c1',2.1,0.42);
    grp.children.forEach(c=>c.raycast=function(){});
    this.beltGrp=grp;this.three.scene.add(grp);
    this._beltJd0=this.jd;
  },

  buildGrid(){
    if(this.gridGrp){this.three.scene.remove(this.gridGrp);}
    const grp=new THREE.Group();
    [1,2,5,10,20,30,40].forEach(rAU=>{
      const pts=[];
      for(let i=0;i<=128;i++){
        const a=2*Math.PI*i/128;
        pts.push(this.disp([rAU*Math.cos(a),rAU*Math.sin(a),0]));
      }
      const g=new THREE.BufferGeometry().setFromPoints(pts);
      grp.add(new THREE.Line(g,new THREE.LineBasicMaterial({color:0x333333,transparent:true,opacity:.5})));
      const lb=this.labelTex(rAU+' AU','#585858');
      const s=new THREE.Sprite(new THREE.SpriteMaterial({map:lb.tex,sizeAttenuation:false,depthTest:false,transparent:true,opacity:.8}));
      s.scale.set(0.026*lb.aspect,0.026,1);
      s.position.copy(this.disp([rAU,0,0]));
      grp.add(s);
    });
    /* vernal-equinox direction ♈ */
    const g=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),this.disp([46,0,0])]);
    grp.add(new THREE.Line(g,new THREE.LineBasicMaterial({color:0x494949,transparent:true,opacity:.55})));
    this.gridGrp=grp;this.three.scene.add(grp);
  },

  buildPlanets(){
    this.bodies.forEach(b=>this.three.scene.remove(b.grp));
    this.orbitLines.forEach(l=>{this.three.scene.remove(l);l.geometry.dispose();});
    this.bodies=[];this.orbitLines=[];
    Object.keys(this.EL).forEach(name=>{
      const st=this.STYLE[name];
      const b=this.mkBody(name,st.c,st.r,this.CMD[name]);
      this.three.scene.add(b.grp);
      const pts=this.orbitPoints(()=>this.planetEls(name,this.jd));
      const g=new THREE.BufferGeometry().setFromPoints(pts);
      const line=new THREE.Line(g,new THREE.LineBasicMaterial({color:new THREE.Color(st.c),transparent:true,opacity:name==='Earth'?.65:.34}));
      line.userData={ssName:name};
      this.three.scene.add(line);
      this.orbitLines.push(line);
      this.bodies.push({name,...b,line});
    });
    this.refreshSmalls();
  },

  /* ---- small bodies fed by EPH (Horizons osculating elements) ---- */
  refreshSmalls(){
    this.smalls.forEach(s=>{this.three.scene.remove(s.grp);if(s.line){this.three.scene.remove(s.line);s.line.geometry.dispose();}});
    this.smalls=[];
    if(typeof EPH==='undefined') return;
    EPH.plotted.forEach(p=>{
      if(!p.els&&!p.pack) return;
      const b=this.mkBody(p.name,p.color,7,p.cmd);
      this.three.scene.add(b.grp);
      let line=null;
      if(p.els&&p.els.e<0.985){
        const pts=this.orbitPoints(()=>({a:p.els.a,e:p.els.e,I:p.els.i,om:p.els.w,Om:p.els.Om,M:0}));
        const g=new THREE.BufferGeometry().setFromPoints(pts);
        line=new THREE.Line(g,new THREE.LineBasicMaterial({color:new THREE.Color(p.color),transparent:true,opacity:.6}));
        this.three.scene.add(line);
      }
      this.smalls.push({name:p.name,cmd:p.cmd,els:p.els,pack:p.pack||null,...b,line});
    });
  },
  smallPos(els,jd){
    let M=(els.M0+els.n*(jd-els.epoch))*D2R;
    M=((M%(2*Math.PI))+3*Math.PI)%(2*Math.PI)-Math.PI;
    return this.posFromEls(els.a,els.e,els.i,els.w,els.Om,M);
  },

  setScaleMode(trueScale,btn){
    this.trueScale=trueScale;
    document.querySelectorAll('#ss-toolbar .ss-scale-btn').forEach(b=>b.classList.remove('on'));
    if(btn) btn.classList.add('on');
    this.buildGrid();this.buildPlanets();this.buildBelts();
  },
  setRate(r,btn){ /* days-per-second → global epoch multiplier */
    EPOCH.setRate(r*86400);
    document.querySelectorAll('#ss-toolbar .ss-rate-btn').forEach(b=>b.classList.remove('on'));
    if(btn) btn.classList.add('on');
    document.getElementById('ss-play').textContent='⏸';
  },
  togglePlay(){
    EPOCH.togglePause();
    document.getElementById('ss-play').textContent=EPOCH.rate===0?'▶':'⏸';
  },
  goNow(){EPOCH.live();this.follow=null;if(this.three)this.three.ctrl.clearTarget();},
  step(days){EPOCH.scrub(days*86400000);},
  resetView(){
    this.follow=null;this.sel=null;
    const c=this.three.ctrl;c.clearTarget();c.tRad=1500;c.tTheta=0.6;c.tPhi=0.95;
  },

  frame(nowP,dt){
    const T=this.three;
    T.ctrl.update(dt);
    /* positions (epoch jd) */
    this.bodies.forEach(b=>{
      const p=this.planetPos(b.name,this.jd);
      b.grp.position.copy(this.disp(p));
      const selOn=this.sel===b.name;
      b.sp.material.opacity=selOn?1:0.95;
      b.line.material.opacity=selOn?0.95:(b.name==='Earth'?0.65:0.34);
    });
    this.smalls.forEach(s=>{
      let p=null;
      if(s.pack) p=EPHSVC.posAt(s.pack,this.jd);   /* exact JPL vectors + Hermite */
      if(!p&&s.els) p=this.smallPos(s.els,this.jd); /* Kepler fallback outside window */
      if(p) s.grp.position.copy(this.disp(p));
    });
    /* TLE-class primary mapped through the unified frame bridge */
    if(this._bridgeMk){
      let shown=false;
      if(typeof SEL!=='undefined'&&SEL.length&&SEL[0].tle&&SEL[0].tle.satrec){
        try{
          const pv=satellite.propagate(SEL[0].tle.satrec,EPOCH.now());
          if(pv&&pv.position&&isFinite(pv.position.x)){
            const hp=BRIDGE.eciKmToHelioAU([pv.position.x,pv.position.y,pv.position.z],this.jd);
            this._bridgeMk.position.copy(this.disp(hp));
            shown=true;
          }
        }catch(e){}
      }
      this._bridgeMk.visible=shown;
    }
    /* camera follow → smooth pan onto the focused body */
    if(this.follow){
      const b=this.bodies.find(x=>x.name===this.follow)||this.smalls.find(x=>x.name===this.follow);
      if(b) T.ctrl.setTarget(b.grp.position);
      else if(this.follow==='Sun') T.ctrl.setTarget(new THREE.Vector3(0,0,0));
    }
    if(nowP-(this._infoT||0)>300){this._infoT=nowP;this.renderInfo();}
    /* belts precess at their mean motion (~2.7 AU → 0.22°/day) */
    if(this.beltGrp){
      this.beltGrp.rotation.y=-(this.jd-(this._beltJd0||this.jd))*0.00386; /* rad: 0.221°/d */
    }
    /* readouts */
    const d=new Date((this.jd-2440587.5)*86400000);
    const el1=document.getElementById('ss-date');
    if(el1) el1.textContent=d.toISOString().slice(0,10)+' '+d.toISOString().slice(11,16)+' UTC';
    const el2=document.getElementById('ss-offset');
    if(el2){
      const offD=EPOCH.offsetMs()/86400000;
      el2.textContent=Math.abs(offD)<0.02?'· NOW':(offD>0?'+':'−')+Math.abs(offD).toFixed(1)+' d';
    }
    /* hover */
    if(nowP-this._hoverLast>80){this._hoverLast=nowP;this.hover();}
    T.renderer.render(T.scene,T.camera);
  },

  pickables(){
    const arr=[this._sunSp];
    this.bodies.forEach(b=>{arr.push(b.sp);arr.push(b.lab);});
    this.smalls.forEach(s=>{arr.push(s.sp);arr.push(s.lab);});
    return arr;
  },
  hover(){
    if(!this._mouseEv) return;
    this._ray.setFromCamera(this._mouse,this.three.camera);
    const hits=this._ray.intersectObjects(this.pickables());
    this.three.renderer.domElement.style.cursor=hits.length?'pointer':'grab';
  },
  clickPick(){
    this._ray.setFromCamera(this._mouse,this.three.camera);
    const hits=this._ray.intersectObjects(this.pickables());
    if(!hits.length) return;
    const u=hits[0].object.userData;
    if(!u||!u.ssName) return;
    this.sel=u.ssName;
    this.focus(u.ssName);
    if(u.cmd&&typeof EPH!=='undefined'){
      EPH.select({cmd:u.cmd,name:u.ssName});
    }
  },
  focus(name){ /* smooth camera pan onto the body's position vector */
    this.follow=name;
    const b=this.bodies.find(x=>x.name===name)||this.smalls.find(x=>x.name===name);
    if(b){
      const d=b.grp.position.length();
      this.three.ctrl.setTarget(b.grp.position,Math.max(80,d*0.55));
    }
  },
  selectByName(name){this.sel=name;if(this.inited)this.focus(name);},

  /* ── overhauled high-visibility telemetry overlay ──
     live hybrid-layer extraction: heliocentric state vector (pos + velocity),
     az/el sweep, Earth & Sun ranges, magnitude, phase, sidereal period */
  PERIODS:{Mercury:87.97,Venus:224.70,Earth:365.26,Mars:686.98,Jupiter:4332.6,
           Saturn:10759.2,Uranus:30688.5,Neptune:60182,Pluto:90560},
  renderInfo(){
    const el=document.getElementById('ss-info');if(!el)return;
    const name=this.follow||this.sel;
    if(!name||name==='Sun'){el.style.display='none';return;}
    const jd=this.jd;
    let p=null,v=null,src='';
    const pl=this.bodies.find(b=>b.name===name);
    const sm=this.smalls.find(s=>s.name===name);
    if(pl){
      p=this.planetPos(name,jd);
      const p2=this.planetPos(name,jd+1/1440);          /* +1 min */
      v=[(p2[0]-p[0])*1440,(p2[1]-p[1])*1440,(p2[2]-p[2])*1440]; /* AU/day */
      src='STANDISH MEAN ELEMENTS';
    } else if(sm){
      if(sm.pack){p=EPHSVC.posAt(sm.pack,jd);v=EPHSVC.velAt(sm.pack,jd);src='JPL VECTORS · HERMITE C¹';}
      if(!p&&sm.els){
        p=this.smallPos(sm.els,jd);
        const p2=this.smallPos(sm.els,jd+1/1440);
        v=[(p2[0]-p[0])*1440,(p2[1]-p[1])*1440,(p2[2]-p[2])*1440];
        src='OSCULATING ELEMENTS';
      }
    }
    if(!p){el.style.display='none';return;}
    const rSun=Math.hypot(p[0],p[1],p[2]);
    const E=BRIDGE.earthHelio(jd);
    const rE=Math.hypot(p[0]-E[0],p[1]-E[1],p[2]-E[2]);
    const vk=v?Math.hypot(v[0],v[1],v[2])*AU_KM/86400:null;  /* km/s */
    /* az/el + mag/phase from the live observer rows if this target is plotted */
    const plot=typeof EPH!=='undefined'?EPH.plotted.find(q=>q.name===name||q.bodyName===name):null;
    let azel='—',mag='—',phase='—';
    if(plot&&plot.rows&&plot.rows.length){
      const tMs=(jd-2440587.5)*86400000;
      let i=0;
      const R=plot.rows;
      for(let k=0;k<R.length;k++) if(Math.abs(R[k].d-tMs)<Math.abs(R[i].d-tMs)) i=k;
      const j=Math.min(i+1,R.length-1);
      if(R[i].el!==null&&R[j].el!==null&&j>i){
        const f=Math.max(0,Math.min(1,(tMs-R[i].d)/(R[j].d-R[i].d||1)));
        azel=(R[i].az+(R[j].az-R[i].az)*f).toFixed(1)+'° / '+(R[i].el+(R[j].el-R[i].el)*f).toFixed(1)+'°';
      } else if(R[i].el!==null) azel=R[i].az.toFixed(1)+'° / '+R[i].el.toFixed(1)+'°';
      if(R[i].mag!==null) mag=R[i].mag.toFixed(2);
      if(R[i].phase!==null) phase=R[i].phase.toFixed(1)+'° ('+(50*(1+Math.cos(R[i].phase*D2R))).toFixed(0)+'% LIT)';
    }
    let period='—';
    if(this.PERIODS[name]) period=(this.PERIODS[name]/365.25).toFixed(2)+' yr';
    else{
      const a=sm&&sm.els?sm.els.a:null;
      if(a) period=(Math.sqrt(a*a*a)*365.25>730?Math.sqrt(a*a*a).toFixed(2)+' yr':(Math.sqrt(a*a*a)*365.25).toFixed(1)+' d');
    }
    const r6=x=>(x>=0?'+':'')+x.toFixed(6);
    el.style.display='block';
    el.innerHTML='<div class="ssi-name">'+name.toUpperCase()+'</div>'+
      '<div class="ssi-src">'+src+'</div>'+
      '<div class="ssi-grid">'+
      '<div class="ssi-k">STATE r̄ (AU)</div><div class="ssi-v mono">'+r6(p[0])+'<br/>'+r6(p[1])+'<br/>'+r6(p[2])+'</div>'+
      '<div class="ssi-k">VELOCITY</div><div class="ssi-v">'+(vk?vk.toFixed(2)+' km/s':'—')+
        (v?'<span class="ssi-sub">['+v.map(x=>(x>=0?'+':'')+x.toFixed(4)).join(', ')+'] AU/d</span>':'')+'</div>'+
      '<div class="ssi-k">RANGE ☉</div><div class="ssi-v">'+rSun.toFixed(4)+' AU</div>'+
      '<div class="ssi-k">RANGE ⊕</div><div class="ssi-v">'+rE.toFixed(4)+' AU · '+(rE*AU_KM/1e6).toFixed(1)+' M km</div>'+
      '<div class="ssi-k">AZ / EL</div><div class="ssi-v">'+azel+'</div>'+
      '<div class="ssi-k">V MAG</div><div class="ssi-v">'+mag+'</div>'+
      '<div class="ssi-k">PHASE ∠</div><div class="ssi-v">'+phase+'</div>'+
      '<div class="ssi-k">SID. PERIOD</div><div class="ssi-v">'+period+'</div>'+
      '</div>'+
      '<div class="ssi-foot" onclick="SS.resetView()">⟲ RELEASE CAMERA</div>';
  }
};

/* ════ TRAJ · geocentric trajectory view for spacecraft ════
   Geocentric ICRF (Earth mean equator, J2000-aligned) state vectors from
   Horizons, km. The Moon is fetched over the same window for context. If the
   sim epoch is outside the target's Horizons data span, the window slides to
   the nearest edge of coverage and the panel says so. Scene units: 1000 km;
   axes as elsewhere (x, z, −y) so north is up. */
const TRAJ={
  three:null,inited:false,plot:null,_tok:0,objs:[],maxR:1,
  S:1e-3,
  v3(p){return new THREE.Vector3(p[0]*this.S,p[2]*this.S,-p[1]*this.S);},
  init(){
    if(this.inited) return;
    this.inited=true;
    const c=document.getElementById('traj-wrap');
    const W=c.clientWidth||800,H=c.clientHeight||360;
    const renderer=new THREE.WebGLRenderer({antialias:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.setSize(W,H);renderer.setClearColor(0x000000,1);
    c.appendChild(renderer.domElement);
    const scene=new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff,0.55));
    const sun=new THREE.DirectionalLight(0xffffff,1.0);scene.add(sun);
    const earth=new THREE.Mesh(new THREE.SphereGeometry(RE_KM*this.S,48,48),
      new THREE.MeshPhongMaterial({color:0x282828,shininess:4}));
    scene.add(earth);
    loadEarthDay(tex=>{earth.material.map=tex;earth.material.color.set(0xffffff);earth.material.needsUpdate=true;});
    const camera=new THREE.PerspectiveCamera(45,W/H,0.01,1e7);
    const ctrl=makeOrbitCtrl(renderer.domElement,camera,{rad:1000,theta:0.6,phi:1.05,minR:8,maxR:5e6});
    new ResizeObserver(()=>{requestAnimationFrame(()=>{const w=c.clientWidth,h=c.clientHeight;
      if(w&&h){renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}});}).observe(c);
    const mk=new THREE.Mesh(new THREE.SphereGeometry(1,16,16),new THREE.MeshBasicMaterial({color:0xffffff}));
    mk.visible=false;scene.add(mk);
    const moon=new THREE.Mesh(new THREE.SphereGeometry(1737.4*this.S,24,24),new THREE.MeshPhongMaterial({color:0x9b9b9b}));
    moon.visible=false;scene.add(moon);
    this.three={renderer,scene,camera,ctrl,earth,sun,mk,moon,container:c};
  },
  hide(){document.getElementById('traj-panel').style.display='none';this.plot=null;},
  clear(){
    const sc=this.three.scene;
    this.objs.forEach(o=>{sc.remove(o);if(o.geometry)o.geometry.dispose();if(o.material)o.material.dispose();});
    this.objs=[];
  },
  line(pts,color,op,dashed){
    const g=new THREE.BufferGeometry().setFromPoints(pts);
    const m=dashed?new THREE.LineDashedMaterial({color,transparent:true,opacity:op,dashSize:4,gapSize:4})
                  :new THREE.LineBasicMaterial({color,transparent:true,opacity:op});
    const l=new THREE.Line(g,m);if(dashed)l.computeLineDistances();
    this.three.scene.add(l);this.objs.push(l);return l;
  },
  async load(plot){
    document.getElementById('traj-panel').style.display='block';
    this.init();
    this.plot=plot;
    const tok=++this._tok;
    const info=document.getElementById('traj-info');
    document.getElementById('traj-title').textContent=plot.name.toUpperCase()+' · GEOCENTRIC ICRF';
    document.getElementById('traj-window').textContent='';
    info.textContent='Fetching trajectory from Horizons…';
    this.clear();this.three.mk.visible=false;this.three.moon.visible=false;
    if(!plot.traj||plot.trajEpoch!==Math.round(EPOCH.ms()/3600000)){
      const r=await EPHSVC.trajectory(plot.cmd,14);
      if(tok!==this._tok) return;
      if(!r.pack&&r.err==='network'&&!JPL_PROXY){info.textContent=JPL_BLOCKED_MSG;return;}
      if(!r.pack){info.textContent=r.cov?'Horizons has no ephemeris for this target near '+fmtDateUTC(EPOCH.now())+'.':'Trajectory request failed ('+r.err+').';return;}
      const moon=await EPHSVC.geoVectors('301',r.t0,r.t1);
      if(tok!==this._tok) return;
      plot.traj=r;plot.trajMoon=moon.pack||null;plot.trajEpoch=Math.round(EPOCH.ms()/3600000);
    }
    this.draw();
  },
  draw(){
    const p=this.plot;if(!p||!p.traj) return;
    const r=p.traj,P=r.pack.P;
    this.clear();
    let maxR=RE_KM*3;
    P.forEach(q=>{const d=Math.hypot(q[0],q[1],q[2]);if(d>maxR)maxR=d;});
    this.maxR=maxR;
    this.line(P.map(q=>this.v3(q)),0xffffff,0.85);
    if(p.trajMoon){
      this.line(p.trajMoon.P.map(q=>this.v3(q)),0x898989,0.6,true);
    }
    /* end-of-data marker */
    const last=P[P.length-1],first=P[0];
    const dot=(q,col)=>{const m=new THREE.Mesh(new THREE.SphereGeometry(maxR*this.S*0.008,12,12),new THREE.MeshBasicMaterial({color:col}));
      m.position.copy(this.v3(q));this.three.scene.add(m);this.objs.push(m);};
    dot(first,0x9b9b9b);dot(last,0x9b9b9b);
    this.three.mk.scale.setScalar(maxR*this.S*0.014);
    this.three.moon.visible=!!p.trajMoon;
    const c=this.three.ctrl;c.tRad=Math.max(30,maxR*this.S*2.6);c.maxR=Math.max(5e3,maxR*this.S*20);
    const t0=r.t0.toISOString().slice(0,16).replace('T',' '),t1=r.t1.toISOString().slice(0,16).replace('T',' ');
    document.getElementById('traj-window').textContent=t0+' → '+t1+' UTC';
    this._infoT=0;
  },
  resetView(){if(!this.three)return;const c=this.three.ctrl;c.clearTarget();c.tTheta=0.6;c.tPhi=1.05;c.tRad=Math.max(30,this.maxR*this.S*2.6);},
  frame(nowP,dt){
    const T=this.three;if(!T||!this.plot||!this.plot.traj) return;
    if(document.getElementById('traj-panel').style.display==='none') return;
    T.ctrl.update(dt);
    const jd=EPOCH.jd(),r=this.plot.traj,pk=r.pack;
    const inWin=jd>=pk.jd0&&jd<=pk.jd1;
    let pos=inWin?EPHSVC.posAt(pk,jd):pk.P[pk.P.length-1];
    if(!inWin&&r.cov&&r.cov.side==='start') pos=pk.P[0];
    T.mk.visible=!!pos;
    if(pos) T.mk.position.copy(this.v3(pos));
    if(this.plot.trajMoon){
      const mp=jd>=this.plot.trajMoon.jd0&&jd<=this.plot.trajMoon.jd1?EPHSVC.posAt(this.plot.trajMoon,jd):null;
      T.moon.visible=!!mp;if(mp) T.moon.position.copy(this.v3(mp));
    }
    T.earth.rotation.y=gmst_from_jd(julianDate(EPOCH.now()));
    if(nowP-(this._sunT||0)>500){this._sunT=nowP;const su=sunECIUnit(EPOCH.now());T.sun.position.set(su[0],su[2],-su[1]);}
    if(nowP-(this._infoT||0)>400&&pos){
      this._infoT=nowP;
      const rng=Math.hypot(pos[0],pos[1],pos[2]);
      let moonD='';
      if(this.plot.trajMoon&&T.moon.visible){const m=T.moon.position;const q=this.v3(pos);moonD=' · from Moon '+(q.distanceTo(m)/this.S).toFixed(0)+' km';}
      let state;
      if(inWin) state='At sim epoch '+EPOCH.now().toISOString().slice(0,16).replace('T',' ')+' UTC';
      else if(r.cov&&r.cov.side==='end') state='Last Horizons state, '+fmtDateUTC(new Date((pk.jd1-2440587.5)*86400000))+' UTC. No ephemeris after this.';
      else if(r.cov&&r.cov.side==='start') state='First Horizons state, '+fmtDateUTC(new Date((pk.jd0-2440587.5)*86400000))+' UTC.';
      else state='Sim epoch is outside the fetched window.';
      document.getElementById('traj-info').innerHTML=state+'<br/>Range from Earth '+rng.toFixed(0)+' km'+moonD+
        '<br/><span class="dim">Solid: '+this.plot.name+' · dashed: Moon · grey dots: window start and end</span>';
    }
    T.renderer.render(T.scene,T.camera);
  }
};

/* ════ V3 · EPHEMERIS — JPL HORIZONS multi-target observer module ════
   Apparent (airless) topocentric RA/DEC + AZ/EL, magnitude, range, elongation
   and phase from the JPL Horizons API for the observer site. Twilight state
   per step from Horizons solar-presence flags: '*' day, C civil, N nautical,
   A astronomical, '' full night. Small bodies additionally get a heliocentric
   osculating-ELEMENTS query so their true orbit renders in the 3-D map.      */
const EPH={
  TARGETS:[
    {cat:'PLANETS',items:[
      {cmd:'199',name:'Mercury',g:'☿'},{cmd:'299',name:'Venus',g:'♀'},{cmd:'499',name:'Mars',g:'♂'},
      {cmd:'599',name:'Jupiter',g:'♃'},{cmd:'699',name:'Saturn',g:'♄'},{cmd:'799',name:'Uranus',g:'⛢'},
      {cmd:'899',name:'Neptune',g:'♆'},{cmd:'999',name:'Pluto',g:'♇'}]},
    {cat:'SUN / MOON',items:[
      {cmd:'10',name:'Sun',g:'☉'},{cmd:'301',name:'Moon',g:'☾'}]},
    {cat:'ASTEROIDS',items:[
      {cmd:'1;',name:'1 Ceres',g:'⬡'},{cmd:'2;',name:'2 Pallas',g:'⬡'},{cmd:'4;',name:'4 Vesta',g:'⬡'},
      {cmd:'7;',name:'7 Iris',g:'⬡'},{cmd:'433;',name:'433 Eros',g:'⬡'},{cmd:'99942;',name:'99942 Apophis',g:'⬡'}]},
    {cat:'SPACECRAFT',items:[
      {cmd:'-1176',name:'CAPSTONE',g:'◇',kind:'sc'},{cmd:'-1024',name:'Artemis II (Integrity)',g:'◇',kind:'sc'},
      {cmd:'-159',name:'Europa Clipper',g:'◇',kind:'sc'},{cmd:'-170',name:'JWST',g:'◇',kind:'sc'},
      {cmd:'-31',name:'Voyager 1',g:'◇',kind:'sc'}]},
    {cat:'COMETS',items:[
      {cmd:'DES=1P;CAP',name:'1P/Halley',g:'☄'},{cmd:'DES=2P;CAP',name:'2P/Encke',g:'☄'},
      {cmd:'DES=12P;CAP',name:'12P/Pons-Brooks',g:'☄'},{cmd:'DES=29P;CAP',name:'29P/SW 1',g:'☄'}]}
  ],
  SITES:[
    {n:'— OBSERVER PRESETS —',hdr:true},
    {n:'Penn State · State College',lat:40.7945,lon:-77.8616,h:354},
    {n:'Mauna Kea Observatory',lat:19.8206,lon:-155.4681,h:4205},
    {n:'Cerro Paranal (VLT)',lat:-24.6272,lon:-70.4042,h:2635},
    {n:'Kitt Peak',lat:31.9583,lon:-111.5967,h:2096},
    {n:'Royal Greenwich',lat:51.4769,lon:0.0005,h:46},
    {n:'Siding Spring',lat:-31.2733,lon:149.0617,h:1165}
  ],
  PALETTE:['#f0f0f0','#d6b26e','#7fa8d8','#c48fb5','#8fc4a0','#c9a08a'],
  enabled:{PLANETS:true,'SUN / MOON':true,SPACECRAFT:true,ASTEROIDS:true,COMETS:true},
  cache:{},elsCache:{},
  plotted:[],            /* [{cmd,name,g,color,rows,bodyName,els?}] */
  active:null,           /* cmd of the active (detailed) target */
  _token:0,_listDone:false,_chartHover:-1,_clockT:null,

  /* ───────── sidebar list ───────── */
  renderList(){
    const box=document.getElementById('eph-targets');
    box.innerHTML='';
    this.TARGETS.forEach(grp=>{
      const h=document.createElement('div');h.className='eph-cat';
      h.innerHTML='<label class="eph-cat-lbl"><input type="checkbox" '+(this.enabled[grp.cat]?'checked':'')+'/> '+grp.cat+'</label>';
      h.querySelector('input').addEventListener('change',e=>{this.enabled[grp.cat]=e.target.checked;this.renderList();});
      box.appendChild(h);
      if(!this.enabled[grp.cat]) return;
      grp.items.forEach(it=>{
        const plot=this.plotted.find(p=>p.cmd===it.cmd);
        const d=document.createElement('div');
        d.className='eph-item'+(this.active===it.cmd?' active':'');
        d.innerHTML='<span class="ei-glyph" style="'+(plot?'color:'+plot.color:'')+'">'+(it.g||'◆')+'</span>'+
          '<span class="ei-name">'+it.name+'</span>'+
          (plot?'<span class="ei-stat" style="color:'+plot.color+'">● PLOTTED</span>':'<span class="ei-stat" style="color:var(--muted)">'+it.cmd.replace(';CAP','').replace('DES=','').replace(';','')+'</span>');
        d.addEventListener('click',()=>this.select(it));
        box.appendChild(d);
      });
    });
    this._listDone=true;
    this.startClock();
  },
  startClock(){
    if(this._clockT) return;
    const tick=()=>{
      const n=new Date();
      const u=document.getElementById('eph-utc'),l=document.getElementById('eph-local');
      if(u) u.textContent=fmtUTCShort(n)+' UTC';
      if(l) l.textContent=fmtLocalTime(n,SITE.tz).slice(0,8)+' LOC';
    };
    tick();this._clockT=setInterval(tick,1000);
  },

  /* ───────── observer site controls ───────── */
  renderSiteChip(){
    const el=document.getElementById('eph-site-txt');
    if(el) el.textContent=Math.abs(SITE.lat_deg).toFixed(3)+'°'+(SITE.lat_deg>=0?'N':'S')+' '+
      Math.abs(SITE.lon_deg).toFixed(3)+'°'+(SITE.lon_deg>=0?'E':'W')+' · '+Math.round(SITE.h_m)+' m · '+SITE.tz;
  },
  sitePreset(idx){
    const s=this.SITES[idx];
    if(!s||s.hdr) return;
    document.getElementById('inp-lat').value=s.lat;
    document.getElementById('inp-lon').value=s.lon;
    document.getElementById('inp-alt').value=s.h;
    applySite(); /* triggers onSiteChange → cache flush + refetch */
  },
  toggleSiteEdit(){
    const f=document.getElementById('eph-site-form');
    if(f.style.display==='flex'){f.style.display='none';return;}
    document.getElementById('eph-lat').value=SITE.lat_deg.toFixed(4);
    document.getElementById('eph-lon').value=SITE.lon_deg.toFixed(4);
    document.getElementById('eph-alt').value=Math.round(SITE.h_m);
    f.style.display='flex';
  },
  applyCustomSite(){
    document.getElementById('inp-lat').value=document.getElementById('eph-lat').value;
    document.getElementById('inp-lon').value=document.getElementById('eph-lon').value;
    document.getElementById('inp-alt').value=document.getElementById('eph-alt').value;
    document.getElementById('eph-site-form').style.display='none';
    applySite();
  },

  /* ── dynamic fuzzy search → JPL SBDB name resolution ──
     debounced; resolves fuzzy keywords to valid Horizons command IDs;
     cleanly catches misses with a stylized NO RECORD FOUND warning */
  _sbdbTimer:null,_sbdbToken:0,
  sbdbType(){
    clearTimeout(this._sbdbTimer);
    const v=document.getElementById('eph-custom-inp').value.trim();
    const box=document.getElementById('eph-sbdb-results');
    if(v.length<2){box.style.display='none';box.innerHTML='';return;}
    box.style.display='block';
    box.innerHTML='<div class="sbdb-row dim">Searching Horizons…</div>';
    this._sbdbTimer=setTimeout(()=>this.sbdbRun(v),450);
  },
  async sbdbRun(v){
    const token=++this._sbdbToken;
    const res=await EPHSVC.sbdbLookup(v);
    if(token!==this._sbdbToken) return;
    const box=document.getElementById('eph-sbdb-results');
    if(!box) return;
    const esc=x=>String(x).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const row=m=>'<div class="sbdb-row hit" onclick="EPH.pickSbdb(\''+esc(m.cmd)+'\',\''+esc(m.name)+'\',\''+(m.kind||'')+'\')">'+
      String(m.name).replace(/</g,'&lt;')+
      '<span class="sbdb-sub">'+[m.type||m.orbitClass||'',(m.alias&&m.alias.length?'aka '+m.alias.join(', '):'')].filter(Boolean).join(' · ')+'</span></div>';
    if(res.ok){
      box.innerHTML=row(res);
    } else if(res.multi){
      box.innerHTML='<div class="sbdb-row dim">'+res.multi.length+' matches</div>'+res.multi.map(row).join('');
    } else if(res.none){
      box.innerHTML='<div class="sbdb-row nores">No Horizons object matches “'+v.replace(/</g,'&lt;')+'”.<span class="sbdb-sub">Named minor planets are one word, e.g. Kathleenhowell. Numbers work too: 5396.</span></div>';
    } else {
      box.innerHTML='<div class="sbdb-row nores">'+(JPL_PROXY?'Could not reach JPL through the relay.':JPL_BLOCKED_MSG)+'</div>';
    }
  },
  pickSbdb(cmd,name,kind){
    document.getElementById('eph-sbdb-results').style.display='none';
    document.getElementById('eph-custom-inp').value='';
    this.select({cmd,name:name.replace(/ \(spacecraft\)$/,''),g:kind==='sc'?'◇':'◆',kind});
  },
  customLookup(){ /* ENTER key — run resolution immediately */
    const v=document.getElementById('eph-custom-inp').value.trim();
    if(!v) return;
    document.getElementById('eph-sbdb-results').style.display='block';
    document.getElementById('eph-sbdb-results').innerHTML='<div class="sbdb-row dim">⌕ resolving…</div>';
    this.sbdbRun(v);
  },

    siteCoordStr(){
    return SITE.lon_deg.toFixed(6)+','+SITE.lat_deg.toFixed(6)+','+(SITE.h_m/1000).toFixed(4);
  },
  isSmallBody(cmd){return cmd.includes(';');},
  isSpacecraft(cmd){return /^-\d+$/.test(String(cmd));},

  /* ───────── selection / fetching ───────── */
  async select(it){
    const token=++this._token;
    this.active=it.cmd;
    this.renderList();
    document.getElementById('eph-empty').style.display='none';
    document.getElementById('eph-target-name').textContent=it.name.toUpperCase();
    document.getElementById('eph-target-sub').textContent='HORIZONS CMD '+it.cmd+' · FETCHING…';
    document.getElementById('eph-fetch-state').textContent='QUERYING…';
    const lg=document.getElementById('eph-log');lg.textContent='';lg.style.display='none';
    if(typeof SS!=='undefined') SS.selectByName(it.name);

    /* register in plotted set IMMEDIATELY — the 3-D orbit must appear even if
       the observer-table fetch later fails (network/CORS) */
    let plot=this.plotted.find(p=>p.cmd===it.cmd);
    if(!plot){
      if(this.plotted.length>=6) this.removePlot(this.plotted[0].cmd,true);
      plot={cmd:it.cmd,name:it.name,g:it.g||'◆',color:this.PALETTE[this.plotted.length%this.PALETTE.length]};
      this.plotted.push(plot);
    }
    if(this.isSpacecraft(it.cmd)){
      if(WEBGL_OK) TRAJ.load(plot);
    } else TRAJ.hide();
    if(this.isSmallBody(it.cmd)){
      if(!plot.els&&typeof SS!=='undefined'){const pe=SS.presetEls(it.cmd);if(pe) plot.els=pe;}
      if(typeof SS!=='undefined'&&SS.inited) SS.refreshSmalls();
      EPHSVC.getVectors(it.cmd).then(pack=>{
        if(pack){plot.pack=pack;if(typeof SS!=='undefined'&&SS.inited) SS.refreshSmalls();}
      });
      this.fetchElements(it.cmd).then(els=>{
        if(els){plot.els=els;if(typeof SS!=='undefined'&&SS.inited) SS.refreshSmalls();}
      });
    }
    this.renderList();

    const key=it.cmd+'|'+this.siteCoordStr()+'|'+new Date().toISOString().slice(0,13);
    let res=this.cache[key];
    if(!res){
      res=await this.fetchHorizons(it.cmd);
      if(token!==this._token) return;
      if(res&&res.rows&&res.rows.length) this.cache[key]=res;
    }
    if(token!==this._token) return;
    document.getElementById('eph-fetch-state').textContent=res&&res.rows.length?'LIVE':res&&res.coverage?'NO CURRENT DATA':'ERROR';
    if(!res){this.showError(JPL_PROXY?'Horizons request failed through the relay. Try refetch.':JPL_BLOCKED_MSG);return;}
    if(res.coverage){
      plot.coverage=res.coverage;plot.rows=null;
      document.getElementById('eph-target-sub').textContent=(res.coverage.name||it.name)+' · '+res.msg;
      document.getElementById('eph-verdict').style.display='inline-flex';
      document.getElementById('eph-verdict').className='verdict v-down';
      document.getElementById('eph-verdict').textContent=res.coverage.side==='end'?'NO EPHEMERIS AFTER '+res.coverage.date.toISOString().slice(0,10):'NOT YET COVERED';
      ['eph-now-grid','eph-chart-panel','eph-win-title'].forEach(id=>document.getElementById(id).style.display='none');
      document.getElementById('eph-windows').innerHTML='';
      this.renderList();
      return;
    }
    if(!res.rows.length){
      this.showError(res.msg||'No ephemeris rows returned.');
      if(res.excerpt){lg.textContent=res.excerpt;lg.style.display='block';}
      return;
    }
    plot.rows=res.rows;plot.bodyName=res.bodyName||it.name;plot.fetchedAt=new Date();
    document.getElementById('eph-target-sub').textContent=
      (res.bodyName||it.name)+' · '+res.rows.length+' × 30-min steps · 72 h · fetched '+fmtUTCShort(plot.fetchedAt)+' UTC';
    this.renderList();
    this.renderAll();
    if(typeof SS!=='undefined'&&SS.inited) SS.refreshSmalls();
  },
  removePlot(cmd,silent){
    this.plotted=this.plotted.filter(p=>p.cmd!==cmd);
    if(this.active===cmd) this.active=this.plotted.length?this.plotted[this.plotted.length-1].cmd:null;
    if(!silent){
      if(typeof SS!=='undefined'&&SS.inited) SS.refreshSmalls();
      this.renderList();
      if(this.active){const a=this.plotted.find(p=>p.cmd===this.active);this.renderAll();}
      else{
        ['eph-now-grid','eph-chart-panel','eph-win-title','eph-att'].forEach(id=>document.getElementById(id).style.display='none');
        document.getElementById('eph-windows').innerHTML='';
        document.getElementById('eph-plotted').innerHTML='';
        document.getElementById('eph-verdict').style.display='none';
        document.getElementById('eph-target-name').textContent='SELECT A TARGET';
        document.getElementById('eph-target-sub').textContent='—';
        document.getElementById('eph-empty').style.display='block';
      }
    }
  },
  setActive(cmd){
    const p=this.plotted.find(x=>x.cmd===cmd);
    if(!p) return;
    this.active=cmd;
    document.getElementById('eph-target-name').textContent=p.name.toUpperCase();
    document.getElementById('eph-target-sub').textContent=p.bodyName+' · '+(p.rows?p.rows.length:0)+' × 30-min steps · 72 h · fetched '+fmtUTCShort(p.fetchedAt)+' UTC';
    if(typeof SS!=='undefined') SS.selectByName(p.name);
    if(this.isSpacecraft(cmd)&&WEBGL_OK) TRAJ.load(p); else TRAJ.hide();
    this.renderList();this.renderAll();
  },
  refetch(){
    if(!this.active) return;
    const p=this.plotted.find(x=>x.cmd===this.active);
    if(!p) return;
    const key=p.cmd+'|'+this.siteCoordStr()+'|'+new Date().toISOString().slice(0,13);
    delete this.cache[key];
    this.select(p);
  },
  onSiteChange(){
    this.cache={};
    this.renderSiteChip();
    /* refetch every plotted target for the new site */
    const list=[...this.plotted];
    this.plotted=[];
    (async()=>{
      for(const p of list) await this.select(p);
    })();
  },
  showError(msg){
    document.getElementById('eph-target-sub').textContent='⚠ '+msg;
    document.getElementById('eph-verdict').style.display='none';
  },

  async fetchHorizons(cmd){
    const start=new Date(Date.now()-30*60000);
    const stop=new Date(Date.now()+72*3600000);
    const fmt=d=>"'"+d.toISOString().slice(0,16).replace('T',' ')+"'";
    const p=new URLSearchParams({
      format:'text',COMMAND:"'"+cmd+"'",OBJ_DATA:'NO',MAKE_EPHEM:'YES',
      EPHEM_TYPE:'OBSERVER',CENTER:"'coord@399'",COORD_TYPE:'GEODETIC',
      SITE_COORD:"'"+this.siteCoordStr()+"'",
      START_TIME:fmt(start),STOP_TIME:fmt(stop),STEP_SIZE:"'30 m'",
      QUANTITIES:"'1,4,9,20,23,24'",ANG_FORMAT:'DEG',CSV_FORMAT:'YES',
      APPARENT:'AIRLESS',EXTRA_PREC:'NO'});
    return this.fetchAPI(p,txt=>this.parse(txt));
  },
  async fetchElements(cmd){
    const k=cmd+'|els';
    if(this.elsCache[k]) return this.elsCache[k];
    const now=new Date(),then=new Date(now.getTime()+3600000);
    const fmt=d=>"'"+d.toISOString().slice(0,16).replace('T',' ')+"'";
    const p=new URLSearchParams({
      format:'text',COMMAND:"'"+cmd+"'",OBJ_DATA:'NO',MAKE_EPHEM:'YES',
      EPHEM_TYPE:'ELEMENTS',CENTER:"'500@10'",
      START_TIME:fmt(now),STOP_TIME:fmt(then),STEP_SIZE:'1',
      OUT_UNITS:'AU-D',REF_PLANE:'ECLIPTIC',CSV_FORMAT:'YES'});
    const out=await this.fetchAPI(p,txt=>this.parseElements(txt));
    if(out) this.elsCache[k]=out;
    return out;
  },
  async fetchAPI(params,parser){
    const base='https://ssd.jpl.nasa.gov/api/horizons.api?'+params.toString();
    const urls=urlChain(base);
    for(const u of urls){
      try{
        const r=await fetch(u,{signal:fetchTimeoutSignal(15000)});
        if(!r.ok) continue;
        const txt=await r.text();
        if(txt.length>100) return parser(txt);
      }catch(e){}
    }
    return null;
  },

  /* observer-table parser: $$SOE..$$EOE CSV */
  parse(txt){
    const out={rows:[],bodyName:null,msg:null,excerpt:null};
    const tn=txt.match(/Target body name:\s*(.+?)\s{2,}/);
    if(tn) out.bodyName=tn[1].trim();
    const i0=txt.indexOf('$$SOE'),i1=txt.indexOf('$$EOE');
    if(i0<0||i1<0){
      const cov=EPHSVC.coverage(txt);
      if(cov){
        out.coverage=cov;
        out.msg=cov.side==='end'
          ?'Horizons has no ephemeris after '+fmtDateUTC(cov.date)+' UTC. The mission has ended, the object is lost or decayed, or JPL has not published newer data.'
          :'Horizons ephemeris starts '+fmtDateUTC(cov.date)+' UTC.';
        return out;
      }
      if(/Multiple major-bodies|matches|Matching small-bodies/i.test(txt)){
        out.msg='Ambiguous designation — Horizons returned multiple matches (list below). Refine the query.';
        out.excerpt=txt.split('\n').filter(l=>/^\s*-?\d|Record|name/i.test(l)).slice(0,25).join('\n');
      } else if(/No ephemeris|cannot be computed|No site/i.test(txt)){
        out.msg='Horizons could not compute an ephemeris for this target/site.';
        out.excerpt=txt.slice(0,600);
      } else {out.msg='Unexpected Horizons response.';out.excerpt=txt.slice(0,600);}
      return out;
    }
    const MON={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
    txt.slice(i0+5,i1).split('\n').forEach(line=>{
      line=line.trim();if(!line) return;
      const c=line.split(',').map(s=>s.trim());
      if(c.length<7) return;
      const dm=c[0].match(/(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}):(\d{2})/);
      if(!dm) return;
      const d=new Date(Date.UTC(+dm[1],MON[dm[2]],+dm[3],+dm[4],+dm[5]));
      const num=v=>{const f=parseFloat(v);return isFinite(f)?f:null;};
      out.rows.push({
        d,sunFlag:c[1]||'',moonFlag:c[2]||'',
        ra:num(c[3]),dec:num(c[4]),az:num(c[5]),el:num(c[6]),
        mag:num(c[7]),sbrt:num(c[8]),delta:num(c[9]),deldot:num(c[10]),
        elong:num(c[11]),phase:num(c[13])});
    });
    return out;
  },
  /* ELEMENTS parser → {a,e,i,Om,w,M0,n,epoch}  (angles rad, n deg/day, epoch JD TDB) */
  parseElements(txt){
    const i0=txt.indexOf('$$SOE'),i1=txt.indexOf('$$EOE');
    if(i0<0||i1<0) return null;
    const line=txt.slice(i0+5,i1).split('\n').map(l=>l.trim()).find(l=>l.length>10);
    if(!line) return null;
    const c=line.split(',').map(s=>s.trim());
    /* CSV columns: JDTDB, CalDate, EC, QR, IN, OM, W, Tp, N, MA, TA, A, AD, PR */
    const f=i=>parseFloat(c[i]);
    if(c.length<12||!isFinite(f(2))) return null;
    return{epoch:f(0),e:f(2),i:f(4)*D2R,Om:f(5)*D2R,w:f(6)*D2R,n:f(8),M0:f(9),a:f(11)};
  },

  twiLabel(f){return f==='*'?'DAYLIGHT':f==='C'?'CIVIL TWILIGHT':f==='N'?'NAUTICAL TWILIGHT':f==='A'?'ASTRONOMICAL TWILIGHT':'NIGHT';},
  twiShort(f){return f==='*'?'DAY':f==='C'?'CIV':f==='N'?'NAU':f==='A'?'AST':'NIGHT';},
  twiColor(f){return f==='*'?'rgba(185,185,185,0.20)':f==='C'?'rgba(157,157,157,0.135)':f==='N'?'rgba(129,129,129,0.085)':f==='A'?'rgba(87,87,87,0.05)':'rgba(0,0,0,0)';},
  twiText(f){return f==='*'?'rgba(213,213,213,.95)':f==='C'?'rgba(185,185,185,.9)':f==='N'?'rgba(161,161,161,.85)':f==='A'?'rgba(142,142,142,.8)':'rgba(142,142,142,.75)';},
  darkOK(f){return f===''||f==='A';},
  minEl(){return parseInt(document.getElementById('eph-minel').value,10);},

  activePlot(){return this.plotted.find(p=>p.cmd===this.active);},

  /* ───────── rendering ───────── */
  renderAll(){
    const ap=this.activePlot();if(!ap) return;
    if(!ap.rows||!ap.rows.length) return;
    const rows=ap.rows,minEl=this.minEl();
    const exempt=ap.cmd==='10'||ap.cmd==='301';
    const visAt=r=>r.el!==null&&r.el>minEl&&(exempt||this.darkOK(r.sunFlag));
    const nowMs=Date.now();
    let iNow=0;for(let i=0;i<rows.length;i++) if(Math.abs(rows[i].d-nowMs)<Math.abs(rows[iNow].d-nowMs)) iNow=i;
    const rNow=rows[iNow];

    /* plotted chips */
    const pc=document.getElementById('eph-plotted');
    pc.innerHTML='<span class="ep-lbl">PLOTTED</span>'+this.plotted.map(p=>
      '<span class="ep-chip'+(p.cmd===this.active?' on':'')+'" style="--c:'+p.color+'" '+
      'onclick="EPH.setActive(\''+p.cmd.replace(/'/g,"\\'")+'\')">'+p.g+' '+p.name+
      '<i onclick="event.stopPropagation();EPH.removePlot(\''+p.cmd.replace(/'/g,"\\'")+'\')">✕</i></span>').join('');

    /* verdict */
    const v=document.getElementById('eph-verdict');
    v.style.display='inline-flex';
    if(visAt(rNow)){v.textContent='● VISIBLE NOW';v.className='verdict v-vis';}
    else if(rNow.el!==null&&rNow.el>minEl){v.textContent='◐ UP · SKY TOO BRIGHT ('+this.twiShort(rNow.sunFlag)+')';v.className='verdict v-bright';}
    else{v.textContent='○ BELOW '+minEl+'° NOW';v.className='verdict v-down';}

    /* now grid (timestamped) */
    const g=document.getElementById('eph-now-grid');
    g.style.display='flex';
    const cell=(k,val,cls)=>'<div class="eg"><div class="eg-k">'+k+'</div><div class="eg-v '+(cls||'')+'">'+val+'</div></div>';
    const raH=rNow.ra!==null?(rNow.ra/15):null;
    const raStr=raH!==null?(Math.floor(raH)+'h '+padZ(Math.floor((raH%1)*60))+'m '+padZ(Math.round((((raH%1)*60)%1)*60))+'s'):'—';
    const decStr=rNow.dec!==null?((rNow.dec>=0?'+':'')+rNow.dec.toFixed(3)+'°'):'—';
    g.innerHTML=
      cell('EPOCH',fmtLocalShort(rNow.d,SITE.tz)+' LOC / '+fmtUTCShort(rNow.d)+' UTC','accent')+
      cell('AZ / EL',rNow.az!==null?rNow.az.toFixed(1)+'° / '+rNow.el.toFixed(1)+'°':'—',rNow.el>minEl?'green':'')+
      cell('RA (ICRF)',raStr)+cell('DEC (ICRF)',decStr)+
      cell('V MAG',rNow.mag!==null?rNow.mag.toFixed(2):'—')+
      cell('RANGE',rNow.delta!==null?(rNow.delta<0.01?(rNow.delta*149597870.7).toFixed(0)+' km':rNow.delta.toFixed(4)+' AU'):'—')+
      cell('RANGE-RATE',rNow.deldot!==null?rNow.deldot.toFixed(2)+' km/s':'—')+
      cell('SOLAR ELONG',rNow.elong!==null?rNow.elong.toFixed(1)+'°':'—')+
      cell('PHASE',rNow.phase!==null?rNow.phase.toFixed(1)+'°':'—')+
      cell('SKY',this.twiLabel(rNow.sunFlag),this.darkOK(rNow.sunFlag)?'green':'amber');

    /* windows (active target) */
    const wins=[];let w=null;
    rows.forEach((r,i)=>{
      if(visAt(r)){if(!w)w={i0:i,i1:i,pk:r.el,iPk:i};else{w.i1=i;if(r.el>w.pk){w.pk=r.el;w.iPk=i;}}}
      else if(w){wins.push(w);w=null;}
    });
    if(w)wins.push(w);
    const wt=document.getElementById('eph-win-title'),wb=document.getElementById('eph-windows');
    wt.style.display='block';
    wt.textContent='VISIBILITY WINDOWS · '+ap.name.toUpperCase()+' · EL >'+minEl+'°'+(exempt?'':' IN ASTRONOMICAL DARKNESS');
    if(!wins.length){
      wb.innerHTML='<div class="eph-nowin">NO VISIBILITY WINDOWS IN THE NEXT 72 H</div>';
    } else {
      wb.innerHTML='<div class="ew-row hdr"><span>START (LOCAL)</span><span>END (LOCAL)</span><span>DUR</span><span>PEAK EL</span><span>AZ@PK</span><span>MAG</span></div>'+
        wins.map(W=>{
          const a=rows[W.i0],b=rows[W.i1],pk=rows[W.iPk];
          const dur=(b.d-a.d)/60000+30;
          return'<div class="ew-row"><span class="green">'+this.dayTag(a.d)+' '+fmtLocalShort(a.d,SITE.tz)+'</span>'+
            '<span>'+this.dayTag(b.d)+' '+fmtLocalShort(b.d,SITE.tz)+'</span>'+
            '<span>'+(dur>=60?Math.floor(dur/60)+'h'+padZ(Math.round(dur%60)):Math.round(dur)+'m')+'</span>'+
            '<span class="amber">'+pk.el.toFixed(0)+'°</span><span>'+pk.az.toFixed(0)+'°</span>'+
            '<span>'+(pk.mag!==null?pk.mag.toFixed(1):'—')+'</span></div>';
        }).join('');
    }
    document.getElementById('eph-att').style.display='block';
    this.renderSiteChip();
    this.drawChart();
  },
  dayTag(d){
    const DAYS=['SUN','MON','TUE','WED','THU','FRI','SAT'];
    /* local civil date via tz offset */
    const loc=new Date(d.getTime()+(SITE.tzOffsetMin||0)*60000);
    return DAYS[loc.getUTCDay()]+' '+loc.getUTCDate();
  },

  drawChart(){
    const ap=this.activePlot();if(!ap) return;
    const panel=document.getElementById('eph-chart-panel');panel.style.display='block';
    const c=document.getElementById('eph-chart');
    resizeCanvas(c);
    const ctx=c.getContext('2d'),W=c.width,H=c.height;
    if(!ap.rows||!ap.rows.length) return;
    const rows=ap.rows,minEl=this.minEl();
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#040404';ctx.fillRect(0,0,W,H);
    const padL=36,padR=10,padT=22,padB=30;
    const pw=W-padL-padR,ph=H-padT-padB;
    const t0=rows[0].d.getTime(),t1=rows[rows.length-1].d.getTime();
    const X=t=>padL+((t-t0)/(t1-t0))*pw;
    const elMin=-30,elMax=90;
    const Y=el=>padT+(1-(el-elMin)/(elMax-elMin))*ph;

    /* twilight bands from the ACTIVE target's solar-presence flags + labels */
    let bi=0;
    while(bi<rows.length-1){
      const f=rows[bi].sunFlag;let bj=bi;
      while(bj<rows.length-1&&rows[bj+1].sunFlag===f) bj++;
      const x0=X(rows[bi].d),x1=X(rows[Math.min(bj+1,rows.length-1)].d);
      const col=this.twiColor(f);
      if(col!=='rgba(0,0,0,0)'){ctx.fillStyle=col;ctx.fillRect(x0,padT,x1-x0,ph);}
      if(x1-x0>34){ /* readable in-chart band label */
        ctx.fillStyle=this.twiText(f);
        ctx.font='bold 10px "IBM Plex Mono",monospace';ctx.textAlign='center';
        ctx.fillText(this.twiShort(f),(x0+x1)/2,padT-9);
        ctx.strokeStyle=this.twiText(f);ctx.lineWidth=.6;ctx.globalAlpha=.6;
        ctx.beginPath();ctx.moveTo(x0+1,padT-5);ctx.lineTo(x1-1,padT-5);ctx.stroke();ctx.globalAlpha=1;
      }
      bi=bj+1;
    }
    /* grid */
    ctx.font='11px IBM Plex Mono';ctx.textAlign='right';
    [-30,0,30,60,90].forEach(e=>{
      ctx.strokeStyle=e===0?'rgba(204,204,204,0.5)':'rgba(51,51,51,0.7)';
      ctx.lineWidth=e===0?1:0.5;
      ctx.beginPath();ctx.moveTo(padL,Y(e));ctx.lineTo(W-padR,Y(e));ctx.stroke();
      ctx.fillStyle='rgba(178,178,178,0.9)';ctx.fillText(e+'°',padL-4,Y(e)+2);
    });
    ctx.strokeStyle='rgba(144,144,144,0.55)';ctx.setLineDash([4,4]);ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(padL,Y(minEl));ctx.lineTo(W-padR,Y(minEl));ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='rgba(144,144,144,0.85)';ctx.textAlign='left';
    ctx.fillText('MIN EL '+minEl+'°',padL+4,Y(minEl)-3);

    /* time axis: local-midnight ticks with weekday+date, noon minor */
    ctx.textAlign='center';
    for(let t=t0;t<=t1;t+=1800000){
      const d=new Date(t);
      const ls=fmtLocalTime(d,SITE.tz);
      const lh=parseInt(ls.slice(0,2),10),lm=parseInt(ls.slice(3,5),10);
      if(lm!==0) continue;
      if(lh===0){
        ctx.strokeStyle='rgba(204,204,204,0.3)';ctx.lineWidth=1;
        ctx.beginPath();ctx.moveTo(X(t),padT);ctx.lineTo(X(t),padT+ph);ctx.stroke();
        ctx.fillStyle='rgba(204,204,204,0.9)';ctx.font='bold 11px "IBM Plex Mono",monospace';
        ctx.fillText(this.dayTag(new Date(t+3600000)),X(t),H-17);
        ctx.fillStyle='rgba(178,178,178,0.8)';ctx.font='10px IBM Plex Mono';
        ctx.fillText('00:00',X(t),H-7);
      } else if(lh%6===0){
        ctx.strokeStyle='rgba(72,72,72,0.35)';ctx.lineWidth=.5;
        ctx.beginPath();ctx.moveTo(X(t),padT);ctx.lineTo(X(t),padT+ph);ctx.stroke();
        ctx.fillStyle='rgba(147,147,147,0.85)';ctx.font='10px IBM Plex Mono';
        ctx.fillText(padZ(lh)+':00',X(t),H-7);
      }
    }
    ctx.textAlign='left';
    ctx.fillStyle='rgba(178,178,178,0.85)';ctx.font='10px "IBM Plex Mono",monospace';
    ctx.fillText('LOCAL TIME · '+SITE.tz,padL,H-17);

    /* curves: every plotted target; active = thick, visible spans glow green */
    this.plotted.forEach(p=>{
      const isA=p.cmd===this.active;
      const ex2=p.cmd==='10'||p.cmd==='301';
      if(!p.rows||!p.rows.length) return;
      for(let i=0;i<p.rows.length-1;i++){
        const a=p.rows[i],b=p.rows[i+1];
        if(a.el===null||b.el===null) continue;
        if(a.d<t0||b.d>t1) continue;
        const vis=a.el>minEl&&(ex2||this.darkOK(a.sunFlag));
        if(isA&&vis){ctx.strokeStyle='#7fbf98';ctx.lineWidth=2.6;ctx.shadowColor='#7fbf98';ctx.shadowBlur=0;}
        else{ctx.strokeStyle=p.color;ctx.lineWidth=isA?1.7:1;ctx.shadowBlur=0;ctx.globalAlpha=isA?0.95:0.55;}
        ctx.beginPath();ctx.moveTo(X(a.d),Y(a.el));ctx.lineTo(X(b.d),Y(b.el));ctx.stroke();
        ctx.shadowBlur=0;ctx.globalAlpha=1;
      }
    });

    /* NOW line with timestamp (global epoch) */
    const nowMs=EPOCH.ms();
    if(nowMs>=t0&&nowMs<=t1){
      ctx.strokeStyle='#e0e0e0';ctx.lineWidth=1.2;
      ctx.beginPath();ctx.moveTo(X(nowMs),padT);ctx.lineTo(X(nowMs),padT+ph);ctx.stroke();
      ctx.fillStyle='#e0e0e0';ctx.font='bold 10px "IBM Plex Mono",monospace';ctx.textAlign='center';
      ctx.fillText('NOW '+fmtLocalShort(new Date(nowMs),SITE.tz),X(nowMs),padT+8);
      ctx.textAlign='left';
    }
    ctx.save();ctx.translate(9,padT+ph/2);ctx.rotate(-Math.PI/2);
    ctx.fillStyle='rgba(178,178,178,0.9)';ctx.font='10px "IBM Plex Mono",monospace';ctx.textAlign='center';
    ctx.fillText('ELEVATION',0,0);ctx.restore();

    /* hover crosshair */
    if(!c._hoverBound){
      c._hoverBound=true;
      c.addEventListener('mousemove',e=>{
        const r=c.getBoundingClientRect();
        EPH._chartHover=(e.clientX-r.left)*(c.width/r.width);
        EPH.drawChart();EPH.chartTip(e);
      });
      c.addEventListener('mouseleave',()=>{EPH._chartHover=-1;document.getElementById('eph-tip').style.display='none';EPH.drawChart();});
    }
    if(this._chartHover>=padL&&this._chartHover<=W-padR){
      const tH=t0+((this._chartHover-padL)/pw)*(t1-t0);
      let iH=0;for(let i=0;i<rows.length;i++) if(Math.abs(rows[i].d-tH)<Math.abs(rows[iH].d-tH)) iH=i;
      const rH=rows[iH];
      ctx.strokeStyle='rgba(255,255,255,0.3)';ctx.lineWidth=0.8;
      ctx.beginPath();ctx.moveTo(X(rH.d),padT);ctx.lineTo(X(rH.d),padT+ph);ctx.stroke();
      if(rH.el!==null){
        ctx.fillStyle='#ffffff';ctx.beginPath();ctx.arc(X(rH.d),Y(rH.el),3,0,2*Math.PI);ctx.fill();
      }
      this._tipRow=rH;this._tipT=tH;
    }
  },
  chartTip(e){
    const r=this._tipRow;if(!r) return;
    const tip=document.getElementById('eph-tip');
    tip.style.display='block';
    const ap=this.activePlot();
    let extra='';
    this.plotted.forEach(p=>{
      if(!this._tipT) return;
      if(!p.rows||!p.rows.length) return;
      let j=0;for(let i=0;i<p.rows.length;i++) if(Math.abs(p.rows[i].d-this._tipT)<Math.abs(p.rows[j].d-this._tipT)) j=i;
      const rr=p.rows[j];
      if(rr&&rr.el!==null) extra+='<div style="color:'+p.color+'">'+p.g+' '+p.name+' · EL '+rr.el.toFixed(1)+'° AZ '+rr.az.toFixed(0)+'°'+(rr.mag!==null?' · m'+rr.mag.toFixed(1):'')+'</div>';
    });
    tip.innerHTML='<b>'+this.dayTag(r.d)+' · '+fmtLocalShort(r.d,SITE.tz)+' LOC · '+fmtUTCShort(r.d)+' UTC</b> · '+this.twiLabel(r.sunFlag)+extra;
    let x=e.clientX+12,y=e.clientY+10;
    if(x+tip.offsetWidth>window.innerWidth-10)x=e.clientX-tip.offsetWidth-12;
    tip.style.left=x+'px';tip.style.top=y+'px';
  }
};
document.getElementById('eph-minel').addEventListener('input',e=>{
  document.getElementById('eph-minel-val').textContent=e.target.value+'°';
  if(EPH.activePlot()) EPH.renderAll();
});
document.getElementById('eph-site-sel').addEventListener('change',e=>{
  EPH.sitePreset(parseInt(e.target.value,10));e.target.value='0';
});

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  MODULE · DiscoveryCenter — public-engagement interface           ║
   ║  · naked-eye pass predictor (mag ≤ 3.5) + overhead screen alert   ║
   ║  · pop-culture metric transformation cards + history blurbs       ║
   ║  · interactive Keplerian orbital sandbox (a / e / i sliders)      ║
   ║  · live NOAA SWPC space weather (Kp, flares, solar wind)          ║
   ║  · global rocket launch manifest (Launch Library 2)               ║
   ╚══════════════════════════════════════════════════════════════════╝ */
/* The Discovery tab (news wire, SDO imagery, launch manifest, sandbox) was
   removed in the overhaul. This stub keeps saved sessions and shared code paths
   working. The two space-weather numbers that matter for drag live in SWX. */
