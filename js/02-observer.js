const EPOCH={
  rate:1,_simMs:Date.now(),_lastP:null,_preRate:1,_scrubbing:false,
  tick(nowP){ /* called once per masterLoop frame */
    if(this._lastP===null) this._lastP=nowP;
    this._simMs+=(nowP-this._lastP)*this.rate;
    this._lastP=nowP;
    if(nowP-(this._hudT||0)>200){this._hudT=nowP;this.renderHUD();}
  },
  ms(){return this._simMs;},
  now(){return new Date(this._simMs);},
  jd(){return jdms(this._simMs);},
  offsetMs(){return this._simMs-Date.now();},
  isLive(){return Math.abs(this.offsetMs())<2500&&this.rate===1;},
  setRate(r,btn){
    this.rate=r;
    document.querySelectorAll('.ep-rate').forEach(b=>b.classList.remove('on'));
    if(btn) btn.classList.add('on');
    else{const b=document.querySelector('.ep-rate[data-r="'+r+'"]');if(b)b.classList.add('on');}
    const pb=document.getElementById('ep-pause');
    if(pb){pb.textContent=r===0?'▶':'⏸';pb.classList.toggle('on',r===0);}
    if(typeof STATE!=='undefined') STATE.dirty();
  },
  togglePause(){
    if(this.rate===0){this.setRate(this._preRate||1);}
    else{this._preRate=this.rate;this.setRate(0);}
  },
  scrub(deltaMs){this._simMs+=deltaMs;},
  setOffset(ms){this._simMs=Date.now()+ms;},
  live(){this._simMs=Date.now();this.setRate(1);},
  renderHUD(){
    const el=document.getElementById('ep-clock');if(!el)return;
    const d=this.now();
    el.textContent=d.toISOString().slice(0,19).replace('T',' ')+' UTC';
    const off=this.offsetMs()/1000;
    const offEl=document.getElementById('ep-offset');
    const live=this.isLive();
    offEl.textContent=live?'● LIVE':(off>=0?'+':'−')+fmtHMS(Math.abs(off))+(this.rate!==1?' · '+(this.rate===0?'PAUSED':this.rate+'×'):'');
    offEl.className=live?'live':'off';
    document.getElementById('ep-dot').className='ep-dot'+(live?' live':'');
    const sl=document.getElementById('ep-scrub');
    if(sl&&!this._scrubbing){
      sl.value=Math.max(-48,Math.min(96,this.offsetMs()/3600000));
    }
    const lc=document.getElementById('ep-local');
    if(lc) lc.textContent=fmtLocalTime(d,SITE.tz)+' LOC';
  },
  bindHUD(){
    const sl=document.getElementById('ep-scrub');
    sl.addEventListener('pointerdown',()=>this._scrubbing=true);
    sl.addEventListener('pointerup',()=>this._scrubbing=false);
    sl.addEventListener('input',()=>{this.setOffset(parseFloat(sl.value)*3600000);});
  }
};

/* ════ V2 · ASTRO EXTENSIONS — azimuthal alt/az, solar vector, Earth shadow ════ */
const D2R=Math.PI/180, R2D=180/Math.PI;
function jdms(ms){return ms/86400000+2440587.5;}
function gmstDegAt(d){return ((280.46061837+360.98564736629*(jdms(d.getTime())-2451545))%360+360)%360;}

/* Equatorial (ra,dec radians) → topocentric alt/az in degrees. Az from North, clockwise. */
function eqToAltAz(ra,dec,d,latDeg,lonDeg){
  let lst=(gmstDegAt(d)+lonDeg)*D2R;
  let H=lst-ra;
  let lat=latDeg*D2R;
  let sinAlt=Math.sin(dec)*Math.sin(lat)+Math.cos(dec)*Math.cos(lat)*Math.cos(H);
  let alt=Math.asin(Math.max(-1,Math.min(1,sinAlt)))*R2D;
  let az=Math.atan2(Math.sin(H),Math.cos(H)*Math.sin(lat)-Math.tan(dec)*Math.cos(lat))*R2D; // from South, westward
  az=(az+180)%360; if(az<0)az+=360;
  return{alt,az};
}
/* Geocentric solar unit vector in true-of-date equatorial frame (≈TEME, <0.01° offset) */
function sunECIUnit(d){
  let s=sunPos(d);
  return[Math.cos(s.dec)*Math.cos(s.ra),Math.cos(s.dec)*Math.sin(s.ra),Math.sin(s.dec)];
}
/* Cylindrical Earth-shadow model (Vallado §5.3): eclipsed iff the satellite is on
   the anti-Sun side of Earth AND within one Earth radius of the shadow axis. */
function isSunlit(r,su){
  let s=r[0]*su[0]+r[1]*su[1]+r[2]*su[2];
  if(s>=0) return true;
  return (r[0]*r[0]+r[1]*r[1]+r[2]*r[2]-s*s) > RE_KM*RE_KM;
}

/* ════ V2 · PROPAGATOR — adaptive SGP4 sampling + per-sample illumination state ════ */
/* ── SatelliteService · SGP4 propagation over a configurable horizon ──
   durS: forecast depth in seconds (granular time-horizon control);
   anchor: epoch to propagate from (defaults to the global sim clock). */
function propagate(tle,durS,anchor){
  let now=anchor||new Date(typeof EPOCH!=='undefined'?EPOCH.ms()-300000:Date.now());
  let GMST0=gmst_from_jd(julianDate(now));
  let siteECEF=geo2ecef(SITE.lat_deg,SITE.lon_deg,SITE.h_m);
  let Re2enu=topoRotm(SITE.lat_deg,SITE.lon_deg);

  /* adaptive time array (unchanged physics: dense at perigee, sparse at apogee) */
  let tEnd=durS?Math.max(durS,0.25*tle.T_s):NUM_REVS*tle.T_s;
  let times=[]; let t=0;
  if(tle.satrec){
    let coarseStep=Math.max(30,tle.T_s/120);
    let altProfile=[]; let tc=0;
    while(tc<=tEnd){
      let d=new Date(now.getTime()+tc*1000);
      let pv=sgp4ECI(tle.satrec,d);
      let altEst=pv?Math.sqrt(pv.r[0]**2+pv.r[1]**2+pv.r[2]**2)-RE_KM:tle.alt_km;
      altProfile.push({tc,alt:Math.max(100,altEst)});
      tc+=coarseStep;
    }
    let pi=0;
    while(t<=tEnd+1){
      times.push(t);
      while(pi<altProfile.length-2&&altProfile[pi+1].tc<t) pi++;
      let alt=altProfile[pi].alt;
      if(pi+1<altProfile.length){
        let frac=(t-altProfile[pi].tc)/(altProfile[pi+1].tc-altProfile[pi].tc+1e-9);
        alt=altProfile[pi].alt+(altProfile[pi+1].alt-altProfile[pi].alt)*frac;
      }
      t+=adaptiveStep(Math.max(100,alt),tle.T_s);
    }
  } else {
    while(t<=tEnd){times.push(t);t+=adaptiveStep(tle.alt_km,tle.T_s);}
  }

  let N=times.length-1;
  let tArr=new Float64Array(N+1);
  let xECI_=new Float64Array((N+1)*3), xECEF_=new Float64Array((N+1)*3);
  let lat_=new Float64Array(N+1),lon_=new Float64Array(N+1);
  let az_=new Float64Array(N+1),el_=new Float64Array(N+1);
  let sunlit_=new Uint8Array(N+1), sunAlt_=new Float32Array(N+1);

  /* two-body fallback initial state */
  let x_tb=null;
  if(!tle.satrec){
    let dt_ep=(now.getTime()-tle.epoch.getTime())/1000;
    let M_now=((tle.M*Math.PI/180+tle.n_rad*dt_ep)%(2*Math.PI)+2*Math.PI)%(2*Math.PI);
    let e=tle.ecc,a=tle.a,inc_r=tle.inc*Math.PI/180;
    let RAAN=tle.raan*Math.PI/180,argp=tle.argp*Math.PI/180;
    let nu=trueFromMean(M_now,e);
    let p_=a*(1-e*e),r_=p_/(1+e*Math.cos(nu));
    let C=dcmPQW2ECI(RAAN,inc_r,argp);
    let sqp=Math.sqrt(MU_E/p_);
    let rECI=mv3(C,[r_*Math.cos(nu),r_*Math.sin(nu),0]);
    let vECI=mv3(C,[-sqp*Math.sin(nu),sqp*(e+Math.cos(nu)),0]);
    x_tb=[rECI[0],rECI[1],rECI[2],vECI[0],vECI[1],vECI[2]];
  }

  /* solar state cache — Sun moves 0.04°/min; refresh every 60 s of track time */
  let sunU=null,sunAltCache=0,sunCacheT=-1e9;

  for(let k=0;k<=N;k++){
    let t=times[k]; tArr[k]=t;
    let sd=new Date(now.getTime()+t*1000);
    let rx,ry,rz;
    if(tle.satrec){
      let pv=sgp4ECI(tle.satrec,sd);
      if(pv){rx=pv.r[0];ry=pv.r[1];rz=pv.r[2];}
      else{rx=NaN;ry=NaN;rz=NaN;}   /* SGP4 failure (decay etc.): leave a gap, never a fake point */
    } else {
      rx=x_tb[0];ry=x_tb[1];rz=x_tb[2];
      if(k<N){let dt=times[k+1]-times[k];x_tb=rk4(x_tb,dt);}
    }
    xECI_[3*k]=rx;xECI_[3*k+1]=ry;xECI_[3*k+2]=rz;

    if(t-sunCacheT>=60||k===0){
      let sp=sunPos(sd);
      sunU=[Math.cos(sp.dec)*Math.cos(sp.ra),Math.cos(sp.dec)*Math.sin(sp.ra),Math.sin(sp.dec)];
      sunAltCache=eqToAltAz(sp.ra,sp.dec,sd,SITE.lat_deg,SITE.lon_deg).alt;
      sunCacheT=t;
    }
    sunlit_[k]=isSunlit([rx,ry,rz],sunU)?1:0;
    sunAlt_[k]=sunAltCache;

    let th=GMST0+WE*t,ct=Math.cos(th),st=Math.sin(th);
    let fx=ct*rx+st*ry,fy=-st*rx+ct*ry,fz=rz;
    xECEF_[3*k]=fx;xECEF_[3*k+1]=fy;xECEF_[3*k+2]=fz;
    lon_[k]=((Math.atan2(fy,fx)*180/Math.PI+540)%360)-180;
    lat_[k]=Math.atan2(fz,Math.sqrt(fx*fx+fy*fy))*180/Math.PI;
    let rho=[fx-siteECEF[0],fy-siteECEF[1],fz-siteECEF[2]];
    let enu=mv3(Re2enu,rho);
    let E_=enu[0],N__=enu[1],U_=enu[2],rng=Math.sqrt(E_*E_+N__*N__+U_*U_);
    az_[k]=((Math.atan2(E_,N__)*180/Math.PI)%360+360)%360;
    el_[k]=Math.asin(Math.max(-1,Math.min(1,U_/rng)))*180/Math.PI;
  }
  return{tArr,xECI:xECI_,xECEF:xECEF_,lat:lat_,lon:lon_,az:az_,el:el_,sunlit:sunlit_,sunAlt:sunAlt_,N,now,GMST0};
}

/* ════ V2 · PASSES — geometric passes + true-visibility classification ════
   A sample is VISIBLE when: elevation > 5°, the satellite is sunlit (cylindrical
   shadow model) AND the site Sun altitude < −6° (civil darkness or darker). */
const VIS_EL_MIN=5, VIS_SUN_MAX=-6;
function findPasses(az,el,t,sunlit,sunAlt){
  let N=t.length,passes=[];
  let i=0;
  while(i<N){
    if(el[i]>=0){
      let i0=i;while(i<N&&el[i]>=0) i++;let i1=i-1;
      let t_rise=t[i0];
      if(i0>0){let d=el[i0]-el[i0-1];if(Math.abs(d)>1e-12)t_rise=t[i0-1]+(0-el[i0-1])*(t[i0]-t[i0-1])/d;}
      let t_set=t[i1];
      if(i1<N-1){let d=el[i1+1]-el[i1];if(Math.abs(d)>1e-12)t_set=t[i1]+(0-el[i1])*(t[i1+1]-t[i1])/d;}
      let elpk=-Infinity,ipk=i0;
      for(let j=i0;j<=i1;j++) if(el[j]>elpk){elpk=el[j];ipk=j;}
      let p={i0,i1,t_rise,t_set,t_peak:t[ipk],el_peak:elpk,az_rise:az[i0],az_set:az[i1],az_peak:az[ipk]};
      /* visibility scan */
      if(sunlit&&sunAlt){
        let v0=-1,v1=-1,vPk=-1,vPkEl=-Infinity;
        for(let j=i0;j<=i1;j++){
          if(el[j]>VIS_EL_MIN&&sunlit[j]&&sunAlt[j]<VIS_SUN_MAX){
            if(v0<0)v0=j; v1=j;
            if(el[j]>vPkEl){vPkEl=el[j];vPk=j;}
          }
        }
        p.visible=v0>=0;
        if(p.visible){p.t_vis0=t[v0];p.t_vis1=t[v1];p.el_visPeak=vPkEl;p.t_visPeak=t[vPk];}
        p.why=p.visible?'VIS':(sunAlt[ipk]>=VIS_SUN_MAX?'DAY':'ECL');
      } else {p.visible=false;p.why='—';}
      passes.push(p);
    } else i++;
  }
  return passes;
}

/* ════ V2 · DEEP SEARCH — first truly visible window in the next 48 h ════ */
function findNextVisible(tle,hours=48){
  if(!tle.satrec) return null;
  let now=EPOCH.now();
  let siteECEF=geo2ecef(SITE.lat_deg,SITE.lon_deg,SITE.h_m);
  let Re2enu=topoRotm(SITE.lat_deg,SITE.lon_deg);
  let step=tle.T_s>20000?120:45;
  let sunU=null,sunAlt=0,sunT=-1e9;
  let inWin=false,win=null;
  for(let t=0;t<=hours*3600;t+=step){
    let d=new Date(now.getTime()+t*1000);
    if(t-sunT>=120){
      let sp=sunPos(d);
      sunU=[Math.cos(sp.dec)*Math.cos(sp.ra),Math.cos(sp.dec)*Math.sin(sp.ra),Math.sin(sp.dec)];
      sunAlt=eqToAltAz(sp.ra,sp.dec,d,SITE.lat_deg,SITE.lon_deg).alt;
      sunT=t;
    }
    let ok=false,elv=-90;
    if(sunAlt<VIS_SUN_MAX){ /* only bother with geometry if the sky is dark */
      let pv=sgp4ECI(tle.satrec,d);
      if(pv){
        let GM=gmst_from_jd(julianDate(d)),ct=Math.cos(GM),st=Math.sin(GM);
        let fx=ct*pv.r[0]+st*pv.r[1],fy=-st*pv.r[0]+ct*pv.r[1],fz=pv.r[2];
        let rho=[fx-siteECEF[0],fy-siteECEF[1],fz-siteECEF[2]];
        let enu=mv3(Re2enu,rho);
        let rng=Math.sqrt(enu[0]**2+enu[1]**2+enu[2]**2);
        elv=Math.asin(Math.max(-1,Math.min(1,enu[2]/rng)))*R2D;
        ok=elv>VIS_EL_MIN&&isSunlit(pv.r,sunU);
      }
    }
    if(ok&&!inWin){inWin=true;win={t0:t,t1:t,elPk:elv,tPk:t};}
    else if(ok){win.t1=t;if(elv>win.elPk){win.elPk=elv;win.tPk=t;}}
    else if(inWin){win.t1=t;return win;}
  }
  return inWin?win:null;
}

/* ════ V3 · THREE.JS FOUNDATION ════
   · realistic Earth (NASA blue-marble) with multi-CDN fallback chain
   · Milky-Way panoramic sky sphere (with procedural star fallback)
   · physically-placed Sun light: one key light aligned with the true solar
     vector at the scene's epoch + soft space-ambient (no fake fill lights) */
let eciThree=null,ecefThree=null;

/* ---- texture loader with fallback chain ---- */
function loadTexChain(urls,onOK,onFail){
  let i=0;
  const tryNext=()=>{
    if(i>=urls.length){if(onFail)onFail();return;}
    const u=urls[i++];
    const ld=new THREE.TextureLoader();
    ld.setCrossOrigin('anonymous');
    ld.load(u,t=>onOK(t),undefined,()=>tryNext());
  };
  tryNext();
}
let earthTexC=null,skyTexC=null;
function loadEarthDay(cb){
  if(earthTexC){cb(earthTexC);return;}
  loadTexChain([
    'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg',
    'https://raw.githubusercontent.com/vasturiano/three-globe/master/example/img/earth-blue-marble.jpg',
    'https://raw.githubusercontent.com/turban/webgl-earth/master/images/2_no_clouds_4k.jpg'
  ],t=>{earthTexC=t;cb(t);},
  ()=>{ /* procedural fallback WITH visible continents + grid so rotation is always visible */
    const cv=document.createElement('canvas');cv.width=2048;cv.height=1024;
    const cx=cv.getContext('2d');
    const g=cx.createLinearGradient(0,0,0,1024);
    g.addColorStop(0,'#1d1d1d');g.addColorStop(.5,'#262626');g.addColorStop(1,'#1d1d1d');
    cx.fillStyle=g;cx.fillRect(0,0,2048,1024);
    cx.fillStyle='#494949';
    [[400,320,160,200,-.3],[480,640,100,160,.2],[1020,280,80,100,0],[1020,560,120,180,0],[1360,320,280,180,.1],[1560,680,100,70,0],[260,180,90,60,.4]].forEach(([x,y,rx,ry,r])=>{
      cx.save();cx.translate(x,y);cx.rotate(r);cx.beginPath();cx.ellipse(0,0,rx,ry,0,0,2*Math.PI);cx.fill();cx.restore();
    });
    cx.fillStyle='#e0e0e0';cx.fillRect(0,0,2048,52);cx.fillRect(0,972,2048,52);
    cx.strokeStyle='rgba(209,209,209,0.10)';cx.lineWidth=1;
    for(let x=0;x<=2048;x+=170){cx.beginPath();cx.moveTo(x,0);cx.lineTo(x,1024);cx.stroke();}
    for(let y=0;y<=1024;y+=170){cx.beginPath();cx.moveTo(0,y);cx.lineTo(2048,y);cx.stroke();}
    earthTexC=new THREE.CanvasTexture(cv);cb(earthTexC);
  });
}
function loadSkyTex(cb,onFail){
  if(skyTexC){cb(skyTexC);return;}
  loadTexChain([
    'https://unpkg.com/three-globe@2.31.0/example/img/night-sky.png',
    'https://raw.githubusercontent.com/vasturiano/three-globe/master/example/img/night-sky.png'
  ],t=>{skyTexC=t;cb(t);},onFail);
}
/* keep the legacy entry point used elsewhere */
function loadEarthTex(cb){loadEarthDay(cb);}

/* ---- shared damped inertial orbit controls ---- */
function makeOrbitCtrl(dom,camera,opts={}){
  const rad0=opts.rad||1000;
  const ctrl={theta:opts.theta??0.82,phi:opts.phi??1.08,rad:rad0,
              tTheta:opts.theta??0.82,tPhi:opts.phi??1.08,tRad:rad0,
              vT:0,vP:0,down:false,
              target:new THREE.Vector3(0,0,0),tTarget:new THREE.Vector3(0,0,0),
              minR:opts.minR||rad0*0.05,maxR:opts.maxR||rad0*30};
  function applyCam(){
    camera.position.set(ctrl.target.x+ctrl.rad*Math.sin(ctrl.phi)*Math.sin(ctrl.theta),
                        ctrl.target.y+ctrl.rad*Math.cos(ctrl.phi),
                        ctrl.target.z+ctrl.rad*Math.sin(ctrl.phi)*Math.cos(ctrl.theta));
    camera.lookAt(ctrl.target);
  }
  ctrl.setTarget=function(v,rad){ctrl.tTarget.copy(v);if(rad!==undefined)ctrl.tRad=Math.max(ctrl.minR,Math.min(ctrl.maxR,rad));};
  ctrl.clearTarget=function(){ctrl.tTarget.set(0,0,0);};
  ctrl.home={theta:ctrl.theta,phi:ctrl.phi,rad:rad0};
  ctrl.reset=function(){ctrl.tRad=ctrl.home.rad;ctrl.tTheta=ctrl.home.theta;ctrl.tPhi=ctrl.home.phi;ctrl.tTarget.set(0,0,0);ctrl.vT=0;ctrl.vP=0;};
  applyCam();
  dom.style.touchAction='none';dom.style.cursor='grab';
  let px=0,py=0;
  dom.addEventListener('pointerdown',e=>{ctrl.down=true;px=e.clientX;py=e.clientY;ctrl.vT=0;ctrl.vP=0;dom.style.cursor='grabbing';try{dom.setPointerCapture(e.pointerId);}catch(_){}});
  dom.addEventListener('pointerup',()=>{ctrl.down=false;dom.style.cursor='grab';});
  dom.addEventListener('pointercancel',()=>ctrl.down=false);
  dom.addEventListener('pointermove',e=>{
    if(!ctrl.down)return;
    const dx=e.clientX-px,dy=e.clientY-py;px=e.clientX;py=e.clientY;
    const k=0.0052*Math.min(1.6,ctrl.rad/(rad0*0.8));
    ctrl.tTheta-=dx*k;ctrl.tPhi-=dy*k;
    ctrl.vT=-dx*k;ctrl.vP=-dy*k;
    ctrl.tPhi=Math.max(.04,Math.min(Math.PI-.04,ctrl.tPhi));
  });
  dom.addEventListener('wheel',e=>{
    e.preventDefault();
    ctrl.tRad=Math.max(ctrl.minR,Math.min(ctrl.maxR,ctrl.tRad*Math.exp(e.deltaY*.0012)));
  },{passive:false});
  dom.addEventListener('dblclick',()=>{ctrl.tRad=rad0;ctrl.tTheta=opts.theta??0.82;ctrl.tPhi=opts.phi??1.08;ctrl.tTarget.set(0,0,0);});
  ctrl.update=function(dt){
    if(!ctrl.down&&(Math.abs(ctrl.vT)>1e-5||Math.abs(ctrl.vP)>1e-5)){
      ctrl.tTheta+=ctrl.vT;ctrl.tPhi+=ctrl.vP;
      ctrl.tPhi=Math.max(.04,Math.min(Math.PI-.04,ctrl.tPhi));
      ctrl.vT*=0.93;ctrl.vP*=0.93;
    }
    const a=1-Math.exp(-dt*11);
    ctrl.theta+=(ctrl.tTheta-ctrl.theta)*a;
    ctrl.phi+=(ctrl.tPhi-ctrl.phi)*a;
    ctrl.rad+=(ctrl.tRad-ctrl.rad)*(1-Math.exp(-dt*9));
    ctrl.target.lerp(ctrl.tTarget,1-Math.exp(-dt*7));
    applyCam();
  };
  return ctrl;
}

/* ---- shared anti-aliased round marker texture (for Points/Sprites) ---- */
let _roundTexCache=null;
function roundDotTex(){
  if(_roundTexCache) return _roundTexCache;
  const cv=document.createElement('canvas');cv.width=cv.height=64;
  const cx=cv.getContext('2d');
  const g=cx.createRadialGradient(32,32,4,32,32,30);
  g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(0.55,'rgba(255,255,255,0.95)');
  g.addColorStop(0.85,'rgba(255,255,255,0.35)');g.addColorStop(1,'rgba(255,255,255,0)');
  cx.fillStyle=g;cx.beginPath();cx.arc(32,32,30,0,2*Math.PI);cx.fill();
  _roundTexCache=new THREE.CanvasTexture(cv);
  return _roundTexCache;
}

/* ---- Earth scene factory ---- */
function initThree3D(cid,opts={}){
  const container=document.getElementById(cid);
  const W=container.clientWidth||400,H=container.clientHeight||300;
  const renderer=new THREE.WebGLRenderer({antialias:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  renderer.setSize(W,H);renderer.setClearColor(0x010101,1);
  container.appendChild(renderer.domElement);

  const scene=new THREE.Scene();
  /* lighting: one true Sun + dim space ambient (Earthshine/starlight) */
  const sunLight=new THREE.DirectionalLight(0xe0e0e0,1.75);
  sunLight.position.set(1.5e5,0,0);scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x414141,0.85));

  /* Milky-Way sky sphere; procedural points as fallback */
  let starPts=null;
  {
    const sv=[];
    for(let i=0;i<1800;i++){const th=Math.random()*2*Math.PI,ph=Math.acos(2*Math.random()-1),r=RE_KM*58;
      sv.push(r*Math.sin(ph)*Math.cos(th),r*Math.cos(ph),r*Math.sin(ph)*Math.sin(th));}
    const sg=new THREE.BufferGeometry();sg.setAttribute('position',new THREE.Float32BufferAttribute(sv,3));
    starPts=new THREE.Points(sg,new THREE.PointsMaterial({color:0xe0e0e0,size:22,transparent:true,opacity:.45,sizeAttenuation:true}));
    scene.add(starPts);
  }
  loadSkyTex(tex=>{
    const sky=new THREE.Mesh(new THREE.SphereGeometry(RE_KM*62,40,24),
      new THREE.MeshBasicMaterial({map:tex,side:THREE.BackSide,depthWrite:false}));
    sky.rotation.x=0.41; /* tilt galactic band off the equator */
    scene.add(sky);
    if(starPts) starPts.visible=false;
  },()=>{});

  const atmo=new THREE.Mesh(new THREE.SphereGeometry(RE_KM*1.015,48,48),
    new THREE.MeshPhongMaterial({color:0x898989,transparent:true,opacity:.07,side:THREE.BackSide,depthWrite:false}));
  scene.add(atmo);

  const earthMat=new THREE.MeshPhongMaterial({color:0x393939,specular:new THREE.Color(0x171717),shininess:9});
  /* Axis mapping (RH): X_three=x_orb, Y_three=z_orb (north up), Z_three=-y_orb.
     SphereGeometry UV puts Greenwich at -Z_three at rotation.y=0.
     ECI: rotation.y=+GMST rotates Greenwich eastward (correct sense). */
  const earthMesh=new THREE.Mesh(new THREE.SphereGeometry(RE_KM,72,72),earthMat);
  earthMesh.name='earth';scene.add(earthMesh);
  loadEarthDay(tex=>{earthMat.map=tex;earthMat.color.set(0xffffff);earthMat.needsUpdate=true;});

  if(opts.axes!==false){
    [[0xd66e6e,[2.2*RE_KM,0,0]],[0x7fbf98,[0,2.2*RE_KM,0]],[0x9a9a9a,[0,0,-2.2*RE_KM]]].forEach(([c,to])=>{
      const g=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0),new THREE.Vector3(...to)]);
      scene.add(new THREE.Line(g,new THREE.LineBasicMaterial({color:c,transparent:true,opacity:.16})));
    });
  }

  const camera=new THREE.PerspectiveCamera(45,W/H,50,2e7);
  const ctrl=makeOrbitCtrl(renderer.domElement,camera,{rad:opts.rad||RE_KM*3.6,minR:RE_KM*1.05,maxR:RE_KM*80});

  new ResizeObserver(()=>{requestAnimationFrame(()=>{const w=container.clientWidth,h=container.clientHeight;
    if(w&&h){renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}});}).observe(container);

  /* su = solar unit vector in this scene's working frame (orbital axes) */
  const api={renderer,scene,camera,earthMesh,ctrl,container,sunLight,
    setSun(su){sunLight.position.set(su[0]*1.5e5,su[2]*1.5e5,-su[1]*1.5e5);}};
  return api;
}

/* WebGL can be unavailable (remote desktops, blocked GPU drivers). The 3-D
   panels then show a note and everything else keeps working. */
let WEBGL_OK=true;
function initThreeScenes(){
  try{
    if(!eciThree)  eciThree =initThree3D('eci-container');
    if(!ecefThree) ecefThree=initThree3D('ecef-container');
  }catch(e){
    WEBGL_OK=false;eciThree=null;ecefThree=null;
    ['eci-container','ecef-container'].forEach(id=>{const c=document.getElementById(id);
      if(c) c.innerHTML='<div class="no-webgl">3-D view unavailable: this browser could not create a WebGL context.</div>';});
  }
}

function clearOrbit3D(scene,tag){
  ['orbit','orbitDots','satMarker','satRing'].forEach(n=>{const o=scene.getObjectByName(n+(tag||''));if(o)scene.remove(o);});
}
function drawOrbit3D(scene,pts,color,tag,mkColor){
  tag=tag||'';mkColor=mkColor??0xe0e0e0;
  clearOrbit3D(scene,tag);
  if(pts.length<2) return;
  const v3pts=pts.map(p=>new THREE.Vector3(p[0],p[2],-p[1]));
  const curve=new THREE.CatmullRomCurve3(v3pts,false,'chordal');
  const segments=Math.min(v3pts.length*2,1200);
  const tube=new THREE.Mesh(new THREE.TubeGeometry(curve,segments,48,8,false),
    new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide,transparent:true,opacity:0.9}));
  tube.name='orbit'+tag;scene.add(tube);
  const p=pts[0];
  const mk=new THREE.Mesh(new THREE.SphereGeometry(150,20,20),new THREE.MeshBasicMaterial({color:mkColor}));
  mk.position.set(p[0],p[2],-p[1]);mk.name='satMarker'+tag;scene.add(mk);
  const ring=new THREE.Mesh(new THREE.TorusGeometry(290,36,10,36),
    new THREE.MeshBasicMaterial({color:mkColor,transparent:true,opacity:.32}));
  ring.position.copy(mk.position);ring.lookAt(0,0,0);ring.name='satRing'+tag;scene.add(ring);
}

/* ════ DAY/NIGHT TERMINATOR + SUN/MOON SUBPOINTS (equirectangular map) ════
   Terminator from sin h = sinφ sinδ + cosφ cosδ cos H = 0 → tanφ = −cos H / tan δ. */
function drawTerminator(ctx,W,H,d){
  const sp=sunPos(d);
  const gm=gmstDegAt(d);
  const tanDec=Math.tan(sp.dec);
  ctx.fillStyle='rgba(2,2,2,0.45)';
  ctx.beginPath();
  let first=true;
  for(let x=0;x<=W;x+=3){
    const lon=(x/W)*360-180;
    const Hh=(gm+lon)*D2R-sp.ra;
    let phi;
    if(Math.abs(tanDec)<1e-4) phi=(-Math.cos(Hh)>=0?90:-90);
    else phi=Math.atan(-Math.cos(Hh)/tanDec)*R2D;
    const y=((90-phi)/180)*H;
    if(first){ctx.moveTo(x,y);first=false;} else ctx.lineTo(x,y);
  }
  if(sp.dec>=0){ctx.lineTo(W,H);ctx.lineTo(0,H);}
  else        {ctx.lineTo(W,0);ctx.lineTo(0,0);}
  ctx.closePath();ctx.fill();

  const toXY=(la,lo)=>({x:((lo+180)/360)*W,y:((90-la)/180)*H});
  const sLon=((sp.ra*R2D-gm+540)%360)-180, sLat=sp.dec*R2D;
  const s=toXY(sLat,sLon);
  ctx.strokeStyle='rgba(224,224,224,.9)';ctx.lineWidth=1;
  for(let i=0;i<8;i++){const a=i*Math.PI/4;
    ctx.beginPath();ctx.moveTo(s.x+Math.cos(a)*5,s.y+Math.sin(a)*5);ctx.lineTo(s.x+Math.cos(a)*9,s.y+Math.sin(a)*9);ctx.stroke();}
  ctx.fillStyle='#e0e0e0';ctx.beginPath();ctx.arc(s.x,s.y,4,0,2*Math.PI);ctx.fill();
  ctx.fillStyle='rgba(224,224,224,.85)';ctx.font='bold 10px IBM Plex Mono';ctx.fillText('SUN',s.x+11,s.y+3);
  const mp=moonPos(d);
  const mLon=((mp.ra*R2D-gm+540)%360)-180, mLat=mp.dec*R2D;
  const m=toXY(mLat,mLon);
  ctx.fillStyle='#e0e0e0';ctx.beginPath();ctx.arc(m.x,m.y,3.5,0,2*Math.PI);ctx.fill();
  ctx.fillStyle='rgba(4,4,4,.85)';ctx.beginPath();ctx.arc(m.x-2.4*(1-mp.phase),m.y,3.1,0,2*Math.PI);ctx.fill();
  ctx.fillStyle='rgba(224,224,224,.85)';ctx.font='bold 10px IBM Plex Mono';ctx.fillText('MOON',m.x+8,m.y+3);
}

/* ════ LIVE LAYERS — 60 fps markers, throttled canvas repaints ════ */
let _gtLast=0,_skyLast=0,_metaLast=0,_sunLast=0;
function cloneCanvas(c){const o=document.createElement('canvas');o.width=c.width;o.height=c.height;o.getContext('2d').drawImage(c,0,0);return o;}

let _repropLast=0;
let _pbIdle=0;
function updateNowMarker(nowP){
  if(!SEL.length){if(nowP-_pbIdle>500){_pbIdle=nowP;renderPassBoard();}return;}
  const simMs=EPOCH.ms();
  /* epoch scrubbed/run beyond the propagated window → regenerate trajectories */
  const D0=SEL[0].data;
  if(D0){
    const e0=(simMs-D0.now.getTime())/1000;
    if((e0<0||e0>D0.tArr[D0.N])&&nowP-_repropLast>3000){
      _repropLast=nowP;
      setTimeout(()=>renderAllSel(),10);
    }
  }
  window._liveSel=[];
  SEL.forEach((s,si)=>{
    const D=s.data;if(!D) return;
    const{tArr,xECI,xECEF,lat,lon,az,el,N}=D;
    const elapsed=(simMs-D.now.getTime())/1000;
    if(elapsed<0||elapsed>tArr[N]) return;
    let lo=0,hi=N;
    while(lo<hi-1){const mid=(lo+hi)>>1;if(tArr[mid]<=elapsed)lo=mid;else hi=mid;}
    const span=tArr[lo+1]-tArr[lo];
    const a=span>0?Math.max(0,Math.min(1,(elapsed-tArr[lo])/span)):0;
    const L=(p,q)=>p+(q-p)*a;
    const ex=L(xECI[3*lo],xECI[3*lo+3]),ey=L(xECI[3*lo+1],xECI[3*lo+4]),ez=L(xECI[3*lo+2],xECI[3*lo+5]);
    const fx=L(xECEF[3*lo],xECEF[3*lo+3]),fy=L(xECEF[3*lo+1],xECEF[3*lo+4]),fz=L(xECEF[3*lo+2],xECEF[3*lo+5]);
    if(!isFinite(ex)||!isFinite(fx)) return;
    const cur={si,color:s.color,tle:s.tle,
      lat:L(lat[lo],lat[lo+1]),lon:L(lon[lo],lon[lo+1]),
      az:L(az[lo],az[lo+1]),el:L(el[lo],el[lo+1]),
      eci:[ex,ey,ez],elapsed};
    window._liveSel.push(cur);
    const tag='-'+si;
    if(eciThree){
      const mk=eciThree.scene.getObjectByName('satMarker'+tag),rg=eciThree.scene.getObjectByName('satRing'+tag);
      if(mk)mk.position.set(ex,ez,-ey);
      if(rg){rg.position.set(ex,ez,-ey);rg.lookAt(0,0,0);}
    }
    if(ecefThree){
      const mk=ecefThree.scene.getObjectByName('satMarker'+tag),rg=ecefThree.scene.getObjectByName('satRing'+tag);
      if(mk)mk.position.set(fx,fz,-fy);
      if(rg){rg.position.set(fx,fz,-fy);rg.lookAt(0,0,0);}
    }
  });
  if(nowP-_gtLast>140){_gtLast=nowP;repaintGroundLive();}
  if(nowP-_skyLast>220){_skyLast=nowP;repaintSkyLive();}
  if(nowP-_metaLast>500){
    _metaLast=nowP;
    renderPassBoard();
    const p0=(window._liveSel||[]).find(s=>s.si===0);
    if(p0) updateLiveMeta(p0.eci[0],p0.eci[1],p0.eci[2],p0.el,p0.elapsed);
  }
}

function repaintGroundLive(){
  const gtC=document.getElementById('gt-canvas');
  if(!gtC||!gtC.width||!gtC._bg) return;
  if(gtC._bg.width!==gtC.width||gtC._bg.height!==gtC.height){redrawStatic2D();return;}
  const ctx=gtC.getContext('2d'),W=gtC.width,H=gtC.height;
  ctx.drawImage(gtC._bg,0,0);
  drawTerminator(ctx,W,H,EPOCH.now());
  (window._liveSel||[]).forEach(s=>{
    /* true line-of-sight geometric sensor footprint per tracked object */
    ctx.strokeStyle=s.color+'66';ctx.lineWidth=1;ctx.setLineDash([4,4]);
    footprintCircle(s.lat,s.lon,s.tle.alt_km,ctx,W,H);
    ctx.stroke();ctx.setLineDash([]);
    if(s.si===0){
      ctx.fillStyle=s.color+'10';
      footprintCircle(s.lat,s.lon,s.tle.alt_km,ctx,W,H);
      ctx.fill();
    }
    const nx=((s.lon+180)/360)*W, ny=((90-s.lat)/180)*H;
    ctx.strokeStyle=s.color+'90';ctx.lineWidth=1.3;
    ctx.beginPath();ctx.arc(nx,ny,s.si===0?13:9,0,2*Math.PI);ctx.stroke();
    ctx.fillStyle=s.color;ctx.beginPath();ctx.arc(nx,ny,s.si===0?5:3.5,0,2*Math.PI);ctx.fill();
    ctx.fillStyle=s.color;ctx.font='bold 10px IBM Plex Mono';
    ctx.fillText(s.si===0?'NOW':s.tle.name.slice(0,10),nx+9,ny-4);
  });
}

function repaintSkyLive(){
  const c=document.getElementById('sky-canvas');
  if(!c||!c.width||!c._bg) return;
  if(c._bg.width!==c.width||c._bg.height!==c.height){redrawStatic2D();return;}
  const ctx=c.getContext('2d'),W=c.width,H=c.height;
  ctx.drawImage(c._bg,0,0);
  const cx=W/2,cy=H/2+4,R=Math.min(W,H)*.40;
  const d=EPOCH.now();
  const sp=sunPos(d),sAA=eqToAltAz(sp.ra,sp.dec,d,SITE.lat_deg,SITE.lon_deg);
  const mp=moonPos(d),mAA=eqToAltAz(mp.ra,mp.dec,d,SITE.lat_deg,SITE.lon_deg);
  const toXY=(azD,elD)=>{const r_=(90-elD)/90*R,ar=azD*D2R;return{x:cx-r_*Math.sin(ar),y:cy-r_*Math.cos(ar)};};
  ctx.font='10px "IBM Plex Mono",monospace';ctx.textAlign='left';
  if(sAA.alt>0){
    const p=toXY(sAA.az,sAA.alt);
    ctx.strokeStyle='#d4d4d4';ctx.lineWidth=1;ctx.beginPath();ctx.arc(p.x,p.y,5,0,2*Math.PI);ctx.stroke();
    ctx.fillStyle='#d4d4d4';ctx.beginPath();ctx.arc(p.x,p.y,1.5,0,2*Math.PI);ctx.fill();
    ctx.fillText('Sun',p.x+9,p.y+3);
  }
  if(mAA.alt>0){
    const p=toXY(mAA.az,mAA.alt);
    ctx.fillStyle='#acacac';ctx.beginPath();ctx.arc(p.x,p.y,4,0,2*Math.PI);ctx.fill();
    ctx.fillText('Moon',p.x+9,p.y+3);
  }
  (window._liveSel||[]).forEach(s=>{
    if(s.el<=0) return;
    const p=toXY(s.az,s.el);
    ctx.fillStyle=s.color;ctx.beginPath();ctx.arc(p.x,p.y,s.si===0?4.5:3.5,0,2*Math.PI);ctx.fill();
    ctx.strokeStyle='#000000';ctx.lineWidth=1.5;ctx.stroke();
  });
  const smEl=document.getElementById('sky-sunmoon');
  if(smEl) smEl.textContent='Sun '+(sAA.alt>=0?'+':'')+sAA.alt.toFixed(1)+'° · Moon '+(mAA.alt>=0?'+':'')+mAA.alt.toFixed(1)+'°, '+Math.round(mp.phase*100)+'% lit';
}

function updateLiveMeta(ex,ey,ez,curEl,elapsed){
  const curAlt=Math.sqrt(ex*ex+ey*ey+ez*ez)-RE_KM;
  if(curAlt>0) document.getElementById('m-alt').textContent=curAlt.toFixed(0)+' km';
  if(!currentPasses) return;
  const inPass=currentPasses.find(p=>p.t_rise<=elapsed&&elapsed<=p.t_set);
  const nextPass=currentPasses.find(p=>p.t_rise>elapsed);
  if(inPass){
    const tos=inPass.t_set-elapsed;
    document.getElementById('m-ttr').textContent='IN PASS · −'+fmtHMS(tos);
    document.getElementById('m-ttr').className='mv green';
    const setAbs=new Date(propagationTime.getTime()+inPass.t_set*1000);
    document.getElementById('m-set').textContent=fmtLocalShort(setAbs,SITE.tz);
    document.getElementById('m-set-local').textContent=fmtUTCShort(setAbs);
    document.getElementById('m-elev').textContent=curEl.toFixed(1)+'° (live)';
    document.getElementById('m-elev').className='mv green';
  } else if(nextPass){
    const ttr=nextPass.t_rise-elapsed;
    document.getElementById('m-ttr').textContent=fmtHMS(ttr);
    document.getElementById('m-ttr').className='mv amber';
    const riseAbs=new Date(propagationTime.getTime()+nextPass.t_rise*1000);
    const setAbs =new Date(propagationTime.getTime()+nextPass.t_set*1000);
    document.getElementById('m-rise').textContent=fmtLocalShort(riseAbs,SITE.tz);
    document.getElementById('m-rise-local').textContent=fmtUTCShort(riseAbs);
    document.getElementById('m-set').textContent=fmtLocalShort(setAbs,SITE.tz);
    document.getElementById('m-set-local').textContent=fmtUTCShort(setAbs);
    document.getElementById('m-elev').textContent=nextPass.el_peak.toFixed(1)+'°';
    document.getElementById('m-elev').className='mv'+(nextPass.el_peak>30?' green':nextPass.el_peak>10?' amber':'');
  }
  if(_nextVisAbs){
    const dtv=(_nextVisAbs.getTime()-EPOCH.ms())/1000;
    const nv=document.getElementById('m-nextvis');
    if(dtv<=0&&_nextVisEndAbs&&EPOCH.ms()<_nextVisEndAbs.getTime()){
      nv.textContent='NOW · pk '+_nextVisPk.toFixed(0)+'°';nv.className='mv green';
    } else if(dtv>0){
      nv.textContent=fmtLocalShort(_nextVisAbs,SITE.tz)+' · −'+fmtHMS(dtv)+' · pk '+_nextVisPk.toFixed(0)+'°';
    }
  }
}

/* ════ MASTER ANIMATION LOOP (single rAF for the whole app) ════ */
let _lastFrameP=performance.now();
/* ── fault-isolated render loop: an exception in any view's frame is caught,
      reported on-screen (ErrorTrap), throttled, and the loop KEEPS RUNNING —
      one bad frame must never freeze an always-on console. ── */
let _frameErrLast=0,_frameErrCount=0;
function masterLoop(){
  requestAnimationFrame(masterLoop);
  try{
    _masterFrame();
  }catch(err){
    const now=performance.now();
    _frameErrCount++;
    if(now-_frameErrLast>5000){
      _frameErrLast=now;
      console.error('[frame]',err);
      if(typeof reportRuntimeError==='function')
        reportRuntimeError('FRAME ['+(document.body.dataset.view||'?')+'] '+err.message+(_frameErrCount>1?' ×'+_frameErrCount:''),err);
      _frameErrCount=0;
    }
  }
}
function _masterFrame(){
  const nowP=performance.now();
  const dt=Math.min(0.1,(nowP-_lastFrameP)/1000);
  _lastFrameP=nowP;
  EPOCH.tick(nowP);            /* ← single master clock: SGP4 + ephemerides in lockstep */
  const view=document.body.dataset.view||'tracker';
  if(view==='tracker'&&!(eciThree&&ecefThree)){
    updateNowMarker(nowP);
  } else if(view==='tracker'&&eciThree&&ecefThree){
    eciThree.ctrl.update(dt);ecefThree.ctrl.update(dt);
    const now=EPOCH.now();
    if(eciThree.earthMesh&&propagationGMST0!==null&&propagationTime!==null){
      const elapsed=(now.getTime()-propagationTime.getTime())/1000;
      eciThree.earthMesh.rotation.y=propagationGMST0+WE*elapsed;
    }
    if(ecefThree.earthMesh) ecefThree.earthMesh.rotation.y=0;
    /* physically-placed Sun at the EPOCH (sim) time */
    if(nowP-_sunLast>400){
      _sunLast=nowP;
      const su=sunECIUnit(now);
      eciThree.setSun(su);
      const th=gmst_from_jd(julianDate(now)),ct=Math.cos(th),st=Math.sin(th);
      ecefThree.setSun([ct*su[0]+st*su[1],-st*su[0]+ct*su[1],su[2]]);
    }
    updateNowMarker(nowP);
    eciThree.renderer.render(eciThree.scene,eciThree.camera);
    ecefThree.renderer.render(ecefThree.scene,ecefThree.camera);
  } else if(view==='catalog'&&CAT.three){
    CAT.frame(nowP,dt);
  } else if(view==='eph'&&typeof SS!=='undefined'&&SS.three){
    SS.frame(nowP,dt);
    if(TRAJ.inited) TRAJ.frame(nowP,dt);
  } else if(view==='ca'&&typeof CA!=='undefined'&&CA.inited&&CA.three){
    CA.frame(nowP,dt);
  } else if(view==='disc'&&typeof DISC!=='undefined'&&DISC.inited){
    DISC.frame(nowP,dt);
  }
}
function footprintCircle(latDeg,lonDeg,altKm,ctx,W,H,rhoDeg){
  // Half-angle of Earth visible from satellite — or an explicit cap radius (deg)
  let rho=rhoDeg!==undefined?rhoDeg*Math.PI/180:Math.acos(RE_KM/(RE_KM+altKm));
  const toXY=(la,lo)=>({x:((lo+180)/360)*W,y:((90-la)/180)*H});
  const N=120;
  ctx.beginPath();
  let first=true;
  for(let i=0;i<=N;i++){
    let bearing=(i/N)*2*Math.PI;
    // Spherical cap point at angular radius rho from satellite sub-point
    let lat0=latDeg*Math.PI/180,lon0=lonDeg*Math.PI/180;
    let slat=Math.sin(lat0),clat=Math.cos(lat0);
    let srho=Math.sin(rho),crho=Math.cos(rho);
    let lat2=Math.asin(slat*crho+clat*srho*Math.cos(bearing));
    let dlon=Math.atan2(Math.sin(bearing)*srho*clat,crho-slat*Math.sin(lat2));
    let lon2=lon0+dlon;
    lon2=((lon2*180/Math.PI+540)%360)-180;
    lat2=lat2*180/Math.PI;
    let {x,y}=toXY(lat2,lon2);
    if(first){ctx.moveTo(x,y);first=false;} else ctx.lineTo(x,y);
  }
  ctx.closePath();
}


/* ════ V2 · GROUND TRACK — static layer (cached); terminator/NOW drawn live ════ */
function drawGroundTrack(canvas,sels){
  let ctx=canvas.getContext('2d');
  let W=canvas.width,H=canvas.height;
  const xy=(la,lo)=>({x:((lo+180)/360)*W,y:((90-la)/180)*H});
  ctx.clearRect(0,0,W,H);
  const bp=worldMapImg?blueprintMap(worldMapImg,W,H):null;
  if(bp) ctx.drawImage(bp,0,0,W,H);
  else if(worldMapImg){ctx.drawImage(worldMapImg,0,0,W,H);ctx.fillStyle='rgba(0,0,0,0.80)';ctx.fillRect(0,0,W,H);}
  else{ctx.fillStyle='#080808';ctx.fillRect(0,0,W,H);}
  ctx.strokeStyle='rgba(60,60,60,0.6)';ctx.lineWidth=.5;
  for(let g=-180;g<=180;g+=30){let{x}=xy(0,g);ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  for(let g=-90;g<=90;g+=30){let{y}=xy(g,0);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke();}
  ctx.strokeStyle='rgba(190,190,190,0.18)';ctx.lineWidth=.7;
  ctx.beginPath();ctx.moveTo(0,H/2);ctx.lineTo(W,H/2);ctx.stroke();

  sels.forEach((S,si)=>{
    const lat=S.latF,lon=S.lonF,passes=S.passes,N=lat.length;
    const prim=si===0;
    /* full track */
    ctx.strokeStyle=prim?S.color+'88':S.color+'55';ctx.lineWidth=prim?1.2:0.9;
    ctx.beginPath();let s0=false;
    for(let k=0;k<N;k++){
      let{x,y}=xy(lat[k],lon[k]);
      if(!s0){ctx.moveTo(x,y);s0=true;}
      else if(Math.abs(lon[k]-lon[k-1])>180){ctx.stroke();ctx.beginPath();ctx.moveTo(x,y);}
      else ctx.lineTo(x,y);
    }ctx.stroke();
    /* pass arcs — visible passes glow */
    passes.forEach(p=>{
      const vis=p.visible;
      if(vis){ctx.shadowColor='#7fbf98';ctx.shadowBlur=0;ctx.strokeStyle='#7fbf98';}
      else ctx.strokeStyle=S.color;
      ctx.lineWidth=vis?3:(prim?2.4:1.8);
      ctx.beginPath();let ps=false;
      for(let j=p.i0;j<=p.i1;j++){
        let{x,y}=xy(lat[j],lon[j]);
        if(!ps){ctx.moveTo(x,y);ps=true;}
        else if(Math.abs(lon[j]-lon[j-1])>180){ctx.stroke();ctx.beginPath();ctx.moveTo(x,y);}
        else ctx.lineTo(x,y);
      }ctx.stroke();ctx.shadowBlur=0;
      if(prim){
        ctx.strokeStyle=S.color+'60';ctx.lineWidth=.8;ctx.setLineDash([3,5]);
        const mid=Math.floor((p.i0+p.i1)/2);
        footprintCircle(lat[mid],lon[mid],S.tle?S.tle.alt_km:500,ctx,W,H);
        ctx.stroke();ctx.setLineDash([]);
      }
    });
    /* direction arrows (primary only, declutter) */
    if(prim){
      ctx.fillStyle=S.color+'70';
      let as=Math.max(1,Math.floor(N/26));
      for(let k=as;k<N-1;k+=as){
        if(Math.abs(lon[k]-lon[k-1])>90) continue;
        let{x:x1,y:y1}=xy(lat[k],lon[k]);let{x:x2,y:y2}=xy(lat[k+1],lon[k+1]);
        let ang=Math.atan2(y2-y1,x2-x1);
        ctx.save();ctx.translate(x1,y1);ctx.rotate(ang);
        ctx.beginPath();ctx.moveTo(5,0);ctx.lineTo(-3,-2.5);ctx.lineTo(-3,2.5);ctx.closePath();ctx.fill();ctx.restore();
      }
    }
  });

  /* observer site + true line-of-sight sensor visibility circle for the primary:
     central angle λ = acos( RE/(RE+h) · cos(el_min) ) − el_min  */
  let{x:sx,y:sy}=xy(SITE.lat_deg,SITE.lon_deg);
  if(sels.length&&sels[0].tle){
    const h=sels[0].tle.alt_km, elm=VIS_EL_MIN*D2R;
    const lam=(Math.acos(RE_KM/(RE_KM+h)*Math.cos(elm))-elm)*R2D;
    ctx.strokeStyle='rgba(214,110,110,0.5)';ctx.lineWidth=1;ctx.setLineDash([6,4]);
    footprintCircle(SITE.lat_deg,SITE.lon_deg,0,ctx,W,H,lam);
    ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle='rgba(214,110,110,0.75)';ctx.font='10px IBM Plex Mono';
    ctx.fillText('SENSOR LOS · EL>'+VIS_EL_MIN+'°',sx+9,sy+13);
  }
  ctx.fillStyle='#d66e6e';
  ctx.beginPath();ctx.moveTo(sx,sy-8);ctx.lineTo(sx+6,sy);ctx.lineTo(sx,sy+8);ctx.lineTo(sx-6,sy);ctx.closePath();ctx.fill();
  ctx.strokeStyle='rgba(214,110,110,0.35)';ctx.lineWidth=1;ctx.beginPath();ctx.arc(sx,sy,15,0,2*Math.PI);ctx.stroke();
  ctx.fillStyle='#d66e6e';ctx.font='bold 11px IBM Plex Mono';ctx.fillText('OBS',sx+9,sy+3);

  ctx.fillStyle='rgba(147,147,147,0.7)';ctx.font='10px IBM Plex Mono';
  for(let g=-120;g<=120;g+=60){let{x}=xy(0,g);ctx.fillText(g+'°',x+2,H-4);}
  for(let g=-60;g<=60;g+=30){let{y}=xy(g,0);ctx.fillText(g+'°',3,y-2);}
}

/* ════ POLAR SKY PLOT (look-angle widget) — multi-object + night filter ════
   Bright green glow = truly visible (sunlit object + dark site, el>5°)
   Dim slate dashes  = object inside Earth's shadow
   Selection color   = geometric pass but sky too bright
   SKY_VIS_ONLY      = plot ONLY passes that clear the night-visibility screen */
let SKY_VIS_ONLY=false,SKY_ALL=false;
/* right column: sky plot or ground track, one at a time at full size */
function setRView(v){
  document.body.dataset.rview=v;
  document.querySelectorAll('.rview-toggle .hud-btn').forEach(b=>b.classList.toggle('on',b.dataset.r===v));
  try{localStorage.setItem('ssa.rview',v);}catch(e){}
  if(typeof redrawStatic2D==='function') setTimeout(redrawStatic2D,30);
}
document.addEventListener('DOMContentLoaded',()=>{let v='sky';try{v=localStorage.getItem('ssa.rview')||'sky';}catch(e){}setRView(v);});
function toggleSitePop(force){
  const p=document.getElementById('site-pop');if(!p) return;
  const open=force===undefined?!p.classList.contains('open'):force;
  if(open){   /* fixed position under the button: the top bar scrolls sideways and would clip it */
    const r=document.getElementById('site-btn').getBoundingClientRect();
    p.style.top=(r.bottom+6)+'px';
    p.style.left=Math.max(8,Math.min(window.innerWidth-256,r.left))+'px';
  }
  p.classList.toggle('open',open);
}
document.addEventListener('click',e=>{const c=document.getElementById('site-cluster');if(c&&!c.contains(e.target)) toggleSitePop(false);});
function siteButtonText(){
  const b=document.getElementById('site-btn');if(!b) return;
  b.textContent=Math.abs(SITE.lat_deg).toFixed(2)+'°'+(SITE.lat_deg>=0?'N':'S')+' '+Math.abs(SITE.lon_deg).toFixed(2)+'°'+(SITE.lon_deg>=0?'E':'W')+' · '+Math.round(SITE.h_m)+' m';
}
document.addEventListener('DOMContentLoaded',()=>siteButtonText());
/* the 3-D panel shows one frame at a time; both scenes stay live underneath */
function setFrame(f){
  document.body.dataset.frame=f;
  document.querySelectorAll('#frame-toggle .hud-btn').forEach(b=>b.classList.toggle('on',b.dataset.f===f));
}
function toggleSkyAll(btn){
  SKY_ALL=!SKY_ALL;
  (btn||document.getElementById('sky-all-btn')).classList.toggle('on',SKY_ALL);
  if(SEL.length) renderAllSel();
}
/* Sky plot. By default only the current or next pass of each tracked object is
   drawn, so the plot stays readable. Line style carries the visibility state:
   thick solid = naked-eye visible, thin solid = sunlit but sky too bright,
   dashed = in Earth's shadow. Rise and set times label the primary only. */
function drawSkyPlot(canvas,sels){
  const ctx=canvas.getContext('2d'),W=canvas.width,H=canvas.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#000000';ctx.fillRect(0,0,W,H);
  const cx=W/2,cy=H/2+4,R=Math.min(W,H)*.40;
  const UI='"IBM Plex Mono",monospace';
  /* grid */
  ctx.lineWidth=1;
  [0,30,60].forEach(e0=>{
    const r=((90-e0)/90)*R;
    ctx.strokeStyle=e0===0?'#373737':'#1c1c1c';
    ctx.beginPath();ctx.arc(cx,cy,r,0,2*Math.PI);ctx.stroke();
    if(e0>0){ctx.fillStyle='#515151';ctx.font='10px '+UI;ctx.textAlign='left';ctx.fillText(e0+'°',cx+3,cy-r+11);}
  });
  ctx.strokeStyle='#1c1c1c';
  ctx.beginPath();ctx.moveTo(cx,cy-R);ctx.lineTo(cx,cy+R);ctx.moveTo(cx-R,cy);ctx.lineTo(cx+R,cy);ctx.stroke();
  ctx.fillStyle='#9b9b9b';ctx.font='11px '+UI;ctx.textAlign='center';
  ctx.fillText('N',cx,cy-R-8);ctx.fillText('S',cx,cy+R+16);
  ctx.textAlign='right';ctx.fillText('E',cx-R-8,cy+4);ctx.textAlign='left';ctx.fillText('W',cx+R+8,cy+4);

  const nowEl=new Date(EPOCH.ms());
  let drewAny=false;
  const boxes=[];
  const label=(txt,x,y)=>{   /* place a label where it overlaps nothing already drawn; else skip it */
    const w=ctx.measureText(txt).width+4,hh=12;
    for(const dy of [0,12,-12,24,-24]){
      const b={x,y:y+dy-hh+2,w,h:hh};
      if(!boxes.some(o=>b.x<o.x+o.w&&o.x<b.x+b.w&&b.y<o.y+o.h&&o.y<b.y+b.h)){boxes.push(b);ctx.fillText(txt,x,y+dy);return;}
    }
  };
  sels.forEach((S,si)=>{
    const az=S.azF,el=S.elF,now=S.data.now,sunlit=S.data.sunlit,sunAlt=S.data.sunAlt;
    const prim=si===0,col=S.color;
    const elapsed=(nowEl.getTime()-now.getTime())/1000;
    const toXY=j=>{const r_=(90-Math.max(0,el[j]))/90*R,ar=az[j]*D2R;return{x:cx-r_*Math.sin(ar),y:cy-r_*Math.cos(ar)};};
    const st=j=>(!sunlit||!sunAlt)?0:(el[j]>VIS_EL_MIN&&sunlit[j]&&sunAlt[j]<VIS_SUN_MAX)?2:(!sunlit[j]?1:0);
    let list=S.passes.filter(p=>p.t_set>=elapsed);
    if(SKY_VIS_ONLY) list=list.filter(p=>p.visible);
    if(!SKY_ALL) list=list.slice(0,1);
    list.forEach(p=>{
      drewAny=true;
      let j=p.i0;
      while(j<p.i1){
        const s0=st(j);let j1=j;
        while(j1<p.i1&&st(j1+1)===s0) j1++;
        ctx.strokeStyle=col;
        ctx.globalAlpha=prim?1:0.75;
        if(s0===2){ctx.lineWidth=prim?3:2.2;ctx.setLineDash([]);}
        else if(s0===1){ctx.lineWidth=1.2;ctx.setLineDash([3,4]);ctx.globalAlpha*=0.6;}
        else{ctx.lineWidth=1.2;ctx.setLineDash([]);ctx.globalAlpha*=0.55;}
        ctx.beginPath();
        for(let q=j;q<=Math.min(j1+1,p.i1);q++){const{x,y}=toXY(q);if(q===j)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
        ctx.stroke();
        j=j1+1;
      }
      ctx.setLineDash([]);ctx.globalAlpha=1;
      /* direction arrow at mid-pass */
      const mid=Math.floor((p.i0+p.i1)/2);
      if(mid+1<=p.i1){
        const a=toXY(mid),b=toXY(mid+1),ang=Math.atan2(b.y-a.y,b.x-a.x);
        ctx.fillStyle=col;ctx.save();ctx.translate(b.x,b.y);ctx.rotate(ang);
        ctx.beginPath();ctx.moveTo(6,0);ctx.lineTo(-3,-3);ctx.lineTo(-3,3);ctx.closePath();ctx.fill();ctx.restore();
      }
      const t=sec=>fmtLocalTime(new Date(now.getTime()+sec*1000),SITE.tz).slice(0,5);
      const rim=(azD,label)=>{
        const ar=azD*D2R,x=cx-(R+14)*Math.sin(ar),y=cy-(R+14)*Math.cos(ar);
        ctx.fillStyle=prim?'#e0e0e0':'#9b9b9b';ctx.font='10px '+UI;ctx.textAlign='center';ctx.fillText(label,x,y+3);
      };
      if(prim){rim(p.az_rise,t(p.t_rise));rim(p.az_set,t(p.t_set));}
      const rp=(90-p.el_peak)/90*R,ap=p.az_peak*D2R;
      const xp=cx-rp*Math.sin(ap),yp=cy-rp*Math.cos(ap);
      ctx.fillStyle=col;ctx.beginPath();ctx.arc(xp,yp,prim?3:2.5,0,2*Math.PI);ctx.fill();
      ctx.font='10px '+UI;ctx.textAlign='left';ctx.fillStyle=prim?'#e0e0e0':'#acacac';
      label((prim?'':S.tle.name.slice(0,12)+' ')+p.el_peak.toFixed(0)+'°',xp+6,yp-4);
    });
  });
  if(!drewAny){
    ctx.fillStyle='#616161';ctx.font='11px '+UI;ctx.textAlign='center';
    ctx.fillText(SKY_VIS_ONLY?'No naked-eye passes in the forecast window':'No passes in the forecast window',cx,cy+R+34);
  }
  ctx.textAlign='start';
}

/* ════ PASS BOARD ════
   One row per tracked object. Status reads live against the sim epoch:
   in view → time to loss of signal; otherwise → time to the next rise. */
const _deepVis={};
function nextNakedEye(S,elapsed){
  const p=S.passes.find(q=>q.visible&&q.t_vis1>elapsed);
  if(p) return{t0:new Date(S.data.now.getTime()+p.t_vis0*1000),pk:p.el_visPeak};
  const key=S.tle.satnum+'|'+S.data.now.getTime();
  if(!(key in _deepVis)){
    _deepVis[key]=undefined;
    setTimeout(()=>{
      const w=findNextVisible(S.tle,48);
      _deepVis[key]=w?{t0:new Date(EPOCH.ms()+w.t0*1000),pk:w.elPk}:null;
    },30);
  }
  const v=_deepVis[key];
  return v===undefined?'scan':v;
}
/* ════ J2K · TEME (SGP4 output) → J2000 (FK5) rotation ════
   r_J2000 = P · N · R3(−Δψ cos ε̄) · r_TEME, with IAU-1976 precession and the
   largest terms of the IAU-1980 nutation series (error under 1 arcsecond).
   Star catalogs and telescope mounts work in J2000, so RA/Dec are shown there. */
const J2K={
  matrix(d){
    const T=(julianDate(d)-2451545.0)/36525,AS=Math.PI/648000,D=Math.PI/180;
    const R1=a=>{const c=Math.cos(a),s=Math.sin(a);return[1,0,0, 0,c,s, 0,-s,c];};
    const R2=a=>{const c=Math.cos(a),s=Math.sin(a);return[c,0,-s, 0,1,0, s,0,c];};
    const R3=a=>{const c=Math.cos(a),s=Math.sin(a);return[c,s,0, -s,c,0, 0,0,1];};
    const mul=(A,B)=>{const C=new Array(9);for(let i=0;i<3;i++)for(let j=0;j<3;j++)
      C[3*i+j]=A[3*i]*B[j]+A[3*i+1]*B[3+j]+A[3*i+2]*B[6+j];return C;};
    const zeta=(2306.2181*T+0.30188*T*T+0.017998*T*T*T)*AS,
          theta=(2004.3109*T-0.42665*T*T-0.041833*T*T*T)*AS,
          z=(2306.2181*T+1.09468*T*T+0.018203*T*T*T)*AS;
    const Om=(125.04452-1934.136261*T)*D,Ls=(280.4665+36000.7698*T)*D,
          Lm=(218.3165+481267.8813*T)*D,lp=(357.52772+35999.05034*T)*D;
    const dpsi=(-17.1996*Math.sin(Om)-1.3187*Math.sin(2*Ls)-0.2274*Math.sin(2*Lm)+0.2062*Math.sin(2*Om)+0.1426*Math.sin(lp))*AS,
          deps=(9.2025*Math.cos(Om)+0.5736*Math.cos(2*Ls)+0.0977*Math.cos(2*Lm)-0.0895*Math.cos(2*Om))*AS,
          eps0=(84381.448-46.8150*T)*AS;
    const P=mul(mul(R3(zeta),R2(-theta)),R3(z));
    const N=mul(mul(R1(-eps0),R3(dpsi)),R1(eps0+deps));
    return mul(mul(P,N),R3(-dpsi*Math.cos(eps0)));
  },
  apply(M,v){return[M[0]*v[0]+M[1]*v[1]+M[2]*v[2],M[3]*v[0]+M[4]*v[1]+M[5]*v[2],M[6]*v[0]+M[7]*v[1]+M[8]*v[2]];}
};

/* ════ OBS · one-shot topocentric state from SGP4 ════
   Az/El from the ECEF line of sight rotated into the site's ENU frame.
   RA/Dec are topocentric J2000: the TEME line of sight rotated by J2K.matrix;
   Range rate uses the site's inertial velocity ω×r. */
const OBS={
  ctx(){return{site:geo2ecef(SITE.lat_deg,SITE.lon_deg,SITE.h_m),R:topoRotm(SITE.lat_deg,SITE.lon_deg)};},
  frame(d){const g=gmst_from_jd(julianDate(d));return{d,c:Math.cos(g),s:Math.sin(g),su:null,j2k:null};},
  look(satrec,F,C,full){
    const pv=sgp4ECI(satrec,F.d);if(!pv||!isFinite(pv.r[0])) return null;
    const r=pv.r,xf=F.c*r[0]+F.s*r[1],yf=-F.s*r[0]+F.c*r[1],zf=r[2];
    const dx=xf-C.site[0],dy=yf-C.site[1],dz=zf-C.site[2],R=C.R;
    const e=R[0]*dx+R[1]*dy+R[2]*dz,n=R[3]*dx+R[4]*dy+R[5]*dz,u=R[6]*dx+R[7]*dy+R[8]*dz;
    const rng=Math.hypot(dx,dy,dz);
    const o={el:Math.asin(u/rng)*R2D,az:(Math.atan2(e,n)*R2D+360)%360,rng,r};
    if(!full) return o;
    const X=C.site[0],Y=C.site[1],Z=C.site[2];
    const sx=F.c*X-F.s*Y,sy=F.s*X+F.c*Y,sz=Z;
    const px=r[0]-sx,py=r[1]-sy,pz=r[2]-sz,v=pv.v;
    if(!F.j2k) F.j2k=J2K.matrix(F.d);
    const q=J2K.apply(F.j2k,[px,py,pz]);
    o.ra=((Math.atan2(q[1],q[0])*R2D+360)%360)/15;
    o.dec=Math.asin(q[2]/rng)*R2D;
    o.rr=(px*(v[0]+WE*sy)+py*(v[1]-WE*sx)+pz*v[2])/rng;
    const rm=Math.hypot(r[0],r[1],r[2]);
    o.alt=rm-RE_KM;o.speed=Math.hypot(v[0],v[1],v[2]);
    o.lat=Math.asin(zf/rm)*R2D;o.lon=Math.atan2(yf,xf)*R2D;
    if(!F.su) F.su=sunECIUnit(F.d);
    o.sunlit=isSunlit(r,F.su);
    return o;
  },
  sunAlt(d){const sp=sunPos(d);return eqToAltAz(sp.ra,sp.dec,d,SITE.lat_deg,SITE.lon_deg).alt;},
  compass(az){return['N','NE','E','SE','S','SW','W','NW'][Math.round(az/45)%8];},
  fmtRA(h){let t=Math.round(h*3600)%86400;const H=Math.floor(t/3600),M=Math.floor(t%3600/60),S=t%60;
    return String(H).padStart(2,'0')+'h'+String(M).padStart(2,'0')+'m'+String(S).padStart(2,'0')+'s';},
  fmtDec(d){const sg=d<0?'−':'+';let t=Math.round(Math.abs(d)*3600);const D=Math.floor(t/3600),M=Math.floor(t%3600/60),S=t%60;
    return sg+String(D).padStart(2,'0')+'°'+String(M).padStart(2,'0')+'′'+String(S).padStart(2,'0')+'″';},
  fmtDMS(d){let t=Math.round(d*3600);const D=Math.floor(t/3600),M=Math.floor(t%3600/60),S=t%60;
    return D+'°'+String(M).padStart(2,'0')+'′'+String(S).padStart(2,'0')+'″';}
};
function pbPick(n){
  const t=allSats.find(x=>x.satnum===n)||SITECAT.list.find(x=>x.satnum===n);if(!t) return;
  if(SEL.find(q=>q.tle.satnum===n)) makePrimary(n); else selectSat(t);
}

/* ════ SITECAT · the whole catalog for the site-wide lists ════
   The passes, in-view and GEO lists cover every tracked object, not just the
   TLE group picked in the sidebar. Loaded once, on first use, from the same
   OrbitSmith mirror the Catalog tab uses (CelesTrak as fallback), and shared
   with that tab so it is downloaded only once per visit. */
const SITECAT={
  list:[],state:'idle',src:'',prog:'',
  ensure(){
    if(this.state==='loading'||this.state==='ready') return;
    const c=(typeof CAT!=='undefined'&&CAT._groupCache)?CAT._groupCache.__full:null;
    if(c){this.adopt(c);return;}
    this.state='loading';this.prog='Loading the full catalog…';PB.onCat(true);
    (async()=>{
      let raw=await OS.fetchCatalog(
        (d,tot,n)=>{this.prog='Loading the full catalog, shard '+d+' of '+tot+' · '+n+' objects so far';PB.onCat();},
        m=>{this.list=[...m.values()];this.src='OrbitSmith';PB.onCat();});
      if(!raw){
        this.prog='OrbitSmith unreachable, trying CelesTrak…';PB.onCat(true);
        raw=await fetchFullCatalog(b=>{this.prog='Loading the CelesTrak catalog · '+(b/1048576).toFixed(1)+' MB';PB.onCat();});
      }
      if(!raw){this.state='fail';this.list=[];this.prog='';PB.onCat(true);return;}
      if(typeof CAT!=='undefined'&&CAT._groupCache&&!CAT._groupCache.__full) CAT._groupCache.__full=raw;
      this.adopt(raw);
    })();
  },
  adopt(raw){
    const L=(Array.isArray(raw)?raw:parseCatalog(raw)).filter(t=>t.satrec);
    L.forEach(t=>{if(!t.objType) t.objType=(typeof CAT!=='undefined'&&CAT.objTypeOfName)?CAT.objTypeOfName(t):'UNKNOWN';});
    this.src=Array.isArray(raw)?'OrbitSmith':'CelesTrak';
    this.list=L;this.state='ready';this.prog='';
    PB.onCat(true);
  }
};

/* ════ PB · site-wide lists over the whole catalog ════
   passes : every pass of every catalogued object in the next few hours
   inview : everything above the horizon right now
   geo    : geosynchronous objects that stay above the horizon for a full day */
const PB={
  tab:'tracked',MAXOBJ:60000,_nc:null,_onCatT:0,_tok:0,res:null,busy:false,_last:0,_geo:null,
  HEAD:{
    tracked:'<tr><th>Object</th><th>Status</th><th>Rise (AOS)</th><th>Set (LOS)</th><th>Max el</th><th>Next naked-eye pass</th><th>TLE age</th></tr>',
    passes:'<tr><th>Name</th><th>NORAD</th><th>AOS</th><th>LOS</th><th>Elevation</th><th>Max elevation</th><th>Visibility</th></tr>',
    inview:'<tr><th>Name</th><th>NORAD</th><th>Azimuth</th><th>Elevation</th><th>Range</th><th>RA (J2000)</th><th>Dec (J2000)</th><th>Lighting</th></tr>',
    geo:'<tr><th>Name</th><th>NORAD</th><th>Azimuth</th><th>Elevation</th><th>Range</th><th>RA (J2000)</th><th>Dec (J2000)</th><th>Sub-longitude</th><th>Lighting</th></tr>'
  },
  SUB:{
    tracked:'Objects you selected. Naked-eye visible means sunlit, above 5°, with the Sun below −6° at the site.',
    passes:'',inview:'',geo:''
  },
  setTab(t){
    this.tab=t;
    document.querySelectorAll('.pb-tab').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));
    document.getElementById('pb-thead').innerHTML=this.HEAD[t];
    document.getElementById('pb-filters').style.display=t==='tracked'?'none':'flex';
    document.querySelectorAll('#pb-filters .pbf-pass').forEach(e=>e.style.display=t==='passes'?'':'none');
    if(t!=='tracked') SITECAT.ensure();
    document.querySelector('.pb-head .pt-export').style.display=t==='tracked'?'':'none';
    document.getElementById('pb-sub').textContent=this.SUB[t];
    document.getElementById('pb-body').innerHTML='';
    this._last=0;
    if(t==='tracked') renderPassBoard(); else this.tick(true);
  },
  /* the list the site-wide tabs scan: the whole catalog, or the sidebar group if the catalog could not be fetched */
  cat(){
    const L=SITECAT.list.length?SITECAT.list:allSats;
    if(this._catSrc!==L||this._catN!==L.length){
      /* element sets older than TLE_STALE_D belong to decayed or lost objects; SGP4 output for them is meaningless */
      const ok=L.filter(t=>t.satrec&&tleAgeDays(t)<=TLE_STALE_D);
      this._catSrc=L;this._catN=L.length;this._cat=ok;this._stale=L.length-ok.length;
    }
    return this._cat;
  },
  staleNote(){return this._stale?' · '+this._stale+' with element sets older than '+TLE_STALE_D+' d left out':'';},
  catLabel(){
    if(SITECAT.list.length) return 'the full catalog ('+SITECAT.src+')';
    if(SITECAT.state==='loading'||SITECAT.state==='idle') return 'the full catalog (loading)';
    const g=document.getElementById('cat-select');
    return '“'+(g&&g.selectedOptions[0]?g.selectedOptions[0].textContent.trim():'group')+'” (full catalog unavailable)';
  },
  /* type and name filters shared by the three site-wide tabs */
  pass(t){
    const ty=document.getElementById('pbf-type').value;
    if(ty!=='ALL'&&(t.objType||'UNKNOWN')!==ty) return false;
    const q=document.getElementById('pbf-name').value.trim().toLowerCase();
    return !q||t.name.toLowerCase().includes(q)||String(t.satnum).includes(q);
  },
  refilter(){this._last=0;if(this.tab==='passes') this.render();else if(this.tab!=='tracked') this.renderNow();},
  /* the catalog grew or finished loading */
  onCat(force){
    if(this.tab==='tracked') return;
    const now=performance.now();
    if(!force&&now-this._onCatT<800) return;
    this._onCatT=now;
    if(this.tab==='passes'&&SITECAT.state==='loading'){this.empty(SITECAT.prog||'Loading the full catalog…',7);this.sub('Passes are computed once the whole catalog has arrived.');return;}
    if(this.tab==='geo'&&SITECAT.state==='loading'){this.empty(SITECAT.prog||'Loading the full catalog…',9);this.sub('');return;}
    this.tick(true);
  },
  /* Lower bound on the seconds before an object can rise above this site's horizon.
     The angle at Earth's centre between object and site must shrink to the horizon
     cone angle (largest at apogee) before it can be seen, and it shrinks no faster
     than the object's peak angular rate (at perigee) plus Earth's spin. */
  bound(t,r,sx,sy,sz){
    let B=t._pbB;
    if(!B){
      const s=t.satrec,e=Math.min(0.99,Math.max(0,s.ecco||0)),n=(s.no||0)/60;
      if(!(n>0)){B=t._pbB={w:1,lam:Math.PI};}
      else{
        const a=Math.cbrt(398600.4418/(n*n)),ra=a*(1+e);
        B=t._pbB={w:n*Math.sqrt((1+e)/Math.pow(1-e,3))+7.2921159e-5,lam:Math.acos(Math.min(1,6356.75/Math.max(ra,6356.75)))};
      }
    }
    const rm=Math.hypot(r[0],r[1],r[2]),sm=Math.hypot(sx,sy,sz);
    const psi=Math.acos(Math.max(-1,Math.min(1,(r[0]*sx+r[1]*sy+r[2]*sz)/(rm*sm))));
    const d=psi-B.lam-0.035;                                 /* 2° margin */
    return d>0?0.8*d/B.w:0;
  },
  /* the same idea in reverse: seconds the object is sure to stay above the horizon
     (horizon cone is smallest at perigee) */
  setBound(t,r,sx,sy,sz){
    this.bound(t,r,sx,sy,sz);
    const B=t._pbB;
    if(B.lamMin===undefined){
      const s=t.satrec,e=Math.min(0.99,Math.max(0,s.ecco||0)),n=(s.no||0)/60;
      const rp=n>0?Math.cbrt(398600.4418/(n*n))*(1-e):0;
      B.lamMin=rp>6378.5?Math.acos(6378.5/rp):0;
    }
    if(!B.lamMin) return 0;
    const rm=Math.hypot(r[0],r[1],r[2]),sm=Math.hypot(sx,sy,sz);
    const psi=Math.acos(Math.max(-1,Math.min(1,(r[0]*sx+r[1]*sy+r[2]*sz)/(rm*sm))));
    const d=B.lamMin-psi-0.035;
    return d>0?0.8*d/B.w:0;
  },
  key(){const L=this.cat();return L.length+'|'+(L[0]?L[0].satnum:0)+'|'+SITE.lat_deg+'|'+SITE.lon_deg+'|'+SITE.h_m;},
  sub(t){document.getElementById('pb-sub').textContent=t;},
  empty(msg,cols){document.getElementById('pb-body').innerHTML='<tr><td colspan="'+cols+'" class="pb-empty">'+msg+'</td></tr>';},
  tick(force){
    const now=performance.now();
    if(this.tab==='passes'){
      if(SITECAT.state==='loading'){if(force) this.onCat(true);return;}
      const hrs=+document.getElementById('pbf-hours').value;
      const stale=!this.res||this.res.key!==this.key()+'|'+hrs||EPOCH.ms()<this.res.t0||EPOCH.ms()-this.res.t0>600000;
      if(stale&&!this.busy) this.rescan();
      else if(force||now-this._last>1000){this._last=now;this.render();}
    } else if(this.tab==='inview'||this.tab==='geo'){
      if(force||now-this._last>3000){this._last=now;this.renderNow();}
    }
  },
  rescan(){
    const tok=++this._tok;this.busy=true;
    const all=this.cat(),sats=all.filter(t=>t.satrec).slice(0,this.MAXOBJ);
    const hrs=+document.getElementById('pbf-hours').value;
    const W=hrs*3600,step=W>7200?60:30,N=Math.floor(W/step);
    const t0=EPOCH.ms(),C=OBS.ctx(),F=[],sAlt=[];
    const SX=new Float64Array(N+1),SY=new Float64Array(N+1),SZ=C.site[2];
    for(let i=0;i<=N;i++){const d=new Date(t0+i*step*1000),f=OBS.frame(d);F.push(f);sAlt.push(OBS.sunAlt(d));
      SX[i]=f.c*C.site[0]-f.s*C.site[1];SY[i]=f.s*C.site[0]+f.c*C.site[1];}
    const out=[],key=this.key()+'|'+hrs;
    const el=new Float32Array(N+1),real=new Uint8Array(N+1);
    const tAt=i=>t0+i*step*1000;
    const one=t=>{
      /* coarse elevation series; while the object cannot possibly be up yet, jump ahead */
      /* and while it is sure to stay up, jump ahead too, filling the gap by linear interpolation */
      let any=false,i=0,up0=-1;
      real.fill(0);
      while(i<=N){
        const o=OBS.look(t.satrec,F[i],C);
        if(!o){if(i===0) return;el[i]=-90;up0=-1;i++;continue;}
        el[i]=o.el;real[i]=1;
        if(up0>=0){for(let q=up0+1;q<i;q++) el[q]=el[up0]+(el[i]-el[up0])*(q-up0)/(i-up0);up0=-1;}
        let sk;
        if(o.el>0){
          any=true;
          sk=Math.floor(this.setBound(t,o.r,SX[i],SY[i],SZ)/step);
          if(sk>=2){
            const k=i+sk;
            if(k>N){for(let q=i+1;q<=N;q++) el[q]=o.el;break;}
            up0=i;i=k;continue;
          }
          i++;continue;
        }
        sk=Math.floor(this.bound(t,o.r,SX[i],SY[i],SZ)/step);
        if(sk>=2){
          const k=i+sk;
          if(k>N){for(let q=i+1;q<=N;q++) el[q]=-90;break;}
          for(let q=i+1;q<k;q++) el[q]=-90;
          i=k;
        } else i++;
      }
      if(!any) return;
      i=0;
      while(i<=N){
        if(el[i]<=0){i++;continue;}
        let i0=i,i1=i;while(i1<N&&el[i1+1]>0) i1++;
        i=i1+1;
        const open0=i0===0,open1=i1===N;
        if(open0&&open1) continue;                        /* up for the whole window */
        const cross=(a,b)=>tAt(a)+(tAt(b)-tAt(a))*(el[a]/(el[a]-el[b]));
        const aos=open0?null:cross(i0-1,i0),los=open1?null:cross(i1,i1+1);
        let k=i0;for(let q=i0;q<=i1;q++) if(real[q]&&el[q]>el[k]) k=q;
        /* refine the peak between the neighbouring computed samples */
        let a=k-1,b=k+1;while(a>0&&!real[a]) a--;while(b<N&&!real[b]) b++;
        let lo=tAt(Math.max(0,a)),hi=tAt(Math.min(N,b)),pk=null;
        const f=ms=>{const o=OBS.look(t.satrec,OBS.frame(new Date(ms)),C,true);return o;};
        for(let it=0;it<14;it++){
          const m1=lo+(hi-lo)/3,m2=hi-(hi-lo)/3,o1=f(m1),o2=f(m2);
          if(!o1||!o2) break;
          if(o1.el<o2.el) lo=m1; else hi=m2;
        }
        const tpk=(lo+hi)/2;pk=f(tpk);
        if(!pk) continue;
        const sa=sAlt[k];
        const a0=OBS.look(t.satrec,F[i0],C),a1=OBS.look(t.satrec,F[i1],C);
        out.push({tle:t,aos,los,tpk,elpk:pk.el,azpk:pk.az,
          az0:a0?a0.az:0,az1:a1?a1.az:0,
          day:sa>=VIS_SUN_MAX,vis:pk.el>VIS_EL_MIN&&pk.sunlit&&sa<VIS_SUN_MAX,sunlit:pk.sunlit});
      }
    };
    let idx=0;
    const chunk=()=>{
      if(tok!==this._tok) return;
      const tEnd=performance.now()+25;
      while(idx<sats.length&&performance.now()<tEnd){try{one(sats[idx]);}catch(e){} idx++;}
      if(idx<sats.length){
        const now=performance.now();
        if(this.tab==='passes'&&now-this._last>500){
          this._last=now;
          this.res={key,t0,hrs,list:out,n:sats.length,capped:all.length>sats.length,pct:Math.round(100*idx/sats.length)};
          this.render();
        }
        setTimeout(chunk,0);
      } else {
        this.res={key,t0,hrs,list:out,n:sats.length,capped:all.length>sats.length};
        this.busy=false;this._last=performance.now();
        if(this.tab==='passes') this.render();
      }
    };
    if(!sats.length){this.res={key,t0,hrs,list:[],n:0};this.busy=false;this.render();return;}
    if(this.tab==='passes') this.empty('Computing passes…',7);
    setTimeout(chunk,0);
  },
  render(){
    if(this.tab!=='passes'||!this.res) return;
    const R=this.res,now=EPOCH.ms(),tz=SITE.tz;
    const minEl=+document.getElementById('pbf-minel').value;
    const visOnly=document.getElementById('pbf-vis').checked,noDay=document.getElementById('pbf-noday').checked;
    let L=R.list.filter(p=>p.elpk>=minEl&&(!visOnly||p.vis)&&(!noDay||!p.day)&&(p.los===null||p.los>now)&&this.pass(p.tle));
    const cur=p=>(p.aos===null||p.aos<=now);
    L.sort((a,b)=>{const ca=cur(a),cb=cur(b);
      if(ca!==cb) return ca?-1:1;
      return ca?((a.los||Infinity)-(b.los||Infinity)):(a.aos-b.aos);});
    this._view={kind:'passes',list:L,at:now,done:R.pct===undefined};
    const total=L.length;L=L.slice(0,300);
    const hms=ms=>fmtLocalTime(new Date(ms),tz);
    const C=OBS.ctx(),F0=OBS.frame(new Date(now)),F1=OBS.frame(new Date(now+2000));
    const rows=L.map(p=>{
      const c=cur(p);let elTxt='—';
      if(c){const o0=OBS.look(p.tle.satrec,F0,C),o1=OBS.look(p.tle.satrec,F1,C);
        if(o0&&o1) elTxt=o0.el.toFixed(0)+'° '+(o1.el>=o0.el?'ascending':'descending');}
      const sel=SEL.find(x=>x.tle.satnum===p.tle.satnum);
      return '<tr class="'+(c?'cur':'')+(sel?' picked':'')+'" onclick="pbPick('+p.tle.satnum+')">'+
        '<td>'+(sel?'<i class="pb-dot" style="background:'+sel.color+'"></i>':'')+p.tle.name+'</td><td>'+p.tle.satnum+'</td>'+
        '<td>'+(c?(p.aos===null?'':'<span class="pb-az">'+hms(p.aos)+'</span>'):hms(p.aos)+' <span class="pb-az">'+OBS.compass(p.az0)+'</span>')+'</td>'+
        '<td>'+(p.los===null?'after window':hms(p.los)+' <span class="pb-az">'+OBS.compass(p.az1)+'</span>')+'</td>'+
        '<td>'+elTxt+'</td>'+
        '<td>'+p.elpk.toFixed(0)+'° at '+hms(p.tpk)+' <span class="pb-az">'+OBS.compass(p.azpk)+'</span></td>'+
        '<td class="'+(p.vis?'pb-vis':'')+'">'+(p.vis?'Naked-eye':p.day?'Daylight':p.sunlit?'Low':'Eclipsed')+'</td></tr>';
    }).join('');
    if(rows) document.getElementById('pb-body').innerHTML=rows;
    else this.empty(R.pct!==undefined?'Computing passes…':R.n?'No passes match these filters.':'No objects loaded.',7);
    this.sub((R.pct!==undefined?'Computing… '+R.pct+'% · ':'')+total+' passes in the next '+R.hrs+' h · '+R.n+' objects in '+this.catLabel()+
      (R.capped?' (first '+this.MAXOBJ+' only)':'')+this.staleNote()+(total>300?' · showing 300':'')+' · local time');
  },
  geoSet(){
    const key=this.key();
    if(this._geo&&this._geo.key===key) return this._geo.set;
    const set=new Set(),C=OBS.ctx(),t0=EPOCH.ms(),F=[];
    for(let i=0;i<48;i++) F.push(OBS.frame(new Date(t0+i*1800000)));
    this.cat().forEach(t=>{
      if(!t.satrec||!(t.n>0.9&&t.n<1.1)) return;
      for(let i=0;i<48;i++){const o=OBS.look(t.satrec,F[i],C);if(!o||o.el<=0) return;}
      set.add(t.satnum);
    });
    this._geo={key,set};return set;
  },
  renderNow(){
    const geo=this.tab==='geo',cols=geo?9:8;
    const now=EPOCH.ms(),C=OBS.ctx(),F0=OBS.frame(new Date(now)),F1=OBS.frame(new Date(now+2000));
    const gs=geo?this.geoSet():null;
    const src=this.cat().filter(t=>t.satrec&&(!geo||gs.has(t.satnum))&&this.pass(t)).slice(0,this.MAXOBJ);
    /* objects far below the horizon are not re-propagated until they could have risen */
    const key=this.key();
    if(!this._nc||this._nc.key!==key||now<this._nc.t) this._nc={key,t:now,m:new Map()};
    this._nc.t=now;
    const M=this._nc.m,sx=F0.c*C.site[0]-F0.s*C.site[1],sy=F0.s*C.site[0]+F0.c*C.site[1],sz=C.site[2];
    let L=[];
    src.forEach(t=>{
      const nc=M.get(t.satnum);if(nc!==undefined&&nc>now) return;
      const o=OBS.look(t.satrec,F0,C);
      if(!o){M.set(t.satnum,Infinity);return;}
      if(o.el<=0){const b=this.bound(t,o.r,sx,sy,sz);if(b>20) M.set(t.satnum,now+b*1000);return;}
      const of=OBS.look(t.satrec,F0,C,true);if(of) L.push({t,o:of});
    });
    L.sort((a,b)=>geo?a.o.az-b.o.az:b.o.el-a.o.el);
    this._view={kind:this.tab,list:L,at:now,done:SITECAT.state!=='loading'};
    const total=L.length;L=L.slice(0,300);
    const rows=L.map(({t,o})=>{
      let ad='';
      if(!geo){const o1=OBS.look(t.satrec,F1,C);if(o1) ad=o1.el>=o.el?' ascending':' descending';}
      const sel=SEL.find(x=>x.tle.satnum===t.satnum);
      return '<tr class="'+(sel?'picked':'')+'" onclick="pbPick('+t.satnum+')">'+
        '<td>'+(sel?'<i class="pb-dot" style="background:'+sel.color+'"></i>':'')+t.name+'</td><td>'+t.satnum+'</td>'+
        '<td>'+o.az.toFixed(1)+'° <span class="pb-az">'+OBS.compass(o.az)+'</span></td>'+
        '<td>'+o.el.toFixed(1)+'°<span class="pb-az">'+ad+'</span></td>'+
        '<td>'+o.rng.toFixed(0)+' km</td><td>'+OBS.fmtRA(o.ra)+'</td><td>'+OBS.fmtDec(o.dec)+'</td>'+
        (geo?'<td>'+Math.abs(o.lon).toFixed(1)+'° '+(o.lon<0?'W':'E')+'</td>':'')+
        '<td>'+(o.sunlit?'Sunlit':'Eclipsed')+'</td></tr>';
    }).join('');
    if(rows) document.getElementById('pb-body').innerHTML=rows;
    else if(SITECAT.state==='loading'&&!src.length) this.empty(SITECAT.prog||'Loading the full catalog…',cols);
    else if(geo) this.empty('No geosynchronous objects matching these filters stay above this site\'s horizon.',cols);
    else this.empty(src.length?'Nothing matching these filters is above the horizon right now.':'No objects loaded.',cols);
    const ld=SITECAT.state==='loading'?' · still loading ('+this.cat().length+' so far)':'';
    this.sub(geo?total+' geosynchronous objects in '+this.catLabel()+' above the horizon for the next 24 h · sorted by azimuth'
                :total+' of '+src.length+' objects in '+this.catLabel()+' above the horizon'+(total>300?' · showing the 300 highest':'')+ld+this.staleNote()+' · RA/Dec topocentric J2000');
  },
  loadGeo(){
    const sel=document.getElementById('cat-select');
    const opt=[...sel.options].find(o=>/Geostationary/i.test(o.textContent));
    if(opt){sel.value=opt.value;sel.dispatchEvent(new Event('change'));}
  },
  /* live data panel for the primary tracked object */
  dataPanel(){
    const nameEl=document.getElementById('sd-name');if(!nameEl) return;
    const S=SEL[0];
    if(!S){nameEl.textContent='No object tracked';document.getElementById('sd-state').innerHTML='&nbsp;';document.getElementById('sd-grid').innerHTML='';return;}
    const now=EPOCH.ms(),C=OBS.ctx();
    const o=S.tle.satrec?OBS.look(S.tle.satrec,OBS.frame(new Date(now)),C,true):null;
    nameEl.innerHTML='<i class="pb-dot" style="background:'+S.color+'"></i>'+S.tle.name;
    if(!o){document.getElementById('sd-state').textContent='SGP4 could not propagate this element set';document.getElementById('sd-grid').innerHTML='';return;}
    const o1=OBS.look(S.tle.satrec,OBS.frame(new Date(now+1000)),C);
    const up=o.el>0,asc=o1&&o1.el>=o.el;
    document.getElementById('sd-state').innerHTML=
      '<span class="'+(up?'sd-up':'')+'">'+(up?'Above horizon':'Below horizon')+'</span> · '+(asc?'Ascending':'Descending')+' '+OBS.compass(o.az)+' · '+(o.sunlit?'Sunlit':'Eclipsed');
    let aos='—',los='—';
    if(S.data&&S.passes){
      const el0=(now-S.data.now.getTime())/1000;
      const cur=S.passes.find(p=>p.t_rise<=el0&&el0<=p.t_set),nxt=S.passes.find(p=>p.t_rise>el0);
      if(cur) los=fmtHMS(cur.t_set-el0);
      else if(nxt){aos=fmtHMS(nxt.t_rise-el0);}
    }
    const yr=S.tle.intl||'';
    const row=(k,v)=>'<div class="sd-k">'+k+'</div><div class="sd-v">'+v+'</div>';
    document.getElementById('sd-grid').innerHTML=
      row('NORAD',S.tle.satnum)+
      row('T + epoch',tleAgeDays(S.tle).toFixed(4)+' d')+
      row('RA (J2000)',OBS.fmtRA(o.ra))+row('Dec (J2000)',OBS.fmtDec(o.dec))+
      row('Azimuth',OBS.fmtDMS(o.az))+row('Elevation',(o.el<0?'−':'+')+OBS.fmtDMS(Math.abs(o.el)))+
      row('Range',o.rng.toFixed(0)+' km')+row('Range rate',(o.rr>=0?'+':'−')+Math.abs(o.rr).toFixed(3)+' km/s')+
      row('Altitude',o.alt.toFixed(0)+' km')+row('Velocity',o.speed.toFixed(3)+' km/s')+
      row('Sub-point',Math.abs(o.lat).toFixed(1)+'°'+(o.lat<0?'S':'N')+' '+Math.abs(o.lon).toFixed(1)+'°'+(o.lon<0?'W':'E'))+
      row('AOS in',aos)+row('LOS in',los);
  }
};
document.addEventListener('DOMContentLoaded',()=>{const h=document.getElementById('pb-thead');if(h){h.innerHTML=PB.HEAD.tracked;document.getElementById('pb-sub').textContent=PB.SUB.tracked;}});

function renderPassBoard(){
  PB.dataPanel();
  if(PB.tab!=='tracked'){PB.tick();return;}
  const body=document.getElementById('pb-body');if(!body) return;
  if(!SEL.length){body.innerHTML='<tr><td colspan="7" class="pb-empty">Select an object from the list.</td></tr>';return;}
  const nowMs=EPOCH.ms(),tz=SITE.tz;
  const hm=d=>fmtLocalTime(d,tz).slice(0,5);
  const day=d=>{const a=new Date(d.getTime()+(SITE.tzOffsetMin||0)*60000),b=new Date(nowMs+(SITE.tzOffsetMin||0)*60000);
    return a.getUTCDate()===b.getUTCDate()?'':['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][a.getUTCDay()]+' ';};
  body.innerHTML=SEL.map((S,si)=>{
    if(!S.data||!S.passes) return '';
    const el0=(nowMs-S.data.now.getTime())/1000;
    const live=(window._liveSel||[]).find(x=>x.si===si);
    const cur=S.passes.find(p=>p.t_rise<=el0&&el0<=p.t_set);
    const nxt=S.passes.find(p=>p.t_rise>el0);
    const P=cur||nxt;
    const abs=sec=>new Date(S.data.now.getTime()+sec*1000);
    let status,cls='';
    if(cur){status='In view · LOS in '+fmtHMS(cur.t_set-el0)+(live?' · el '+live.el.toFixed(0)+'°':'');cls='up';}
    else if(nxt) status='Rises in '+fmtHMS(nxt.t_rise-el0);
    else status='No pass in '+(HORIZON_S/3600)+' h';
    const nv=nextNakedEye(S,el0);
    const nvTxt=nv==='scan'?'scanning…':nv?(nv.t0.getTime()<=nowMs?'now':day(nv.t0)+hm(nv.t0))+' · max '+nv.pk.toFixed(0)+'°':'none in 48 h';
    const age=tleAgeDays(S.tle);
    return '<tr class="'+cls+(si===0?' prim':'')+'" onclick="makePrimary('+S.tle.satnum+')">'+
      '<td><i class="pb-dot" style="background:'+S.color+'"></i>'+S.tle.name+'<span class="pb-id">'+S.tle.satnum+'</span></td>'+
      '<td class="pb-status">'+status+'</td>'+
      '<td>'+(P?day(abs(P.t_rise))+hm(abs(P.t_rise))+' <span class="pb-az">'+P.az_rise.toFixed(0)+'°</span>':'—')+'</td>'+
      '<td>'+(P?day(abs(P.t_set))+hm(abs(P.t_set))+' <span class="pb-az">'+P.az_set.toFixed(0)+'°</span>':'—')+'</td>'+
      '<td>'+(P?P.el_peak.toFixed(0)+'°':'—')+'</td>'+
      '<td>'+nvTxt+'</td>'+
      '<td class="'+(age>TLE_STALE_D?'pb-stale':'')+'">'+age.toFixed(1)+' d</td></tr>';
  }).join('');
}

function fmtHMS(sec){
  if(sec<=0) return'IN PASS';
  let h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=Math.floor(sec%60);
  return h>0?h+'h '+padZ(m)+'m':m>0?padZ(m)+'m '+padZ(s)+'s':padZ(s)+'s';
}

function resizeCanvas(c){let r=c.getBoundingClientRect();let w=Math.max(1,Math.round(r.width)),h=Math.max(1,Math.round(r.height));if(c.width!==w||c.height!==h){c.width=w;c.height=h;}}


/* ╔══════════════════════════════════════════════════════════════════╗
   ║  MODULE · SatelliteService — TLE-class tracking (SGP4 engine)     ║
   ║  ActiveSelection array: track several objects simultaneously;     ║
   ║  all orbits/tracks/footprints overlay together, SEL[0] = primary. ║
   ╚══════════════════════════════════════════════════════════════════╝ */
const SEL=[];                                   /* [{tle,color,data,passes,latF,lonF,azF,elF,tF}] */
const SEL_COLORS=['#f0f0f0','#d6b26e','#7fa8d8','#c48fb5','#8fc4a0'];
const SEL_MAX=5;
let HORIZON_S=24*3600;                          /* forecast depth (s) — toggle cluster */
function setHorizon(hours,btn){
  HORIZON_S=hours*3600;
  document.querySelectorAll('.hz-btn').forEach(b=>b.classList.remove('on'));
  if(btn) btn.classList.add('on');
  else{const b=document.querySelector('.hz-btn[data-h="'+hours+'"]');if(b)b.classList.add('on');}
  if(SEL.length) renderAllSel();
  if(typeof STATE!=='undefined') STATE.dirty();
}
function toggleSkyVis(btn){
  SKY_VIS_ONLY=!SKY_VIS_ONLY;
  (btn||document.getElementById('sky-vis-btn')).classList.toggle('on',SKY_VIS_ONLY);
  if(SEL.length) renderAllSel();
  if(typeof STATE!=='undefined') STATE.dirty();
}
function renderSelChips(){
  const box=document.getElementById('sel-chips');if(!box)return;
  box.innerHTML=SEL.map((s,i)=>
    '<span class="sel-chip'+(i===0?' prim':'')+'" style="--c:'+s.color+'" onclick="makePrimary('+s.tle.satnum+')">'+
    (i===0?'◉ ':'')+s.tle.name.slice(0,16)+
    '<i onclick="event.stopPropagation();deselectSat('+s.tle.satnum+')">✕</i></span>').join('')+
    (SEL.length>1?'<span class="sel-hint">'+SEL.length+' TRACKED · CLICK CHIP → PRIMARY</span>':'');
}
function makePrimary(satnum){
  const i=SEL.findIndex(s=>s.tle.satnum===satnum);
  if(i<=0) return;
  SEL.unshift(SEL.splice(i,1)[0]);
  SEL.forEach((s,k)=>s.color=SEL_COLORS[k]);
  renderAllSel();
}
function deselectSat(satnum){
  const i=SEL.findIndex(s=>s.tle.satnum===satnum);
  if(i<0) return;
  const tag='-'+(SEL.length-1);
  if(eciThree) clearOrbit3D(eciThree.scene,tag);
  if(ecefThree) clearOrbit3D(ecefThree.scene,tag);
  SEL.splice(i,1);
  SEL.forEach((s,k)=>s.color=SEL_COLORS[k]);
  syncListHighlight();
  if(SEL.length) renderAllSel();
  else{renderSelChips();window._liveSel=[];renderPassBoard();}
  if(typeof STATE!=='undefined') STATE.dirty();
}
function syncListHighlight(){
  document.querySelectorAll('#sat-list .sat-item').forEach(el=>{
    const sn=parseInt(el.dataset.satnum,10);
    const k=SEL.findIndex(s=>s.tle.satnum===sn);
    el.classList.toggle('active',k===0);
    el.classList.toggle('co-sel',k>0);
    el.style.setProperty('--selc',k>=0?SEL[k].color:'transparent');
  });
}

/* ════ META + NEXT-VISIBLE-PASS (primary target) ════ */
let _nextVisAbs=null,_nextVisEndAbs=null,_nextVisPk=0,_nextVisToken=0;

function updateMeta(tle,passes,now){
  document.getElementById('selected-sat-name').textContent=tle.name;
  document.getElementById('norad-id').textContent='NORAD: '+tle.satnum+'  ·  '+tle.orbitType;
  document.getElementById('m-alt').textContent=tle.alt_km.toFixed(0)+' km';
  document.getElementById('m-period').textContent=(tle.T_s/60).toFixed(2)+' min';
  document.getElementById('m-inc').textContent=tle.inc.toFixed(4)+'°';
  document.getElementById('m-ecc').textContent=tle.ecc.toFixed(7);
  document.getElementById('m-type').textContent=tle.orbitType;
  document.getElementById('m-fp').textContent=tle.fp_km.toFixed(0)+' km';
  document.getElementById('oe-a').textContent=tle.a.toFixed(1)+' km';
  document.getElementById('oe-e').textContent=tle.ecc.toFixed(7);
  document.getElementById('oe-i').textContent=tle.inc.toFixed(4);
  document.getElementById('oe-raan').textContent=tle.raan.toFixed(4);
  document.getElementById('oe-argp').textContent=tle.argp.toFixed(4);
  document.getElementById('oe-M').textContent=tle.M.toFixed(4);
  document.getElementById('oe-b').textContent=tle.bstar.toExponential(3);
  document.getElementById('oe-ep').textContent=fmtDateUTC(tle.epoch)+' ('+tleAgeDays(tle).toFixed(1)+' d)';

  let nextPass=passes.find(p=>p.t_set>0);
  if(nextPass){
    let riseAbs=new Date(now.getTime()+nextPass.t_rise*1000);
    let setAbs=new Date(now.getTime()+nextPass.t_set*1000);
    document.getElementById('m-rise').textContent=fmtLocalTime(riseAbs,SITE.tz).slice(0,8);
    document.getElementById('m-rise-local').textContent=fmtUTCShort(riseAbs);
    document.getElementById('m-set').textContent=fmtLocalTime(setAbs,SITE.tz).slice(0,8);
    document.getElementById('m-set-local').textContent=fmtUTCShort(setAbs);
    document.getElementById('m-ttr').textContent=fmtHMS(nextPass.t_rise);
    let elv=nextPass.el_peak;
    document.getElementById('m-elev').textContent=elv.toFixed(1)+'°';
    document.getElementById('m-elev').className='mv'+(elv>30?' green':elv>10?' amber':'');
  } else {
    ['m-rise','m-rise-local','m-set','m-set-local','m-ttr'].forEach(id=>document.getElementById(id).textContent='—');
    document.getElementById('m-elev').textContent='NO PASS';
  }

  /* NEXT VISIBLE PASS chip — first visible pass inside the 5-rev window, else deep 48 h scan */
  const nv=document.getElementById('m-nextvis');
  _nextVisAbs=null;_nextVisEndAbs=null;_nextVisPk=0;
  let firstVis=passes.find(p=>p.visible&&p.t_vis1>0);
  if(firstVis){
    _nextVisAbs=new Date(now.getTime()+firstVis.t_vis0*1000);
    _nextVisEndAbs=new Date(now.getTime()+firstVis.t_vis1*1000);
    _nextVisPk=firstVis.el_visPeak;
    nv.textContent=fmtLocalShort(_nextVisAbs,SITE.tz)+' · pk '+_nextVisPk.toFixed(0)+'°';
    nv.className='mv green';
  } else {
    nv.textContent='SCANNING 48 h…';nv.className='mv';
    const token=++_nextVisToken,tleRef=tle;
    setTimeout(()=>{
      if(token!==_nextVisToken||currentTLE!==tleRef) return;
      const win=findNextVisible(tleRef,48);
      if(token!==_nextVisToken||currentTLE!==tleRef) return;
      if(win){
        _nextVisAbs=new Date(now.getTime()+win.t0*1000);
        _nextVisEndAbs=new Date(now.getTime()+win.t1*1000);
        _nextVisPk=win.elPk;
        nv.textContent=fmtLocalShort(_nextVisAbs,SITE.tz)+' · pk '+_nextVisPk.toFixed(0)+'°';
        nv.className='mv green';
      } else {nv.textContent='NONE ≤48 h';nv.className='mv';}
    },60);
  }

  /* Pass table with VIS column */
  lastPasses=passes;
  let tbody=document.getElementById('pass-table-body');
  let wrap=document.getElementById('pass-table-wrap');
  tbody.innerHTML='<div class="pass-row hdr"><span>RISE LOCAL</span><span>SET LOCAL</span><span>EL</span><span>DUR</span><span>AZr</span><span>VIS</span></div>';
  /* the old overlay table is retired; the pass board replaces it */
  passes.slice(0,10).forEach(p=>{
    let r=new Date(now.getTime()+p.t_rise*1000);
    let s=new Date(now.getTime()+p.t_set*1000);
    let dur=Math.max(0,p.t_set-p.t_rise);
    let chip=p.visible?'<span class="vis-chip vc-vis" title="Sunlit satellite over a dark site — naked-eye visible">VIS</span>'
      :p.why==='ECL'?'<span class="vis-chip vc-ecl" title="Satellite inside Earth\'s shadow at culmination">ECL</span>'
      :'<span class="vis-chip vc-day" title="Sky too bright (Sun above −6°)">DAY</span>';
    let row=document.createElement('div');row.className='pass-row'+(p.visible?' is-vis':'');
    row.innerHTML=`<span class="pr-rise">${fmtLocalShort(r,SITE.tz)}</span>`+
      `<span class="pr-set">${fmtLocalShort(s,SITE.tz)}</span>`+
      `<span class="pr-el">${p.el_peak.toFixed(0)}°</span>`+
      `<span class="pr-dur">${Math.floor(dur/60)}m${padZ(Math.floor(dur%60))}s</span>`+
      `<span class="pr-az">${p.az_rise.toFixed(0)}°</span>`+chip;
    tbody.appendChild(row);
  });
}

/* ════ V2 · CSV EXPORT (adds visibility columns) ════ */
function exportCSV(){
  if(!currentTLE||!lastPasses.length) return;
  let now=propagationTime||new Date();
  let rows=['RISE_LOCAL,SET_LOCAL,RISE_UTC,SET_UTC,DURATION_s,PEAK_EL_deg,AZ_RISE_deg,AZ_SET_deg,AZ_PEAK_deg,VISIBLE,VIS_START_UTC,VIS_END_UTC,VIS_PEAK_EL_deg'];
  lastPasses.forEach(p=>{
    let r=new Date(now.getTime()+p.t_rise*1000);
    let s=new Date(now.getTime()+p.t_set*1000);
    let dur=Math.max(0,p.t_set-p.t_rise);
    let rLocal=fmtLocalTime(r,SITE.tz).slice(0,8);
    let sLocal=fmtLocalTime(s,SITE.tz).slice(0,8);
    let v0=p.visible?new Date(now.getTime()+p.t_vis0*1000).toISOString():'';
    let v1=p.visible?new Date(now.getTime()+p.t_vis1*1000).toISOString():'';
    rows.push([rLocal,sLocal,r.toISOString(),s.toISOString(),dur.toFixed(1),p.el_peak.toFixed(2),
      p.az_rise.toFixed(2),p.az_set.toFixed(2),p.az_peak.toFixed(2),
      p.visible?'YES':'NO ('+p.why+')',v0,v1,p.visible?p.el_visPeak.toFixed(2):''].join(','));
  });
  let blob=new Blob([rows.join('\n')],{type:'text/csv'});
  let a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=currentTLE.name.replace(/\s+/g,'_')+'_passes.csv';a.click();
}

/* ════ V2 · RENDER ALL ════ */
function renderAllSel(){
  if(!SEL.length) return;
  const prim=SEL[0];
  let propLabel=prim.tle.satrec?'SGP4/SDP4':'TWO-BODY';
  let es=document.getElementById('eci-prop-status');
  let ef=document.getElementById('ecef-prop-status');
  if(es) es.textContent=propLabel+' · TEME · '+SEL.length+' OBJ · DRAG/SCROLL';
  if(ef) ef.textContent=propLabel+' · WGS-84 · '+SEL.length+' OBJ · DRAG/SCROLL';

  const anchor=new Date(EPOCH.ms()-300000);   /* shared epoch — all selections in lockstep */
  SEL.forEach((s,si)=>{
    s.color=SEL_COLORS[si];
    s.data=propagate(s.tle,HORIZON_S,anchor);
    const{tArr,az,el,lat,lon,sunlit,sunAlt}=s.data;
    s.tF=Array.from(tArr);s.azF=Array.from(az);s.elF=Array.from(el);
    s.latF=Array.from(lat);s.lonF=Array.from(lon);
    s.passes=findPasses(s.azF,s.elF,s.tF,sunlit,sunAlt);
  });
  /* legacy globals stay bound to the primary (live meta, CSV, overlays) */
  currentTLE=prim.tle;currentData=prim.data;currentPasses=prim.passes;
  propagationTime=prim.data.now;propagationGMST0=prim.data.GMST0;

  /* 3-D: one tagged orbit per selection in its color */
  for(let k=0;k<SEL_MAX;k++){
    if(eciThree) clearOrbit3D(eciThree.scene,'-'+k);
    if(ecefThree) clearOrbit3D(ecefThree.scene,'-'+k);
  }
  SEL.forEach((s,si)=>{
    const{xECI,xECEF,N}=s.data;
    const eciPts=[],ecefPts=[];
    for(let k=0;k<=N;k++){
      /* decayed / corrupt element sets can emit NaN — never let it reach the GPU */
      if(isFinite(xECI[3*k])&&isFinite(xECI[3*k+1])&&isFinite(xECI[3*k+2]))
        eciPts.push([xECI[3*k],xECI[3*k+1],xECI[3*k+2]]);
      if(isFinite(xECEF[3*k])&&isFinite(xECEF[3*k+1])&&isFinite(xECEF[3*k+2]))
        ecefPts.push([xECEF[3*k],xECEF[3*k+1],xECEF[3*k+2]]);
    }
    const c=parseInt(s.color.slice(1),16);
    if(eciThree) drawOrbit3D(eciThree.scene,eciPts,c,'-'+si,c);
    if(ecefThree) drawOrbit3D(ecefThree.scene,ecefPts,c,'-'+si,c);
  });

  const gtC=document.getElementById('gt-canvas');resizeCanvas(gtC);
  const skyC=document.getElementById('sky-canvas');resizeCanvas(skyC);
  const doGT=()=>{
    gtC._bg=null;
    drawGroundTrack(gtC,SEL);
    gtC._bg=cloneCanvas(gtC);
    _gtLast=0;
  };
  if(worldMapImg) doGT(); else loadWorldMap(()=>doGT());

  skyC._bg=null;
  drawSkyPlot(skyC,SEL);
  skyC._bg=cloneCanvas(skyC);
  _skyLast=0;_metaLast=0;

  updateMeta(prim.tle,prim.passes,prim.data.now);
  renderPassBoard();
  renderSelChips();
  syncListHighlight();
  overlayPasses();
  if(typeof STATE!=='undefined') STATE.dirty();
}
/* back-compat shim (timers, applySite, boot paths) */
function renderAll(tle){
  if(tle&&!SEL.find(s=>s.tle===tle)&&SEL.length===0) SEL.push({tle,color:SEL_COLORS[0]});
  renderAllSel();
}

/* ════ V2 · TIMERS — markers run at 60 fps in masterLoop; only re-prop is timed ════ */
const TRAJ_REPROP_MS = 60 * 60 * 1000;
function startTimers(){
  clearInterval(trajTimer);
  trajTimer=setInterval(()=>{
    if(SEL.length){
      document.getElementById('refresh-countdown').textContent='REFRESHING TRAJ…';
      setTimeout(()=>{
        renderAllSel();
        document.getElementById('refresh-countdown').textContent='LIVE 60 fps · TRAJ 60 min';
      },50);
    }
  }, TRAJ_REPROP_MS);
  document.getElementById('refresh-countdown').textContent='LIVE 60 fps · TRAJ 60 min';
}

/* ════ SELECT SAT — toggles membership in the ActiveSelection array ════ */
let activeItem=null;
function selectSat(tle,itemEl){
  const i=SEL.findIndex(s=>s.tle.satnum===tle.satnum);
  if(i>=0){deselectSat(tle.satnum);return;}
  if(SEL.length>=SEL_MAX) SEL.pop();
  SEL.push({tle,color:SEL_COLORS[SEL.length]});
  initThreeScenes();
  renderAllSel();
  startTimers();
}

/* ════ V2 · PASS QUALITY — adds true-visibility tier ('vis') ════ */
function getPassQuality(tle){
  try{
    let now=new Date();
    let siteECEF=geo2ecef(SITE.lat_deg,SITE.lon_deg,SITE.h_m);
    let Re2enu=topoRotm(SITE.lat_deg,SITE.lon_deg);
    let T=Math.min(tle.T_s,7200);
    let step=T/60;
    let maxEl=-90,anyVis=false;
    let sunU=null,sunAlt=0,sunT=-1e9;

    if(tle.satrec){
      for(let k=0;k<=60;k++){
        let t=k*step;
        let d=new Date(now.getTime()+t*1000);
        let pv=sgp4ECI(tle.satrec,d);
        if(!pv) continue;
        let[rx,ry,rz]=pv.r;
        let GMST=gmst_from_jd(julianDate(d));
        let ct=Math.cos(GMST),st=Math.sin(GMST);
        let fx=ct*rx+st*ry,fy=-st*rx+ct*ry,fz=rz;
        let rho=[fx-siteECEF[0],fy-siteECEF[1],fz-siteECEF[2]];
        let enu=mv3(Re2enu,rho);
        let U_=enu[2],rng=Math.sqrt(enu[0]**2+enu[1]**2+enu[2]**2);
        let el=Math.asin(Math.max(-1,Math.min(1,U_/rng)))*180/Math.PI;
        if(el>maxEl) maxEl=el;
        if(el>VIS_EL_MIN&&!anyVis){
          if(t-sunT>=300){
            let sp=sunPos(d);
            sunU=[Math.cos(sp.dec)*Math.cos(sp.ra),Math.cos(sp.dec)*Math.sin(sp.ra),Math.sin(sp.dec)];
            sunAlt=eqToAltAz(sp.ra,sp.dec,d,SITE.lat_deg,SITE.lon_deg).alt;
            sunT=t;
          }
          if(sunAlt<VIS_SUN_MAX&&isSunlit([rx,ry,rz],sunU)) anyVis=true;
        }
      }
    } else {
      let dt_ep=(now.getTime()-tle.epoch.getTime())/1000;
      let M_now=((tle.M*Math.PI/180+tle.n_rad*dt_ep)%(2*Math.PI)+2*Math.PI)%(2*Math.PI);
      let e=tle.ecc,a=tle.a,inc_r=tle.inc*Math.PI/180;
      let RAAN=tle.raan*Math.PI/180,argp=tle.argp*Math.PI/180;
      let nu=trueFromMean(M_now,e);let p_=a*(1-e*e),r_=p_/(1+e*Math.cos(nu));
      let C=dcmPQW2ECI(RAAN,inc_r,argp);let sqp=Math.sqrt(MU_E/p_);
      let rECI=mv3(C,[r_*Math.cos(nu),r_*Math.sin(nu),0]);
      let vECI=mv3(C,[-sqp*Math.sin(nu),sqp*(e+Math.cos(nu)),0]);
      let x=[rECI[0],rECI[1],rECI[2],vECI[0],vECI[1],vECI[2]];
      let GMST0=gmst_from_jd(julianDate(now));
      for(let k=0;k<=60;k++){
        let t=k*step,th=GMST0+WE*t,ct=Math.cos(th),st=Math.sin(th);
        let fx=ct*x[0]+st*x[1],fy=-st*x[0]+ct*x[1],fz=x[2];
        let rho=[fx-siteECEF[0],fy-siteECEF[1],fz-siteECEF[2]];
        let enu=mv3(Re2enu,rho);let U_=enu[2],rng=Math.sqrt(enu[0]**2+enu[1]**2+enu[2]**2);
        let el=Math.asin(Math.max(-1,Math.min(1,U_/rng)))*180/Math.PI;
        if(el>maxEl) maxEl=el;
        if(k<60) x=rk4(x,step);
      }
    }
    if(anyVis) return 'vis';
    if(maxEl>30) return 'soon';
    if(maxEl>0) return 'later';
    return 'none';
  }catch(e){return'none';}
}

/* ════ POPULATE LIST ════ */
let allSats=[];
let _plToken=0;
function satItem(tle){
  let div=document.createElement('div');div.className='sat-item';
  div.dataset.satnum=tle.satnum;
  const age=tleAgeDays(tle);
  div.innerHTML=`<div class="sat-name">${tle.name}</div>`+
    `<div class="sat-meta-row">`+
    `<span class="sat-meta">NORAD ${tle.satnum}</span>`+
    `<span class="orbit-badge badge-${tle.orbitType}">${tle.orbitType}</span>`+
    `<span class="sat-inc">${tle.inc.toFixed(1)}°</span>`+
    (age>7?`<span class="sat-age${age>TLE_STALE_D?' stale':''}" title="TLE epoch ${fmtDateUTC(tle.epoch)} UTC">${age.toFixed(0)} d old</span>`:'')+
    `<span class="pass-indicator pi-none" id="pi-${tle.satnum}"></span>`+
    `</div>`;
  div.addEventListener('click',()=>selectSat(tle,div));
  return div;
}
/* add rows to the end of the list as data arrives */
/* The list shows at most LIST_CAP rows; search reaches everything loaded.
   Tens of thousands of rows make the page sluggish for no benefit. */
const LIST_CAP=400;
let _listShown=0,_listTotal=0;
function appendList(sats,reset){
  const list=document.getElementById('sat-list');
  if(reset){_listShown=0;_listTotal=0;}
  _listTotal+=sats.length;
  const room=Math.max(0,LIST_CAP-_listShown);
  if(room){
    const frag=document.createDocumentFragment();
    sats.slice(0,room).forEach(t=>frag.appendChild(satItem(t)));
    _listShown+=Math.min(room,sats.length);
    const more=document.getElementById('list-more');
    if(more) list.insertBefore(frag,more); else list.appendChild(frag);
  }
  let more=document.getElementById('list-more');
  if(_listTotal>_listShown){
    if(!more){more=document.createElement('div');more.id='list-more';more.className='loading-list';list.appendChild(more);}
    more.textContent='Showing the first '+_listShown+' of '+_listTotal+'. Search by name or NORAD ID to reach the rest.';
  } else if(more) more.remove();
}
function checkQuality(sats){
  let toCheck=sats.slice(0,40);
  const token=++_plToken;
  function checkNext(i){
    if(token!==_plToken||i>=toCheck.length) return;
    let tle=toCheck[i];
    let q=getPassQuality(tle);
    let el=document.getElementById('pi-'+tle.satnum);
    if(el){el.className='pass-indicator pi-'+q;el.title=q==='vis'?'Visible pass within one period':q==='soon'?'High pass (>30° EL) within one period':q==='later'?'Pass within one period':'No pass within one period';}
    setTimeout(()=>checkNext(i+1),20);
  }
  checkNext(0);
}
function populateList(sats){
  let list=document.getElementById('sat-list');list.innerHTML='';
  if(sats.length===0){list.innerHTML='<div class="loading-list">No satellites found.</div>';return;}
  appendList(sats,true);
  syncListHighlight();
  document.getElementById('sat-count').textContent=sats.length+' objects';
  checkQuality(sats);
}

function filterList(q){
  const raw=q.trim();q=raw.toLowerCase();
  const hits=allSats.filter(t=>t.name.toLowerCase().includes(q)||String(t.satnum).includes(q));
  populateList(hits);
  if(raw.length>=3){
    const list=document.getElementById('sat-list');
    const box=document.createElement('div');box.className='search-more';
    const safe=raw.replace(/[<>"']/g,'');
    box.innerHTML=(hits.length?'':'<div class="sm-note">Not in the loaded group.</div>')+
      '<button class="hud-btn" onclick="searchCelestrak(\''+safe+'\')">Search full CelesTrak catalog for “'+safe+'”</button>'+
      '<button class="hud-btn" onclick="searchHorizons(\''+safe+'\')">Look up “'+safe+'” in JPL Horizons</button>';
    if(!hits.length) list.innerHTML='';
    list.appendChild(box);
  }
}
/* CelesTrak GP query by name (or NORAD id) across the whole public catalog */
async function searchCelestrak(q){
  const list=document.getElementById('sat-list');
  list.innerHTML='<div class="loading-list">Searching CelesTrak for “'+q+'”…</div>';
  const base=/^\d+$/.test(q)?'https://celestrak.org/NORAD/elements/gp.php?CATNR='+q+'&FORMAT=tle'
                           :'https://celestrak.org/NORAD/elements/gp.php?NAME='+encodeURIComponent(q)+'&FORMAT=tle';
  let txt=null;
  for(const u of urlChain(base)){
    try{const r=await fetch(u,{signal:fetchTimeoutSignal(15000)});if(r.ok){txt=await r.text();break;}}catch(e){}
  }
  const found=txt&&/^1 /m.test(txt)?parseCatalog(txt):[];
  if(!found.length){
    list.innerHTML='<div class="loading-list">'+(txt===null?'Could not reach CelesTrak.':'CelesTrak has no TLE matching “'+q+'”.')+
      '<br>Objects beyond Earth orbit (CAPSTONE, Artemis) have no TLE.</div>';
    const b=document.createElement('div');b.className='search-more';
    b.innerHTML='<button class="hud-btn" onclick="searchHorizons(\''+q+'\')">Look up “'+q+'” in JPL Horizons</button>';
    list.appendChild(b);
    return;
  }
  found.forEach(t=>{if(!allSats.find(x=>x.satnum===t.satnum)) allSats.unshift(t);});
  populateList(found);
  document.getElementById('sat-count').textContent=found.length+' found';
}
function searchHorizons(q){
  switchView('eph');
  const inp=document.getElementById('eph-custom-inp');
  inp.value=q;EPH.customLookup();inp.focus();
}
document.getElementById('search-input').addEventListener('input',e=>filterList(e.target.value));
let oeExpanded=true,siteExpanded=true;
function toggleOE(){oeExpanded=!oeExpanded;document.getElementById('oe-grid').style.display=oeExpanded?'grid':'none';document.getElementById('oe-toggle-btn').textContent=oeExpanded?'▾':'▸';}
function toggleSite(){siteExpanded=!siteExpanded;document.getElementById('site-form').style.display=siteExpanded?'flex':'none';document.getElementById('site-toggle-btn').textContent=siteExpanded?'▾':'▸';}

async function applySite(){
  let lat=parseFloat(document.getElementById('inp-lat').value);
  let lon=parseFloat(document.getElementById('inp-lon').value);
  let h=parseFloat(document.getElementById('inp-alt').value)||0;
  if(isNaN(lat)||isNaN(lon)) return;
  lat=Math.max(-90,Math.min(90,lat));
  lon=((lon+180)%360+360)%360-180;
  document.getElementById('site-tz-display').textContent='TZ: detecting…';
  let tz=await lookupTimezone(lat,lon);
  tz=tz||'UTC';
  let offsetMin=computeTZOffsetMin(tz);
  SITE={lat_deg:lat,lon_deg:lon,h_m:h,tz,tzOffsetMin:offsetMin};
  document.getElementById('inp-lat').value=lat.toFixed(4);
  document.getElementById('inp-lon').value=lon.toFixed(4);
  document.getElementById('site-label-gt').textContent='⬟ '+lat.toFixed(2)+'°N '+Math.abs(lon).toFixed(2)+'°'+(lon>=0?'E':'W');
  updateLocalTZLabel();
  siteButtonText();
  if(typeof EPH!=='undefined') EPH.onSiteChange();
  if(currentTLE){currentData=null;renderAll(currentTLE);}
  setTimeout(fetchConditions,400);
}

async function geolocateMe(){
  if(!navigator.geolocation){alert('Geolocation not available');return;}
  document.getElementById('site-tz-display').textContent='TZ: locating…';
  navigator.geolocation.getCurrentPosition(async pos=>{
    let lat=pos.coords.latitude,lon=pos.coords.longitude,h=pos.coords.altitude;
    document.getElementById('inp-lat').value=lat.toFixed(4);
    document.getElementById('inp-lon').value=lon.toFixed(4);
    if(h!==null&&isFinite(h)) document.getElementById('inp-alt').value=Math.round(h);
    await applySite();
  },err=>{document.getElementById('site-tz-display').textContent='TZ: geolocation denied';});
}

/* ════ CLICK TO MOVE SITE ON GROUND TRACK ════ */
function setupGTClick(){
  let gtC=document.getElementById('gt-canvas');
  gtC.addEventListener('click',async e=>{
    let r=gtC.getBoundingClientRect();
    let px=(e.clientX-r.left)/r.width;
    let py=(e.clientY-r.top)/r.height;
    let lon=px*360-180;
    let lat=90-py*180;
    document.getElementById('inp-lat').value=lat.toFixed(4);
    document.getElementById('inp-lon').value=lon.toFixed(4);
    await applySite();
  });
}

/* ════ TLE FETCH & PARSE ════ */
function parseCatalog(raw){
  let lines=raw.split('\n').map(l=>l.trim()).filter(l=>l.length>0);
  let sats=[],n=Math.floor(lines.length/3);
  for(let i=0;i<n;i++){
    let name=lines[3*i];
    if(/^[12] /.test(name)) continue;
    let l1=lines[3*i+1],l2=lines[3*i+2];
    let t=parseTLE(name,l1,l2);
    if(t){t.rawL1=l1;t.rawL2=l2;sats.push(t);}
  }
  return sats;
}
/* CelesTrak refuses to serve the same group twice within its 2-hour update
   cycle ("GP data has not updated since your last successful download"), and
   it counts by network address, so a whole lab behind one address shares the
   limit. Every group is therefore kept in the browser for 2 hours and reused. */
const TLE_TTL_MS=2*3600*1000;
const TLECACHE={
  mem:new Map(),
  async get(url){
    const m=this.mem.get(url);
    if(m) return m;
    try{
      const c=await caches.open('ssa-tle-v1'),r=await c.match(url);
      if(!r) return null;
      const o={t:+r.headers.get('x-saved')||0,text:await r.text()};
      this.mem.set(url,o);return o;
    }catch(e){return null;}
  },
  async put(url,text){
    const o={t:Date.now(),text};this.mem.set(url,o);
    try{const c=await caches.open('ssa-tle-v1');
      await c.put(url,new Response(text,{headers:{'x-saved':String(o.t),'content-type':'text/plain'}}));}catch(e){}
  }
};
const isTLE=t=>/^1 \d{5}/m.test(t)&&/^2 \d{5}/m.test(t)&&!/<html/i.test(t.slice(0,400));
let LAST_TLE_NOTE='';
async function fetchGroup(group){
  const url=`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
  const hit=await TLECACHE.get(url);
  if(hit&&Date.now()-hit.t<TLE_TTL_MS) return hit.text;
  try{
    const r=await fetch(url,{mode:'cors',signal:fetchTimeoutSignal(60000)});
    const t=await r.text();
    if(r.ok&&isTLE(t)){TLECACHE.put(url,t);return t;}
    if(/has not updated/i.test(t)) LAST_TLE_NOTE='CelesTrak limits each group to one download per 2 hours from one network address.';
  }catch(e){}
  return hit?hit.text:null;   /* an older copy beats nothing */
}
/* feed a saved copy through the same batch interface, without blocking the page */
async function replayTLE(text,onBatch,isLive){
  const lines=text.split('\n');let n=0,i=0;
  while(i<lines.length){
    const batch=[],end=Math.min(lines.length,i+3000);
    for(;i+2<end+2&&i+2<lines.length;){
      const a=lines[i].trim(),b=lines[i+1].trim(),c=lines[i+2].trim();
      if(a&&!/^[12] /.test(a)&&/^1 /.test(b)&&/^2 /.test(c)){
        const t=parseTLE(a,b,c);if(t){t.rawL1=b;t.rawL2=c;batch.push(t);}
        i+=3;
      } else i++;
      if(i>=end) break;
    }
    if(i+2>=lines.length) i=lines.length;
    if(!isLive()) return n;
    if(batch.length){n+=batch.length;onBatch(batch);}
    await new Promise(r=>setTimeout(r,0));
  }
  return n;
}
/* Read a CelesTrak TLE response as it downloads and hand over each batch of
   complete element sets, so the list fills while the transfer is still running.
   Returns the number of objects, or -1 if the source could not be read. */
async function streamGroup(group,onBatch,isLive){
  const url=`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
  let count=0,full='';
  LAST_TLE_NOTE='';
  const hit=await TLECACHE.get(url);
  if(hit&&Date.now()-hit.t<TLE_TTL_MS) return replayTLE(hit.text,onBatch,isLive);
  const stale=()=>hit?replayTLE(hit.text,onBatch,isLive):-1;
  try{
    const r=await fetch(url,{mode:'cors',signal:fetchTimeoutSignal(120000)});
    if(!r.ok){
      try{if(/has not updated/i.test(await r.text())) LAST_TLE_NOTE='CelesTrak limits each group to one download per 2 hours from one network address. Try again later.';}catch(e){}
      return stale();
    }
    if(!r.body||!r.body.getReader){
      const txt=await r.text(),sats=parseCatalog(txt);
      if(sats.length){TLECACHE.put(url,txt);onBatch(sats);}
      return sats.length||stale();
    }
    const rd=r.body.getReader(),dec=new TextDecoder();
    let buf='',lines=[],sniffed=false;
    for(;;){
      const{done,value}=await rd.read();
      if(!isLive()){try{rd.cancel();}catch(e){}return count;}
      const piece=done?dec.decode():dec.decode(value,{stream:true});
      buf+=piece;full+=piece;
      if(!sniffed&&buf.length>40){sniffed=true;
        if(/has not updated/i.test(buf)){LAST_TLE_NOTE='CelesTrak limits each group to one download per 2 hours from one network address. Try again later.';try{rd.cancel();}catch(e){}return stale();}
        if(/<html|<!doctype/i.test(buf.slice(0,400))){try{rd.cancel();}catch(e){}return stale();}}
      const parts=buf.split('\n');buf=done?'':parts.pop();
      for(const q of parts){const t=q.trim();if(t) lines.push(t);}
      const batch=[];let i=0;
      while(i+2<lines.length){
        if(!/^[12] /.test(lines[i])&&/^1 /.test(lines[i+1])&&/^2 /.test(lines[i+2])){
          const t=parseTLE(lines[i],lines[i+1],lines[i+2]);
          if(t){t.rawL1=lines[i+1];t.rawL2=lines[i+2];batch.push(t);}
          i+=3;
        } else i++;
      }
      lines=lines.slice(i);
      if(batch.length){count+=batch.length;onBatch(batch);}
      if(done) break;
    }
    if(count) TLECACHE.put(url,full);
    return count;
  }catch(e){return count||stale();}
}
let _catTok=0;
async function loadCategory(group){
  const tok=++_catTok;
  const list=document.getElementById('sat-list'),cnt=document.getElementById('sat-count'),search=document.getElementById('search-input');
  list.innerHTML=`<div class="loading-list">Fetching ${group}…<br><span class="spinner-sm"></span></div>`;
  cnt.textContent='loading…';search.value='';
  allSats=[];
  let first=true;
  const n=await streamGroup(group,batch=>{
    for(const t of batch) allSats.push(t);
    if(!search.value){
      if(first) list.innerHTML='';
      appendList(batch,first);
    }
    first=false;
    cnt.textContent=allSats.length+' objects…';
  },()=>tok===_catTok);
  if(tok!==_catTok) return;
  if(!allSats.length){
    cnt.textContent='0 objects';
    list.innerHTML='<div class="loading-list">'+(LAST_TLE_NOTE||(n<0?'Could not reach CelesTrak for this group.<br>Check the network and pick the group again.':'CelesTrak returned no objects for this group.'))+'</div>';
    return;
  }
  cnt.textContent=allSats.length+' objects';
  syncListHighlight();
  if(search.value) filterList(search.value); else checkQuality(allSats);
}
document.getElementById('cat-select').addEventListener('change',e=>loadCategory(e.target.value));

/* No embedded fallback: the old block carried invented element sets under real
   satellite names. If CelesTrak is unreachable the UI says so instead. */
function getFallbackSats(){return [];}

/* ════ INIT ════ */
let _redrawT=null;
function redrawStatic2D(){
  if(!SEL.length||!SEL[0].data) return;
  const gtC=document.getElementById('gt-canvas'),skyC=document.getElementById('sky-canvas');
  resizeCanvas(gtC);resizeCanvas(skyC);
  if(gtC.width>1){gtC._bg=null;drawGroundTrack(gtC,SEL);gtC._bg=cloneCanvas(gtC);}
  if(skyC.width>1){skyC._bg=null;drawSkyPlot(skyC,SEL);skyC._bg=cloneCanvas(skyC);}
  _gtLast=0;_skyLast=0;
}
function setupResizers(){
  ['gt-canvas','sky-canvas'].forEach(id=>{
    let c=document.getElementById(id);
    new ResizeObserver(()=>{
      clearTimeout(_redrawT);
      _redrawT=setTimeout(()=>{redrawStatic2D();},120);
    }).observe(c.parentElement);
  });
}

/* ════ TLE DOWNLOAD ════ */
function downloadTLE(){
  if(!currentTLE) return;
  // Reconstruct 3-line TLE from parsed fields
  // We need the original raw lines — store them at parse time via rawL1/rawL2
  if(!currentTLE.rawL1||!currentTLE.rawL2){
    alert('Raw TLE lines not available for this satellite. Re-select it from the list.');
    return;
  }
  let content=[currentTLE.name, currentTLE.rawL1, currentTLE.rawL2].join('\n');
  let blob=new Blob([content],{type:'text/plain'});
  let a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=(currentTLE.name.replace(/[^a-zA-Z0-9_\-]/g,'_')||'satellite')+'.tle';
  a.click();
}

let worldMapImg=null,_bpCache=null;
/* Outline ("blueprint") map: land and sea are told apart from the colour of
   the satellite mosaic (sea is blue-dominant), small specks are removed with a
   majority filter, and coastlines are the land pixels that touch sea.
   Built once, then reused. Falls back to a darkened photo if the image
   cannot be read. */
function blueprintMap(img,W0,H0){
  /* 1. land/sea mask, once, at 2048×1024 */
  if(_bpCache===null){
    try{
      const W=2048,H=1024,c=document.createElement('canvas');c.width=W;c.height=H;
      const x=c.getContext('2d');x.drawImage(img,0,0,W,H);
      const p=x.getImageData(0,0,W,H).data;
      let m=new Uint8Array(W*H);
      for(let i=0,k=0;k<W*H;k++,i+=4){const r=p[i],g=p[i+1],b=p[i+2];m[k]=(b>r*1.25&&b>=g)?0:1;}
      const vote=(src,rad,need)=>{const o=new Uint8Array(W*H);
        for(let yy=0;yy<H;yy++)for(let xx=0;xx<W;xx++){let s=0;
          for(let dy=-rad;dy<=rad;dy++){const y2=Math.min(H-1,Math.max(0,yy+dy));
            for(let dx=-rad;dx<=rad;dx++) s+=src[y2*W+((xx+dx+W)%W)];}
          o[yy*W+xx]=s>=need?1:0;}
        return o;};
      m=vote(m,1,5);m=vote(m,2,13);
      _bpCache={mask:m,W,H,draw:null,dw:0,dh:0};
    }catch(e){_bpCache=false;}   /* image not readable (cross-origin): use the darkened photo */
  }
  if(!_bpCache) return null;
  /* 2. outline drawn at the size it is shown, so coastlines stay one crisp pixel */
  const C=_bpCache;
  if(C.draw&&C.dw===W0&&C.dh===H0) return C.draw;
  const c=document.createElement('canvas');c.width=W0;c.height=H0;
  const x=c.getContext('2d'),d=x.createImageData(W0,H0),p=d.data;
  const s=new Uint8Array(W0*H0);
  for(let yy=0;yy<H0;yy++){const sy=Math.min(C.H-1,(yy*C.H/H0)|0);
    for(let xx=0;xx<W0;xx++) s[yy*W0+xx]=C.mask[sy*C.W+Math.min(C.W-1,(xx*C.W/W0)|0)];}
  for(let k=0,i=0;k<W0*H0;k++,i+=4){
    const yy=(k/W0)|0,xx=k-yy*W0;let v=4;
    if(s[k]){
      const coast=(xx>0&&!s[k-1])||(xx<W0-1&&!s[k+1])||(yy>0&&!s[k-W0])||(yy<H0-1&&!s[k+W0]);
      v=coast?150:20;
    }
    p[i]=p[i+1]=p[i+2]=v;p[i+3]=255;
  }
  x.putImageData(d,0,0);
  C.draw=c;C.dw=W0;C.dh=H0;
  return c;
}
function loadWorldMap(cb){
  if(worldMapImg){cb(worldMapImg);return;}
  let img=new Image();img.crossOrigin='anonymous';
  img.src='https://raw.githubusercontent.com/turban/webgl-earth/master/images/2_no_clouds_4k.jpg';
  img.onload=()=>{worldMapImg=img;cb(img);};
  img.onerror=()=>{
    let cv=document.createElement('canvas');cv.width=1080;cv.height=540;
    let ctx=cv.getContext('2d');
    let g=ctx.createLinearGradient(0,0,0,540);g.addColorStop(0,'#141414');g.addColorStop(1,'#080808');
    ctx.fillStyle=g;ctx.fillRect(0,0,1080,540);
    ctx.fillStyle='#202020';
    [[80,80,220,280],[160,290,120,200],[460,80,100,180],[460,180,140,240],[560,70,380,210],[790,310,150,110]].forEach(([x,y,w,h])=>{
      ctx.beginPath();ctx.roundRect(x,y,w,h,18);ctx.fill();
    });
    ctx.fillStyle='#2a2a2a';ctx.fillRect(0,505,1080,35);
    ctx.strokeStyle='rgba(165,165,165,0.07)';ctx.lineWidth=0.5;
    for(let g2=0;g2<=1080;g2+=90){ctx.beginPath();ctx.moveTo(g2,0);ctx.lineTo(g2,540);ctx.stroke();}
    for(let g2=0;g2<=540;g2+=45){ctx.beginPath();ctx.moveTo(0,g2);ctx.lineTo(1080,g2);ctx.stroke();}
    worldMapImg=cv;cb(cv);
  };
}

/* ════ OBSERVING CONDITIONS ════
   Sources:
   - 7Timer ASTRO API  → cloud, seeing, transparency, wind
   - SunCalc math      → darkness / limiting magnitude (client-side)
   - AirNow API        → smoke / AQI
================================================================ */

/* --- Sun/Moon math (no external lib needed) --- */
const DEG=Math.PI/180;
function jd(d){return d.getTime()/86400000+2440587.5;}

function sunPos(d){
  let T=(jd(d)-2451545)/36525;
  let L=(280.46646+36000.76983*T)%360;
  let M=(357.52911+35999.05029*T-0.0001537*T*T)*DEG;
  let C=(1.914602-0.004817*T-0.000014*T*T)*Math.sin(M)+(0.019993-0.000101*T)*Math.sin(2*M)+0.000289*Math.sin(3*M);
  let lon=(L+C)*DEG;
  let e=23.439291*DEG;
  let ra=Math.atan2(Math.cos(e)*Math.sin(lon),Math.cos(lon));
  let dec=Math.asin(Math.sin(e)*Math.sin(lon));
  return{ra,dec};
}

function moonPos(d){
  let T=(jd(d)-2451545)/36525;
  let L=(218.3164477+481267.88123421*T)*DEG;
  let M=(357.5291092+35999.0502909*T)*DEG;
  let Mm=(134.9634114+477198.8676313*T)*DEG;
  let D=(297.8502042+445267.1115168*T)*DEG;
  let F=(93.2720993+483202.0175273*T)*DEG;
  let lon=L+6.289*DEG*Math.sin(Mm)-1.274*DEG*Math.sin(2*D-Mm)+0.658*DEG*Math.sin(2*D)
          -0.214*DEG*Math.sin(2*Mm)-0.114*DEG*Math.sin(2*F)+1.274*DEG*Math.sin(2*D-M-Mm)+0.658*DEG*Math.sin(2*D-M);
  let lat=5.128*DEG*Math.sin(F)+0.281*DEG*Math.sin(Mm+F)-0.278*DEG*Math.sin(Mm-F)-0.173*DEG*Math.sin(2*D-F);
  let ra=Math.atan2(Math.cos(23.44*DEG)*Math.sin(lon),Math.cos(lon));
  let dec=Math.asin(Math.sin(23.44*DEG)*Math.sin(lon)*Math.cos(lat)+Math.sin(lat)*Math.cos(23.44*DEG));
  let phase=0.5*(1-Math.cos(D*2)); // 0=new,1=full
  return{ra,dec,phase};
}

function altAz(raDec,d,lat,lon){
  // Hour angle
  let T=(jd(d)-2451545)/36525;
  let gmst=((280.46061837+360.98564736629*(jd(d)-2451545))%360+360)%360;
  let lst=(gmst+lon)*DEG;
  let ha=lst-raDec.ra;
  let sinAlt=Math.sin(raDec.dec)*Math.sin(lat*DEG)+Math.cos(raDec.dec)*Math.cos(lat*DEG)*Math.cos(ha);
  let alt=Math.asin(Math.max(-1,Math.min(1,sinAlt)))/DEG;
  return{alt};
}

function limitingMag(d,lat,lon){
  let sun=sunPos(d);let moon=moonPos(d);
  let sunAlt=altAz(sun,d,lat,lon).alt;
  let moonAlt=altAz(moon,d,lat,lon).alt;

  // Daytime/twilight
  if(sunAlt>0) return{lm:null,label:'DAY',dark:0};
  if(sunAlt>-6) return{lm:null,label:'CIVIL',dark:1};
  if(sunAlt>-12) return{lm:3.5,label:'NAUT',dark:2};
  if(sunAlt>-18) return{lm:5.0,label:'ASTRO',dark:3};

  // Night — moon contribution (simplified Krisciunas-Schaefer)
  let base=6.8; // limiting mag at zenith, dark sky, no moon
  if(moonAlt>0){
    let moonFrac=moon.phase; // 0=new,1=full
    let moonPenalty=moonFrac*moonFrac*2.5; // up to ~2.5 mag loss at full moon
    let altBonus=Math.max(0,(moonAlt/90)*0.5);
    base=Math.max(3.5,base-moonPenalty+altBonus);
  }
  return{lm:parseFloat(base.toFixed(1)),label:'NIGHT',dark:4+(moonAlt>0?0:1)};
}

/* Darkness color: dark=0 day, 1 civil, 2 naut, 3 astro, 4 night+moon, 5 night dark */
function darkColor(darkLevel){
  return['#ffffff','#e0e0e0','#e0e0e0','#929292','#272727','#040404'][Math.min(5,darkLevel)];
}

/* --- 7Timer fetch --- */
/* --- Open-Meteo fetch (CORS-safe, no key needed) --- */
async function fetchWeather(lat,lon){
  // Use observer's IANA timezone so Open-Meteo returns times in local time
  let tz=encodeURIComponent(SITE.tz||'UTC');
  let url=`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    +`&hourly=cloud_cover,wind_speed_10m,precipitation_probability,cape,lifted_index,dewpoint_2m,temperature_2m`
    +`&forecast_days=2&timezone=${tz}`;
  try{
    let r=await fetch(url,{signal:fetchTimeoutSignal(30000)});
    if(r.ok){
      let j=await r.json();
      if(j&&j.hourly) return j.hourly;
    }
  }catch(e){}
  return null;
}

/* --- AirNow fetch --- */
async function fetchAQI(lat,lon){
  let omUrl=`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=us_aqi,pm2_5`;
  try{
    let r=await fetch(omUrl,{signal:fetchTimeoutSignal(6000)});
    if(r.ok){
      let j=await r.json();
      if(j&&j.current) return{aqi:j.current.us_aqi,pm25:j.current.pm2_5};
    }
  }catch(e){}
  return null;
}

/* --- Derive seeing (1-5) from CAPE + lifted index --- */
function deriveSee(cape,li){
  // Lifted index: positive=stable(good seeing), negative=unstable(bad seeing)
  // CAPE: 0=stable, >500=convective
  if(li===null||li===undefined) return 3;
  if(li>4&&(cape||0)<100) return 5;   // excellent
  if(li>2&&(cape||0)<300) return 4;   // good
  if(li>0) return 3;                   // average
  if(li>-2) return 2;                  // poor
  return 1;                            // bad
}

/* --- Derive transparency (1-8) from dewpoint depression --- */
function deriveTrans(temp,dew,cloud){
  if(cloud>75) return 1; // too cloudy
  let dep=temp-dew; // dewpoint depression — higher=drier=more transparent
  if(dep>20) return 8;
  if(dep>15) return 7;
  if(dep>12) return 6;
  if(dep>9)  return 5;
  if(dep>6)  return 4;
  if(dep>3)  return 3;
  return 2;
}

/* --- Color helpers --- */
function cloudColor(v){ // 0-100% cloud cover
  if(v<=10) return'#1f1f1f';
  if(v<=25) return'#363636';
  if(v<=40) return'#9e9e9e';
  if(v<=55) return'#cbcbcb';
  if(v<=70) return'#bdbdbd';
  if(v<=85) return'#757575';
  return'#2e2e2e';
}
function seeingColor(v){ // 1=bad..5=excellent
  const c=['#2e2e2e','#757575','#b5b5b5','#9e9e9e','#828282'];
  return c[Math.min(4,Math.max(0,v-1))];
}
function transpColor(v){ // 1=poor..8=excellent
  const c=['#2e2e2e','#333333','#5c5c5c','#9f9f9f','#838383','#535353','#404040','#262626'];
  return c[Math.min(7,Math.max(0,v-1))];
}
function windColor(v){ // m/s
  if(v<3) return '#3c3c3c';
  if(v<6) return '#727272';
  if(v<10) return '#8d8d8d';
  if(v<15) return '#757575';
  return '#353535';
}
function smokeColor(aqi){
  if(aqi===null||aqi===undefined) return'#1a1a1a';
  if(aqi<=50) return'#1f1f1f';
  if(aqi<=100) return'#808080';
  if(aqi<=150) return'#757575';
  if(aqi<=200) return'#2e2e2e';
  return'#151515';
}

/* --- Tooltip text --- */
const wxTip={
  cloud:v=>'Cloud cover: '+v+'%',
  seeing:v=>{const l=['Bad 1/5','Poor 2/5','Average 3/5','Good 4/5','Excellent 5/5'];return'Seeing: '+l[Math.min(4,v-1)];},
  transp:v=>{const l=['Poor','Below Avg','Below Avg','Average','Above Avg','Transparent','Transparent','Transparent'];return'Transparency: '+l[Math.min(7,v-1)];},
  wind:v=>v.toFixed(1)+' m/s · '+(v*1.944).toFixed(0)+' kt',
  dark:(d,lm)=>d.label+(lm!==null?' · LimMag '+lm:''),
  smoke:aqi=>aqi===null?'AQI: No data':'AQI '+aqi+(aqi<=50?' · Good':aqi<=100?' · Moderate':aqi<=150?' · Unhealthy (sensitive)':' · Unhealthy')
};

/* --- Main fetch & render --- */
let wxData=null;

async function fetchConditions(){
  let lat=SITE.lat_deg,lon=SITE.lon_deg;
  document.getElementById('wx-status').textContent='FETCHING…';
  document.getElementById('wx-site-label').textContent=lat.toFixed(2)+'°N '+Math.abs(lon).toFixed(2)+'°'+(lon>=0?'E':'W');

  let [hourly, aqiData] = await Promise.all([fetchWeather(lat,lon), fetchAQI(lat,lon)]);

  if(!hourly){document.getElementById('wx-status').textContent='WEATHER UNAVAILABLE';return;}

  wxData={hourly,aqiData,lat,lon,fetchedAt:Date.now()};
  renderConditions();
  overlayPasses();
  document.getElementById('wx-status').textContent='UPDATED '+fmtLocalTime(new Date(),SITE.tz).slice(0,5)+' LOCAL';
}

function renderConditions(){
  if(!wxData) return;
  const {hourly,aqiData,lat,lon}=wxData;
  const now=new Date();

  // Find the index of the current hour in the hourly array
  // Open-Meteo now returns times in observer local time e.g. "2026-05-16T10:00"
  const times=hourly.time;
  const nowLocal=fmtLocalTime(now,SITE.tz); // "HH:MM:SS"
  const nowLocalHour=fmtLocalTime(now,SITE.tz).slice(0,13); // unused — match by index instead
  // Build a local date string to match against Open-Meteo's local time strings
  const nowLocalStr=(()=>{
    try{
      return new Intl.DateTimeFormat('sv-SE',{timeZone:SITE.tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false}).format(now).slice(0,13);
    }catch(e){return now.toISOString().slice(0,13);}
  })();
  let startIdx=times.findIndex(t=>t.slice(0,13)===nowLocalStr);
  if(startIdx<0) startIdx=0;

  // Show next 24 hours, one cell per hour
  const numSlots=24;
  const slots=[];
  for(let i=0;i<numSlots;i++){
    let idx=startIdx+i;
    if(idx>=times.length) break;
    // times[idx] is local time string e.g. "2026-05-16T22:00"
    // Convert to real UTC using the site's known offset (tzOffsetMin)
    let localHour=parseInt(times[idx].slice(11,13));
    // Parse local string as if UTC, then subtract the local offset to get true UTC
    let localMs=Date.parse(times[idx]+':00Z'); // treat as UTC first
    let slotUTC=new Date(localMs - SITE.tzOffsetMin*60000); // shift back to real UTC
    slots.push({
      localHour,
      slotUTC,
      cloud: hourly.cloud_cover[idx]??50,
      wind:  hourly.wind_speed_10m[idx]??0,
      cape:  hourly.cape[idx]??0,
      li:    hourly.lifted_index[idx]??0,
      temp:  hourly.temperature_2m[idx]??10,
      dew:   hourly.dewpoint_2m[idx]??5,
    });
  }

  // Clear all cells
  ['wx-hours','wx-cloud','wx-seeing','wx-transp','wx-dark','wx-wind','wx-smoke'].forEach(id=>{
    document.getElementById(id).innerHTML='';
  });

  const tooltip=document.getElementById('tooltip');

  slots.forEach((s,i)=>{
    let hh=padZ(s.localHour);
    let dark=limitingMag(s.slotUTC,lat,lon);
    let see=deriveSee(s.cape,s.li);
    let trans=deriveTrans(s.temp,s.dew,s.cloud);

    let defs=[
      {id:'wx-hours', label:hh,  bg:'transparent', color:'var(--muted)', tip:null},
      {id:'wx-cloud', bg:cloudColor(s.cloud),  tip:wxTip.cloud(Math.round(s.cloud))},
      {id:'wx-seeing',bg:seeingColor(see),     tip:wxTip.seeing(see)},
      {id:'wx-transp',bg:transpColor(trans),   tip:wxTip.transp(trans)},
      {id:'wx-dark',  bg:darkColor(dark.dark), tip:wxTip.dark(dark,dark.lm)},
      {id:'wx-wind',  bg:windColor(s.wind),    tip:wxTip.wind(s.wind)},
      {id:'wx-smoke', bg:smokeColor(aqiData?.aqi), tip:wxTip.smoke(aqiData?.aqi)},
    ];

    defs.forEach(d=>{
      let cell=document.createElement('div');
      cell.className='wx-cell';
      cell.style.background=d.bg;
      if(d.label){
        cell.style.display='flex';cell.style.alignItems='center';cell.style.justifyContent='center';
        cell.style.fontSize='6px';cell.style.color=d.color||'var(--muted)';
        cell.style.fontFamily='var(--font-hud)';cell.textContent=d.label;
        cell.style.background='transparent';cell.style.height='10px';
      }
      if(d.tip){
        cell.addEventListener('mouseenter',e=>{
          tooltip.textContent=d.tip;tooltip.style.display='block';
          tooltip.style.left=(e.clientX+12)+'px';tooltip.style.top=(e.clientY-24)+'px';
        });
        cell.addEventListener('mousemove',e=>{
          tooltip.style.left=(e.clientX+12)+'px';tooltip.style.top=(e.clientY-24)+'px';
        });
        cell.addEventListener('mouseleave',()=>{tooltip.style.display='none';});
      }
      document.getElementById(d.id).appendChild(cell);
    });
  });
}

/* ════ PASS OVERLAY ON CONDITIONS STRIP ════
   After conditions render, mark hours that fall within a predicted pass.
   Called after renderConditions() and after selectSat().             */
function overlayPasses(){
  if(!wxData||!currentPasses||!currentTLE||!propagationTime) return;
  const cloudCells=document.getElementById('wx-cloud').children;
  if(!cloudCells.length) return;

  const numCells=cloudCells.length;
  // Each cell i corresponds to slotUTC[i] — rebuild times from wxData
  const {hourly}=wxData;
  const times=hourly.time;
  const startIdx=(()=>{
    const nowLocalStr=(()=>{
      try{return new Intl.DateTimeFormat('sv-SE',{timeZone:SITE.tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hour12:false}).format(new Date()).slice(0,13);}
      catch(e){return new Date().toISOString().slice(0,13);}
    })();
    let idx=times.findIndex(t=>t.slice(0,13)===nowLocalStr);
    return idx<0?0:idx;
  })();

  // Remove any existing pass overlays
  document.querySelectorAll('.wx-pass-overlay').forEach(el=>el.remove());

  // For each pass, find which hour cells it overlaps
  const rows=['wx-cloud','wx-seeing','wx-transp','wx-dark','wx-wind','wx-smoke'];

  currentPasses.forEach((p,pi)=>{
    // p.t_rise / p.t_set are seconds from propagationTime
    let riseUTC=new Date(propagationTime.getTime()+p.t_rise*1000);
    let setUTC =new Date(propagationTime.getTime()+p.t_set*1000);
    let elPk=p.el_peak;
    let col=elPk>30?'rgba(127,191,152,0.55)':elPk>10?'rgba(197,197,197,0.45)':'rgba(165,165,165,0.35)';
    let border=elPk>30?'#7fbf98':elPk>10?'#c5c5c5':'#a7a7a7';

    for(let i=0;i<numCells;i++){
      let idx=startIdx+i;
      if(idx>=times.length) break;
      // Get UTC instant for this cell
      let localMs=Date.parse(times[idx]+':00Z');
      let cellUTC=new Date(localMs-SITE.tzOffsetMin*60000);
      let cellEnd=new Date(cellUTC.getTime()+3600000);
      // Check overlap: pass overlaps cell if rise<cellEnd && set>cellStart
      if(riseUTC<cellEnd && setUTC>cellUTC){
        rows.forEach(rowId=>{
          let cells=document.getElementById(rowId).children;
          if(i<cells.length){
            let overlay=document.createElement('div');
            overlay.className='wx-pass-overlay';
            overlay.style.cssText=`position:absolute;inset:0;background:${col};border-top:2px solid ${border};border-bottom:2px solid ${border};pointer-events:none;z-index:3;`;
            // First cell of pass: left border
            let localRiseMs=Date.parse(times[idx]+':00Z')-SITE.tzOffsetMin*60000;
            if(riseUTC>=cellUTC) overlay.style.borderLeft=`2px solid ${border}`;
            if(setUTC<=cellEnd)  overlay.style.borderRight=`2px solid ${border}`;
            cells[i].style.position='relative';
            cells[i].appendChild(overlay);
          }
        });
        // Also add tooltip enhancement to hour cell
        let hCells=document.getElementById('wx-hours').children;
        if(i<hCells.length){
          let tip=document.getElementById('tooltip');
          let passLabel=`${currentTLE.name} · ${fmtLocalShort(riseUTC,SITE.tz)}–${fmtLocalShort(setUTC,SITE.tz)} · peak ${elPk.toFixed(0)}°`;
          hCells[i].style.color=border;
          hCells[i].style.fontWeight='bold';
          // Attach tooltip
          hCells[i].addEventListener('mouseenter',e=>{tip.textContent=passLabel;tip.style.display='block';tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY-24)+'px';});
          hCells[i].addEventListener('mousemove',e=>{tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY-24)+'px';});
          hCells[i].addEventListener('mouseleave',()=>{tip.style.display='none';});
        }
      }
    }
  });
}


/* ════ V2 · CATALOG 3D — full-catalog real-time inertial viewer ════
   Propagation strategy (accuracy-honest at every time scale):
   · every object is seeded with SGP4 at the current sim epoch;
   · between SGP4 fixes, motion is bridged with a symplectic-Euler two-body
     integration (substeps ≤ 8 s of sim time) — energy-stable, no secular drift;
   · a time-boxed (≈3 ms/frame) background sweep continuously re-anchors objects
     with fresh SGP4 fixes, cycling through the whole catalog, so the two-body
     bridge never accumulates more than a few seconds–minutes of drag/J2 error.
   Earth orientation: rotation.y = GMST(simTime) — same convention as ECI view. */
