const STATE={
  KEY:'ssa.v4.state',
  _t:null,_restoring:false,
  dirty(){ /* debounced save — call from any state-changing hook */
    if(this._restoring) return;
    clearTimeout(this._t);
    this._t=setTimeout(()=>this.save(),900);
  },
  camOf(T){return T&&T.ctrl?{t:T.ctrl.tTheta,p:T.ctrl.tPhi,r:T.ctrl.tRad}:null;},
  applyCam(T,c){
    if(!T||!T.ctrl||!c) return;
    T.ctrl.tTheta=T.ctrl.theta=c.t;T.ctrl.tPhi=T.ctrl.phi=c.p;T.ctrl.tRad=T.ctrl.rad=c.r;
  },
  save(){
    try{
      const s={
        v:5,
        view:document.body.dataset.view||'tracker',
        wxOpen,
        horizonH:HORIZON_S/3600,
        skyVisOnly:SKY_VIS_ONLY,
        catGroups:CAT.GROUPS.filter(g=>g.on).map(g=>g.id),
        catFilter:CAT.filter,
        rate:EPOCH.rate,
        minEl:(document.getElementById('eph-minel')||{}).value,
        ephPlotted:typeof EPH!=='undefined'?EPH.plotted.map(p=>({cmd:p.cmd,name:p.name,g:p.g||'◆'})):[],
        ephActive:typeof EPH!=='undefined'?EPH.active:null,
        sel:SEL.map(s=>s.tle.satnum),
        sandbox:DISC.sandbox,
        cardSel:DISC._cardSel,
        ssScale:typeof SS!=='undefined'?SS.trueScale:undefined,
        cams:{
          eci:this.camOf(typeof eciThree!=='undefined'?eciThree:null),
          ecef:this.camOf(typeof ecefThree!=='undefined'?ecefThree:null),
          cat:this.camOf(CAT.three),
          ca:this.camOf(typeof CA!=='undefined'?CA.three:null),
          ss:this.camOf(typeof SS!=='undefined'?SS.three:null),
          sb:this.camOf(DISC.three)
        }
      };
      localStorage.setItem(this.KEY,JSON.stringify(s));
    }catch(e){}
  },
  load(){
    try{return JSON.parse(localStorage.getItem(this.KEY)||'null');}catch(e){return null;}
  }
};

/* ════ VIEW SWITCHING ════ */
function switchView(v){
  if(v==='disc') v='tracker';   /* Discovery was removed; old saved sessions land on Observer */
  document.body.dataset.view=v;
  document.querySelectorAll('.view').forEach(el=>el.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===v));
  try{
  if(v==='catalog'&&!CAT.inited){
    if(!WEBGL_OK){document.getElementById('cat-canvas-wrap').innerHTML='<div class="no-webgl">3-D catalog view needs WebGL, which this browser could not provide.</div>';}
    else CAT.init();
    if(CAT.inited) CAT.loadChecked();
    const c=STATE._pending&&STATE._pending.cams?STATE._pending.cams.cat:null;
    if(c) STATE.applyCam(CAT.three,c);
  }
  if(v==='eph'){
    if(!EPH._listDone){
      EPH.renderList();
      EPH.renderSiteChip();
      const sel=document.getElementById('eph-site-sel');
      EPH.SITES.forEach((s,i)=>{
        if(i===0) return;
        const o=document.createElement('option');o.value=i;o.textContent=s.n;sel.appendChild(o);
      });
    }
    if(!SS.inited&&WEBGL_OK){
      SS.init();
      document.querySelectorAll('.ss-scale-btn').forEach((b,k)=>b.classList.toggle('on',(k===1)===SS.trueScale));
      const c=STATE._pending&&STATE._pending.cams?STATE._pending.cams.ss:null;
      if(c) STATE.applyCam(SS.three,c);
      /* restore plotted deep-space targets sequentially */
      const pl=STATE._pending?STATE._pending.ephPlotted:null;
      if(pl&&pl.length&&!EPH.plotted.length){
        (async()=>{
          for(const p of pl){await EPH.select(p);}
          if(STATE._pending.ephActive) EPH.active=STATE._pending.ephActive;
          EPH.renderList();EPH.drawChart();
        })();
      }
    }
    if(EPH.activePlot()) setTimeout(()=>EPH.drawChart(),40);
  }
  if(v==='ca'&&!CA.inited){
    try{CA.init();}catch(e){console.warn('CA 3-D unavailable',e);CA.refresh&&CA.refresh();}
    const c=STATE._pending&&STATE._pending.cams?STATE._pending.cams.ca:null;
    if(c) STATE.applyCam(CA.three,c);
  }
  if(v==='disc'&&!DISC.inited){
    try{DISC.init();}catch(e){console.warn('Discovery 3-D unavailable',e);DISC.inited=true;}
    const c=STATE._pending&&STATE._pending.cams?STATE._pending.cams.sb:null;
    if(c) STATE.applyCam(DISC.three,c);
  }
  if(v==='tracker'&&SEL.length&&SEL[0].data){
    /* hidden canvases collapse to 0×0 — repaint static layers on return */
    setTimeout(()=>renderAllSel(),30);
  }
  }catch(err){
    console.error('[switchView:'+v+']',err);
    if(typeof reportRuntimeError==='function') reportRuntimeError('TAB '+v.toUpperCase()+' INIT: '+err.message,err);
  }
  STATE.dirty();
}

/* ════ WX STRIP COLLAPSE ════ */
let wxOpen=false;
function toggleWx(){
  wxOpen=!wxOpen;
  document.getElementById('wx-strip').classList.toggle('open',wxOpen);
  document.getElementById('wx-toggle-btn').textContent=wxOpen?'▾ COLLAPSE':'▸ EXPAND';
  STATE.dirty();
}

/* ════ V4 · BOOT — restore exact prior operating state ════ */
window.addEventListener('load',async()=>{
  try{
  SITE.tzOffsetMin=computeTZOffsetMin(SITE.tz);
  const saved=STATE.load();
  STATE._pending=saved;
  STATE._restoring=true;

  document.getElementById('load-msg').textContent='Initializing 3-D scenes…';
  setupResizers();
  initThreeScenes();
  EPOCH.bindHUD();
  masterLoop();
  loadWorldMap(()=>{});
  updateLocalTZLabel();
  setupGTClick();

  /* restore simple toggles before any propagation */
  if(saved){
    if(saved.horizonH) setHorizon(saved.horizonH);
    if(saved.skyVisOnly) toggleSkyVis();
    if(saved.wxOpen) toggleWx();
    if(saved.rate!==undefined&&saved.rate!==1) EPOCH.setRate(saved.rate);
    if(saved.minEl&&document.getElementById('eph-minel')) document.getElementById('eph-minel').value=saved.minEl;
    if(saved.catGroups&&saved.v>=5) CAT.GROUPS.forEach(g=>g.on=saved.catGroups.includes(g.id));
    if(saved.catFilter){CAT.filter=saved.catFilter;
      const fb=document.querySelector('#cat-filter-bar .cfb-btn.on');
      document.querySelectorAll('#cat-filter-bar .cfb-btn').forEach(b=>{
        const lbl={ALL:'ALL OBJECTS',ACTIVE:'ACTIVE SATS',DEBRIS:'DEBRIS ONLY',RB:'ROCKET BODIES'}[saved.catFilter];
        b.classList.toggle('on',b.textContent===lbl);
      });}
    if(saved.sandbox) DISC.sandbox=saved.sandbox;
    if(saved.cardSel!==undefined) DISC._cardSel=saved.cardSel;
    if(saved.ssScale!==undefined&&typeof SS!=='undefined') SS.trueScale=!!saved.ssScale;
    if(saved.cams){
      STATE.applyCam(eciThree,saved.cams.eci);
      STATE.applyCam(ecefThree,saved.cams.ecef);
    }
  }

  /* the page is usable now; the catalog streams in behind it */
  document.getElementById('loading-overlay').classList.add('hide');
  setTimeout(()=>{document.getElementById('loading-overlay').style.display='none';},500);
  document.getElementById('sat-list').innerHTML='<div class="loading-list">Loading Space Stations from CelesTrak…</div>';
  let raw=await fetchGroup('stations');
  allSats=raw?parseCatalog(raw):getFallbackSats();
  populateList(allSats);
  if(!raw) document.getElementById('sat-list').innerHTML=
    '<div class="loading-list">Could not reach CelesTrak.<br>Check the network and pick a group again.</div>';

  /* restore the ActiveSelection array (NORAD ids), else default to ISS */
  let restored=0;
  if(saved&&saved.sel&&saved.sel.length){
    saved.sel.forEach(sn=>{
      const tle=allSats.find(t=>t.satnum===sn);
      if(tle&&SEL.length<SEL_MAX&&!SEL.find(s=>s.tle.satnum===sn)){
        SEL.push({tle,color:SEL_COLORS[SEL.length]});restored++;
      }
    });
  }
  if(!restored){
    const iss=allSats.find(t=>t.satnum===25544)||allSats[0];
    if(iss) SEL.push({tle:iss,color:SEL_COLORS[0]});
  }
  if(SEL.length){renderAllSel();startTimers();}
  setTimeout(()=>fetchConditions(),1500);

  /* restore active tab last (lazily boots its module) */
  STATE._restoring=false;
  if(saved&&saved.view&&saved.view!=='tracker') switchView(saved.view);

  /* continuous cache: heartbeat save every 10 s + camera deltas */
  setInterval(()=>STATE.save(),10000);
  if(typeof SSA!=='undefined') SSA._booted();
  }catch(err){
    console.error('[boot]',err);
    if(typeof reportRuntimeError==='function') reportRuntimeError('BOOT FAILED: '+err.message,err);
    /* never strand the user behind the loading overlay */
    const ov=document.getElementById('loading-overlay');
    if(ov){ov.classList.add('hide');setTimeout(()=>ov.style.display='none',700);}
    if(typeof SSA!=='undefined') SSA._booted(err);
  }
});
