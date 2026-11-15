const DISC={inited:true,sandbox:null,_cardSel:undefined,three:null,frame(){}};

/* ════ SWX · Kp and F10.7 from NOAA SWPC, shown in the epoch bar ════ */
const SWX={
  async refresh(){
    const get=async u=>{try{const r=await fetch(u,{signal:fetchTimeoutSignal(14000)});return r.ok?await r.json():null;}catch(e){return null;}};
    const el=document.getElementById('ep-wx');if(!el) return;
    /* the two feeds are independent: show each as soon as it arrives */
    get('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json').then(kp=>{
      if(!kp||!kp.length) return;
      const k=parseFloat(kp[kp.length-1].kp_index??kp[kp.length-1].estimated_kp);
      if(!isFinite(k)) return;
      const e=document.getElementById('ep-kp');
      e.textContent='Kp '+k.toFixed(1);e.className=k>=5?'storm':'';
      e.title='Planetary K index (NOAA SWPC). '+(k<4?'Quiet field.':k<5?'Unsettled.':'Geomagnetic storm: expect higher drag in LEO.');
    });
    get('https://services.swpc.noaa.gov/products/summary/10cm-flux.json').then(f=>{
      if(!f||!f.Flux) return;
      const e=document.getElementById('ep-f107');
      e.textContent='F10.7 '+parseFloat(f.Flux).toFixed(0)+' sfu';
      e.title='10.7 cm solar radio flux (NOAA SWPC), the standard proxy for thermospheric density and drag.';
    });
  },
  init(){
    const bar=document.getElementById('epoch-bar');if(!bar) return;
    const el=document.createElement('span');el.id='ep-wx';
    el.innerHTML='<span id="ep-kp">Kp —</span><span id="ep-f107">F10.7 —</span>';
    bar.appendChild(el);
    this.refresh();setInterval(()=>this.refresh(),600000);
  }
};
document.addEventListener('DOMContentLoaded',()=>SWX.init());

const CA={
  inited:false,three:null,rows:[],sel:-1,sort:'range',
  t1:null,t2:null,_tleCache:{},_src:'—',

  init(){
    if(this.inited) return;
    this.inited=true;
    this.three=initThree3D('ca-canvas-wrap',{axes:false,rad:RE_KM*5.4});
    this.refresh();
    setInterval(()=>this.refresh(),60*60*1000);   /* hourly feed refresh */
  },

  /* ── SOCRATES feed: try CSV endpoints, then the HTML report, then sample ── */
  async refresh(){
    const st=document.getElementById('ca-feed-state');
    st.textContent='FETCHING SOCRATES…';
    const bases=[
      'https://celestrak.org/SOCRATES/sort-minRange.csv',
      'https://celestrak.org/SOCRATES/sort-maxProb.csv',
      'https://celestrak.org/SOCRATES/socrates.csv',
      'https://celestrak.org/SOCRATES/'
    ];
    let rows=null,src=null;
    for(const base of bases){
      const urls=urlChain(base);
      for(const u of urls){
        try{
          const r=await fetch(u,{signal:fetchTimeoutSignal(20000)});
          if(!r.ok) continue;
          const txt=await r.text();
          rows=this.parseSocrates(txt);
          if(rows&&rows.length){src=base.endsWith('/')?'SOCRATES HTML REPORT':'SOCRATES CSV';break;}
        }catch(e){}
      }
      if(rows&&rows.length) break;
    }
    if(!rows||!rows.length){
      rows=[];src='SOCRATES FEED UNREACHABLE · NO CONJUNCTION DATA';
    }
    this._src=src;
    this.rows=rows;
    this.renderList();
    st.textContent=src+' · '+rows.length+' PAIRS';
    if(this.sel<0&&rows.length) this.select(0);
  },

  /* tolerant parser: SOCRATES CSV (header keyed) or the HTML report table */
  parseSocrates(txt){
    const out=[];
    if(/<html|<table/i.test(txt)){
      /* HTML report: rows carry NORAD ids, names, TCA, range, speed, prob */
      const trs=txt.split(/<tr[^>]*>/i).slice(1);
      for(const tr of trs){
        const cells=[...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>m[1].replace(/<[^>]+>/g,'').trim());
        if(cells.length<8) continue;
        const nums=cells.map(c=>parseFloat(c));
        /* heuristics: find two 4-6 digit ints (NORAD ids) and a date cell */
        const idIdx=cells.map((c,i)=>/^\d{4,6}$/.test(c)?i:-1).filter(i=>i>=0);
        const tcaIdx=cells.findIndex(c=>/\d{4}.*\d{2}:\d{2}/.test(c));
        if(idIdx.length>=2&&tcaIdx>=0){
          const rng=nums.find((v,i)=>i>tcaIdx&&isFinite(v)&&v<50);
          const spd=nums.find((v,i)=>i>tcaIdx&&isFinite(v)&&v>0.05&&v<20);
          out.push({id1:cells[idIdx[0]],n1:cells[idIdx[0]+1]||'OBJ '+cells[idIdx[0]],
                    id2:cells[idIdx[1]],n2:cells[idIdx[1]+1]||'OBJ '+cells[idIdx[1]],
                    tca:new Date(cells[tcaIdx].replace(/\s+/,'T')+'Z'),
                    rangeKm:rng??0,relV:spd??0,prob:null});
        }
        if(out.length>=20) break;
      }
      return out.filter(r=>r.tca&&!isNaN(r.tca));
    }
    /* CSV with a header row */
    const lines=txt.split(/\r?\n/).filter(l=>l.trim());
    const hi=lines.findIndex(l=>/TCA/i.test(l)&&/,/.test(l));
    if(hi<0) return null;
    const H=lines[hi].split(',').map(s=>s.trim().toUpperCase());
    const col=names=>{for(const n of names){const i=H.findIndex(h=>h.includes(n));if(i>=0)return i;}return -1;};
    const c={id1:col(['NORAD_CAT_ID_1','SAT1_ID','OBJECT_1_ID']),n1:col(['OBJECT_NAME_1','SAT1_NAME']),
             id2:col(['NORAD_CAT_ID_2','SAT2_ID','OBJECT_2_ID']),n2:col(['OBJECT_NAME_2','SAT2_NAME']),
             tca:col(['TCA']),rng:col(['TCA_RANGE','MIN_RNG','RANGE']),
             v:col(['RELATIVE_SPEED','REL_SPEED','RELATIVE_VELOCITY']),p:col(['MAX_PROB','PC','PROBABILITY'])};
    if(c.id1<0||c.id2<0||c.tca<0) return null;
    for(let i=hi+1;i<lines.length&&out.length<25;i++){
      const f=lines[i].split(',').map(s=>s.trim());
      if(f.length<H.length-1) continue;
      const tca=new Date(f[c.tca].replace(' ','T')+(f[c.tca].endsWith('Z')?'':'Z'));
      if(isNaN(tca)) continue;
      out.push({id1:f[c.id1],n1:c.n1>=0?f[c.n1]:'OBJ '+f[c.id1],
                id2:f[c.id2],n2:c.n2>=0?f[c.n2]:'OBJ '+f[c.id2],
                tca,rangeKm:c.rng>=0?parseFloat(f[c.rng]):0,
                relV:c.v>=0?parseFloat(f[c.v]):0,
                prob:c.p>=0?parseFloat(f[c.p]):null});
    }
    return out;
  },
  sampleRows(){
    const h=3600000,now=Date.now();
    return[
      {id1:'25544',n1:'ISS (ZARYA)',id2:'48275',n2:'CZ-5B R/B',tca:new Date(now+9*h),rangeKm:1.42,relV:11.2,prob:2.1e-4},
      {id1:'43013',n1:'NOAA 20',id2:'29275',n2:'FENGYUN 1C DEB',tca:new Date(now+14*h),rangeKm:0.31,relV:14.6,prob:8.4e-4},
      {id1:'20580',n1:'HST',id2:'39084',n2:'COSMOS 2251 DEB',tca:new Date(now+22*h),rangeKm:0.88,relV:9.8,prob:1.2e-4},
      {id1:'48274',n1:'TIANHE',id2:'31114',n2:'IRIDIUM 33 DEB',tca:new Date(now+31*h),rangeKm:2.6,relV:12.4,prob:4.0e-5},
      {id1:'28654',n1:'NOAA 18',id2:'34454',n2:'SL-16 R/B',tca:new Date(now+41*h),rangeKm:0.54,relV:13.1,prob:5.5e-4}
    ];
  },

  setSort(s,btn){
    this.sort=s;
    document.querySelectorAll('.ca-sort').forEach(b=>b.classList.remove('on'));
    if(btn) btn.classList.add('on');
    this.renderList();
  },
  renderList(){
    const host=document.getElementById('ca-list');if(!host)return;
    const rows=[...this.rows];
    if(this.sort==='range') rows.sort((a,b)=>a.rangeKm-b.rangeKm);
    else if(this.sort==='tca') rows.sort((a,b)=>a.tca-b.tca);
    else rows.sort((a,b)=>(b.prob||0)-(a.prob||0));
    this._view=rows;
    host.innerHTML=rows.map((r,i)=>{
      const dt=(r.tca.getTime()-EPOCH.ms())/1000;
      return '<div class="ca-row'+(i===this.sel?' sel':'')+'" onclick="CA.select('+i+')">'+
        '<div class="car-top"><span class="car-pair">'+r.n1.slice(0,15)+' ⚠ '+r.n2.slice(0,15)+'</span>'+
        '<span class="car-rng">'+(r.rangeKm<1?(r.rangeKm*1000).toFixed(0)+' m':r.rangeKm.toFixed(2)+' km')+'</span></div>'+
        '<div class="car-sub">'+r.id1+' × '+r.id2+' · TCA '+(dt>0?'T−'+fmtHMS(dt):'T+'+fmtHMS(-dt))+
        ' · '+r.relV.toFixed(1)+' km/s'+(r.prob?' · Pc '+r.prob.toExponential(1):'')+'</div></div>';
    }).join('');
  },

  async fetchTLE(id){
    if(this._tleCache[id]) return this._tleCache[id];
    /* a NORAD id may already be in a loaded catalog bucket */
    if(typeof CAT!=='undefined'&&CAT.sats.length){
      const hit=CAT.sats.find(s=>String(s.tle.satnum)===String(id));
      if(hit){this._tleCache[id]=hit.tle;return hit.tle;}
    }
    const base='https://celestrak.org/NORAD/elements/gp.php?CATNR='+id+'&FORMAT=tle';
    for(const u of urlChain(base)){
      try{
        const r=await fetch(u,{signal:fetchTimeoutSignal(15000)});
        if(!r.ok) continue;
        const t=await r.text();
        if(t.includes('1 ')&&t.includes('2 ')){
          const p=parseCatalog(t).filter(x=>x.satrec);
          if(p.length){this._tleCache[id]=p[0];return p[0];}
        }
      }catch(e){}
    }
    return null;
  },

  async select(i){
    this.sel=i;this.renderList();
    const r=this._view[i];if(!r)return;
    document.getElementById('ca-pair-title').textContent=r.n1+'  ×  '+r.n2;
    document.getElementById('ca-detail-state').textContent='FETCHING ELEMENT SETS…';
    const[t1,t2]=await Promise.all([this.fetchTLE(r.id1),this.fetchTLE(r.id2)]);
    this.t1=t1;this.t2=t2;this.cur=r;
    if(!t1||!t2){
      document.getElementById('ca-detail-state').textContent='⚠ TLE FETCH FAILED FOR '+(!t1?r.id1:r.id2)+' — GEOMETRY UNAVAILABLE';
      return;
    }
    document.getElementById('ca-detail-state').textContent='SGP4 ELEMENT SETS LOADED · EPOCHS '+fmtDateUTC(t1.epoch).slice(0,11)+' / '+fmtDateUTC(t2.epoch).slice(0,11);
    this.buildScene();
    this.drawSMA();
    this.renderDetail();
  },

  eciAt(tle,d){
    try{const pv=satellite.propagate(tle.satrec,d);
      if(pv&&pv.position&&isFinite(pv.position.x))
        return{r:[pv.position.x,pv.position.y,pv.position.z],v:[pv.velocity.x,pv.velocity.y,pv.velocity.z]};
    }catch(e){}
    return null;
  },

  buildScene(){
    const T=this.three,r=this.cur;
    /* clear previous pair artifacts */
    ['caOrb1','caOrb2','caMk1','caMk2','caMiss','caTCA','caSub','caSubLine'].forEach(n=>{
      const o=T.scene.getObjectByName(n);if(o)T.scene.remove(o);
    });
    const mkOrbit=(tle,color,name)=>{
      const P=tle.T_s,N=180,pts=[];
      for(let k=0;k<=N;k++){
        const d=new Date(r.tca.getTime()+((k/N)-0.5)*P*1000);
        const s=this.eciAt(tle,d);
        if(s) pts.push(new THREE.Vector3(s.r[0],s.r[2],-s.r[1]));
      }
      if(pts.length<2) return;
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({color,transparent:true,opacity:.9}));
      line.name=name;T.scene.add(line);
    };
    mkOrbit(this.t1,0xcccccc,'caOrb1');
    mkOrbit(this.t2,0xe0e0e0,'caOrb2');
    const s1=this.eciAt(this.t1,r.tca),s2=this.eciAt(this.t2,r.tca);
    if(s1&&s2){
      const p1=new THREE.Vector3(s1.r[0],s1.r[2],-s1.r[1]);
      const p2=new THREE.Vector3(s2.r[0],s2.r[2],-s2.r[1]);
      const mk=(p,c,n)=>{const m=new THREE.Mesh(new THREE.SphereGeometry(130,16,16),
        new THREE.MeshBasicMaterial({color:c}));m.position.copy(p);m.name=n;T.scene.add(m);};
      mk(p1,0xcccccc,'caMk1');mk(p2,0xe0e0e0,'caMk2');
      const miss=new THREE.Line(new THREE.BufferGeometry().setFromPoints([p1,p2]),
        new THREE.LineBasicMaterial({color:0xd66e6e}));
      miss.name='caMiss';T.scene.add(miss);
      const mid=p1.clone().add(p2).multiplyScalar(0.5);
      const tcaMk=new THREE.Mesh(new THREE.TorusGeometry(420,40,10,40),
        new THREE.MeshBasicMaterial({color:0xd66e6e,transparent:true,opacity:.65}));
      tcaMk.position.copy(mid);tcaMk.lookAt(0,0,0);tcaMk.name='caTCA';T.scene.add(tcaMk);
      /* conjunction SUB-POINT: rotate the ECI midpoint into ECEF at TCA → geodetic */
      const gm=gmst_from_jd(julianDate(r.tca)),ct=Math.cos(gm),st=Math.sin(gm);
      const mE=[ct*(s1.r[0]+s2.r[0])/2+st*(s1.r[1]+s2.r[1])/2,
               -st*(s1.r[0]+s2.r[0])/2+ct*(s1.r[1]+s2.r[1])/2,(s1.r[2]+s2.r[2])/2];
      const lon=((Math.atan2(mE[1],mE[0])*R2D+540)%360)-180;
      const lat=Math.atan2(mE[2],Math.hypot(mE[0],mE[1]))*R2D;
      this.subLL={lat,lon};
      /* the sub-point lives on the rotating earthMesh so it tracks GMST */
      const la=lat*D2R,lo=lon*D2R;
      const sp=new THREE.Mesh(new THREE.SphereGeometry(110,12,12),
        new THREE.MeshBasicMaterial({color:0x9a9a9a}));
      sp.position.set(RE_KM*1.01*Math.cos(la)*Math.cos(lo),RE_KM*1.01*Math.sin(la),-RE_KM*1.01*Math.cos(la)*Math.sin(lo));
      sp.name='caSub';
      if(T.earthMesh) T.earthMesh.add(sp); else T.scene.add(sp);
      const sl=new THREE.Line(new THREE.BufferGeometry().setFromPoints([sp.position.clone().multiplyScalar(1.0),sp.position.clone().normalize().multiplyScalar(mid.length())]),
        new THREE.LineBasicMaterial({color:0x9a9a9a,transparent:true,opacity:.3}));
      sl.name='caSubLine';
      if(T.earthMesh) T.earthMesh.add(sl); else T.scene.add(sl);
    }
  },

  /* osculating semi-major axis a(t)=1/(2/r − v²/μ) over ±12 h for both objects */
  drawSMA(){
    const c=document.getElementById('ca-sma');if(!c)return;
    c.width=c.clientWidth*2;c.height=c.clientHeight*2;
    const ctx=c.getContext('2d'),W=c.width,H=c.height;
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='rgba(4,4,4,.6)';ctx.fillRect(0,0,W,H);
    const series=[[this.t1,'#cccccc'],[this.t2,'#e0e0e0']].map(([tle,col])=>{
      const pts=[];
      for(let k=0;k<=96;k++){
        const d=new Date(this.cur.tca.getTime()+((k/96)-0.5)*24*3600*1000);
        const s=this.eciAt(tle,d);
        if(!s) continue;
        const rm=Math.hypot(...s.r),vm2=s.v[0]**2+s.v[1]**2+s.v[2]**2;
        pts.push({k,a:1/(2/rm-vm2/MU_E)});
      }
      return{pts,col,tle};
    });
    const all=series.flatMap(s=>s.pts.map(p=>p.a));
    if(!all.length) return;
    let aMin=Math.min(...all),aMax=Math.max(...all);
    const pad=(aMax-aMin)*0.15+0.5;aMin-=pad;aMax+=pad;
    /* TCA line */
    ctx.strokeStyle='rgba(214,110,110,.8)';ctx.lineWidth=2;ctx.setLineDash([6,4]);
    ctx.beginPath();ctx.moveTo(W/2,0);ctx.lineTo(W/2,H);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='rgba(214,110,110,.9)';ctx.font='13px IBM Plex Mono';ctx.fillText('TCA',W/2+5,14);
    series.forEach(s=>{
      ctx.beginPath();
      s.pts.forEach((p,i)=>{
        const x=p.k/96*W,y=H-(p.a-aMin)/(aMax-aMin)*H;
        i?ctx.lineTo(x,y):ctx.moveTo(x,y);
      });
      ctx.strokeStyle=s.col;ctx.lineWidth=2.5;ctx.shadowColor=s.col;ctx.shadowBlur=0;ctx.stroke();ctx.shadowBlur=0;
      const last=s.pts[s.pts.length-1];
      ctx.fillStyle=s.col;ctx.font='13px IBM Plex Mono';
      ctx.fillText(s.tle.name.slice(0,14)+' a≈'+last.a.toFixed(1)+' km',8,s.col==='#cccccc'?16:32);
    });
    ctx.fillStyle='rgba(180,180,180,.85)';ctx.font='12px IBM Plex Mono';
    ctx.fillText('OSCULATING SMA · TCA ± 12 H',W-220,H-8);
  },

  renderDetail(){
    const r=this.cur,el=document.getElementById('ca-info');
    const row=(k,v)=>'<div class="ssi-k">'+k+'</div><div class="ssi-v">'+v+'</div>';
    el.innerHTML='<div class="ssi-name" style="font-size:11px;">CONJUNCTION GEOMETRY</div>'+
      '<div class="ssi-grid">'+
      row('OBJECTS','<span style="color:#cccccc">'+r.n1+'</span> ('+r.id1+')<br/><span style="color:#e0e0e0">'+r.n2+'</span> ('+r.id2+')')+
      row('TCA',fmtDateUTC(r.tca)+'<span class="ssi-sub">'+fmtLocalTime(r.tca,SITE.tz)+' LOCAL</span>')+
      row('MISS DIST',(r.rangeKm<1?(r.rangeKm*1000).toFixed(0)+' m':r.rangeKm.toFixed(2)+' km'))+
      row('REL VELOCITY',r.relV.toFixed(2)+' km/s')+
      (r.prob!==null?row('MAX Pc',r.prob.toExponential(2)):'')+
      (this.subLL?row('SUB-POINT',this.subLL.lat.toFixed(2)+'°, '+this.subLL.lon.toFixed(2)+'°'):'')+
      (this.t1?row('SMA / INC ①',this.t1.a.toFixed(0)+' km · '+this.t1.inc.toFixed(1)+'°'):'')+
      (this.t2?row('SMA / INC ②',this.t2.a.toFixed(0)+' km · '+this.t2.inc.toFixed(1)+'°'):'')+
      '</div>';
  },

  frame(nowP,dt){
    const T=this.three;
    T.ctrl.update(dt);
    /* live markers at the global epoch + earth at GMST */
    const d=EPOCH.now();
    if(T.earthMesh) T.earthMesh.rotation.y=gmst_from_jd(julianDate(d));
    if(nowP-(this._sunT||0)>400){this._sunT=nowP;T.setSun(sunECIUnit(d));}
    if(this.t1&&this.t2&&nowP-(this._mkT||0)>120){
      this._mkT=nowP;
      const m1=T.scene.getObjectByName('caMk1'),m2=T.scene.getObjectByName('caMk2');
      const s1=this.eciAt(this.t1,d),s2=this.eciAt(this.t2,d);
      if(m1&&s1) m1.position.set(s1.r[0],s1.r[2],-s1.r[1]);
      if(m2&&s2) m2.position.set(s2.r[0],s2.r[2],-s2.r[1]);
    }
    if(nowP-(this._listT||0)>1000){this._listT=nowP;if(this.rows.length)this.renderList();}
    T.renderer.render(T.scene,T.camera);
  }
};

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  MODULE · UIStateManager — lab-grade always-on persistence        ║
   ║  Every core parameter caches continuously to localStorage:        ║
   ║  camera viewpoints · active filters · selection arrays · time     ║
   ║  rate/offset · tab + sub-toggle states · sandbox sliders.         ║
   ║  A browser reset re-initializes straight into the prior layout.   ║
   ╚══════════════════════════════════════════════════════════════════╝ */
