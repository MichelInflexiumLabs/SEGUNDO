//VISTAS
// ═══════════════════════════════════════════════════════════
const VISTAS=['view-main','view-ai','view-config','view-login','view-admin-menu','view-enroll','view-enroll-instrucciones','view-admin-usuarios','view-admin-registros'];
function mostrarVista(id){
  VISTAS.forEach(v=>{ const e=document.getElementById(v); if(e){e.classList.remove('active');e.style.display='none';} });
  const el=document.getElementById(id); if(el){el.style.display='flex';setTimeout(()=>el.classList.add('active'),10);}
}
function setBioRingState(state){ // 'waiting' | 'detecting' | 'identified'
  const ring=document.getElementById('bio-ring-new');
  if(ring){ ring.className='bio-ring-new'; ring.classList.add('state-'+state); }
}
function setBioStatus(cls,txt){
  const e=document.getElementById('bio-status');
  if(!e) return;
  e.className='bio-hint-sub';
  // Mapeo seguro de clase — nunca agrega string vacío
  const clsMap={'ok':'ok','error':'err','err':'err','warn':'warn','warning':'warn','loading':'warn','scanning':'scan'};
  const cssClass = clsMap[cls] || null;
  if(cssClass) e.classList.add(cssClass);
  e.textContent=txt||'';
}
function setBioLabel(txt){ const e=document.getElementById('bio-label'); if(e) e.textContent=txt; }

function volverMain(){
  mostrarVista('view-main');
  clearTimeout(autoResetTimer);
  scanActive = false;
  if(enrollDetectLoop){clearInterval(enrollDetectLoop);enrollDetectLoop=null;}
  // Limpiar canvas
  const cv=document.getElementById('bio-canvas-overlay');
  if(cv) cv.getContext('2d').clearRect(0,0,cv.width,cv.height);
  document.getElementById('overlay-eventos').style.display='none';
  detectedPerson=null; lastConfidence=null;
  // Mostrar video de cámara (stream sigue activo)
  const bv=document.getElementById('bio-video');
  if(bv&&videoStream&&videoStream.active){ bv.srcObject=videoStream; bv.style.display='block'; }
  const ph=document.getElementById('bio-placeholder'); if(ph) ph.style.display='none';
  setBioRingState('waiting');
  setBioLabel('Asistencia');
  setBioStatus('ok','Presione un botón para marcar asistencia');
  actualizarEstadoSistema();
  // Reanudar detección facial en background
  startFaceWakeUp();
  logDiag('volver_main');
}
function mostrarLogin(){
  mostrarVista('view-login');
  document.getElementById('login-pass').value='';
  document.getElementById('login-error').classList.remove('show');
}
function verificarLogin(){
  if(document.getElementById('login-pass').value===CONFIG.password){
    mostrarVista('view-admin-menu');
  } else {
    document.getElementById('login-error').classList.add('show');
    document.getElementById('login-pass').value='';
  }
}
function irAEnrollDesdeAdmin(){ mostrarVista('view-enroll-instrucciones'); }
function irAConfigDesdeAdmin(){
  document.getElementById('cfg-personal-count').textContent=employees.length+' funcionarios';
  renderCfgEventos(); mostrarVista('view-config');
}
function cambiarFormato(){ CONFIG.formato24=document.getElementById('cfg-formato-hora').value==='24'; }

// ═══════════════════════════════════════════════════════════
// 