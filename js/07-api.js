/* ╔══════════════════════════════════════════════════════════════════╗
   ║  SSA · command interface                                          ║
   ║  A fixed list of named commands that another program (Claire, a   ║
   ║  script, a test) can call to drive the dashboard and read back    ║
   ║  the numbers it shows. The buttons and these commands call the    ║
   ║  same functions, so what Claire says matches what is on screen.   ║
   ║                                                                   ║
   ║    await SSA.run('lists.show', {tab:'inview', type:'debris'})     ║
   ║    SSA.describe()   every command, its options and example words  ║
   ║    SSA.tools()      the same list as language-model tool specs    ║
   ║    SSA.state()      what is on screen right now                   ║
   ║    SSA.on(fn)       events (ready, catalog loaded, scan done …)   ║
   ║                                                                   ║
   ║  Ways in: call SSA directly (pywebview evaluate_js, Playwright),  ║
   ║  window.postMessage with ?claire=1, a WebSocket to a local        ║
   ║  program with ?claire=ws://localhost:8765, or a link that sets    ║
   ║  the view (?view=observer&list=inview&type=debris).               ║
   ║  Full reference: docs/COMMANDS.md                                 ║
   ╚══════════════════════════════════════════════════════════════════╝ */
const SSA=(function(){
  const VERSION='1.0.0';
  const VIEW_ID={observer:'tracker',catalog:'catalog',ephemeris:'eph',conjunctions:'ca'};
  const VIEW_NAME={tracker:'observer',catalog:'catalog',eph:'ephemeris',ca:'conjunctions',disc:'observer'};

  /* ───────── small helpers ───────── */
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function until(fn,ms=30000,step=150){
    const t0=Date.now();
    while(Date.now()-t0<ms){
      try{const v=fn();if(v) return v;}catch(e){}
      await sleep(step);
    }
    return null;
  }
  class Fail extends Error{constructor(msg,extra){super(msg);this.extra=extra||null;}}
  const fail=(msg,extra)=>{throw new Fail(msg,extra);};
  const num=(x,d=1)=>x==null||!isFinite(x)?null:Math.round(x*10**d)/10**d;
  const isoUTC=ms=>new Date(ms).toISOString().replace(/\.\d{3}Z$/,'Z');
  function localStr(ms){
    try{
      return new Intl.DateTimeFormat('sv-SE',{timeZone:SITE.tz||'UTC',year:'numeric',month:'2-digit',day:'2-digit',
        hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(ms));
    }catch(e){return isoUTC(ms);}
  }
  /* every time in a result: UTC, local wall time at the site, and minutes from the dashboard clock */
  const when=ms=>ms==null||!isFinite(ms)?null:{utc:isoUTC(ms),local:localStr(ms),in_min:num((ms-EPOCH.ms())/60000,1)};
  const compass=az=>OBS.compass(az);
  const curView=()=>VIEW_NAME[document.body.dataset.view]||'observer';
  function setView(v){if(curView()!==v) switchView(VIEW_ID[v]);}
  const norm=s=>String(s||'').toUpperCase().replace(/\s+/g,' ').trim();

  /* ───────── finding objects (TLE class) ───────── */
  async function celestrakByName(q){
    const base='https://celestrak.org/NORAD/elements/gp.php?NAME='+encodeURIComponent(q)+'&FORMAT=tle';
    for(const u of urlChain(base)){
      try{
        const r=await fetch(u,{signal:fetchTimeoutSignal(15000)});
        if(!r.ok) continue;
        const t=await r.text();
        return /^1 /m.test(t)?parseCatalog(t).filter(x=>x.satrec):[];
      }catch(e){}
    }
    return null;
  }
  function pools(){return [allSats,SITECAT.list,(CAT.sats||[]).map(s=>s.tle)];}
  function searchLocal(q){
    const n=norm(q),out=new Map();
    const add=t=>{if(t&&t.satrec&&!out.has(t.satnum)) out.set(t.satnum,t);};
    for(const P of pools()) P.forEach(t=>{if(norm(t.name)===n) add(t);});
    for(const P of pools()) P.forEach(t=>{const m=norm(t.name);if(m.startsWith(n+' ')||m.startsWith(n+'(')||m.startsWith(n+'-')) add(t);});
    for(const P of pools()) P.forEach(t=>{if(norm(t.name).includes(n)) add(t);});
    return [...out.values()];
  }
  /* everyday names whose catalog names differ ("Hubble" is listed as HST; "HUBBLE 6" is something else) */
  const COMMON={'HUBBLE':20580,'HUBBLE SPACE TELESCOPE':20580,'HST':20580,'ISS':25544,'SPACE STATION':25544,
    'INTERNATIONAL SPACE STATION':25544,'THE SPACE STATION':25544,'ZARYA':25544,'TIANGONG':48274,'CHINESE SPACE STATION':48274,
    'CSS':48274,'TIANHE':48274};
  /* one object from a name or NORAD number; asks for clarification when the name is ambiguous */
  async function findTLE(q){
    if(q===undefined||q===null||String(q).trim()==='') fail('Name an object (name or NORAD number).');
    let s=String(q).trim();
    if(COMMON[norm(s)]) s=String(COMMON[norm(s)]);
    if(/^\d+$/.test(s)){
      const id=+s;
      for(const P of pools()){const t=P.find(x=>x.satnum===id&&x.satrec);if(t) return t;}
      const t=await CA.fetchTLE(id);
      if(t) return t;
      fail('No element set found for NORAD '+id+'.');
    }
    const n=norm(s);
    let hits=searchLocal(s);
    if(!hits.length){const r=await celestrakByName(s);if(r&&r.length) hits=r;}
    if(!hits.length) fail('No Earth-orbiting object matches "'+s+'". Objects beyond Earth orbit are in the ephemeris commands.');
    const exact=hits.filter(t=>norm(t.name)===n);
    if(exact.length) return exact.sort((a,b)=>a.satnum-b.satnum)[0];
    const pre=hits.filter(t=>{const m=norm(t.name);return m.startsWith(n+' ')||m.startsWith(n+'(')||m.startsWith(n+'-');});
    if(pre.length) return pre.sort((a,b)=>a.satnum-b.satnum)[0];
    if(hits.length===1) return hits[0];
    fail('"'+s+'" matches several objects. Say which one.',{matches:hits.slice(0,10).map(brief)});
  }
  const typeOf=t=>t.objType||(typeof CAT!=='undefined'?CAT.objTypeOfName(t):'UNKNOWN');
  const brief=t=>({norad:t.satnum,name:t.name,type:typeOf(t),orbit:t.orbitType,tle_age_days:num(tleAgeDays(t),1)});

  function lookNow(tle,ms){
    const d=new Date(ms===undefined?EPOCH.ms():ms),C=OBS.ctx();
    const o=OBS.look(tle.satrec,OBS.frame(d),C,true);
    if(!o) return null;
    const o2=OBS.look(tle.satrec,OBS.frame(new Date(d.getTime()+2000)),C);
    return{azimuth_deg:num(o.az,2),elevation_deg:num(o.el,2),direction:compass(o.az),
      above_horizon:o.el>0,rising:o2?o2.el>=o.el:null,range_km:num(o.rng,1),range_rate_km_s:num(o.rr,3),
      ra_j2000_hours:num(o.ra,5),ra_j2000:OBS.fmtRA(o.ra),dec_j2000_deg:num(o.dec,4),dec_j2000:OBS.fmtDec(o.dec),
      altitude_km:num(o.alt,1),speed_km_s:num(o.speed,3),subpoint_lat_deg:num(o.lat,2),subpoint_lon_deg:num(o.lon,2),
      sunlit:!!o.sunlit};
  }
  function elements(t){
    return{epoch:isoUTC(t.epoch.getTime()),tle_age_days:num(tleAgeDays(t),2),inclination_deg:num(t.inc,4),
      eccentricity:num(t.ecc,7),raan_deg:num(t.raan,4),arg_perigee_deg:num(t.argp,4),mean_anomaly_deg:num(t.M,4),
      mean_motion_rev_day:num(t.n,8),period_min:num(t.T_s/60,2),semi_major_axis_km:num(t.a,1),
      perigee_alt_km:num(t.a*(1-t.ecc)-RE_KM,1),apogee_alt_km:num(t.a*(1+t.ecc)-RE_KM,1)};
  }
  function passOut(p,t0ms){
    const at=s=>t0ms+s*1000;
    const o={rise:when(at(p.t_rise)),rise_az_deg:num(p.az_rise,0),rise_direction:compass(p.az_rise),
      peak:when(at(p.t_peak)),max_elevation_deg:num(p.el_peak,1),peak_az_deg:num(p.az_peak,0),peak_direction:compass(p.az_peak),
      set:when(at(p.t_set)),set_az_deg:num(p.az_set,0),set_direction:compass(p.az_set),
      duration_min:num((p.t_set-p.t_rise)/60,1),naked_eye:!!p.visible,
      why_not_visible:p.visible?null:(p.why==='DAY'?'daylight at the site':p.why==='ECL'?'in Earth shadow':null)};
    if(p.visible) o.naked_eye_window={start:when(at(p.t_vis0)),end:when(at(p.t_vis1)),max_elevation_deg:num(p.el_visPeak,1)};
    return o;
  }
  function passesFor(tle,hours){
    const anchor=new Date(EPOCH.ms());
    const d=propagate(tle,hours*3600,anchor);
    const ps=findPasses(Array.from(d.az),Array.from(d.el),Array.from(d.tArr),d.sunlit,d.sunAlt);
    return ps.map(p=>passOut(p,d.now.getTime()));
  }
  async function trackedRow(S,i){
    const nowMs=EPOCH.ms(),t0=S.data.now.getTime(),el0=(nowMs-t0)/1000;
    const cur=S.passes.find(p=>p.t_rise<=el0&&el0<=p.t_set);
    const nxt=S.passes.find(p=>p.t_rise>el0);
    let nv=nextNakedEye(S,el0);
    if(nv==='scan'){await until(()=>nextNakedEye(S,el0)!=='scan',4000,120);nv=nextNakedEye(S,el0);}
    return{norad:S.tle.satnum,name:S.tle.name,primary:i===0,color:S.color,type:typeOf(S.tle),
      status:cur?'in view':nxt?'below horizon':'no pass in the forecast horizon',
      now:lookNow(S.tle,nowMs),
      current_pass:cur?passOut(cur,t0):null,next_pass:nxt?passOut(nxt,t0):null,
      next_naked_eye:nv&&nv!=='scan'?{start:when(nv.t0.getTime()),max_elevation_deg:num(nv.pk,1)}:null,
      tle_age_days:num(tleAgeDays(S.tle),2)};
  }

  /* ───────── argument handling ───────── */
  function asBool(v,name){
    if(typeof v==='boolean') return v;
    const s=String(v).toLowerCase().trim();
    if(['1','true','yes','on','y','show','enable'].includes(s)) return true;
    if(['0','false','no','off','n','hide','disable'].includes(s)) return false;
    fail('"'+name+'" must be true or false.');
  }
  function asEnum(v,spec,name){
    const vals=spec.values;
    if(typeof vals[0]==='number'){
      const x=parseFloat(v);
      if(!isFinite(x)) fail('"'+name+'" must be one of '+vals.join(', ')+'.');
      if(vals.includes(x)) return x;
      if(spec.nearest) return vals.reduce((a,b)=>Math.abs(b-x)<Math.abs(a-x)?b:a);
      fail('"'+name+'" must be one of '+vals.join(', ')+'.');
    }
    const s=String(v).toLowerCase().trim();
    const hit=vals.find(x=>x===s);
    if(hit) return hit;
    for(const[k,list] of Object.entries(spec.aliases||{})) if(list.includes(s)) return k;
    const loose=s.replace(/[^a-z0-9]/g,'');
    const h2=vals.find(x=>x.replace(/[^a-z0-9]/g,'')===loose);
    if(h2) return h2;
    for(const[k,list] of Object.entries(spec.aliases||{})) if(list.some(a=>a.replace(/[^a-z0-9]/g,'')===loose)) return k;
    fail('"'+name+'" must be one of: '+vals.join(', ')+'.');
  }
  function coerce(def,args){
    const out={},spec=def.args||{};
    args=args||{};
    if(typeof args!=='object'||Array.isArray(args)) fail('Options must be an object, e.g. {"tab":"passes"}.');
    for(const k of Object.keys(args)) if(!(k in spec)) fail('Unknown option "'+k+'" for '+def.name+'. Options: '+(Object.keys(spec).join(', ')||'none')+'.');
    for(const[k,s] of Object.entries(spec)){
      let v=args[k];
      if(v===undefined||v===null||v===''){
        if(s.required) fail('"'+k+'" is required for '+def.name+'.');
        if(s.default!==undefined) out[k]=s.default;
        continue;
      }
      if(s.type==='number'){
        v=parseFloat(v);
        if(!isFinite(v)) fail('"'+k+'" must be a number.');
        if(s.min!==undefined&&v<s.min) fail('"'+k+'" must be at least '+s.min+'.');
        if(s.max!==undefined&&v>s.max) fail('"'+k+'" must be at most '+s.max+'.');
      } else if(s.type==='boolean') v=asBool(v,k);
      else if(s.type==='enum') v=asEnum(v,s,k);
      else if(s.type==='list'){v=Array.isArray(v)?v.map(String):String(v).split(',').map(x=>x.trim()).filter(Boolean);}
      else if(s.type==='object_ref') v=String(v).trim();
      else v=String(v);
      out[k]=v;
    }
    return out;
  }

  /* ───────── the command table ─────────
     name: dotted, lowercase. say: phrases a person might use (for the language model).
     args: {type: number|string|boolean|enum|list|object_ref, values, aliases, default, required, desc} */
  const CMDS=[];
  const C=(name,def)=>{def.name=name;CMDS.push(def);};
  const OBJ={type:'object_ref',desc:'Object name (e.g. "ISS", "Hubble") or NORAD catalog number (e.g. 25544).'};
  const LIST_TYPES={type:'enum',values:['all','payload','rb','debris'],
    aliases:{all:['everything','all objects','any'],payload:['payloads','satellite','satellites','active','spacecraft'],
             rb:['rocket body','rocket bodies','r/b','rockets','stages','upper stage'],debris:['junk','fragments','deb']},
    desc:'Object type to show.'};

  /* ── about the dashboard ── */
  C('help',{group:'about',summary:'List the commands (optionally only those whose name starts with a prefix).',
    say:['what can you do on the dashboard','list dashboard commands'],
    args:{prefix:{type:'string',desc:'Only commands starting with this, e.g. "lists".'}},
    run:a=>{const d=api.describe();if(a.prefix) d.commands=d.commands.filter(c=>c.name.startsWith(a.prefix));return d;}});
  C('state',{group:'about',summary:'What the dashboard is showing right now: view, clock, site, tracked objects, filters, loaded data.',
    say:['what is on the screen','where are we','current settings'],run:()=>api.state()});
  C('app.ready',{group:'about',summary:'Wait until the dashboard has started (and optionally until the full catalog has loaded).',
    args:{full_catalog:{type:'boolean',default:false,desc:'Also wait for the full public catalog.'},timeout_s:{type:'number',default:60,min:1,max:300}},
    run:async a=>{
      await until(()=>api._ready,a.timeout_s*1000);
      if(a.full_catalog){SITECAT.ensure();await until(()=>SITECAT.state==='ready'||SITECAT.state==='fail',a.timeout_s*1000);}
      return{ready:api._ready,full_catalog:SITECAT.state,objects:SITECAT.list.length};
    }});

  /* ── views ── */
  C('view.show',{group:'views',summary:'Switch the main tab.',
    say:['go to the catalog','open the JPL tab','show conjunctions','back to the observer'],
    args:{view:{type:'enum',required:true,values:['observer','catalog','ephemeris','conjunctions'],
      aliases:{observer:['tracker','tracking','passes','sky','home','main'],catalog:['3d','3-d','globe','earth','catalogue','all objects'],
               ephemeris:['jpl','horizons','eph','deep space','solar system','planets','asteroids'],
               conjunctions:['conjunction','close approach','close approaches','socrates','collisions','ca']}}},
    run:a=>{setView(a.view);return{view:curView()};}});

  /* ── time ── */
  C('time.get',{group:'time',summary:'The dashboard clock: simulated time, speed, and offset from real time.',
    say:['what time is it on the dashboard'],run:()=>api.state().time});
  C('time.live',{group:'time',summary:'Return to real time at normal speed.',say:['go live','back to now','reset time'],
    run:()=>{EPOCH.live();return api.state().time;}});
  C('time.pause',{group:'time',summary:'Freeze the clock.',say:['pause','stop the animation','freeze'],
    run:()=>{if(EPOCH.rate!==0) EPOCH.togglePause();return api.state().time;}});
  C('time.play',{group:'time',summary:'Run the clock (resume after a pause), optionally at a new speed.',
    say:['play','play the animation','resume','animate'],
    args:{rate:{type:'number',min:-1e7,max:1e7,desc:'Simulated seconds per real second (1 = real time, 60, 1000…).'}},
    run:a=>{if(a.rate!==undefined) EPOCH.setRate(a.rate);else if(EPOCH.rate===0) EPOCH.togglePause();return api.state().time;}});
  C('time.rate',{group:'time',summary:'Set clock speed in simulated seconds per real second. 0 pauses; negative runs backward.',
    say:['speed up','fast forward','60 times speed','slow down','run backward'],
    args:{rate:{type:'number',required:true,min:-1e7,max:1e7}},
    run:a=>{EPOCH.setRate(a.rate);return api.state().time;}});
  C('time.set',{group:'time',summary:'Jump the clock to a date and time. ISO 8601; without an offset it is read as UTC, or as site local time with local=true.',
    say:['set the time to 9 pm','jump to tomorrow at 6','go to 2026-12-01 03:00 UTC'],
    args:{time:{type:'string',required:true,desc:'e.g. "2026-12-01T03:00:00Z", "2026-12-01 21:30", or "now".'},
          local:{type:'boolean',default:false,desc:'Read a time without offset as site local time.'}},
    run:a=>{
      if(a.time.toLowerCase()==='now'){EPOCH.live();return api.state().time;}
      let s=a.time.trim().replace(' ','T');
      const hasOff=/([zZ]|[+-]\d{2}:?\d{2})$/.test(s);
      let ms=Date.parse(hasOff?s:s+'Z');
      if(!isFinite(ms)) fail('Could not read the time "'+a.time+'". Use e.g. 2026-12-01T21:30.');
      if(!hasOff&&a.local) ms-=(SITE.tzOffsetMin||0)*60000;
      EPOCH.setOffset(ms-Date.now());
      return api.state().time;
    }});
  C('time.shift',{group:'time',summary:'Move the clock forward (positive) or back (negative).',
    say:['go forward two hours','back 30 minutes','skip ahead a day'],
    args:{days:{type:'number',default:0},hours:{type:'number',default:0},minutes:{type:'number',default:0}},
    run:a=>{EPOCH.scrub(((a.days*24+a.hours)*60+a.minutes)*60000);return api.state().time;}});

  /* ── observer site ── */
  const siteOut=()=>({lat_deg:num(SITE.lat_deg,4),lon_deg:num(SITE.lon_deg,4),alt_m:Math.round(SITE.h_m),time_zone:SITE.tz,
    label:Math.abs(SITE.lat_deg).toFixed(2)+'°'+(SITE.lat_deg>=0?'N':'S')+' '+Math.abs(SITE.lon_deg).toFixed(2)+'°'+(SITE.lon_deg>=0?'E':'W')});
  async function setSite(lat,lon,alt){
    document.getElementById('inp-lat').value=lat;
    document.getElementById('inp-lon').value=lon;
    if(alt!==undefined) document.getElementById('inp-alt').value=alt;
    await applySite();
    return siteOut();
  }
  C('site.get',{group:'site',summary:'The observer site (latitude, longitude, altitude, time zone).',
    say:['where is my site','what site are we using'],run:()=>siteOut()});
  C('site.set',{group:'site',summary:'Move the observer site. Every pass, list and ephemeris is recomputed for it.',
    say:['set my site to','observe from','change location to'],
    args:{lat:{type:'number',required:true,min:-90,max:90,desc:'Degrees north.'},
          lon:{type:'number',required:true,min:-180,max:360,desc:'Degrees east (west is negative).'},
          alt_m:{type:'number',min:-500,max:9000,desc:'Metres above sea level (kept if omitted).'}},
    run:a=>setSite(a.lat,a.lon,a.alt_m)});
  C('site.preset',{group:'site',summary:'Use one of the built-in observatory sites.',
    say:['observe from Mauna Kea','use the Penn State site'],
    args:{name:{type:'enum',required:true,values:['penn state','mauna kea','paranal','kitt peak','greenwich','siding spring'],
      aliases:{'penn state':['state college','psu','home','university park','penn state state college'],
               'paranal':['cerro paranal','vlt','chile'],'greenwich':['royal greenwich','london'],'mauna kea':['hawaii','maunakea']}}},
    run:a=>{
      const s=EPH.SITES.find(x=>!x.hdr&&x.n.toLowerCase().includes(a.name.split(' ')[0]));
      if(!s) fail('Preset not found.');
      return setSite(s.lat,s.lon,s.h).then(o=>({preset:s.n,...o}));
    }});
  C('site.locate',{group:'site',summary:'Set the site from this computer\'s location (the browser may ask for permission).',
    say:['use my location','locate me','where am I'],
    run:async()=>{
      if(!navigator.geolocation) fail('This browser has no location service.');
      const before=SITE.lat_deg+','+SITE.lon_deg;
      geolocateMe();
      const ok=await until(()=>SITE.lat_deg+','+SITE.lon_deg!==before,20000,250);
      if(!ok) fail('No location came back (permission denied or unavailable). Use site.set with coordinates.');
      return siteOut();
    }});

  /* ── observer tab: TLE group and tracked objects ── */
  C('observer.groups',{group:'observer',summary:'The TLE groups the observer sidebar can load.',
    run:()=>[...document.getElementById('cat-select').options].map(o=>({group:o.value,label:o.textContent.trim()}))});
  C('observer.group',{group:'observer',summary:'Load a TLE group into the observer sidebar (Space Stations, Starlink, GPS …).',
    say:['load starlink','show the weather satellites','list GPS satellites'],
    args:{group:{type:'string',required:true,desc:'Group id or label, e.g. "starlink", "gps-ops", "Space Stations". See observer.groups.'}},
    run:async a=>{
      const sel=document.getElementById('cat-select'),q=a.group.toLowerCase().replace(/[^a-z0-9]/g,'');
      const opts=[...sel.options];
      const o=opts.find(x=>x.value.toLowerCase().replace(/[^a-z0-9]/g,'')===q)||opts.find(x=>x.textContent.toLowerCase().replace(/[^a-z0-9]/g,'')===q)||
              opts.find(x=>x.textContent.toLowerCase().replace(/[^a-z0-9]/g,'').includes(q))||opts.find(x=>x.value.toLowerCase().includes(q));
      if(!o) fail('No group matches "'+a.group+'".',{groups:opts.map(x=>x.textContent.trim())});
      setView('observer');
      sel.value=o.value;
      await loadCategory(o.value);
      return{group:o.value,label:o.textContent.trim(),objects:allSats.length,note:allSats.length?null:(LAST_TLE_NOTE||'CelesTrak returned nothing.')};
    }});
  C('objects.find',{group:'objects',summary:'Search Earth-orbiting objects by name or NORAD number across the loaded group, the full catalog and CelesTrak.',
    say:['find Hubble','is there a satellite called','search for Starlink 1000'],
    args:{query:{type:'string',required:true},limit:{type:'number',default:10,min:1,max:100}},
    run:async a=>{
      let hits=/^\d+$/.test(a.query.trim())?pools().flatMap(P=>P.filter(t=>t.satnum===+a.query.trim())):searchLocal(a.query);
      if(!hits.length&&SITECAT.state!=='ready'){SITECAT.ensure();await until(()=>SITECAT.state==='ready'||SITECAT.state==='fail',60000);
        hits=/^\d+$/.test(a.query.trim())?SITECAT.list.filter(t=>t.satnum===+a.query.trim()):searchLocal(a.query);}
      if(!hits.length){const r=/^\d+$/.test(a.query.trim())?[await CA.fetchTLE(+a.query.trim())].filter(Boolean):await celestrakByName(a.query);if(r) hits=r;}
      const uniq=[...new Map(hits.map(t=>[t.satnum,t])).values()];
      return{query:a.query,total:uniq.length,matches:uniq.slice(0,a.limit).map(brief)};
    }});
  C('objects.track',{group:'objects',summary:'Track an object in the observer tab (orbit, ground track, sky plot, passes). Up to 5 at once; the newest becomes primary.',
    say:['track the ISS','show me Hubble','follow NORAD 25544','plot Tiangong'],
    args:{object:{...OBJ,required:true},replace:{type:'boolean',default:false,desc:'Stop tracking everything else first.'}},
    run:async a=>{
      const t=await findTLE(a.object);
      setView('observer');
      if(a.replace) [...SEL].forEach(s=>{if(s.tle.satnum!==t.satnum) deselectSat(s.tle.satnum);});
      if(SEL.find(s=>s.tle.satnum===t.satnum)) makePrimary(t.satnum);
      else{selectSat(t);makePrimary(t.satnum);}
      if(PB.tab!=='tracked') PB.setTab('tracked');
      const S=SEL.find(s=>s.tle.satnum===t.satnum);
      if(!S||!S.data) fail('Tracking started but propagation failed for '+t.name+'.');
      return trackedRow(S,SEL.indexOf(S));
    }});
  C('objects.untrack',{group:'objects',summary:'Stop tracking one object, or all of them.',say:['stop tracking','remove the ISS','clear tracked objects'],
    args:{object:{...OBJ,required:true,desc:'Name, NORAD number, or "all".'}},
    run:async a=>{
      if(a.object.toLowerCase()==='all'){[...SEL].forEach(s=>deselectSat(s.tle.satnum));return{tracked:[]};}
      const s=String(a.object),n=norm(s);
      const S=SEL.find(x=>String(x.tle.satnum)===s)||SEL.find(x=>norm(x.tle.name)===n)||SEL.find(x=>norm(x.tle.name).includes(n));
      if(!S) fail('"'+s+'" is not being tracked.',{tracked:SEL.map(x=>x.tle.name)});
      deselectSat(S.tle.satnum);
      return{removed:S.tle.name,tracked:SEL.map(x=>x.tle.name)};
    }});
  C('objects.primary',{group:'objects',summary:'Make a tracked object the primary one (data panel, sky plot focus).',
    args:{object:{...OBJ,required:true}},
    run:async a=>{
      const s=String(a.object),n=norm(s);
      const S=SEL.find(x=>String(x.tle.satnum)===s)||SEL.find(x=>norm(x.tle.name).includes(n));
      if(!S) fail('"'+s+'" is not being tracked.',{tracked:SEL.map(x=>x.tle.name)});
      makePrimary(S.tle.satnum);
      return trackedRow(SEL[0],0);
    }});
  C('objects.tracked',{group:'objects',summary:'The tracked objects with where they are now, the current or next pass, and the next naked-eye pass.',
    say:['when does it rise','is the ISS up','what am I tracking'],
    run:async()=>{const out=[];for(let i=0;i<SEL.length;i++) if(SEL[i].data) out.push(await trackedRow(SEL[i],i));return{site:siteOut(),tracked:out};}});
  C('objects.info',{group:'objects',summary:'Everything about one Earth-orbiting object without changing the screen: orbital elements, position and pointing now (J2000 RA/Dec), and its passes over the site.',
    say:['tell me about Hubble','is the ISS visible tonight','when is the next Tiangong pass','where is NORAD 20580'],
    args:{object:{...OBJ,required:true},hours:{type:'number',default:24,min:1,max:72,desc:'How far ahead to list passes.'}},
    run:async a=>{
      const t=await findTLE(a.object);
      const passes=passesFor(t,a.hours);
      let nv=passes.find(p=>p.naked_eye&&p.naked_eye_window.end.in_min>0)||null;
      let nextNakedEye=nv?nv.naked_eye_window:null;
      if(!nextNakedEye&&a.hours<48){const w=findNextVisible(t,48);if(w) nextNakedEye={start:when(EPOCH.ms()+w.t0*1000),max_elevation_deg:num(w.elPk,1)};}
      return{...brief(t),site:siteOut(),now:lookNow(t),elements:elements(t),
        passes_hours:a.hours,passes:passes.filter(p=>p.set&&p.set.in_min>0),next_naked_eye:nextNakedEye,
        tle:t.rawL1&&t.rawL2?[t.name,t.rawL1,t.rawL2]:null};
    }});
  C('objects.download_tle',{group:'objects',summary:'Download the primary tracked object\'s element set as a .txt file.',
    run:()=>{if(!SEL.length) fail('Nothing is tracked.');downloadTLE();return{downloaded:SEL[0].tle.name};}});

  /* ── observer tab: display ── */
  C('observer.horizon',{group:'observer',summary:'Forecast horizon for tracked objects (how far ahead orbits and passes are drawn).',
    say:['show the next 6 hours','forecast 24 hours'],
    args:{hours:{type:'enum',required:true,values:[6,12,18,24],nearest:true}},
    run:a=>{setHorizon(a.hours);return{horizon_h:a.hours};}});
  C('observer.plot',{group:'observer',summary:'Right-hand plot: sky plot (alt/az dome) or ground track (map).',
    say:['show the sky plot','switch to the map','show ground track'],
    args:{plot:{type:'enum',required:true,values:['sky','groundtrack'],
      aliases:{sky:['skyplot','sky plot','dome','polar','alt az','altaz'],groundtrack:['ground track','map','gt','track','world map']}}},
    run:a=>{setView('observer');setRView(a.plot==='sky'?'sky':'gt');return{plot:a.plot};}});
  C('observer.frame',{group:'observer',summary:'3-D orbit view frame: inertial (ECI) or Earth-fixed (ECEF).',
    say:['show inertial frame','switch to earth fixed'],
    args:{frame:{type:'enum',required:true,values:['inertial','earthfixed'],
      aliases:{inertial:['eci','teme','j2000','space fixed'],earthfixed:['ecef','earth fixed','rotating','itrf','wgs84']}}},
    run:a=>{setView('observer');setFrame(a.frame==='inertial'?'eci':'ecef');return{frame:a.frame};}});
  C('skyplot.options',{group:'observer',summary:'Sky plot options: draw every pass in the horizon (not just the next) and/or only naked-eye-visible segments.',
    say:['show all passes on the sky plot','only visible passes'],
    args:{all_passes:{type:'boolean'},visible_only:{type:'boolean'}},
    run:a=>{
      if(a.all_passes!==undefined&&a.all_passes!==SKY_ALL) toggleSkyAll();
      if(a.visible_only!==undefined&&a.visible_only!==SKY_VIS_ONLY) toggleSkyVis();
      return{all_passes:SKY_ALL,visible_only:SKY_VIS_ONLY};
    }});
  C('observer.conditions',{group:'observer',summary:'Observing weather at the site for the coming hours (cloud cover, wind, rain chance, temperature); can open or refresh the panel.',
    say:['is it cloudy tonight','what is the weather for observing','show observing conditions'],
    args:{open:{type:'boolean',desc:'Open (true) or close (false) the conditions panel.'},refresh:{type:'boolean',default:false},
          hours:{type:'number',default:12,min:1,max:48}},
    run:async a=>{
      if(a.open!==undefined&&a.open!==wxOpen) toggleWx();
      if(a.refresh||!wxData) await fetchConditions();
      if(!wxData) fail('Weather service unavailable.');
      const h=wxData.hourly,off=(SITE.tzOffsetMin||0)*60000,now=Date.now(),out=[];
      for(let i=0;i<h.time.length&&out.length<a.hours;i++){
        const utc=Date.parse(h.time[i]+':00Z')-off;
        if(utc<now-3600000) continue;
        out.push({time:{utc:isoUTC(utc),local:h.time[i].replace('T',' ')},cloud_cover_pct:h.cloud_cover?h.cloud_cover[i]:null,
          wind_kmh:h.wind_speed_10m?h.wind_speed_10m[i]:null,precip_chance_pct:h.precipitation_probability?h.precipitation_probability[i]:null,
          temperature_c:h.temperature_2m?h.temperature_2m[i]:null});
      }
      return{site:siteOut(),source:'Open-Meteo',fetched:when(wxData.fetchedAt),hours:out};
    }});
  C('observer.export_csv',{group:'observer',summary:'Download the primary object\'s pass table as CSV.',
    run:()=>{if(!SEL.length) fail('Nothing is tracked.');exportCSV();return{exported:SEL[0].tle.name};}});

  /* ── observer tab: site-wide lists over the whole catalog ── */
  function applyListFilters(a){
    const set=(id,v)=>{const e=document.getElementById(id);if(e) e.value=v;};
    let rescan=false;
    if(a.type!==undefined) set('pbf-type',{all:'ALL',payload:'PAYLOAD',rb:'RB',debris:'DEBRIS'}[a.type]);
    if(a.name!==undefined) set('pbf-name',a.name);
    if(a.hours!==undefined){const e=document.getElementById('pbf-hours');if(+e.value!==a.hours){e.value=String(a.hours);rescan=true;}}
    if(a.min_elevation!==undefined) set('pbf-minel',String(a.min_elevation));
    if(a.visible_only!==undefined) document.getElementById('pbf-vis').checked=a.visible_only;
    if(a.exclude_daytime!==undefined) document.getElementById('pbf-noday').checked=a.exclude_daytime;
    if(rescan&&PB.tab==='passes') PB.rescan();
    PB.refilter();
  }
  function listFilters(){
    const g=id=>document.getElementById(id);
    return{type:{ALL:'all',PAYLOAD:'payload',RB:'rb',DEBRIS:'debris'}[g('pbf-type').value],name:g('pbf-name').value,
      hours:+g('pbf-hours').value,min_elevation:+g('pbf-minel').value,visible_only:g('pbf-vis').checked,exclude_daytime:g('pbf-noday').checked};
  }
  const FILTER_ARGS={
    type:LIST_TYPES,
    name:{type:'string',desc:'Only names or NORAD numbers containing this text ("" clears).'},
    hours:{type:'enum',values:[1,2,4,6],nearest:true,desc:'Passes list: how many hours ahead.'},
    min_elevation:{type:'enum',values:[0,10,20,30,45,60],nearest:true,desc:'Passes list: only passes whose peak is above this many degrees.'},
    visible_only:{type:'boolean',desc:'Passes list: only naked-eye-visible passes (sunlit object, dark sky).'},
    exclude_daytime:{type:'boolean',desc:'Passes list: hide passes that peak in daylight.'}};
  const TAB={type:'enum',values:['tracked','passes','inview','geo'],
    aliases:{tracked:['selected','my objects','tracked objects'],passes:['upcoming','current and upcoming','next passes','rising','pass list'],
             inview:['in view','overhead','above','up now','visible now','in the sky','above me','in view now'],
             geo:['always in view','geostationary','geosynchronous','geo belt','stationary']}};
  C('lists.show',{group:'lists',summary:'Show one of the site lists under the observer tab, optionally setting filters. Passes, in-view and GEO lists cover the whole public catalog.',
    say:['show debris overhead','what is above me','show upcoming passes','show geostationary satellites I can see'],
    args:{tab:{...TAB,required:true},...FILTER_ARGS},
    run:a=>{
      setView('observer');
      const{tab,...f}=a;
      if(PB.tab!==tab) PB.setTab(tab);
      applyListFilters(f);
      return{tab:PB.tab,filters:listFilters(),catalog:SITECAT.state};
    }});
  C('lists.filter',{group:'lists',summary:'Change filters on the site lists without switching list.',
    say:['only debris','only visible ones','payloads only','clear the filter','next 6 hours'],
    args:{...FILTER_ARGS},
    run:a=>{applyListFilters(a);return{tab:PB.tab,filters:listFilters()};}});
  function rowPass(p,now){
    const t=p.tle,cur=p.aos===null||p.aos<=now;
    return{norad:t.satnum,name:t.name,type:typeOf(t),in_progress:cur,
      rise:p.aos===null?null:when(p.aos),rise_direction:p.aos===null?null:compass(p.az0),
      peak:when(p.tpk),max_elevation_deg:num(p.elpk,1),peak_direction:compass(p.azpk),
      set:p.los===null?null:when(p.los),set_direction:p.los===null?null:compass(p.az1),
      visibility:p.vis?'naked-eye':p.day?'daylight':p.sunlit?'low':'eclipsed',
      now:cur?lookNow(t,now):null};
  }
  function rowNow(t,o,geo){
    const r={norad:t.satnum,name:t.name,type:typeOf(t),azimuth_deg:num(o.az,1),direction:compass(o.az),elevation_deg:num(o.el,1),
      range_km:Math.round(o.rng),ra_j2000:OBS.fmtRA(o.ra),ra_j2000_hours:num(o.ra,5),dec_j2000:OBS.fmtDec(o.dec),dec_j2000_deg:num(o.dec,4),
      sunlit:!!o.sunlit};
    if(geo) r.subpoint_lon_deg=num(o.lon,2);
    return r;
  }
  C('lists.get',{group:'lists',summary:'Read a site list as data (shows it on screen too). Waits for the catalog and the pass scan to finish.',
    say:['how many objects are overhead','which debris is above me','what passes are coming up','list the visible passes'],
    args:{tab:{...TAB,desc:'Defaults to the list on screen.'},limit:{type:'number',default:20,min:1,max:500},
          timeout_s:{type:'number',default:90,min:5,max:300},...FILTER_ARGS},
    run:async a=>{
      const{tab,limit,timeout_s,...f}=a;
      setView('observer');
      if(tab&&PB.tab!==tab) PB.setTab(tab);
      if(Object.keys(f).length) applyListFilters(f);
      const T=PB.tab,lim=timeout_s*1000;
      if(T==='tracked') return api.run('objects.tracked').then(r=>r.ok?r.result:fail(r.error));
      SITECAT.ensure();
      await until(()=>SITECAT.state!=='loading'&&SITECAT.state!=='idle',lim);
      if(T==='passes'){
        PB.tick(true);
        await until(()=>PB.res&&PB.res.pct===undefined&&!PB.busy&&PB.res.key===PB.key()+'|'+(+document.getElementById('pbf-hours').value),lim,250);
        PB.render();
      } else PB.renderNow();
      const V=PB._view;
      if(!V||V.kind!==T) fail('The list did not finish in time. Try again.');
      const now=EPOCH.ms();
      const rows=T==='passes'?V.list.slice(0,limit).map(p=>rowPass(p,now)):V.list.slice(0,limit).map(x=>rowNow(x.t,x.o,T==='geo'));
      return{tab:T,site:siteOut(),filters:listFilters(),total:V.list.length,shown:rows.length,
        source:PB.catLabel(),stale_left_out:PB._stale||0,computed:when(V.at),
        sorted_by:T==='passes'?'in progress first, then rise time':T==='geo'?'azimuth':'elevation (highest first)',rows};
    }});
  C('lists.recalculate',{group:'lists',summary:'Recompute the passes list from the current clock.',run:()=>{PB.rescan();return{tab:PB.tab};}});

  /* ── 3-D catalog ── */
  const CF={all:'ALL',payload:'ACTIVE',debris:'DEBRIS',rb:'RB'};
  async function catalogReady(ms=90000){
    setView('catalog');
    if(!WEBGL_OK||!CAT.inited) fail('The 3-D catalog needs WebGL, which this browser does not provide.');
    await until(()=>CAT.sats.length&&document.getElementById('cat-progress').style.display==='none',ms,250);
    if(!CAT.sats.length) fail('The catalog has not loaded yet.');
  }
  function catCounts(){
    const by={};let shown=0;
    CAT.sats.forEach(s=>{by[s.cls]=(by[s.cls]||0)+1;if(s.vis!==false) shown++;});
    return{total:CAT.sats.length,shown,filter:Object.keys(CF).find(k=>CF[k]===CAT.filter)||'all',
      payload:(by.LEO||0)+(by.MEO||0)+(by.GEO||0)+(by.HEO||0),payload_leo:by.LEO||0,payload_meo:by.MEO||0,payload_geo:by.GEO||0,payload_heo:by.HEO||0,
      debris:by.DEB||0,rocket_bodies:by.RB||0,stale:by.STALE||0};
  }
  C('catalog.filter',{group:'catalog',summary:'Show all objects, payloads, debris or rocket bodies in the 3-D catalog.',
    say:['show only debris in the catalog','show rocket bodies','show everything'],
    args:{type:{...LIST_TYPES,required:true}},
    run:a=>{
      setView('catalog');
      const f=CF[a.type];
      const btn=[...document.querySelectorAll('#cat-filter-bar .cfb-btn')].find(b=>(b.getAttribute('onclick')||'').includes("'"+f+"'"));
      CAT.setFilter(f,btn);
      return catCounts();
    }});
  C('catalog.buckets',{group:'catalog',summary:'Choose which data sets the 3-D catalog loads (full catalog, Starlink, GPS, debris clouds …) and reload.',
    say:['add starlink to the catalog','load only the GEO belt'],
    args:{only:{type:'list',desc:'Exactly these bucket ids.'},add:{type:'list'},remove:{type:'list'},load:{type:'boolean',default:true}},
    run:async a=>{
      const ids=CAT.GROUPS.map(g=>g.id),chk=l=>(l||[]).forEach(x=>{if(!ids.includes(x)) fail('Unknown bucket "'+x+'".',{buckets:CAT.GROUPS.map(g=>({id:g.id,label:g.n}))});});
      chk(a.only);chk(a.add);chk(a.remove);
      if(a.only) CAT.GROUPS.forEach(g=>g.on=a.only.includes(g.id));
      (a.add||[]).forEach(x=>CAT.GROUPS.find(g=>g.id===x).on=true);
      (a.remove||[]).forEach(x=>CAT.GROUPS.find(g=>g.id===x).on=false);
      if(CAT.inited) CAT.renderGroupMenu();
      STATE.dirty();
      if(a.load){setView('catalog');if(CAT.inited){CAT.loadChecked();await sleep(300);await until(()=>document.getElementById('cat-progress').style.display==='none',120000,300);}}
      return{buckets:CAT.GROUPS.map(g=>({id:g.id,label:g.n,on:g.on})),counts:CAT.sats.length?catCounts():null};
    }});
  C('catalog.counts',{group:'catalog',summary:'How many objects the 3-D catalog holds, by class.',
    say:['how many objects are in orbit','how much debris is there'],
    run:async()=>{await catalogReady();return catCounts();}});
  C('catalog.select',{group:'catalog',summary:'Highlight one object in the 3-D catalog, draw its orbit and open its card.',
    say:['show me where the ISS is in the catalog','highlight Hubble'],
    args:{object:{...OBJ,required:true}},
    run:async a=>{
      await catalogReady();
      const s=String(a.object).trim(),n=norm(s);
      let i=/^\d+$/.test(s)?CAT.sats.findIndex(x=>x.tle.satnum===+s):CAT.sats.findIndex(x=>norm(x.tle.name)===n);
      if(i<0&&!/^\d+$/.test(s)) i=CAT.sats.findIndex(x=>norm(x.tle.name).startsWith(n));
      if(i<0) fail('"'+s+'" is not in the loaded catalog buckets.');
      CAT.select(i);
      const S=CAT.sats[i];
      return{...brief(S.tle),now:lookNow(S.tle),elements:elements(S.tle)};
    }});
  C('catalog.deselect',{group:'catalog',summary:'Clear the highlighted object in the 3-D catalog.',run:()=>{CAT.deselect();return{selected:null};}});
  C('catalog.track_selected',{group:'catalog',summary:'Send the highlighted catalog object to the observer tab for tracking.',
    run:async()=>{if(CAT.selected<0) fail('Nothing is selected in the catalog.');const t=CAT.sats[CAT.selected].tle;CAT.trackSelected();
      const S=SEL.find(s=>s.tle.satnum===t.satnum);return S?trackedRow(S,SEL.indexOf(S)):{tracked:t.name};}});

  /* ── camera in any 3-D view ── */
  function sceneFor(v){
    v=v||curView();
    if(v==='observer') return document.body.dataset.frame==='ecef'?ecefThree:eciThree;
    if(v==='catalog') return CAT.three;
    if(v==='ephemeris') return SS.three;
    if(v==='conjunctions') return CA.three;
    return null;
  }
  const CAMV={type:'enum',values:['current','observer','catalog','ephemeris','conjunctions'],default:'current',desc:'Which 3-D view (defaults to the one on screen).'};
  function camOut(T){const c=T.ctrl;return{distance_km:Math.round(c.tRad),azimuth_deg:num(((c.tTheta*R2D)%360+360)%360,1),tilt_deg:num(c.tPhi*R2D,1)};}
  function camera(a){
    const v=a.view==='current'?curView():a.view;
    if(v!==curView()) setView(v);
    const T=sceneFor(v);
    if(!T||!T.ctrl) fail('That 3-D view is not available (it needs WebGL).');
    return T;
  }
  C('camera.zoom',{group:'camera',summary:'Zoom the 3-D view in or out.',say:['zoom out','zoom in','closer','further away'],
    args:{direction:{type:'enum',required:true,values:['in','out'],aliases:{in:['closer','nearer'],out:['further','farther','away','back']}},
          factor:{type:'number',default:1.8,min:1.05,max:50},view:CAMV},
    run:a=>{const T=camera(a),c=T.ctrl,k=a.direction==='in'?1/a.factor:a.factor;c.tRad=Math.max(c.minR,Math.min(c.maxR,c.tRad*k));return camOut(T);}});
  C('camera.rotate',{group:'camera',summary:'Turn the 3-D view.',say:['rotate left','look from above','tilt down'],
    args:{direction:{type:'enum',required:true,values:['left','right','up','down']},degrees:{type:'number',default:30,min:1,max:180},view:CAMV},
    run:a=>{const T=camera(a),c=T.ctrl,r=a.degrees*D2R;
      if(a.direction==='left') c.tTheta-=r;else if(a.direction==='right') c.tTheta+=r;
      else{c.tPhi+=a.direction==='down'?r:-r;c.tPhi=Math.max(.04,Math.min(Math.PI-.04,c.tPhi));}
      return camOut(T);}});
  C('camera.reset',{group:'camera',summary:'Put the 3-D view back to its starting angle and distance.',say:['reset the view','recenter'],
    args:{view:CAMV},
    run:a=>{const T=camera(a);if(curView()==='ephemeris') SS.resetView();else if(T.ctrl.reset) T.ctrl.reset();return camOut(T);}});

  /* ── ephemeris (JPL Horizons) ── */
  const sq=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  function builtin(q){
    const n=sq(q);
    for(const g of EPH.TARGETS) for(const it of g.items){
      const m=sq(it.name);
      if(it.cmd===q||m===n||m.replace(/^\d+/,'')===n) return{...it};
    }
    return null;
  }
  async function resolveTarget(q){
    if(!q) fail('Name a target (planet, moon, asteroid, comet or spacecraft).');
    const b=builtin(q);if(b) return b;
    const p=EPH.plotted.find(x=>sq(x.name)===sq(q)||x.cmd===q);if(p) return{cmd:p.cmd,name:p.name,g:p.g};
    const r=await EPHSVC.sbdbLookup(q);
    if(r.ok) return{cmd:r.cmd,name:String(r.name).replace(/ \(spacecraft\)$/,''),g:r.kind==='sc'?'◇':'◆',kind:r.kind};
    if(r.multi) fail('"'+q+'" matches several Horizons objects. Say which one.',{matches:r.multi.map(m=>({name:m.name,horizons_id:m.cmd,type:m.type||null}))});
    if(r.none) fail('JPL Horizons has no object matching "'+q+'". Named minor planets are one word, e.g. Kathleenhowell.');
    fail(JPL_PROXY?'Could not reach JPL through the relay.':JPL_BLOCKED_MSG);
  }
  function ephSummary(cmd){
    const p=EPH.plotted.find(x=>x.cmd===cmd);
    if(!p) fail('That target is not plotted.');
    const base={target:p.name,horizons_name:p.bodyName||p.name,horizons_id:p.cmd,site:siteOut()};
    if(p.coverage) return{...base,status:'no ephemeris',
      message:p.coverage.side==='end'?'JPL Horizons has no ephemeris after '+isoUTC(p.coverage.date.getTime())+'. The mission has ended, the object is lost or decayed, or JPL has not published newer data.'
                                     :'JPL Horizons ephemeris starts '+isoUTC(p.coverage.date.getTime())+'.',
      coverage_edge:isoUTC(p.coverage.date.getTime())};
    const W=EPH.windowsOf(p);
    if(!W) return{...base,status:'no data',message:document.getElementById('eph-target-sub').textContent};
    const r=W.rNow,au=r.delta;
    return{...base,status:'ok',min_elevation_deg:W.minEl,darkness_rule:W.exempt?'not applied (Sun or Moon)':'astronomical darkness required',
      visible_now:W.visNow,
      brightness:r.mag==null?null:r.mag<=6?'naked eye (V '+r.mag.toFixed(1)+')':r.mag<=9?'binoculars (V '+r.mag.toFixed(1)+')':'telescope needed (V '+r.mag.toFixed(1)+')',
      verdict:W.visNow?'visible now':W.upNow?'above the limit but the sky is too bright':'below the elevation limit',
      sky:EPH.twiLabel(r.sunFlag).toLowerCase(),
      now:{time:when(r.d.getTime()),azimuth_deg:num(r.az,1),direction:r.az!==null?compass(r.az):null,elevation_deg:num(r.el,1),
        ra_icrf_deg:num(r.ra,4),dec_icrf_deg:num(r.dec,4),magnitude_v:num(r.mag,2),
        range_au:num(au,6),range_km:au!==null?Math.round(au*AU_KM):null,range_rate_km_s:num(r.deldot,2),
        solar_elongation_deg:num(r.elong,1),phase_angle_deg:num(r.phase,1)},
      windows_span_h:72,
      windows:W.wins.map(w=>{const a=W.rows[w.i0],b=W.rows[w.i1],k=W.rows[w.iPk];
        return{start:when(a.d.getTime()),end:when(b.d.getTime()),duration_min:Math.round((b.d-a.d)/60000+30),
          peak:when(k.d.getTime()),peak_elevation_deg:num(k.el,1),peak_azimuth_deg:num(k.az,0),peak_direction:compass(k.az),magnitude_v:num(k.mag,1)};}),
      fetched:p.fetchedAt?when(p.fetchedAt.getTime()):null,
      note:'Horizons times are real time, not the dashboard clock. Windows are 30-minute samples.'};
  }
  async function plotTarget(q){
    const it=await resolveTarget(q);
    setView('ephemeris');
    await until(()=>EPH._listDone,5000,100);
    if(EPH.plotted.find(p=>p.cmd===it.cmd&&(p.rows||p.coverage))) EPH.setActive(it.cmd);
    else await EPH.select(it);
    return ephSummary(it.cmd);
  }
  C('eph.resolve',{group:'ephemeris',summary:'Find a deep-space object in JPL Horizons by name or number without plotting it.',
    say:['look up Maruthiakella','what is the Horizons id of CAPSTONE'],
    args:{query:{type:'string',required:true}},
    run:async a=>{const it=await resolveTarget(a.query);return{name:it.name,horizons_id:it.cmd,kind:it.kind||(EPH.isSpacecraft(it.cmd)?'sc':EPH.isSmallBody(it.cmd)?'small':'major')};}});
  C('eph.plot',{group:'ephemeris',summary:'Plot a planet, moon, asteroid, comet or spacecraft from JPL Horizons and return its visibility from the site.',
    say:['plot Mars','show CAPSTONE','add Kathleenhowell','plot Artemis II'],
    args:{target:{type:'string',required:true,desc:'Name or Horizons id, e.g. "Mars", "Maruthiakella", "CAPSTONE", "433", "Halley".'}},
    run:a=>plotTarget(a.target)});
  C('eph.visibility',{group:'ephemeris',summary:'Is a deep-space object visible from the site now, and when in the next 72 hours (elevation limit, astronomical darkness).',
    say:['is Maruthiakella visible from my site','can I see Jupiter tonight','when is Mars up','is CAPSTONE still tracked'],
    args:{target:{type:'string',desc:'Defaults to the active ephemeris target.'}},
    run:async a=>{
      if(a.target) return plotTarget(a.target);
      if(!EPH.active) fail('No ephemeris target is plotted. Give a target.');
      return ephSummary(EPH.active);
    }});
  C('eph.focus',{group:'ephemeris',summary:'Make one of the plotted targets the active one.',args:{target:{type:'string',required:true}},
    run:async a=>{const p=EPH.plotted.find(x=>sq(x.name).includes(sq(a.target))||x.cmd===a.target);
      if(!p) fail('"'+a.target+'" is not plotted.',{plotted:EPH.plotted.map(x=>x.name)});
      setView('ephemeris');EPH.setActive(p.cmd);return ephSummary(p.cmd);}});
  C('eph.remove',{group:'ephemeris',summary:'Remove a plotted target, or all of them.',args:{target:{type:'string',required:true,desc:'Name or "all".'}},
    run:a=>{
      if(a.target.toLowerCase()==='all'){[...EPH.plotted].forEach(p=>EPH.removePlot(p.cmd));return{plotted:[]};}
      const p=EPH.plotted.find(x=>sq(x.name).includes(sq(a.target))||x.cmd===a.target);
      if(!p) fail('"'+a.target+'" is not plotted.',{plotted:EPH.plotted.map(x=>x.name)});
      EPH.removePlot(p.cmd);return{removed:p.name,plotted:EPH.plotted.map(x=>x.name)};
    }});
  C('eph.list',{group:'ephemeris',summary:'Plotted targets and the built-in target list.',
    run:()=>({active:EPH.active,plotted:EPH.plotted.map(p=>({name:p.name,horizons_id:p.cmd,status:p.coverage?'no ephemeris':p.rows?'ok':'pending'})),
      built_in:EPH.TARGETS.map(g=>({category:g.cat,targets:g.items.map(i=>i.name)}))})});
  C('eph.min_elevation',{group:'ephemeris',summary:'Elevation limit (degrees) used for ephemeris visibility windows.',
    args:{degrees:{type:'number',required:true,min:0,max:30}},
    run:a=>{const e=document.getElementById('eph-minel');e.value=String(Math.round(a.degrees));e.dispatchEvent(new Event('input'));
      return{min_elevation_deg:EPH.minEl(),active:EPH.active?ephSummary(EPH.active):null};}});
  C('eph.refetch',{group:'ephemeris',summary:'Fetch the active target again from JPL Horizons.',
    run:async()=>{if(!EPH.active) fail('No target is active.');const c=EPH.active;EPH.refetch();await sleep(300);
      await until(()=>{const p=EPH.plotted.find(x=>x.cmd===c);return p&&(p.rows||p.coverage);},30000,250);return ephSummary(c);}});
  C('solar.scale',{group:'ephemeris',summary:'Solar-system map scale: compact (readable) or true linear distances.',
    args:{mode:{type:'enum',required:true,values:['compact','true'],aliases:{compact:['compressed','log','readable'],true:['true scale','linear','real','actual']}}},
    run:a=>{setView('ephemeris');const btn=document.querySelectorAll('#ss-toolbar .ss-scale-btn')[a.mode==='true'?1:0];
      if(!SS.inited) fail('The solar-system map needs WebGL.');SS.setScaleMode(a.mode==='true',btn);return{scale:a.mode};}});
  C('solar.rate',{group:'ephemeris',summary:'Animate the solar-system map at this many days per second.',say:['speed up the planets','run the solar system'],
    args:{days_per_second:{type:'number',required:true,min:-3650,max:3650}},
    run:a=>{const btn=[...document.querySelectorAll('#ss-toolbar .ss-rate-btn')].find(b=>(b.getAttribute('onclick')||'').includes('('+a.days_per_second+','));
      SS.setRate(a.days_per_second,btn||null);return api.state().time;}});
  C('solar.step',{group:'ephemeris',summary:'Step the clock by a number of days (for the solar-system map; affects every view).',
    args:{days:{type:'number',required:true}},run:a=>{SS.step(a.days);return api.state().time;}});

  /* ── conjunctions (CelesTrak SOCRATES) ── */
  function conjRow(r,i){
    return{rank:i+1,object_1:{norad:+r.id1,name:r.n1},object_2:{norad:+r.id2,name:r.n2},closest_approach:when(r.tca.getTime()),
      miss_distance_km:num(r.rangeKm,3),relative_speed_km_s:num(r.relV,2),probability:r.prob};
  }
  async function conjReady(){
    setView('conjunctions');
    await until(()=>CA._src&&CA._src!=='—',40000,250);
    if(!CA.rows.length) fail(CA._src||'No conjunction data.');
  }
  const SORT={type:'enum',values:['range','tca','probability'],aliases:{range:['distance','miss distance','closest'],tca:['time','soonest','next'],probability:['prob','pc','risk','likelihood']}};
  C('conj.list',{group:'conjunctions',summary:'Predicted close approaches between catalogued objects (CelesTrak SOCRATES).',
    say:['any close approaches','what conjunctions are coming','riskiest conjunctions'],
    args:{sort:{...SORT,desc:'Order (defaults to the one on screen).'},limit:{type:'number',default:10,min:1,max:50}},
    run:async a=>{
      await conjReady();
      if(a.sort){const s=a.sort==='probability'?'prob':a.sort;const b=[...document.querySelectorAll('.ca-sort')].find(x=>(x.getAttribute('onclick')||'').includes("'"+s+"'"));CA.setSort(s,b);}
      return{source:CA._src,sort:CA.sort==='prob'?'probability':CA.sort,total:CA._view.length,rows:CA._view.slice(0,a.limit).map(conjRow)};
    }});
  C('conj.select',{group:'conjunctions',summary:'Open one conjunction (by rank in the current order, or by an object in it) and draw the encounter.',
    args:{rank:{type:'number',min:1},object:{type:'string',desc:'Name or NORAD number of either object.'}},
    run:async a=>{
      await conjReady();
      let i=a.rank?a.rank-1:-1;
      if(a.object){const n=norm(a.object);i=CA._view.findIndex(r=>r.id1===a.object||r.id2===a.object||norm(r.n1).includes(n)||norm(r.n2).includes(n));}
      if(i<0||i>=CA._view.length) fail('No such conjunction in the list.');
      await CA.select(i);
      return{...conjRow(CA._view[i],i),detail:document.getElementById('ca-detail-state').textContent};
    }});
  C('conj.refresh',{group:'conjunctions',summary:'Fetch the SOCRATES report again.',
    run:async()=>{setView('conjunctions');CA._src='—';await CA.refresh();return{source:CA._src,total:CA.rows.length};}});

  /* ── space weather ── */
  C('spaceweather.get',{group:'space weather',summary:'Planetary K index and 10.7 cm solar flux from NOAA SWPC (drag and aurora conditions).',
    say:['how is space weather','is there a geomagnetic storm','what is Kp'],
    run:async()=>{if(SWX.kp===undefined&&SWX.f107===undefined){SWX.refresh();await until(()=>SWX.kp!==undefined,8000);}
      return{kp:SWX.kp??null,kp_time:SWX.kpAt||null,kp_meaning:SWX.kp==null?null:SWX.kp<4?'quiet':SWX.kp<5?'unsettled':'geomagnetic storm',
        f107_sfu:SWX.f107??null,source:'NOAA SWPC'};}});

  /* ── links and screen messages ── */
  C('share.link',{group:'other',summary:'A web address that opens the dashboard in its current state (view, site, tracked objects, list, filters, target).',
    say:['give me a link to this view','share this'],run:()=>({url:api.link()})});
  C('ui.caption',{group:'other',summary:'Show a short caption at the bottom of the dashboard (for example what Claire is saying). Empty text hides it.',
    args:{text:{type:'string',default:''},seconds:{type:'number',default:6,min:0,max:120,desc:'0 keeps it until replaced.'}},
    run:a=>{
      let el=document.getElementById('ssa-caption');
      if(!el){el=document.createElement('div');el.id='ssa-caption';document.body.appendChild(el);}
      clearTimeout(el._t);el.textContent=a.text;el.classList.toggle('on',!!a.text);
      if(a.text&&a.seconds) el._t=setTimeout(()=>el.classList.remove('on'),a.seconds*1000);
      return{shown:!!a.text};
    }});

  /* ───────── public object ───────── */
  const listeners=[];
  const api={
    version:VERSION,_ready:false,
    commands:CMDS,
    find(name){const n=String(name||'').toLowerCase().replace(/_/g,'.');return CMDS.find(c=>c.name===n)||CMDS.find(c=>c.name.replace(/\./g,'_')===String(name));},
    /* run one command; never throws. → {ok, command, result} or {ok:false, command, error, details} */
    async run(name,args){
      const def=api.find(name);
      if(!def) return{ok:false,command:name,error:'Unknown command "'+name+'". Call help for the list.'};
      try{
        const a=coerce(def,args);
        const result=await def.run(a);
        emit({type:'command',command:def.name,ok:true});
        return{ok:true,command:def.name,result};
      }catch(e){
        emit({type:'command',command:def.name,ok:false,error:e.message});
        return{ok:false,command:def.name,error:e instanceof Fail?e.message:'Dashboard error: '+e.message,details:e.extra||null};
      }
    },
    /* several commands in order; stops at the first failure unless keepGoing */
    async batch(list,keepGoing){
      const out=[];
      for(const s of list){const r=await api.run(s.command||s[0],s.args||s[1]);out.push(r);if(!r.ok&&!keepGoing) break;}
      return out;
    },
    describe(){
      return{app:'CARE Lab SSA Dashboard',version:VERSION,
        usage:'await SSA.run(name, options) → {ok, result} or {ok:false, error, details}. Times are given in UTC, site local time, and minutes from the dashboard clock.',
        commands:CMDS.map(c=>({name:c.name,group:c.group,summary:c.summary,say:c.say||[],args:Object.fromEntries(Object.entries(c.args||{}).map(([k,s])=>[k,
          {type:s.type,required:!!s.required,default:s.default,values:s.values,aliases:s.aliases,min:s.min,max:s.max,desc:s.desc}]))}))};
    },
    /* the command list as language-model tool definitions (name, description, input_schema) */
    tools(){
      return CMDS.map(c=>{
        const props={},req=[];
        for(const[k,s] of Object.entries(c.args||{})){
          let p;
          if(s.type==='number') p={type:'number'};
          else if(s.type==='boolean') p={type:'boolean'};
          else if(s.type==='enum') p=typeof s.values[0]==='number'?{type:'number',enum:s.values}:{type:'string',enum:s.values};
          else if(s.type==='list') p={type:'array',items:{type:'string'}};
          else if(s.type==='object_ref') p={type:['string','integer']};
          else p={type:'string'};
          const d=[s.desc,s.aliases?'Also accepts: '+Object.entries(s.aliases).map(([k2,v])=>k2+' ('+v.slice(0,4).join(', ')+')').join('; ')+'.':'',
                   s.min!==undefined||s.max!==undefined?'Range '+(s.min??'')+' to '+(s.max??'')+'.':'',s.default!==undefined&&s.default!==''?'Default '+JSON.stringify(s.default)+'.':''].filter(Boolean).join(' ');
          if(d) p.description=d;
          props[k]=p;if(s.required) req.push(k);
        }
        return{name:c.name.replace(/\./g,'_'),description:c.summary+(c.say&&c.say.length?' Example requests: '+c.say.map(x=>'"'+x+'"').join(', ')+'.':''),
          input_schema:{type:'object',properties:props,required:req}};
      });
    },
    state(){
      const g=id=>document.getElementById(id);
      const sel=g('cat-select');
      return{
        app:'CARE Lab SSA Dashboard',version:VERSION,ready:api._ready,view:curView(),
        time:{utc:isoUTC(EPOCH.ms()),local:localStr(EPOCH.ms()),rate:EPOCH.rate,paused:EPOCH.rate===0,live:EPOCH.isLive(),
              offset_from_real_min:num(EPOCH.offsetMs()/60000,1)},
        site:siteOut(),
        observer:{group:sel&&sel.selectedOptions[0]?{group:sel.value,label:sel.selectedOptions[0].textContent.trim(),objects:allSats.length}:null,
          tracked:SEL.map((s,i)=>({norad:s.tle.satnum,name:s.tle.name,primary:i===0})),
          horizon_h:HORIZON_S/3600,plot:document.body.dataset.rview==='gt'?'groundtrack':'sky',
          frame:document.body.dataset.frame==='ecef'?'earthfixed':'inertial',
          skyplot:{all_passes:SKY_ALL,visible_only:SKY_VIS_ONLY},conditions_open:wxOpen,
          list:{tab:PB.tab,filters:listFilters()}},
        full_catalog:{state:SITECAT.state,objects:SITECAT.list.length,source:SITECAT.src||null,used:PB._cat?PB._cat.length:null,stale_left_out:PB._stale||0},
        catalog:{webgl:WEBGL_OK,loaded:CAT.sats.length,filter:Object.keys(CF).find(k=>CF[k]===CAT.filter)||'all',
          buckets:CAT.GROUPS.filter(x=>x.on).map(x=>x.id),selected:CAT.selected>=0?{norad:CAT.sats[CAT.selected].tle.satnum,name:CAT.sats[CAT.selected].tle.name}:null},
        ephemeris:{active:EPH.active?(EPH.plotted.find(p=>p.cmd===EPH.active)||{}).name||EPH.active:null,
          plotted:EPH.plotted.map(p=>p.name),min_elevation_deg:EPH.minEl(),solar_scale:SS.trueScale?'true':'compact'},
        conjunctions:{source:CA._src,rows:CA.rows.length,sort:CA.sort==='prob'?'probability':CA.sort},
        space_weather:{kp:SWX.kp??null,f107_sfu:SWX.f107??null}};
    },
    link(){
      const s=api.state(),p=new URLSearchParams();
      p.set('view',s.view);
      p.set('site',[s.site.lat_deg,s.site.lon_deg,s.site.alt_m].join(','));
      if(SEL.length) p.set('track',SEL.map(x=>x.tle.satnum).join(','));
      if(s.observer.group) p.set('group',s.observer.group.group);
      p.set('list',s.observer.list.tab);
      const f=s.observer.list.filters;
      if(f.type!=='all') p.set('type',f.type);
      if(f.name) p.set('name',f.name);
      if(s.observer.list.tab==='passes'){p.set('hours',f.hours);p.set('minel',f.min_elevation);if(f.visible_only)p.set('visible','1');if(f.exclude_daytime)p.set('daytime','0');}
      p.set('plot',s.observer.plot);p.set('frame',s.observer.frame);p.set('horizon',s.observer.horizon_h);
      if(s.catalog.filter!=='all') p.set('catfilter',s.catalog.filter);
      if(EPH.active) p.set('target',(EPH.plotted.find(x=>x.cmd===EPH.active)||{}).name||EPH.active);
      if(!s.time.live) p.set('time',s.time.utc);
      if(s.time.rate!==1) p.set('rate',s.time.rate);
      return location.origin+location.pathname+'?'+p.toString();
    },
    on(fn){if(typeof fn==='function') listeners.push(fn);return()=>{const i=listeners.indexOf(fn);if(i>=0) listeners.splice(i,1);};},
    _booted(err){
      if(api._ready) return;
      api._ready=true;
      emit({type:'ready',error:err?err.message:null});
      applyLink().catch(e=>console.warn('[SSA link]',e));
    }
  };

  /* ───────── events ───────── */
  let ws=null;
  const bridgeOn=()=>new URLSearchParams(location.search).has('claire');
  function emit(ev){
    ev.at=new Date().toISOString();
    listeners.forEach(fn=>{try{fn(ev);}catch(e){}});
    try{window.dispatchEvent(new CustomEvent('ssa',{detail:ev}));}catch(e){}
    if(bridgeOn()){
      if(window.parent!==window) window.parent.postMessage({ssa:'event',event:ev},'*');
      if(window.opener) try{window.opener.postMessage({ssa:'event',event:ev},'*');}catch(e){}
    }
    if(ws&&ws.readyState===1) try{ws.send(JSON.stringify({type:'event',event:ev}));}catch(e){}
  }
  /* watch for slow jobs finishing so a caller can wait on events instead of polling */
  const seen={};
  setInterval(()=>{
    const now={view:curView(),fullCatalog:SITECAT.state,catalogObjects:CAT.sats.length,
      passScan:PB.res?(PB.res.pct===undefined&&!PB.busy?'done':'running'):'none',
      plotted:EPH.plotted.map(p=>p.name+':'+(p.rows?'ok':p.coverage?'none':'…')).join('|'),
      tracked:SEL.map(s=>s.tle.satnum).join(','),site:SITE.lat_deg+','+SITE.lon_deg,conj:CA.rows.length};
    for(const k of Object.keys(now)) if(seen[k]!==undefined&&seen[k]!==now[k]) emit({type:'change',what:k,value:now[k]});
    Object.assign(seen,now);
  },700);

  /* ───────── ways in ───────── */
  /* 1. window.postMessage (iframe parent or opener), only with ?claire in the address */
  window.addEventListener('message',async e=>{
    const m=e.data;
    if(!m||m.ssa!=='run'||!bridgeOn()) return;
    if(e.source!==window.parent&&e.source!==window.opener) return;
    const r=await api.run(m.command,m.args);
    e.source.postMessage({ssa:'result',id:m.id,...r},e.origin==='null'?'*':e.origin);
  });
  /* 2. WebSocket client to a program on this computer: ?claire=ws://localhost:8765 */
  function connectWS(url){
    try{ws=new WebSocket(url);}catch(e){console.warn('[SSA] bad WebSocket address',url);return;}
    ws.onopen=()=>ws.send(JSON.stringify({type:'hello',app:'CARE Lab SSA Dashboard',version:VERSION,ready:api._ready}));
    ws.onmessage=async ev=>{
      let m;try{m=JSON.parse(ev.data);}catch(e){return;}
      if(m.type==='describe'){ws.send(JSON.stringify({type:'describe',id:m.id,result:api.describe(),tools:api.tools()}));return;}
      if(m.type==='state'){ws.send(JSON.stringify({type:'state',id:m.id,result:api.state()}));return;}
      if(!m.command) return;
      const r=await api.run(m.command,m.args);
      ws.send(JSON.stringify({type:'result',id:m.id,...r}));
    };
    ws.onclose=()=>setTimeout(()=>connectWS(url),5000);
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const c=new URLSearchParams(location.search).get('claire');
    if(c&&/^wss?:\/\//.test(c)) connectWS(c);
  });

  /* 3. a link that sets the view: ?view=observer&list=inview&type=debris&site=40.79,-77.86 … */
  /* 4. a small typed console for trying commands: ?console=1, or SSA.console() */
  function openConsole(){
    if(document.getElementById('ssa-console')) return;
    const box=document.createElement('div');box.id='ssa-console';
    box.innerHTML='<div class="sc-head">SSA commands <span>help · state · lists.get {"tab":"inview","limit":5}</span><i title="Close">✕</i></div>'+
      '<input id="ssa-console-in" spellcheck="false" placeholder=\'command {"option":"value"}\'/><pre id="ssa-console-out"></pre>';
    document.body.appendChild(box);
    box.querySelector('i').onclick=()=>box.remove();
    const inp=box.querySelector('input'),out=box.querySelector('pre');
    inp.addEventListener('keydown',async e=>{
      if(e.key!=='Enter') return;
      const line=inp.value.trim();if(!line) return;
      const sp=line.search(/\s/),name=sp<0?line:line.slice(0,sp),rest=sp<0?'':line.slice(sp).trim();
      let args={};
      if(rest){try{args=JSON.parse(rest);}catch(err){out.textContent='Options must be JSON, e.g. {"tab":"passes"}';return;}}
      out.textContent='running '+name+' …';
      const r=await api.run(name,args);
      const txt=JSON.stringify(r,null,1);
      out.textContent=txt.length>20000?txt.slice(0,20000)+'\n… (cut)':txt;
    });
    inp.focus();
  }
  api.console=openConsole;
  async function applyLink(){
    const p=new URLSearchParams(location.search);
    if(p.has('console')) openConsole();
    const has=k=>p.has(k)&&p.get(k)!=='';
    const steps=[];
    if(has('site')){const[lat,lon,alt]=p.get('site').split(',').map(parseFloat);steps.push(['site.set',{lat,lon,alt_m:isFinite(alt)?alt:undefined}]);}
    if(has('group')) steps.push(['observer.group',{group:p.get('group')}]);
    if(has('track')) p.get('track').split(',').filter(Boolean).forEach((t,i)=>steps.push(['objects.track',{object:t,replace:i===0}]));
    if(has('horizon')) steps.push(['observer.horizon',{hours:p.get('horizon')}]);
    if(has('plot')) steps.push(['observer.plot',{plot:p.get('plot')}]);
    if(has('frame')) steps.push(['observer.frame',{frame:p.get('frame')}]);
    const f={};
    if(has('type')) f.type=p.get('type');
    if(has('name')) f.name=p.get('name');
    if(has('hours')) f.hours=p.get('hours');
    if(has('minel')) f.min_elevation=p.get('minel');
    if(has('visible')) f.visible_only=p.get('visible');
    if(has('daytime')) f.exclude_daytime=!asBool(p.get('daytime'),'daytime');
    if(has('list')) steps.push(['lists.show',{tab:p.get('list'),...f}]);
    else if(Object.keys(f).length) steps.push(['lists.filter',f]);
    if(has('catfilter')) steps.push(['catalog.filter',{type:p.get('catfilter')}]);
    if(has('target')) steps.push(['eph.plot',{target:p.get('target')}]);
    if(has('time')) steps.push(['time.set',{time:p.get('time')}]);
    if(has('rate')) steps.push(['time.rate',{rate:p.get('rate')}]);
    if(has('view')) steps.push(['view.show',{view:p.get('view')}]);
    for(const[c,a] of steps){
      Object.keys(a).forEach(k=>a[k]===undefined&&delete a[k]);
      const r=await api.run(c,a);
      if(!r.ok) console.warn('[SSA link] '+c+': '+r.error);
    }
  }
  return api;
})();
window.SSA=SSA;
