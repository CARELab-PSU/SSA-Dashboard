const CAT={
  three:null,sats:[],mesh:null,
  anchorIdx:0,selected:-1,hoverIdx:-1,
  _ray:null,_mouse:null,_mouseEv:null,_hoverLast:0,
  _orbitT:0,_cardLast:0,_loadToken:0,inited:false,
  _dummyM:null,

  /* full tracked-environment buckets: payloads, rocket bodies, debris fields */
  GROUPS:[
    {id:'__full',  n:'FULL PUBLIC CATALOG (EVERYTHING TRACKED)', on:true},
    {id:'visual',  n:'100 BRIGHTEST',        on:true},
    {id:'stations',n:'SPACE STATIONS',       on:true},
    {id:'active',  n:'ACTIVE PAYLOADS (ALL)',on:true},
    {id:'starlink',n:'STARLINK',             on:false},
    {id:'oneweb',  n:'ONEWEB',               on:false},
    {id:'gps-ops', n:'GPS OPS',              on:false},
    {id:'glo-ops', n:'GLONASS',              on:false},
    {id:'galileo', n:'GALILEO',              on:false},
    {id:'beidou',  n:'BEIDOU',               on:false},
    {id:'geo',     n:'GEO BELT',             on:false},
    {id:'weather', n:'WEATHER',              on:false},
    {id:'science', n:'SCIENCE',              on:false},
    {id:'cosmos-2251-debris', n:'COSMOS-2251 DEBRIS', on:true},
    {id:'iridium-33-debris',  n:'IRIDIUM-33 DEBRIS',  on:true},
    {id:'fengyun-1c-debris',  n:'FENGYUN-1C DEBRIS',  on:true},
    {id:'cosmos-1408-debris', n:'COSMOS-1408 DEBRIS', on:false},
    {id:'last-30-days',       n:'LAUNCHED <30 DAYS',  on:false}
  ],
  /* object classes: payloads colored by regime; debris + rocket bodies get
     their own classes so the full junk environment reads at a glance */
  CLS_COLOR:{LEO:[0.86,0.86,0.86],MEO:[0.50,0.66,0.85],GEO:[0.84,0.70,0.43],HEO:[0.77,0.56,0.71],MOLNIYA:[0.77,0.56,0.71],
             DEB:[0.45,0.45,0.45],RB:[0.79,0.63,0.54],STALE:[0.20,0.20,0.20]},
  classOf(t){
    if(t.objType==='DEBRIS') return 'DEB';
    if(t.objType==='RB') return 'RB';
    const n=t.name.toUpperCase();
    if(/\bDEB\b|DEBRIS/.test(n)) return 'DEB';
    if(/R\/B|\bAKM\b|\bPKM\b/.test(n)) return 'RB';
    return t.orbitType==='MOLNIYA'?'HEO':t.orbitType;
  },
  /* coarse object_type from a TLE name (for CelesTrak-sourced buckets that
     don't carry OrbitSmith's explicit object_type field) */
  objTypeOfName(t){
    const n=(t.name||'').toUpperCase();
    if(/\bDEB\b|DEBRIS/.test(n)) return 'DEBRIS';
    if(/R\/B|\bAKM\b|\bPKM\b|ROCKET/.test(n)) return 'RB';
    return 'PAYLOAD';
  },
  filter:'ALL',
  matchesFilter(objType){
    const f=this.filter;
    if(f==='ALL') return true;
    if(f==='ACTIVE') return objType==='PAYLOAD';
    if(f==='DEBRIS') return objType==='DEBRIS';
    if(f==='RB') return objType==='RB';
    return true;
  },
  setFilter(f,btn){
    this.filter=f;
    document.querySelectorAll('#cat-filter-bar .cfb-btn').forEach(b=>b.classList.remove('on'));
    if(btn) btn.classList.add('on');
    if(this.sats) for(const s of this.sats) s.vis=this.matchesFilter(s.objType);
    this.applyZoomScale(true);
    this.updateCounts();
    if(typeof STATE!=='undefined') STATE.dirty();
  },

  init(){
    if(this.inited) return;
    this.inited=true;
    this.three=initThree3D('cat-canvas-wrap',{axes:false,rad:RE_KM*6.2});
    this._ray=new THREE.Raycaster();
    this._mouse=new THREE.Vector2();
    const dom=this.three.renderer.domElement;
    dom.addEventListener('pointermove',e=>{
      const r=dom.getBoundingClientRect();
      this._mouse.x=((e.clientX-r.left)/r.width)*2-1;
      this._mouse.y=-((e.clientY-r.top)/r.height)*2+1;
      this._mouseEv=e;
    });
    let downXY=null;
    dom.addEventListener('pointerdown',e=>downXY=[e.clientX,e.clientY]);
    dom.addEventListener('pointerup',e=>{
      if(!downXY) return;
      const moved=Math.hypot(e.clientX-downXY[0],e.clientY-downXY[1]);
      downXY=null;
      if(moved<5) this.clickPick();
    });
    this.renderGroupMenu();
    document.getElementById('cat-groups-btn').addEventListener('click',e=>{
      e.stopPropagation();
      document.getElementById('cat-groups-menu').classList.toggle('open');
    });
    document.addEventListener('click',e=>{
      const m=document.getElementById('cat-groups-menu');
      if(m&&!m.contains(e.target)&&e.target.id!=='cat-groups-btn') m.classList.remove('open');
    });
  },

  renderGroupMenu(){
    const m=document.getElementById('cat-groups-menu');
    const allOn=this.GROUPS.every(g=>g.on);
    m.innerHTML='<label class="cg-item cg-all"><input type="checkbox" id="cg-selall" '+(allOn?'checked':'')+'/> ★ SELECT ALL</label>'+
      this.GROUPS.map((g,i)=>
      '<label class="cg-item"><input type="checkbox" data-i="'+i+'" '+(g.on?'checked':'')+'/> '+g.n+'</label>').join('')+
      '<button class="hud-btn amber" style="margin:6px;" onclick="CAT.loadChecked()">⟳ LOAD SELECTED</button>';
    m.querySelectorAll('input[data-i]').forEach(inp=>inp.addEventListener('change',e=>{
      this.GROUPS[+e.target.dataset.i].on=e.target.checked;
      if(typeof STATE!=='undefined') STATE.dirty();
    }));
    document.getElementById('cg-selall').addEventListener('change',e=>{
      this.GROUPS.forEach(g=>g.on=e.target.checked);
      this.renderGroupMenu();
      document.getElementById('cat-groups-menu').classList.add('open');
      if(typeof STATE!=='undefined') STATE.dirty();
    });
    const btn=document.getElementById('cat-groups-btn');
    if(btn) btn.textContent='BUCKETS ('+this.GROUPS.filter(g=>g.on).length+') ▾';
  },
  _groupCache:{},
  async loadChecked(){
    const token=++this._loadToken;
    document.getElementById('cat-groups-menu').classList.remove('open');
    const want=this.GROUPS.filter(g=>g.on);
    const btn=document.getElementById('cat-groups-btn');
    if(btn) btn.textContent='BUCKETS ('+want.length+') ▾';
    const prog=document.getElementById('cat-progress'),ptxt=document.getElementById('cat-progress-txt');
    prog.style.display='flex';
    this.deselect();
    /* combined buckets, deduped by NORAD id */
    const byNorad=new Map();
    let gotAny=false;
    /* streamed display: rebuild the instanced mesh from what has arrived so far */
    let lastBuild=0;
    const partial=()=>{
      const now=performance.now();
      if(token!==this._loadToken||now-lastBuild<1500||!byNorad.size) return;
      lastBuild=now;
      this.buildInstanced([...byNorad.values()],token,prog,ptxt,true);
    };
    for(let gi=0;gi<want.length;gi++){
      if(token!==this._loadToken) return;
      ptxt.textContent='Fetching '+want[gi].n+' ('+(gi+1)+'/'+want.length+')…';
      let raw=this._groupCache[want[gi].id];
      if(raw===undefined){
        if(want[gi].id==='__full'){
          /* primary: OrbitSmith static mirror (full ~34.6k + object_type) */
          ptxt.textContent='Loading full catalog from OrbitSmith…';
          raw=await OS.fetchCatalog((d,tot,nObj)=>{ptxt.textContent='OrbitSmith catalog — shard '+d+' / '+tot+' · '+nObj+' objects…';},
            m=>{if(token!==this._loadToken) return;
              for(const t of m.values()) if(t.satrec&&!byNorad.has(t.satnum)) byNorad.set(t.satnum,t);
              partial();});
          if(raw){this._srcLabel='ORBITSMITH (OFFLINE MIRROR)';}
          else{
            /* fallback: live CelesTrak full dump */
            ptxt.textContent='OrbitSmith unreachable — falling back to CelesTrak…';
            raw=await fetchFullCatalog(p=>{ptxt.textContent='CelesTrak full catalog… '+(p/1048576).toFixed(1)+' MB';});
            if(raw) this._srcLabel='CELESTRAK GP (FALLBACK)';
          }
        }else{
          raw=await fetchGroup(want[gi].id);
          if(raw&&!this._srcLabel) this._srcLabel='CELESTRAK GP';
        }
        if(raw) this._groupCache[want[gi].id]=raw;
      }
      if(token!==this._loadToken) return;
      if(!raw) continue;
      gotAny=true;
      if(Array.isArray(raw)){
        /* OrbitSmith path: objects already parsed + objType-tagged */
        raw.forEach(t=>{if(t.satrec&&!byNorad.has(t.satnum)) byNorad.set(t.satnum,t);});
      }else{
        parseCatalog(raw).forEach(t=>{if(t.satrec&&!byNorad.has(t.satnum)){t.objType=this.objTypeOfName(t);byNorad.set(t.satnum,t);}});
      }
      if(gi<want.length-1) partial();
    }
    let parsed=[...byNorad.values()];
    if(!gotAny){parsed=[];this._srcLabel='NO SOURCE REACHABLE';ptxt.textContent='Could not reach OrbitSmith or CelesTrak. No catalog loaded.';}
    else ptxt.textContent=parsed.length+' unique objects merged — building instanced buffer…';
    document.getElementById('cat-src-stamp').textContent=(this._srcLabel||'CATALOG')+' · FETCHED '+fmtUTCShort(new Date())+'Z · '+parsed.length+' OBJ';
    this._srcLabel=null;
    this.buildInstanced(parsed,token,prog,ptxt);
  },
  /* ── Instanced WebGL strategy: ONE hardware-accelerated draw call for the
        entire tracked environment (tens of thousands of objects). Round
        geometry (icosahedron) — no square points anywhere. Per-frame motion
        writes translation terms straight into the instance matrix buffer. ── */
  buildInstanced(parsed,token,prog,ptxt,partial){
    const gen=this._buildGen=(this._buildGen||0)+1;
    /* objects already on screen keep their state, so a streamed rebuild does not blank them */
    const old=new Map((this.sats||[]).map(q=>[q.tle.satnum,q]));
    this.sats=parsed.map(t=>{const ot=t.objType||this.objTypeOfName(t);const age=tleAgeDays(t);
      const o=old.get(t.satnum),keep=o&&o.ok;
      return{tle:t,cls:age>TLE_STALE_D?'STALE':this.classOf(t),objType:ot,age,vis:this.matchesFilter(ot),
             r:keep?o.r:[0,0,0],v:keep?o.v:[0,0,0],ok:false,_keep:keep};});
    if(this.mesh){this.three.scene.remove(this.mesh);this.mesh.geometry.dispose();this.mesh.material.dispose();this.mesh=null;}
    if(!this.sats.length){this.updateCounts();return;}
    const n=this.sats.length;
    const geo=new THREE.IcosahedronGeometry(1,1);
    const mat=new THREE.MeshBasicMaterial({transparent:true,opacity:0.95});
    const mesh=new THREE.InstancedMesh(geo,mat,n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const M=new THREE.Matrix4();
    for(let i=0;i<n;i++){
      const cls=this.sats[i].cls;
      const sc=cls==='DEB'?26:cls==='RB'?38:46;       /* debris renders smaller */
      this.sats[i].sc=sc;
      M.makeScale(sc,sc,sc);
      const q=this.sats[i];
      if(q._keep&&q.vis) M.setPosition(q.r[0],q.r[2],-q.r[1]);
      else M.setPosition(0,-1e9,0);                   /* park off-screen until seeded */
      mesh.setMatrixAt(i,M);
      const c=this.CLS_COLOR[cls]||[0.7,0.7,0.8];
      mesh.setColorAt(i,new THREE.Color(c[0],c[1],c[2]));
    }
    mesh.frustumCulled=false;
    mesh.instanceMatrix.needsUpdate=true;
    if(mesh.instanceColor) mesh.instanceColor.needsUpdate=true;
    this.mesh=mesh;
    this.three.scene.add(mesh);
    /* chunked SGP4 seed so the UI never blocks */
    let i=0;
    const seedChunk=()=>{
      if(token!==this._loadToken||gen!==this._buildGen) return;
      const t0=performance.now();
      const d=EPOCH.now();
      while(i<n&&performance.now()-t0<11){this.anchorOne(i,d);i++;}
      if(!partial) ptxt.textContent='Seeding SGP4 states… '+i+' / '+n;
      this.mesh.instanceMatrix.needsUpdate=true;
      if(i<n) requestAnimationFrame(seedChunk);
      else{if(!partial) prog.style.display='none';this.updateCounts();this.applyZoomScale(true);}
    };
    requestAnimationFrame(seedChunk);
    this.updateCounts();
  },

  /* one SGP4 fix → state vectors + GPU buffer (orbital → three coords: x, z, −y) */
  anchorOne(i,d){
    const s=this.sats[i],a=this.mesh.instanceMatrix.array,o=i*16;
    try{
      const pv=satellite.propagate(s.tle.satrec,d);
      if(pv&&pv.position&&isFinite(pv.position.x)){
        s.r[0]=pv.position.x;s.r[1]=pv.position.y;s.r[2]=pv.position.z;
        s.v[0]=pv.velocity.x;s.v[1]=pv.velocity.y;s.v[2]=pv.velocity.z;
        s.ok=true;
        a[o+12]=s.r[0];a[o+13]=s.r[2];a[o+14]=-s.r[1];
        return;
      }
    }catch(e){}
    s.ok=false;a[o+13]=-1e9;
  },

  /* time controls forward to the GLOBAL epoch clock — full lockstep */
  setScale(k,btn){
    EPOCH.setRate(k);
    document.querySelectorAll('#cat-toolbar .tw-btn').forEach(b=>b.classList.remove('on'));
    if(btn) btn.classList.add('on');
    document.getElementById('tw-pause').textContent='⏸';
  },
  setPause(){
    EPOCH.togglePause();
    document.getElementById('tw-pause').textContent=EPOCH.rate===0?'▶':'⏸';
    document.getElementById('tw-pause').classList.toggle('on',EPOCH.rate===0);
  },
  resetNow(){
    EPOCH.live();
    const d=EPOCH.now();
    for(let i=0;i<this.sats.length;i++) this.anchorOne(i,d);
    if(this.mesh) this.mesh.instanceMatrix.needsUpdate=true;
    this.anchorIdx=0;
    if(this.selected>=0) this.drawSelOrbit();
  },

  updateCounts(){
    const by={};let shown=0;
    this.sats.forEach(s=>{by[s.cls]=(by[s.cls]||0)+1;if(s.vis!==false)shown++;});
    const fl=this.filter&&this.filter!=='ALL'?' · '+this.filter+' ('+shown+' SHOWN)':'';
    document.getElementById('cat-counts').textContent=
      this.sats.length+' OBJ · PAYLOAD '+((by.LEO||0)+(by.MEO||0)+(by.GEO||0)+(by.HEO||0))+
      ' · DEBRIS '+(by.DEB||0)+' · R/B '+(by.RB||0)+(by.STALE?' · STALE TLE >'+TLE_STALE_D+' d '+by.STALE:'')+fl;
  },

  /* zoom-adaptive geometric scale: markers shrink toward true point objects as
     the camera closes in; grow for legibility when zoomed far out */
  _lastScaleRad:0,
  applyZoomScale(force){
    if(!this.mesh) return;
    const rad=this.three.ctrl.rad,R0=RE_KM*6.2;
    if(!force&&Math.abs(rad-this._lastScaleRad)/Math.max(rad,1)<0.04) return;
    this._lastScaleRad=rad;
    const f=Math.min(3,Math.max(0.06,Math.pow(rad/R0,1.3)));
    const a=this.mesh.instanceMatrix.array;
    for(let i=0;i<this.sats.length;i++){
      const vis=this.sats[i].vis!==false;
      const sc=vis?this.sats[i].sc*f:0,o=i*16;
      a[o]=sc;a[o+5]=sc;a[o+10]=sc;
    }
    this.mesh.instanceMatrix.needsUpdate=true;
  },

  /* per-frame: advance sim clock, bridge-integrate, re-anchor, render */
  frame(nowP,dt){
    const T=this.three;
    T.ctrl.update(dt);
    this.applyZoomScale(false);
    const dtSim=dt*EPOCH.rate;            /* sim seconds this frame (global clock) */
    if(this.sats.length&&this.mesh&&Math.abs(dtSim)>1e-9){
      /* symplectic Euler two-body bridge, substeps ≤ 8 s */
      const nSub=Math.max(1,Math.ceil(Math.abs(dtSim)/8));
      const h=dtSim/nSub;
      const arr=this.mesh.instanceMatrix.array;
      for(let i=0;i<this.sats.length;i++){
        const s=this.sats[i];
        if(!s.ok) continue;
        let[rx,ry,rz]=s.r,[vx,vy,vz]=s.v;
        for(let q=0;q<nSub;q++){
          const r2=rx*rx+ry*ry+rz*rz,r1=Math.sqrt(r2);
          const k=-MU_E/(r2*r1)*h;
          vx+=k*rx;vy+=k*ry;vz+=k*rz;     /* kick */
          rx+=vx*h;ry+=vy*h;rz+=vz*h;     /* drift */
        }
        s.r[0]=rx;s.r[1]=ry;s.r[2]=rz;s.v[0]=vx;s.v[1]=vy;s.v[2]=vz;
        const o=i*16;
        arr[o+12]=rx;arr[o+13]=rz;arr[o+14]=-ry;
      }
      /* time-boxed SGP4 re-anchor sweep (~3 ms budget) */
      const t0=performance.now(),d=EPOCH.now();
      let nA=0;
      while(performance.now()-t0<3&&nA<this.sats.length){
        this.anchorOne(this.anchorIdx,d);
        this.anchorIdx=(this.anchorIdx+1)%this.sats.length;
        nA++;
      }
      this.mesh.instanceMatrix.needsUpdate=true;
    }
    /* Earth orientation + Sun direction at the SIM epoch — true physics under acceleration */
    const simD=EPOCH.now();
    if(T.earthMesh) T.earthMesh.rotation.y=gmst_from_jd(julianDate(simD));
    if(nowP-(this._sunT||0)>250){this._sunT=nowP;T.setSun(sunECIUnit(simD));}
    /* clocks (global epoch) */
    const sd=simD;
    document.getElementById('cat-simclock').textContent=
      sd.toISOString().slice(0,19).replace('T',' ')+' UTC'+(EPOCH.rate===0?' ⏸':'');
    const off=EPOCH.offsetMs()/1000;
    document.getElementById('cat-simoffset').textContent=
      Math.abs(off)<2?'· REAL TIME':(off>0?'· +':'· −')+fmtHMS(Math.abs(off))+' vs now';
    /* hover picking (throttled) */
    if(nowP-this._hoverLast>70&&this.mesh){this._hoverLast=nowP;this.hoverPick();}
    /* selected: live marker + card */
    if(this.selected>=0){
      const s=this.sats[this.selected];
      const mk=T.scene.getObjectByName('catSelMk');
      if(mk&&s.ok) mk.position.set(s.r[0],s.r[2],-s.r[1]);
      if(nowP-this._cardLast>400){this._cardLast=this._cardLast=nowP;this.updateCard();}
      if(nowP-this._orbitT>60000){this._orbitT=nowP;this.drawSelOrbit();}
    }
    T.renderer.render(T.scene,T.camera);
  },

  raySetup(){
    this._ray.setFromCamera(this._mouse,this.three.camera);
  },
  pick(){
    this.raySetup();
    const hits=this._ray.intersectObject(this.mesh);
    return hits.length?hits[0].instanceId:-1;
  },
  hoverPick(){
    const hv=document.getElementById('cat-hover');
    if(!this._mouseEv){hv.style.display='none';return;}
    const i=this.pick();
    if(i>=0){
      this.hoverIdx=i;
      const s=this.sats[i],t=s.tle;
      const alt=Math.sqrt(s.r[0]**2+s.r[1]**2+s.r[2]**2)-RE_KM;
      const spd=Math.sqrt(s.v[0]**2+s.v[1]**2+s.v[2]**2);
      hv.innerHTML='<div class="ch-name">'+t.name+'</div>'+
        '<div class="ch-row"><span>NORAD</span><span>'+t.satnum+' · '+(s.cls==='DEB'?'DEBRIS':s.cls==='RB'?'ROCKET BODY':t.orbitType)+'</span></div>'+
        '<div class="ch-row"><span>ALT</span><span>'+alt.toFixed(0)+' km</span></div>'+
        '<div class="ch-row"><span>SPEED</span><span>'+spd.toFixed(2)+' km/s</span></div>'+
        '<div class="ch-row"><span>INC / T</span><span>'+t.inc.toFixed(1)+'° · '+(t.T_s/60).toFixed(0)+' min</span></div>'+
        '<div class="ch-row"><span>TLE AGE</span><span>'+s.age.toFixed(1)+' d'+(s.age>TLE_STALE_D?' (stale)':'')+'</span></div>'+
        '<div class="ch-row" style="color:var(--muted);margin-top:3px;"><span>CLICK</span><span>ORBIT + DETAILS</span></div>';
      const wrap=document.getElementById('cat-stage').getBoundingClientRect();
      let x=this._mouseEv.clientX-wrap.left+14,y=this._mouseEv.clientY-wrap.top+10;
      hv.style.display='block';
      const hw=hv.offsetWidth,hh=hv.offsetHeight;
      if(x+hw>wrap.width-8)x=this._mouseEv.clientX-wrap.left-hw-12;
      if(y+hh>wrap.height-8)y=wrap.height-hh-8;
      hv.style.left=x+'px';hv.style.top=y+'px';
      this.three.renderer.domElement.style.cursor='pointer';
    } else {
      this.hoverIdx=-1;hv.style.display='none';
      this.three.renderer.domElement.style.cursor='grab';
    }
  },
  clickPick(){
    const i=this.pick();
    if(i>=0) this.select(i);
  },

  select(i){
    this.selected=i;
    const T=this.three,s=this.sats[i];
    let mk=T.scene.getObjectByName('catSelMk');
    if(!mk){
      mk=new THREE.Mesh(new THREE.SphereGeometry(120,14,14),new THREE.MeshBasicMaterial({color:0xe0e0e0}));
      mk.name='catSelMk';T.scene.add(mk);
    }
    mk.position.set(s.r[0],s.r[2],-s.r[1]);
    this._orbitT=performance.now();
    this.drawSelOrbit();
    document.getElementById('cat-card').style.display='block';
    document.getElementById('cc-name').textContent=s.tle.name;
    this.updateCard();
  },
  /* one-period orbit sampled directly from SGP4 (true osculating + perturbed path) */
  drawSelOrbit(){
    const T=this.three;
    let old=T.scene.getObjectByName('catSelOrbit');
    if(old){T.scene.remove(old);old.geometry.dispose();old.material.dispose();}
    if(this.selected<0) return;
    const s=this.sats[this.selected];
    const P=s.tle.T_s,NPTS=160,pts=[];
    for(let k=0;k<=NPTS;k++){
      const d=new Date(EPOCH.ms()+(k/NPTS)*P*1000);
      try{
        const pv=satellite.propagate(s.tle.satrec,d);
        if(pv&&pv.position&&isFinite(pv.position.x))
          pts.push(new THREE.Vector3(pv.position.x,pv.position.z,-pv.position.y));
      }catch(e){}
    }
    if(pts.length<2) return;
    const g=new THREE.BufferGeometry().setFromPoints(pts);
    const line=new THREE.Line(g,new THREE.LineBasicMaterial({color:0xe0e0e0,transparent:true,opacity:.85}));
    line.name='catSelOrbit';T.scene.add(line);
  },
  updateCard(){
    if(this.selected<0) return;
    const s=this.sats[this.selected],t=s.tle;
    const rmag=Math.sqrt(s.r[0]**2+s.r[1]**2+s.r[2]**2);
    const spd=Math.sqrt(s.v[0]**2+s.v[1]**2+s.v[2]**2);
    /* sub-satellite point at sim epoch */
    const gm=gmst_from_jd(julianDate(EPOCH.now()));
    const ct=Math.cos(gm),st=Math.sin(gm);
    const fx=ct*s.r[0]+st*s.r[1],fy=-st*s.r[0]+ct*s.r[1],fz=s.r[2];
    const lon=((Math.atan2(fy,fx)*R2D+540)%360)-180;
    const lat=Math.atan2(fz,Math.sqrt(fx*fx+fy*fy))*R2D;
    const apo=t.a*(1+t.ecc)-RE_KM,per=t.a*(1-t.ecc)-RE_KM;
    const sl=isSunlit(s.r,sunECIUnit(EPOCH.now()));
    document.getElementById('cc-grid').innerHTML=
      row('NORAD',t.satnum)+row('CLASS',t.orbitType)+
      row('ALT',(rmag-RE_KM).toFixed(1)+' km')+row('SPEED',spd.toFixed(3)+' km/s')+
      row('SUBPOINT',lat.toFixed(2)+'°, '+lon.toFixed(2)+'°')+row('ILLUM',sl?'SUNLIT ☀':'IN SHADOW ●')+
      row('APOGEE',apo.toFixed(0)+' km')+row('PERIGEE',per.toFixed(0)+' km')+
      row('INC',t.inc.toFixed(3)+'°')+row('PERIOD',(t.T_s/60).toFixed(2)+' min')+
      row('ECC',t.ecc.toFixed(6))+row('RAAN',t.raan.toFixed(2)+'°')+
      row('TLE EPOCH',fmtDateUTC(t.epoch))+row('TLE AGE',s.age.toFixed(1)+' d');
    function row(k,v){return'<div class="cc-row"><span class="cc-k">'+k+'</span><span class="cc-v">'+v+'</span></div>';}
  },
  deselect(){
    this.selected=-1;
    document.getElementById('cat-card').style.display='none';
    if(this.three){
      const o=this.three.scene.getObjectByName('catSelOrbit');
      if(o){this.three.scene.remove(o);o.geometry.dispose();o.material.dispose();}
      const m=this.three.scene.getObjectByName('catSelMk');
      if(m) this.three.scene.remove(m);
    }
  },
  trackSelected(){
    if(this.selected<0) return;
    const t=this.sats[this.selected].tle;
    let found=allSats.find(x=>x.satnum===t.satnum);
    if(!found){allSats.unshift(t);populateList(allSats);found=t;}
    switchView('tracker');
    /* find its list item to highlight */
    let item=null;
    document.querySelectorAll('#sat-list .sat-item').forEach(el=>{
      if(el.querySelector('.sat-meta')&&el.querySelector('.sat-meta').textContent.includes(String(found.satnum))) item=el;
    });
    selectSat(found,item);
    if(item) item.scrollIntoView({block:'center'});
  }
};

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  MODULE · EphemerisService — deep-space pipeline (non-TLE class)  ║
   ║  · Fuzzy name resolution  → JPL Small-Body Database Lookup API    ║
   ║  · State-vector packets   → JPL Horizons EPHEM_TYPE=VECTORS       ║
   ║  · Rate-limit protection  → IndexedDB + in-memory packet cache    ║
   ║  · Fluid animation        → cubic Hermite interpolation (uses     ║
   ║    BOTH position and velocity samples ⇒ C¹-continuous motion)     ║
   ║  · Frame bridge           → ECI (equatorial, km) ⇄ heliocentric   ║
   ║    ecliptic J2000 (AU) into one unified scene space               ║
   ╚══════════════════════════════════════════════════════════════════╝ */
const AU_KM=149597870.7;
