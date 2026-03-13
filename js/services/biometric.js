// ═══════════════════════════════════════════════════════════
// MÓDULO 1 — CÁMARA (servicio permanente)
// ═══════════════════════════════════════════════════════════
// La cámara se inicia una vez y nunca se reinicia durante uso
// ═══════════════════════════════════════════════════════════
const MODELS_URL='https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model';
let faceApiReady = false;
let videoStream  = null;   // MediaStream — nunca se destruye durante uso normal
let globalVideo  = null;   // <video> oculto para face-api
let scanActive   = false;  // true solo durante el proceso de un botón
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getUmbral(){ return parseInt(document.getElementById('cfg-umbral')?.value||42)/100; }

// Construye FaceMatcher filtrando outliers
// IMPORTANTE: el label debe ser el nombre del empleado para que findBestMatch lo devuelva
function buildMatcher(descriptors, label){
  if(!descriptors||descriptors.length<2) return null;
  const len=descriptors[0].length;
  const centroide=new Float32Array(len);
  descriptors.forEach(d=>d.forEach((v,i)=>centroide[i]+=v/descriptors.length));
  const distancias=descriptors.map(d=>faceapi.euclideanDistance(d,centroide));
  const media=distancias.reduce((a,b)=>a+b,0)/distancias.length;
  const desviacion=Math.sqrt(distancias.map(d=>(d-media)**2).reduce((a,b)=>a+b,0)/distancias.length);
  const buenos=descriptors.filter((_,i)=>distancias[i]<=media+1.5*desviacion);
  const final=buenos.length>=2?buenos:descriptors;
  const empLabel = label || 'person';
  console.log(`🧠 Muestras: ${descriptors.length} total → ${final.length} válidas | label="${empLabel}"`);
  return new faceapi.FaceMatcher([new faceapi.LabeledFaceDescriptors(empLabel, final)], getUmbral());
}

function findBestMatch(descriptor){
  if(!descriptor||!enrolledPeople.length) return {name:null,distance:1};
  let bestName=null, bestDist=1;
  const umbral=getUmbral();
  enrolledPeople.forEach(ep=>{
    if(!ep.matcher) return;
    // Usar ep.matcher directamente — ya tiene el label correcto (nombre del empleado)
    // Solo actualizar el umbral si cambió
    let matcher = ep.matcher;
    if(Math.abs(matcher.distanceThreshold - umbral) > 0.01){
      matcher = new faceapi.FaceMatcher(ep.matcher.labeledDescriptors, umbral);
    }
    const result = matcher.findBestMatch(descriptor);
    console.log(`🔍 ${ep.name}: result.label="${result.label}" dist=${result.distance.toFixed(3)} umbral=${umbral}`);
    // El label del resultado debe coincidir con el nombre del empleado
    if(result.label !== 'unknown' && result.distance < bestDist){
      bestDist = result.distance;
      bestName = ep.name;
    }
  });
  console.log(`🏆 Mejor match: "${bestName}" dist=${bestDist.toFixed(3)}`);
  return {name:bestName, distance:bestDist};
}

function getConfianzaLabel(dist){
  if(dist<=0.35) return {label:'ALTA',cls:'alta',emoji:'🟢'};
  if(dist<=0.45) return {label:'MEDIA',cls:'media',emoji:'🟡'};
  return {label:'BAJA',cls:'baja',emoji:'🟠'};
}

let cameraPermissionState='unknown';

async function obtenerStream(){
  try{
    return await navigator.mediaDevices.getUserMedia({
      video:{width:{ideal:320},height:{ideal:240},facingMode:{ideal:'user'}}
    });
  }catch(e1){
    return await navigator.mediaDevices.getUserMedia({video:true});
  }
}

// Inicia cámara UNA SOLA VEZ — no se llama durante marcaciones
async function iniciarCamaraGlobal(){
  if(videoStream&&videoStream.active){
    logDiag('camera_already_active'); return true;
  }
  try{
    videoStream=await obtenerStream();
    cameraPermissionState='granted';
    try{ localStorage.setItem('kiosk_cam_permission','granted'); }catch(e){}
    // <video> oculto para face-api
    if(globalVideo){ try{globalVideo.remove();}catch(e){} }
    globalVideo=document.createElement('video');
    globalVideo.srcObject=videoStream; globalVideo.autoplay=true;
    globalVideo.muted=true; globalVideo.playsInline=true; globalVideo.style.display='none';
    document.body.appendChild(globalVideo);
    await new Promise(r=>{globalVideo.onloadedmetadata=r; setTimeout(r,3000);});
    await globalVideo.play().catch(()=>{});
    // <video> visible en el círculo biométrico
    const bv=document.getElementById('bio-video');
    if(bv){ bv.srcObject=videoStream; bv.style.display='block'; }
    const ph=document.getElementById('bio-placeholder'); if(ph) ph.style.display='none';
    try{ document.getElementById('cam-led').classList.add('recording'); }catch(e){}
    actualizarDotCamara(true);
    logDiag('camera_started');
    return true;
  }catch(err){
    cameraPermissionState=(err.name==='NotAllowedError'||err.name==='PermissionDeniedError')?'denied':'error';
    logDiag('camera_error:'+err.name+':'+err.message);
    actualizarDotCamara(false);
    setBioStatus('err','Sin cámara — '+err.name);
    setBioLabel('Habilitá la cámara en el navegador');
    return false;
  }
}

// Devuelve el elemento <video> listo para face-api
// Auto-repara globalVideo si está desconectado del stream
function getCameraFrame(){
  // Si globalVideo está desconectado pero hay stream activo → reconectar
  if(globalVideo && videoStream && videoStream.active){
    if(!globalVideo.srcObject || globalVideo.srcObject !== videoStream){
      globalVideo.srcObject = videoStream;
      globalVideo.play().catch(()=>{});
    }
  }
  if(globalVideo&&globalVideo.readyState>=2&&globalVideo.videoWidth>0) return globalVideo;
  // Fallback: bio-video visible
  const bv=document.getElementById('bio-video');
  if(bv&&bv.readyState>=2&&bv.videoWidth>0) return bv;
  return null;
}

// ═══════════════════════════════════════════════════════════
// MÓDULO 2 — RECONOCIMIENTO (Face Wake-Up continuo)
// Detecta y extrae descriptor en background, SIN comparar
// Cuando el usuario presiona un botón, el descriptor ya está listo
// ═══════════════════════════════════════════════════════════
let wakeUp = {
  running:    false,
  descriptor: null,   // último descriptor extraído
  timestamp:  0,      // cuándo se extrajo
  timerId:    null,
};

async function startFaceWakeUp(){
  if(wakeUp.running) return;
  if(!faceApiReady) return;
  wakeUp.running = true;
  logDiag('wakeup_start');
  const opts = new faceapi.TinyFaceDetectorOptions({inputSize:224, scoreThreshold:0.5});

  const tick = async () => {
    if(!wakeUp.running) return;
    const src = getCameraFrame();
    if(src){
      try{
        const det = await faceapi
          .detectSingleFace(src, opts)
          .withFaceLandmarks(true)
          .withFaceDescriptor();
        if(det&&det.descriptor){
          wakeUp.descriptor = det.descriptor;
          wakeUp.timestamp  = Date.now();
        }
      }catch(e){}
    }
    if(wakeUp.running){
      wakeUp.timerId = setTimeout(tick, 500); // detectar cada 500ms
    }
  };
  tick();
}

function stopFaceWakeUp(){
  wakeUp.running = false;
  if(wakeUp.timerId){ clearTimeout(wakeUp.timerId); wakeUp.timerId=null; }
  logDiag('wakeup_stop');
}

// ═══════════════════════════════════════════════════════════
// PERSISTENCIA DE ENROLADOS — sessionStorage
// Float32Array no es serializable a JSON directamente
// Se convierte a Array normal para guardar y se reconstruye al cargar
// ═══════════════════════════════════════════════════════════
function guardarEnroladosSession(){
  try{
    const data = enrolledPeople.map(ep => ({
      employee_id: ep.employee_id,
      name:        ep.name,
      photo:       ep.photo || null,
      // Convertir cada Float32Array descriptor a Array normal
      descriptors: ep.matcher.labeledDescriptors[0].descriptors.map(d => Array.from(d)),
    }));
    sessionStorage.setItem('kiosk_enrolled', JSON.stringify(data));
    console.log(`💾 ${data.length} enrolados guardados en sessionStorage`);
  }catch(e){ console.warn('[SESSION] error guardando enrolados:', e.message); }
}

function cargarEnroladosSession(){
  if(!faceApiReady){ console.log('[SESSION] IA no lista, no se puede cargar enrolados'); return; }
  try{
    const raw = sessionStorage.getItem('kiosk_enrolled');
    if(!raw) return;
    const data = JSON.parse(raw);
    if(!data.length) return;
    let cargados = 0;
    data.forEach(ep => {
      // Verificar que no esté ya cargado
      if(enrolledPeople.find(e=>e.employee_id===ep.employee_id)) return;
      try{
        // Reconstruir Float32Array descriptors
        const descriptors = ep.descriptors.map(d => new Float32Array(d));
        const matcher = buildMatcher(descriptors, ep.name);
        if(!matcher){ console.warn(`[SESSION] no se pudo reconstruir matcher para ${ep.name}`); return; }
        enrolledPeople.push({
          employee_id: ep.employee_id,
          name:        ep.name,
          photo:       ep.photo || null,
          matcher,
          labeledDescriptors: matcher.labeledDescriptors,
        });
        // Actualizar flag enrolled en employees
        const empRef = employees.find(e=>e.id===ep.employee_id);
        if(empRef){ empRef.enrolled=true; if(ep.photo) empRef.photo=ep.photo; }
        cargados++;
      }catch(e){ console.warn(`[SESSION] error reconstruyendo ${ep.name}:`, e.message); }
    });
    if(cargados>0){
      console.log(`✅ ${cargados} enrolado(s) restaurados desde sessionStorage`);
      actualizarEstadoSistema();
    }
  }catch(e){ console.warn('[SESSION] error cargando enrolados:', e.message); }
}

// ═══════════════════════════════════════════════════════════
// MÓDULO WORK CODE — popup opcional antes del escaneo
// ═══════════════════════════════════════════════════════════
let _wcResolve = null;
let _wcTimer   = null;

function mostrarWorkCode(tipo) {
  return new Promise(resolve => {
    _wcResolve = resolve;
    document.getElementById('wc-tipo-label').textContent = tipo.toUpperCase();
    document.getElementById('overlay-workcode').classList.add('show');
    // Countdown 3 segundos → Normal (workCode=0)
    let secs = 3;
    document.getElementById('wc-secs').textContent = secs;
    _wcTimer = setInterval(() => {
      secs--;
      document.getElementById('wc-secs').textContent = secs;
      if(secs <= 0) confirmarWorkCode(0);
    }, 1000);
  });
}

function confirmarWorkCode(code) {
  if(_wcTimer){ clearInterval(_wcTimer); _wcTimer=null; }
  document.getElementById('overlay-workcode').classList.remove('show');
  if(_wcResolve){ _wcResolve(code); _wcResolve=null; }
}

// ═══════════════════════════════════════════════════════════
// MÓDULO 3 — REGISTRO DE ASISTENCIA
// Solo se activa cuando el usuario presiona un botón
// Usa el descriptor ya calculado por el Wake-Up
// ═══════════════════════════════════════════════════════════

// Cooldown anti-duplicado: mismo usuario no puede marcar 2 veces en 5 segundos
const cooldown = {};
function enCooldown(nombre){
  if(!nombre) return false;
  const last = cooldown[nombre]||0;
  return (Date.now()-last) < 5000;
}
function setCooldown(nombre){ if(nombre) cooldown[nombre]=Date.now(); }

async function iniciarEscaneo(tipo, icono, color, attendanceType, employeeIdOverride, verifyModeOverride, workCode){
  if(scanActive){
    setBioStatus('warn','Procesando...');
    return;
  }
  scanActive = true;
  try {
    await _escaneoInterno(tipo, icono, color, attendanceType, employeeIdOverride, verifyModeOverride, workCode);
  } catch(e) {
    console.error('[SCAN] excepción:', e.message, e.stack);
    setBioStatus('err','Error: '+e.message);
    setBioLabel('Error interno');
  } finally {
    scanActive = false;
    startFaceWakeUp();
  }
}

async function _escaneoInterno(tipo, icono, color, attendanceType, employeeIdOverride, verifyModeOverride, workCode){

  // PASO 1: workCode viene del evento seleccionado (o 0 si es botón normal)
  const finalWorkCode = workCode || 0;

  stopFaceWakeUp();
  setBioRingState('detecting');

  // PASO 2: verificar estado del sistema — mostrar en pantalla
  setBioLabel('Verificando sistema...');
  setBioStatus('scanning', `IA:${faceApiReady?'OK':'NO'} | Enrolados:${enrolledPeople.length} | Cam:${videoStream&&videoStream.active?'OK':'NO'}`);
  console.log(`[SCAN] Estado: faceApiReady=${faceApiReady} enrolledPeople=${enrolledPeople.length} videoStream=${!!(videoStream&&videoStream.active)}`);
  if(enrolledPeople.length>0) console.log(`[SCAN] Personas enroladas:`, enrolledPeople.map(e=>e.name));
  await sleep(400);

  // PASO 3: sin IA o sin enrolados → BLOQUEAR (no registrar sin reconocimiento si hay enrolados)
  if(!faceApiReady){
    setBioLabel('IA no disponible'); setBioStatus('err','Los modelos de reconocimiento no cargaron');
    await sleep(3000);
    setBioLabel('Asistencia'); setBioStatus('ok','Presione un botón para marcar asistencia'); setBioRingState('waiting');
    return;
  }
  if(enrolledPeople.length===0){
    // Sin enrolados: modo manual permitido
    setBioLabel('Registrando...'); setBioStatus('ok','Sin biometría configurada — modo libre');
    await sleep(400);
    detectedPerson=null; lastConfidence=null;
    await registrarMarca(tipo, icono, color, attendanceType, employeeIdOverride||null, verifyModeOverride||9, finalWorkCode);
    return;
  }

  // PASO 4: asegurar video disponible
  setBioLabel('Buscando cámara...');
  // Forzar reconexión de globalVideo
  if(videoStream&&videoStream.active){
    if(!globalVideo){
      globalVideo=document.createElement('video');
      globalVideo.autoplay=true; globalVideo.muted=true;
      globalVideo.playsInline=true; globalVideo.style.display='none';
      document.body.appendChild(globalVideo);
    }
    if(globalVideo.srcObject!==videoStream){
      globalVideo.srcObject=videoStream;
      await globalVideo.play().catch(()=>{});
      await sleep(500);
    }
  }

  let src = getCameraFrame();
  setBioStatus('scanning', `Video: ${src?src.videoWidth+'x'+src.videoHeight:'NO DISPONIBLE'}`);
  await sleep(300);

  if(!src){
    setBioLabel('Sin video'); setBioStatus('err','No hay fuente de video');
    await sleep(3000);
    setBioLabel('Asistencia'); setBioStatus('ok','Presione un botón para marcar asistencia'); setBioRingState('waiting');
    return;
  }

  // PASO 5: escaneo facial
  setBioLabel('Escaneando...'); setBioStatus('scanning','Detectando rostro...');
  const opts = new faceapi.TinyFaceDetectorOptions({inputSize:320, scoreThreshold:0.35});
  const scanSeg = parseInt(document.getElementById('cfg-scan-tiempo')?.value||20);
  const deadline = Date.now() + scanSeg * 1000;
  let descriptor = null;
  let frameN = 0;

  // Usar descriptor del wake-up si es reciente (< 3 segundos)
  if(wakeUp.descriptor && (Date.now()-wakeUp.timestamp) < 3000){
    descriptor = wakeUp.descriptor;
    setBioStatus('scanning','Descriptor del wake-up disponible');
  }

  while(!descriptor && Date.now() < deadline){
    src = getCameraFrame();
    frameN++;
    const seg = Math.max(0,Math.ceil((deadline-Date.now())/1000));
    if(!src){ setBioStatus('scanning',`Frame ${frameN}: sin video... ${seg}s`); await sleep(300); continue; }
    try{
      setBioStatus('scanning',`Frame ${frameN}: detectando... ${seg}s`);
      const det = await faceapi.detectSingleFace(src,opts).withFaceLandmarks(true).withFaceDescriptor();
      if(det&&det.descriptor){
        descriptor=det.descriptor;
        setBioStatus('scanning',`✅ Rostro detectado en frame ${frameN}`);
      } else {
        setBioStatus('scanning',`Frame ${frameN}: sin rostro... ${seg}s`);
      }
    }catch(e){
      setBioStatus('err',`Frame ${frameN} error: ${e.message.substring(0,30)}`);
    }
    if(!descriptor) await sleep(150);
  }

  // PASO 6: sin rostro
  if(!descriptor){
    setBioRingState('waiting'); setBioLabel('No se detectó rostro');
    setBioStatus('err',`${frameN} frames — sin detección`);
    hablarTexto('No se detectó ningún rostro. Por favor, reintente.');
    await sleep(4000);
    setBioLabel('Asistencia'); setBioStatus('ok','Presione un botón para marcar asistencia'); setBioRingState('waiting');
    return;
  }

  // PASO 7: comparar
  setBioRingState('detecting'); setBioLabel('Comparando...');
  const match = findBestMatch(descriptor);
  setBioStatus('scanning',`Resultado: ${match.name||'desconocido'} dist=${match.distance?.toFixed(3)}`);
  await sleep(500);

  // PASO 8: cooldown
  if(match.name && enCooldown(match.name)){
    setBioRingState('waiting'); setBioLabel('Ya registrado');
    setBioStatus('warn',match.name+' ya marcó hace pocos segundos');
    await sleep(2500);
    setBioLabel('Asistencia'); setBioStatus('ok','Presione un botón para marcar asistencia'); setBioRingState('waiting');
    return;
  }

  // PASO 9: reconocido
  if(match.name){
    setCooldown(match.name);
    detectedPerson=match.name; lastConfidence=match.distance;
    setBioRingState('identified'); setBioStatus('ok',match.name+' identificado');
    const emp=enrolledPeople.find(e=>e.name===match.name);
    await sleep(400);
    await registrarMarca(tipo, icono, color, attendanceType, emp?.employee_id||null, 7, finalWorkCode);
    return;
  }

  // PASO 10: no reconocido
  setBioRingState('waiting'); setBioLabel('Rostro no identificado');
  setBioStatus('err',`No reconocido — dist=${match.distance?.toFixed(3)}`);
  hablarTexto('Rostro no identificado. Por favor, reintente.');
  await sleep(4000);
  setBioLabel('Asistencia'); setBioStatus('ok','Presione un botón para marcar asistencia'); setBioRingState('waiting');
  // wake-up se reanuda en finally
}
// ═══════════════════════════════════════════════════════════
// MARCACIÓN
// ═══════════════════════════════════════════════════════════
async function registrarMarca(tipo,icono,color,attendanceType,employeeId,verifyMode,workCode){
  logDiag('attendance_recorded:'+tipo+(detectedPerson?':'+detectedPerson:''));
  const log=registrarLog(employeeId, verifyMode||9, attendanceType||0, workCode||0);
  const ts=log.timestamp.split(' ')[1].substring(0,5); // HH:MM
  const now=new Date();
  const dias=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const meses=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

  // Actualizar panel "última marcación"
  const nombreMarca=detectedPerson||'Sin identificar';
  const nameEl=document.getElementById('last-mark-name');
  const metaEl=document.getElementById('last-mark-meta');
  const avatarEl=document.getElementById('last-mark-avatar');
  if(nameEl) nameEl.textContent=nombreMarca;
  if(metaEl) metaEl.textContent=`${tipo} · ${ts}`;
  if(avatarEl){
    avatarEl.classList.add('has-mark');
    // Mostrar foto si el funcionario tiene una capturada en el enrolamiento
    const empFoto = employees.find(e=>e.name===detectedPerson);
    if(empFoto?.photo){
      avatarEl.innerHTML=`<img src="${empFoto.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else if(empFoto){
      avatarEl.innerHTML=`<span style="font-family:var(--font-display);font-size:13px;font-weight:700;color:#fff;">${empFoto.iniciales}</span>`;
      avatarEl.style.background=empFoto.color;
    }
  }

  // Agregar a eventos recientes (máximo 3)
  recentLogs.unshift({nombre:nombreMarca, tipo, ts});
  if(recentLogs.length>3) recentLogs.length=3;
  renderRecentEvents();

  mostrarVista('view-ai');
  document.getElementById('ai-check-icon').textContent=icono;
  const confirmTipo=document.getElementById('ai-confirm-tipo');
  const confirmSub=document.getElementById('ai-confirm-sub');
  const confirmBlock=document.getElementById('ai-confirm-block');
  confirmTipo.textContent=tipo; confirmTipo.style.color=color;
  confirmBlock.style.display='block';
  confirmTipo.style.animation='none'; confirmTipo.offsetHeight; confirmTipo.style.animation='checkPop .45s cubic-bezier(.34,1.56,.64,1)';
  document.getElementById('ai-mark-time').textContent=`${ts} — ${dias[now.getDay()]}, ${now.getDate()} de ${meses[now.getMonth()]}`;
  document.getElementById('ai-loading').style.display='flex';
  document.getElementById('ai-message-text').style.display='none';
  document.getElementById('ai-tts-btn').style.display='none';
  document.getElementById('ai-return-btn').style.display='none';
  const personRow=document.getElementById('ai-person-row');
  if(detectedPerson){
    document.getElementById('ai-person-name').textContent=detectedPerson;
    const conf=getConfianzaLabel(lastConfidence||0.5);
    // work_code label para la pantalla de confirmación
    // Buscar nombre del evento en eventosLista primero
    let wcLabel = '';
    if(workCode && workCode !== 0){
      const evCustom = eventosLista.find(e => e.workCode === workCode);
      const wcNombres = {10:'MÉDICO',11:'SALIDA TRANSITORIA',12:'COMISIÓN',13:'HS EXTRA INICIO',14:'HS EXTRA FIN',15:'REUNIÓN EXTERNA'};
      wcLabel = ` · EVENTO: ${evCustom ? evCustom.nombre : (wcNombres[workCode]||'EVENTO')}`;
    }
    confirmSub.textContent=`✔ ${detectedPerson}${wcLabel} — CON ÉXITO`;
    // Foto en ai-person-row
    const aiAvatar = document.getElementById('ai-person-avatar');
    const empFotoAi = employees.find(e=>e.name===detectedPerson);
    if(aiAvatar && empFotoAi?.photo){
      aiAvatar.innerHTML=`<img src="${empFotoAi.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
    } else if(aiAvatar && empFotoAi){
      aiAvatar.innerHTML=`<span style="font-weight:700;font-size:14px;color:#fff;">${empFotoAi.iniciales}</span>`;
      aiAvatar.style.background=empFotoAi.color;
    }
    const badge=document.getElementById('ai-confidence-badge');
    badge.className='confidence-badge '+conf.cls;
    badge.textContent=conf.emoji+' '+conf.label;
    badge.style.display='';
    personRow.style.display='flex';
  } else {
    confirmSub.textContent='SIN RECONOCIMIENTO — REGISTRADO IGUAL';
    personRow.style.display='none';
  }
  mostrarToast(`${tipo} registrada — ${ts}`);
  // TTS de confirmación — siempre se lee, NO el mensaje IA
  const ttsOnCheck = document.getElementById('toggle-tts')?.classList.contains('on');
  if(ttsOnCheck){
    const attTypeNames = {0:'Entrada',1:'Salida',2:'Descanso',3:'Retorno'};
    const attName = attTypeNames[attendanceType] || tipo;
    // Nombres de eventos en voz natural
    // Nombre del evento: buscar en eventosLista primero (eventos custom), luego mapa fijo
    let wcVoz = '';
    if(workCode && workCode !== 0){
      const evCustom = eventosLista.find(e => e.workCode === workCode);
      if(evCustom){
        wcVoz = evCustom.nombre; // nombre exacto del evento tal como lo configuró el admin
      } else {
        const workCodeVoz = {
          10:'Salida médica', 11:'Salida transitoria',
          12:'Comisión de servicio', 13:'Inicio hora extra',
          14:'Fin hora extra', 15:'Reunión externa'
        };
        wcVoz = workCodeVoz[workCode] || `Evento ${workCode}`;
      }
    }
    const nombreVoz = detectedPerson || '';
    // Formato: "Marcación confirmada. Evento: SALIDA MÉDICA. Carlos Rodríguez. Con éxito."
    let partes = ['Marcación confirmada'];
    if(wcVoz){
      partes.push(`Evento: ${wcVoz}`);
    } else {
      partes.push(attName);
    }
    if(nombreVoz) partes.push(nombreVoz);
    partes.push('con éxito');
    const msgVoz = partes.join('. ') + '.';
    hablarTexto(msgVoz);
    // Esperar que el TTS termine antes de continuar
    const durMs = (partes.join(' ').length * 60) + 500; // ~60ms por caracter
    await sleep(Math.min(durMs, 4000));
  }
  // TTS del mensaje IA se ejecuta desde mostrarMensajeIA
  const apiKey=document.getElementById('cfg-apikey').value.trim();
  const iaOn=document.getElementById('toggle-ia').classList.contains('on');
  if(apiKey&&iaOn) await obtenerMensajeIA(tipo,ts,apiKey,detectedPerson);
  else{
    const M={ENTRADA:'Buen día. Que sea una jornada con buena onda y muchos pibes que aprendan de verdad.',SALIDA:'Hasta mañana. Descansá bien, te lo ganaste.',DESCANSO:'A recargar pilas. Un buen descanso no es tiempo perdido.',RETORNO:'Bienvenido de vuelta. Las aulas te esperan.',MÉDICO:'Que te atiendan rápido y te recuperés pronto.',LICENCIA:'Disfrutá el tiempo con tranquilidad.'};
    mostrarMensajeIA(M[tipo]||`Marcación de ${tipo} registrada correctamente.`);
  }
  autoResetTimer=setTimeout(volverMain,(parseInt(document.getElementById('cfg-autoreset')?.value)||15)*1000);
}

async function obtenerMensajeIA(tipo,hora,apiKey,nombre){
  const saludo=nombre?`El docente ${nombre}`:'Un docente';
  const prompt=`Sos el asistente del sistema de control de asistencia de la Escuela N° 192 de Montevideo, Uruguay. ${saludo} acaba de registrar su "${tipo}" a las ${hora}. Generá un mensaje motivador muy breve (2 oraciones cortas), tono cálido y rioplatense uruguayo (voseo, léxico local). Sin emojis ni símbolos, solo texto plano.`;
  try{
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:150,messages:[{role:'user',content:prompt}]})});
    const data=await r.json();
    mostrarMensajeIA(data.content?.map(b=>b.text||'').join('')||'Marcación registrada. ¡Que tengas una jornada bárbara!');
  }catch(e){ mostrarMensajeIA('Marcación registrada. ¡Que tengas una jornada bárbara, compañero!'); }
}
function mostrarMensajeIA(texto){
  document.getElementById('ai-loading').style.display='none';
  const el=document.getElementById('ai-message-text'); el.textContent=texto; el.style.display='block';
  // El mensaje IA NO se lee automáticamente — el usuario presiona el botón si quiere escucharlo
  document.getElementById('ai-tts-btn').style.display='flex';
  document.getElementById('ai-return-btn').style.display='flex';
  window._lastAiMsg=texto;
}

// ═══════════════════════════════════════════════════════════
// ENROLAMIENTO — 10 muestras + filtro outliers
// ═══════════════════════════════════════════════════════════
let funcionarioSeleccionado=null, enrollDetectLoop=null;

function mostrarInstruccionesEnroll(){ mostrarVista('view-enroll-instrucciones'); }
function irAEnroll(){ stopFaceWakeUp(); mostrarVista('view-enroll'); mostrarListaFuncionarios(); }

function mostrarListaFuncionarios(){
  // Parar loops de detección y captura automática de enroll
  if(enrollDetectLoop){ clearInterval(enrollDetectLoop); enrollDetectLoop=null; }
  if(enrollAutoLoop){ clearInterval(enrollAutoLoop); enrollAutoLoop=null; }
  // Resetear buffer de captura
  enrollDescsBuf=[]; enrollScoresBuf=[]; enrollCapturing=false;
  // Reconectar globalVideo al stream (enroll-video lo puede haber desconectado)
  if(videoStream&&videoStream.active&&globalVideo){
    globalVideo.srcObject=videoStream;
    globalVideo.play().catch(()=>{});
  }
  // Reanudar wake-up para que la pantalla principal detecte rostros
  startFaceWakeUp();
  const lista=document.getElementById('enroll-func-lista');
  const vacio=document.getElementById('enroll-func-vacio');
  const captura=document.getElementById('enroll-captura');
  captura.style.display='none'; lista.style.display='flex';
  lista.innerHTML='';
  if(!employees.length){ vacio.style.display='block'; return; }
  vacio.style.display='none';
  employees.forEach(emp=>{
    const enrolled=enrolledPeople.find(e=>e.employee_id===emp.id);
    const item=document.createElement('div');
    item.className='func-item'+(enrolled?' enrolled':'');
    const av=`<div style="width:44px;height:44px;border-radius:50%;background:${emp.color};color:#fff;font-family:var(--font-display);font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:2px solid rgba(255,255,255,.25);">${emp.iniciales}</div>`;
    item.innerHTML=`${av}<div class="func-info"><div class="func-codigo">#${String(emp.odoo_employee_id).padStart(4,'0')}</div><div class="func-nombre">${emp.name}</div></div><span class="func-badge ${enrolled?'ok':'no'}">${enrolled?'✔ Enrolado':'Sin rostro'}</span>`;
    item.onclick=()=>seleccionarFuncionario(emp);
    lista.appendChild(item);
  });
}

function seleccionarFuncionario(emp){
  const enrolled=enrolledPeople.find(e=>e.employee_id===emp.id);
  if(enrolled){
    if(!confirm(`${emp.name} ya tiene su rostro registrado.\n¿Eliminar y capturar nuevamente?`)) return;
    enrolledPeople.splice(enrolledPeople.indexOf(enrolled),1);
    emp.enrolled=false;
    mostrarToast('Rostro anterior eliminado');
  }
  funcionarioSeleccionado=emp;
  // Resetear buffer antes de nueva captura
  enrollDescsBuf=[]; enrollScoresBuf=[]; enrollCapturing=false;
  if(enrollAutoLoop){ clearInterval(enrollAutoLoop); enrollAutoLoop=null; }
  document.getElementById('enroll-func-lista').style.display='none';
  document.getElementById('enroll-func-vacio').style.display='none';
  const captura=document.getElementById('enroll-captura'); captura.style.display='flex';
  document.getElementById('enroll-sel-codigo').textContent='#'+String(emp.odoo_employee_id).padStart(4,'0');
  document.getElementById('enroll-sel-nombre').textContent=emp.name;
  const av=document.getElementById('enroll-sel-avatar');
  av.style.background=emp.color; av.style.color='#fff'; av.textContent=emp.iniciales;
  setProgreso(0,'Listo para capturar');
  setTimeout(async()=>{
    // Parar wake-up para que no compita con enroll-video por el stream
    stopFaceWakeUp();
    const ev=document.getElementById('enroll-video');
    const ep=document.getElementById('enroll-placeholder');
    if(!videoStream||!videoStream.active){
      document.getElementById('enroll-cam-label').textContent='Iniciando cámara...';
      await iniciarCamaraGlobal(); await sleep(800);
    }
    if(videoStream){
      ev.srcObject=videoStream;
      await ev.play().catch(()=>{});
      ev.style.display='block';
      if(ep) ep.style.display='none';
      await sleep(500); // esperar que el video arranque
      arrancarDeteccionEnroll();
    } else {
      document.getElementById('enroll-cam-label').textContent='Sin cámara';
      document.getElementById('enroll-cam-status').textContent='Habilitá el permiso de cámara';
    }
  },100);
}

function setProgreso(pct,label){
  document.getElementById('enroll-prog-bar').style.width=pct+'%';
  document.getElementById('enroll-prog-label').textContent=label;
}

// ── Estado de captura automática ──────────────────────────
const ENROLL_TOTAL   = 15;   // muestras objetivo
const ENROLL_MIN_OK  = 8;    // mínimo para guardar
const ENROLL_SCORE   = 0.55; // score mínimo para aceptar muestra
const ENROLL_DIV_MIN = 0.22; // distancia mínima entre muestras (forzar diversidad)
let   enrollCapturing = false;   // captura en curso
let   enrollDots      = [];      // clase CSS de cada punto
let   enrollDescsBuf  = [];      // descriptores acumulados
let   enrollScoresBuf = [];      // scores acumulados
let   enrollAutoLoop  = null;    // loop de captura automática

function initEnrollDots(){
  enrollDots=[]; enrollDescsBuf=[]; enrollScoresBuf=[];
  const grid=document.getElementById('enroll-dots-grid');
  if(!grid) return;
  grid.innerHTML='';
  for(let i=0;i<ENROLL_TOTAL;i++){
    const d=document.createElement('div');
    d.className='enroll-sample-dot';
    d.id=`enroll-dot-${i}`;
    grid.appendChild(d);
    enrollDots.push('empty');
  }
}

function setDot(i, cls){
  enrollDots[i]=cls;
  const el=document.getElementById(`enroll-dot-${i}`);
  if(el) el.className='enroll-sample-dot '+cls;
}

function setQuality(score){
  const bar  = document.getElementById('enroll-quality-bar');
  const lbl  = document.getElementById('enroll-quality-label');
  const ring = document.getElementById('enroll-cam-ring');
  const ovl  = document.getElementById('enroll-score-overlay');
  if(!bar||!lbl) return;
  const pct = Math.round(score*100);
  bar.style.width = pct+'%';
  if(score>=0.85){
    bar.className='enroll-quality-bar high'; lbl.className='enroll-quality-label high';
    lbl.textContent='EXCELENTE'; if(ring){ring.style.borderColor='#00e676';ring.style.boxShadow='0 0 20px rgba(0,230,118,.4)';}
  } else if(score>=0.72){
    bar.className='enroll-quality-bar mid'; lbl.className='enroll-quality-label mid';
    lbl.textContent='BUENA'; if(ring){ring.style.borderColor='#ffd600';ring.style.boxShadow='0 0 16px rgba(255,214,0,.3)';}
  } else {
    bar.className='enroll-quality-bar low'; lbl.className='enroll-quality-label low';
    lbl.textContent='BAJA'; if(ring){ring.style.borderColor='#ff5252';ring.style.boxShadow='0 0 12px rgba(255,82,82,.3)';}
  }
  if(ovl){ ovl.style.display='block'; ovl.textContent=`SCORE ${pct}%`; }
}

function clearQuality(){
  const bar=document.getElementById('enroll-quality-bar');
  const lbl=document.getElementById('enroll-quality-label');
  const ring=document.getElementById('enroll-cam-ring');
  const ovl=document.getElementById('enroll-score-overlay');
  if(bar){bar.style.width='0%';bar.className='enroll-quality-bar';}
  if(lbl){lbl.textContent='—';lbl.className='enroll-quality-label';}
  if(ring){ring.style.borderColor='rgba(0,229,255,.3)';ring.style.boxShadow='0 0 20px rgba(0,229,255,.15)';}
  if(ovl){ovl.style.display='none';}
}

function arrancarDeteccionEnroll(){
  if(enrollAutoLoop){ clearInterval(enrollAutoLoop); enrollAutoLoop=null; }
  enrollCapturing=false;
  initEnrollDots();
  const countLbl=document.getElementById('enroll-count-label');
  if(countLbl) countLbl.textContent=`0/${ENROLL_TOTAL}`;
  setProgreso(0,'Posicioná tu rostro en el círculo');
  clearQuality();
  const btn=document.getElementById('enroll-confirm-btn');
  if(btn) btn.style.display='none';
  document.getElementById('enroll-cam-label').textContent='BUSCANDO ROSTRO...';
  document.getElementById('enroll-cam-status').textContent='Mirá directo a la cámara';

  const opts=new faceapi.TinyFaceDetectorOptions({inputSize:320,scoreThreshold:0.5});
  let lastCapture=0;

  enrollAutoLoop=setInterval(async()=>{
    if(document.getElementById('view-enroll')?.style.display==='none'){
      clearInterval(enrollAutoLoop); enrollAutoLoop=null; return;
    }
    if(!faceApiReady||enrollCapturing) return;

    const video=document.getElementById('enroll-video');
    const canvas=document.getElementById('enroll-canvas');
    if(!video||video.readyState<2||video.videoWidth===0) return;

    // Dibujar bounding box
    const W=video.offsetWidth||video.videoWidth||200;
    const H=video.offsetHeight||video.videoHeight||200;
    if(canvas){ canvas.width=W; canvas.height=H; }
    const ctx=canvas?.getContext('2d');
    if(ctx) ctx.clearRect(0,0,W,H);

    const okCount = enrollDots.filter(d=>d==='ok').length;

    // Si ya tenemos todas las muestras, dejar de capturar
    if(okCount>=ENROLL_TOTAL){ clearInterval(enrollAutoLoop); enrollAutoLoop=null; return; }

    try{
      const det=await faceapi.detectSingleFace(video,opts).withFaceLandmarks(true).withFaceDescriptor();
      const now=Date.now();

      if(det && det.descriptor){
        const score=det.detection.score;
        setQuality(score);

        // Dibujar bounding box
        if(ctx){
          const vW=video.videoWidth||W, vH=video.videoHeight||H;
          const sx=W/vW, sy=H/vH;
          const box=det.detection.box;
          const bx=(vW-box.x-box.width)*sx, by=box.y*sy, bw=box.width*sx, bh=box.height*sy;
          const color=score>=ENROLL_SCORE?'#00e676':score>=0.55?'#ffd600':'#ff5252';
          ctx.save();
          ctx.strokeStyle=color; ctx.lineWidth=2; ctx.shadowColor=color; ctx.shadowBlur=10;
          ctx.strokeRect(bx,by,bw,bh);
          const cL=8; ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.shadowBlur=0;
          [[bx,by,1,1],[bx+bw,by,-1,1],[bx,by+bh,1,-1],[bx+bw,by+bh,-1,-1]].forEach(([cx,cy,dx,dy])=>{
            ctx.beginPath();ctx.moveTo(cx+dx*cL,cy);ctx.lineTo(cx,cy);ctx.lineTo(cx,cy+dy*cL);ctx.stroke();
          });
          ctx.restore();
        }

        // Capturar muestra automáticamente si calidad es suficiente
        // Mínimo 250ms entre capturas para evitar frames idénticos
        if(score>=ENROLL_SCORE && (now-lastCapture)>=250){
          // Filtro de diversidad: rechazar si es muy similar a una muestra existente
          const esDiversa = enrollDescsBuf.length===0 || enrollDescsBuf.every(
            prev => faceapi.euclideanDistance(prev, det.descriptor) >= ENROLL_DIV_MIN
          );
          if(!esDiversa){
            document.getElementById('enroll-cam-status').textContent='Mueve levemente la cabeza';
          }
          if(esDiversa){
            lastCapture=now;
            const idx=okCount;
            if(idx<ENROLL_TOTAL){
              setDot(idx, 'ok');
              enrollDescsBuf.push(det.descriptor);
              enrollScoresBuf.push(score);
              const newOk=enrollDescsBuf.length;
              const pct=Math.round((newOk/ENROLL_TOTAL)*100);
              if(countLbl) countLbl.textContent=`${newOk}/${ENROLL_TOTAL}`;
              setProgreso(pct,`Muestra ${newOk}/${ENROLL_TOTAL} — Score: ${Math.round(score*100)}%`);

              if(newOk>=ENROLL_TOTAL){
                clearInterval(enrollAutoLoop); enrollAutoLoop=null;
                _finalizarCaptura();
              } else if(newOk>=ENROLL_MIN_OK){
                // Suficientes muestras → mostrar botón de guardar
                const btn=document.getElementById('enroll-confirm-btn');
                if(btn) btn.style.display='block';
                document.getElementById('enroll-cam-label').textContent=`${newOk} MUESTRAS LISTAS`;
                document.getElementById('enroll-cam-status').textContent=`Podés guardar o esperar ${ENROLL_TOTAL-newOk} muestras más`;
              } else {
                document.getElementById('enroll-cam-label').textContent=`CAPTURANDO ${newOk}/${ENROLL_TOTAL}`;
                document.getElementById('enroll-cam-status').textContent='Mantené el rostro centrado';
              }
            }
          }
        } else if(score<ENROLL_SCORE){
          const hint=score<0.35?'Iluminá mejor tu cara':'Acercate un poco a la cámara';
          document.getElementById('enroll-cam-label').textContent='CALIDAD INSUFICIENTE';
          document.getElementById('enroll-cam-status').textContent=hint;
        }
      } else {
        // Sin cara
        clearQuality();
        document.getElementById('enroll-cam-label').textContent='BUSCANDO ROSTRO...';
        document.getElementById('enroll-cam-status').textContent='Mirá directo a la cámara';
        if(ctx) ctx.clearRect(0,0,W,H);
        const ovl=document.getElementById('enroll-score-overlay');
        if(ovl) ovl.style.display='none';
      }
    }catch(e){ console.warn('[ENROLL]',e.message); }
  },200); // 5fps para captura
}

async function _finalizarCaptura(){
  document.getElementById('enroll-cam-label').textContent='✅ CAPTURA COMPLETA';
  const avgScore=enrollScoresBuf.reduce((a,b)=>a+b,0)/enrollScoresBuf.length;
  const calidad=avgScore>=0.85?'Excelente':avgScore>=0.72?'Buena':'Aceptable';
  document.getElementById('enroll-cam-status').textContent=`${enrollDescsBuf.length} muestras — Calidad: ${calidad} (${Math.round(avgScore*100)}%)`;
  setProgreso(100,`✅ ${enrollDescsBuf.length} muestras capturadas`);
  const btn=document.getElementById('enroll-confirm-btn');
  if(btn){ btn.style.display='block'; btn.textContent='💾 GUARDAR PERFIL BIOMÉTRICO'; }
}

function confirmarEnrollManual(){
  // Llamado desde el botón — usa los descriptores acumulados en enrollDescsBuf
  _ejecutarGuardadoEnroll(enrollDescsBuf);
}

// Verifica si un descriptor ya existe asociado a OTRO funcionario
// Umbral fijo 0.40 para esta validación (independiente del umbral de escaneo)
const UMBRAL_DUPLICADO = 0.40;
function detectarDuplicado(descriptors){
  if(!enrolledPeople.length) return null;
  // Calcular descriptor promedio del candidato
  const len = descriptors[0].length;
  const promedio = new Float32Array(len);
  descriptors.forEach(d => d.forEach((v,i) => promedio[i] += v / descriptors.length));
  // Comparar contra cada persona enrolada (que NO sea el mismo funcionario)
  for(const ep of enrolledPeople){
    if(ep.employee_id === funcionarioSeleccionado?.id) continue; // mismo funcionario: re-enrolamiento OK
    if(!ep.matcher) continue;
    const matcher = new faceapi.FaceMatcher(ep.matcher.labeledDescriptors, UMBRAL_DUPLICADO);
    const result  = matcher.findBestMatch(promedio);
    console.log(`🔎 Anti-dup vs ${ep.name}: label="${result.label}" dist=${result.distance.toFixed(3)} umbral=${UMBRAL_DUPLICADO}`);
    if(result.label !== 'unknown' || result.distance < UMBRAL_DUPLICADO){
      return ep.name; // nombre del funcionario con quien ya existe
    }
  }
  return null;
}

function cerrarOverlayDuplicado(){
  document.getElementById('overlay-duplicado').classList.remove('show');
  mostrarListaFuncionarios();
}

async function _ejecutarGuardadoEnroll(descriptors){
  if(!funcionarioSeleccionado){mostrarToast('Seleccioná un funcionario primero');return;}
  if(!descriptors||descriptors.length<ENROLL_MIN_OK){
    mostrarToast(`Pocas muestras válidas (${descriptors?.length||0}). Reposicioná tu rostro.`);
    return;
  }
  const btn=document.getElementById('enroll-confirm-btn');
  if(btn) btn.disabled=true;
  // Detener loop de captura si sigue activo
  if(enrollAutoLoop){ clearInterval(enrollAutoLoop); enrollAutoLoop=null; }
  console.log(`[ENROLL] Guardando con ${descriptors.length} muestras. Avg score: ${(enrollScoresBuf.reduce((a,b)=>a+b,0)/enrollScoresBuf.length).toFixed(2)}`);

  // ── VALIDACIÓN ANTI-DUPLICADOS ──────────────────────
  setProgreso(90,'Verificando unicidad del rostro...');
  await sleep(200);
  const yaExiste = detectarDuplicado(descriptors);
  if(yaExiste){
    setProgreso(0,'Registro cancelado — rostro duplicado');
    btn.disabled=false;
    document.getElementById('dup-quien-label').textContent=`Funcionario registrado: ${yaExiste}`;
    document.getElementById('overlay-duplicado').classList.add('show');
    console.warn(`🚫 Duplicado detectado: mismo rostro ya registrado para "${yaExiste}"`);
    return;
  }
  // ── FIN VALIDACIÓN ──────────────────────────────────

  const matcher=buildMatcher(descriptors, funcionarioSeleccionado.name);
  if(!matcher){setProgreso(0,'Error al construir matcher');return;}

  // ── Capturar foto del funcionario ─────────────────────
  let photoDataUrl = null;
  try{
    const src = (enrollVideo&&enrollVideo.readyState>=2&&enrollVideo.videoWidth>0) ? enrollVideo : globalVideo;
    if(src && src.readyState>=2){
      const snapCanvas = document.createElement('canvas');
      const vw = src.videoWidth, vh = src.videoHeight;
      // Recortar cuadrado centrado (cara)
      const side = Math.min(vw, vh);
      const sx = Math.round((vw-side)/2), sy = Math.round((vh-side)/2);
      snapCanvas.width = 120; snapCanvas.height = 120;
      const sctx = snapCanvas.getContext('2d');
      // Espejear igual que el video de enroll (transform:scaleX(-1))
      sctx.save();
      sctx.translate(120, 0); sctx.scale(-1, 1);
      sctx.drawImage(src, sx, sy, side, side, 0, 0, 120, 120);
      sctx.restore();
      photoDataUrl = snapCanvas.toDataURL('image/jpeg', 0.75);
    }
  }catch(e){ console.warn('[ENROLL] foto error:', e.message); }

  // Verificar que el label del matcher sea el nombre correcto
  const matcherLabel = matcher.labeledDescriptors?.[0]?.label;
  console.log(`✅ Matcher creado para "${funcionarioSeleccionado.name}" con label="${matcherLabel}"`);
  
  enrolledPeople.push({
    employee_id: funcionarioSeleccionado.id,
    name: funcionarioSeleccionado.name,
    photo: photoDataUrl,
    matcher,
    labeledDescriptors: matcher.labeledDescriptors
  });
  console.log(`📦 enrolledPeople ahora tiene ${enrolledPeople.length} persona(s):`, enrolledPeople.map(e=>e.name));
  guardarEnroladosSession();
  actualizarEstadoSistema();
  // Guardar foto también en employees para acceso global
  const empRef = employees.find(e=>e.id===funcionarioSeleccionado.id);
  if(empRef && photoDataUrl) empRef.photo = photoDataUrl;

  funcionarioSeleccionado.enrolled=true;
  setProgreso(100, `✅ ${descriptors.length} muestras registradas`);
  mostrarToast(`✅ ${funcionarioSeleccionado.name} enrolado (${descriptors.length}/${TOTAL} muestras válidas)`);
  setTimeout(()=>mostrarListaFuncionarios(), 2000);
}

// ═══════════════════════════════════════════════════════════
// TTS
// ═══════════════════════════════════════════════════════════
function limpiarParaVoz(t){ return t.replace(/[\u{1F000}-\u{1FFFF}]/gu,'').replace(/[\u{2600}-\u{27BF}]/gu,'').replace(/\s{2,}/g,' ').trim(); }
function elegirVoz(){
  const voices=window.speechSynthesis?.getVoices()||[];
  // Prioridad: es-UY > es-AR > Google español > cualquier español
  for(const fn of [
    v=>v.lang==='es-UY',
    v=>v.lang==='es-AR',
    v=>v.lang.startsWith('es-')&&v.name.toLowerCase().includes('google'),
    v=>v.lang.startsWith('es-')&&v.name.toLowerCase().includes('female'),
    v=>v.lang.startsWith('es'),
  ]){ const m=voices.find(fn); if(m) return m; }
  return null;
}

// FIX Android: espera activa para que las voces estén disponibles
async function esperarVoces(maxMs=1000){
  if(window.speechSynthesis.getVoices().length>0) return;
  await new Promise(resolve=>{
    const t=setTimeout(resolve,maxMs);
    window.speechSynthesis.onvoiceschanged=()=>{ clearTimeout(t); resolve(); };
  });
}

function hablarTexto(texto,onEnd){
  if(!('speechSynthesis' in window)){if(onEnd)onEnd();return;}
  const ttsOn=document.getElementById('toggle-tts')?.classList.contains('on');
  if(!ttsOn){if(onEnd)onEnd();return;}
  const txt=limpiarParaVoz(texto); if(!txt){if(onEnd)onEnd();return;}
  // FIX Android: cancelar utterances pendientes
  window.speechSynthesis.cancel();
  // FIX Android: resume por si el sintetizador quedó pausado
  if(window.speechSynthesis.paused) window.speechSynthesis.resume();
  // FIX Android: setTimeout(0) para mantener contexto de gesto del usuario
  setTimeout(async()=>{
    await esperarVoces(800);
    // Segunda verificación: si fue cancelado mientras esperábamos
    window.speechSynthesis.cancel();
    if(window.speechSynthesis.paused) window.speechSynthesis.resume();
    const u=new SpeechSynthesisUtterance(txt);
    u.lang='es-AR'; u.rate=0.88; u.pitch=1.0; u.volume=1.0;
    if(onEnd) u.onend=onEnd;
    u.onerror=(e)=>{ console.warn('TTS error:',e.error); if(onEnd)onEnd(); };
    const v=elegirVoz(); if(v){ u.voice=v; u.lang=v.lang; }
    window.speechSynthesis.speak(u);
    // FIX Android Chrome bug: el sintetizador a veces se congela en utterances largas
    // Reiniciar si después de 10s sigue "speaking" sin avanzar
    const watchdog=setTimeout(()=>{
      if(window.speechSynthesis.speaking){ window.speechSynthesis.cancel(); if(onEnd)onEnd(); }
    },10000);
    u.onend=()=>{ clearTimeout(watchdog); if(onEnd)onEnd(); };
  },0);
}
function leerMensaje(){
  if(!window._lastAiMsg) return;
  const btn=document.getElementById('ai-tts-btn');
  btn.innerHTML='🔊 Reproduciendo...'; btn.style.opacity='.65';
  hablarTexto(window._lastAiMsg,()=>{btn.innerHTML='🔊 Leer mensaje IA';btn.style.opacity='1';});
}

// ═══════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════
function mostrarToast(msg){
  const t=document.getElementById('toast'); document.getElementById('toast-msg').textContent=msg;
  t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),3500);
}

// ═══════════════════════════════════════════════════════════
// EVENTOS ESPECIALES
// ═══════════════════════════════════════════════════════════
const eventosLista=[
  {nombre:'MÉDICO',           icono:'🏥', color:'#ff5252', attendanceType:1, workCode:10},
  {nombre:'SALIDA TRANSITORIA',icono:'🚶',color:'#ff9100', attendanceType:1, workCode:11},
  {nombre:'COMISIÓN',         icono:'📋', color:'#42a5f5', attendanceType:1, workCode:12},
  {nombre:'INICIO HS EXTRA',  icono:'⏰', color:'#ffcc80', attendanceType:0, workCode:13},
  {nombre:'FIN HS EXTRA',     icono:'⏰', color:'#ffcc80', attendanceType:1, workCode:14},
  {nombre:'REUNIÓN EXTERNA',  icono:'🤝', color:'#80cbc4', attendanceType:1, workCode:15},
];
function abrirEventos(){
  const overlay=document.getElementById('overlay-eventos');
  const lista=document.getElementById('lista-eventos');
  const vacio=document.getElementById('eventos-vacio');
  lista.innerHTML='';
  if(!eventosLista.length){vacio.style.display='block';lista.style.display='none';}
  else{
    vacio.style.display='none'; lista.style.display='flex';
    eventosLista.forEach(ev=>{
      const item=document.createElement('div'); item.className='evento-item';
      item.innerHTML=`<span class="evento-icon">${ev.icono}</span><span class="evento-nombre">${ev.nombre}</span><span class="evento-arrow">→</span>`;
      item.onclick=()=>seleccionarEvento(ev); lista.appendChild(item);
    });
  }
  overlay.style.display='flex';
}
function cerrarEventos(){ document.getElementById('overlay-eventos').style.display='none'; }
function seleccionarEvento(ev){ cerrarEventos(); iniciarEscaneo(ev.nombre,ev.icono,ev.color,ev.attendanceType||0,null,null,ev.workCode||0); }
function renderCfgEventos(){
  const lista=document.getElementById('cfg-lista-eventos');
  const vacio=document.getElementById('cfg-eventos-vacio');
  if(!lista) return; lista.innerHTML='';
  if(!eventosLista.length){vacio.style.display='block';return;}
  vacio.style.display='none';
  const attTypeNames = ['Entrada','Salida','Descanso','Retorno'];
  eventosLista.forEach((ev,idx)=>{
    const row=document.createElement('div'); row.className='cfg-evento-row';
    const tipoLabel = attTypeNames[ev.attendanceType] || 'Salida';
    const wcLabel   = ev.workCode ? `WC-${ev.workCode}` : 'WC-00';
    row.innerHTML=`<span class="cfg-evento-icono">${ev.icono}</span><div style="flex:1;min-width:0;"><span class="cfg-evento-label">${ev.nombre}</span><div style="font-family:var(--font-mono);font-size:8px;color:var(--text-muted);margin-top:1px;">${tipoLabel} · ${wcLabel}</div></div><button class="cfg-evento-del" onclick="eliminarEvento(${idx})">✕</button>`;
    lista.appendChild(row);
  });
}
function agregarEvento(){
  const n   = document.getElementById('cfg-evento-nombre');
  const ic  = document.getElementById('cfg-evento-icono');
  const tp  = document.getElementById('cfg-evento-tipo');
  const wc  = document.getElementById('cfg-evento-wc');
  const nombre = n.value.trim().toUpperCase();
  const icono  = ic.value.trim() || '📌';
  if(!nombre){ mostrarToast('Ingresá el nombre del evento'); return; }
  const attendanceType = parseInt(tp?.value ?? 1);
  const workCode       = parseInt(wc?.value || 0) || 0;
  const colores = ['#ce93d8','#ffcc80','#80cbc4','#ef9a9a','#a5d6a7','#90caf9','#fff59d','#ffab91'];
  const coloresTipo = {0:'#00e676', 1:'#ff5252', 2:'#ff9100', 3:'#42a5f5'};
  const color = coloresTipo[attendanceType] || colores[eventosLista.length % colores.length];
  eventosLista.push({ nombre, icono, color, attendanceType, workCode });
  n.value=''; ic.value=''; if(wc) wc.value='';
  renderCfgEventos();
  mostrarToast(`Evento "${nombre}" agregado (WC-${workCode||'00'})`);
}
function eliminarEvento(idx){ const n=eventosLista[idx]?.nombre; eventosLista.splice(idx,1); renderCfgEventos(); mostrarToast(`"${n}" eliminado`); }


// ═══════════════════════════════════════════════════════════
// MÓDULO C — EXPORTACIÓN TXT
// Formato: employee_code,date,time,verify_mode,attendance_type,work_code
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// ADMIN — VER FUNCIONARIOS
// ═══════════════════════════════════════════════════════════
function abrirAdminUsuarios(){
  const lista = document.getElementById('admin-usr-list');
  lista.innerHTML = '';
  const enroladosCount = employees.filter(e=>e.enrolled).length;
  const sub = document.getElementById('admin-usr-sub');
  if(sub) sub.textContent = `${enroladosCount}/${employees.length} con biometría`;

  employees.forEach(emp => {
    const enrolled = enrolledPeople.find(e=>e.employee_id===emp.id);
    const card = document.createElement('div');
    card.className = 'usr-card';

    // Avatar: foto si existe, iniciales si no
    let avatarHTML = '';
    if(emp.photo){
      avatarHTML = `<div class="usr-avatar"><img src="${emp.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div>`;
    } else {
      avatarHTML = `<div class="usr-avatar" style="background:${emp.color};">${emp.iniciales}</div>`;
    }

    const badgeClass = enrolled ? 'ok' : 'no';
    const badgeIcon  = enrolled ? '🫅 Biometría OK' : '👤 Sin rostro';

    card.innerHTML = `
      ${avatarHTML}
      <div class="usr-info">
        <div class="usr-name">${emp.name}</div>
        <div class="usr-code">#${String(emp.odoo_employee_id).padStart(4,'0')} · ID ${emp.id}</div>
      </div>
      <div class="usr-bio-badge ${badgeClass}">${badgeIcon}</div>
    `;
    lista.appendChild(card);
  });

  mostrarVista('view-admin-usuarios');
}

// ═══════════════════════════════════════════════════════════
// ADMIN — VER REGISTROS
// ═══════════════════════════════════════════════════════════
function abrirAdminRegistros(){
  // Poblar select de empleados
  const sel = document.getElementById('reg-f-emp');
  sel.innerHTML = '<option value="">Todos los funcionarios</option>';
  employees.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id; opt.textContent = e.name;
    sel.appendChild(opt);
  });
  // Fechas por defecto: hoy
  const hoy = new Date().toISOString().split('T')[0];
  const desdeEl = document.getElementById('reg-f-desde');
  const hastaEl = document.getElementById('reg-f-hasta');
  if(desdeEl && !desdeEl.value) desdeEl.value = hoy;
  if(hastaEl && !hastaEl.value) hastaEl.value = hoy;
  filtrarRegistros();
  mostrarVista('view-admin-registros');
}

function filtrarRegistros(){
  const desde  = document.getElementById('reg-f-desde')?.value || '';
  const hasta  = document.getElementById('reg-f-hasta')?.value || '';
  const empId  = document.getElementById('reg-f-emp')?.value || '';
  const attTypeNames = ['Entrada','Salida','Descanso','Retorno'];
  const attTypeCSS   = ['entrada','salida','descanso','retorno'];

  let logs = [...attendanceLogs];
  if(desde) logs = logs.filter(r => r.date >= desde);
  if(hasta) logs = logs.filter(r => r.date <= hasta);
  if(empId) logs = logs.filter(r => r.employee_id === parseInt(empId));
  // Más reciente primero
  logs.sort((a,b) => b.timestamp.localeCompare(a.timestamp));

  const countEl = document.getElementById('reg-count');
  if(countEl) countEl.textContent = `${logs.length} registro${logs.length!==1?'s':''}`;

  const table = document.getElementById('reg-table');
  table.innerHTML = '';

  if(!logs.length){
    table.innerHTML = '<div class="reg-empty">Sin registros para los filtros seleccionados</div>';
    return;
  }

  logs.forEach(r => {
    const emp = employees.find(e=>e.id===r.employee_id);
    const nombre = emp ? emp.name : `ID ${r.employee_code}`;
    const tipoIdx = r.attendance_type;
    const tipoLabel = attTypeNames[tipoIdx] || `Tipo ${tipoIdx}`;
    const tipoCss   = attTypeCSS[tipoIdx]   || 'entrada';
    const wcNames = {0:'',10:'Médico',11:'Sal. transitoria',12:'Comisión',13:'HS Extra+',14:'HS Extra-',15:'Reunión'};
    const wcLabel = r.work_code ? (wcNames[r.work_code]||`WC-${r.work_code}`) : '';

    // Avatar
    let avatarHTML = '';
    if(emp?.photo){
      avatarHTML = `<div class="reg-row-avatar"><img src="${emp.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div>`;
    } else if(emp){
      avatarHTML = `<div class="reg-row-avatar" style="background:${emp.color};">${emp.iniciales}</div>`;
    } else {
      avatarHTML = `<div class="reg-row-avatar" style="background:#455a64;">#</div>`;
    }

    const row = document.createElement('div');
    row.className = 'reg-row';
    row.innerHTML = `
      ${avatarHTML}
      <div class="reg-row-info">
        <div class="reg-row-name">${nombre}</div>
        <div class="reg-row-meta">${r.date}${wcLabel?' · '+wcLabel:''} · ${r.verify_mode===7?'Facial':'Manual'}</div>
      </div>
      <div class="reg-row-tipo ${tipoCss}">${tipoLabel}</div>
      <div class="reg-row-hora">${r.time.substring(0,5)}</div>
    `;
    table.appendChild(row);
  });
}

// Abre el modal de selección de formato
function exportarRegistros(){
  if(!attendanceLogs.length){
    mostrarToast('Sin registros para exportar');
    return;
  }
  const countEl = document.getElementById('export-record-count');
  if(countEl) countEl.textContent = `${attendanceLogs.length} registro${attendanceLogs.length!==1?'s':''} listos para exportar`;
  document.getElementById('overlay-export').classList.add('show');
}

function cerrarExportModal(){
  document.getElementById('overlay-export').classList.remove('show');
}

// Genera y descarga el archivo en el formato elegido
function ejecutarExport(fmt){
  cerrarExportModal();
  const now = new Date();
  const stamp = `${now.getFullYear()}${formatDig(now.getMonth()+1)}${formatDig(now.getDate())}_${formatDig(now.getHours())}${formatDig(now.getMinutes())}`;

  if(fmt === 'txt'){
    // ── TXT: employee_code,date,time,verify_mode,attendance_type,work_code
    const lines = attendanceLogs.map(r =>
      `${r.employee_code},${r.date},${r.time},${r.verify_mode},${r.attendance_type},${r.work_code}`
    );
    const content = lines.join('\n');
    const fname   = `asistencia_${stamp}.txt`;
    const blob    = new Blob([content], {type:'text/plain;charset=utf-8'});
    _descargarBlob(blob, fname);
    _registrarExport(fname, 'TXT');
    mostrarToast(`✅ TXT exportado — ${attendanceLogs.length} registros`);

  } else if(fmt === 'xlsx'){
    // ── XLSX con SheetJS
    if(typeof XLSX === 'undefined'){
      mostrarToast('Error: librería Excel no cargada. Usá TXT.');
      return;
    }

    // Mapeo de códigos a etiquetas legibles
    const attTypeLabel  = {0:'Entrada',1:'Salida',2:'Descanso',3:'Retorno'};
    const verifyLabel   = {1:'Huella',2:'PIN',3:'NFC',7:'Facial',9:'Manual'};
    const workCodeLabel = {0:'Normal',10:'Médico',11:'Salida transitoria',12:'Comisión',13:'HS Extra inicio',14:'HS Extra fin',15:'Reunión externa'};

    // Fila de encabezados
    const headers = [
      'Código Funcionario','Nombre','Fecha','Hora',
      'Método Verificación','Tipo Marcación','Work Code (Evento)'
    ];

    const rows = attendanceLogs.map(r => {
      const emp = employees.find(e => e.odoo_employee_id === r.employee_code);
      return [
        r.employee_code,
        emp ? emp.name : '—',
        r.date,
        r.time,
        verifyLabel[r.verify_mode]   || r.verify_mode,
        attTypeLabel[r.attendance_type] || r.attendance_type,
        workCodeLabel[r.work_code]   || r.work_code,
      ];
    });

    const wsData = [headers, ...rows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // Ancho de columnas
    ws['!cols'] = [
      {wch:18},{wch:24},{wch:12},{wch:10},{wch:20},{wch:16},{wch:22}
    ];

    // Estilo de encabezado (negrita, fondo azul oscuro)
    const headerRange = XLSX.utils.decode_range(ws['!ref']);
    for(let c = headerRange.s.c; c <= headerRange.e.c; c++){
      const cell = ws[XLSX.utils.encode_cell({r:0, c})];
      if(cell){
        cell.s = {
          font:    {bold:true, color:{rgb:'FFFFFF'}},
          fill:    {fgColor:{rgb:'1565C0'}},
          alignment: {horizontal:'center'},
        };
      }
    }

    // Hoja de resumen en segunda pestaña
    const resumenData = [
      ['Resumen de Exportación'],
      ['Fecha exportación', `${now.getFullYear()}-${formatDig(now.getMonth()+1)}-${formatDig(now.getDate())} ${formatDig(now.getHours())}:${formatDig(now.getMinutes())}`],
      ['Total registros',    attendanceLogs.length],
      ['Pendientes de sync', attendanceLogs.filter(r=>!r.synced).length],
      ['Dispositivo',        document.getElementById('cfg-device-id')?.value||'tablet_01'],
      ['',''],
      ['Distribución por tipo'],
      ['Entradas',   attendanceLogs.filter(r=>r.attendance_type===0).length],
      ['Salidas',    attendanceLogs.filter(r=>r.attendance_type===1).length],
      ['Descansos',  attendanceLogs.filter(r=>r.attendance_type===2).length],
      ['Retornos',   attendanceLogs.filter(r=>r.attendance_type===3).length],
    ];
    const wsResumen = XLSX.utils.aoa_to_sheet(resumenData);
    wsResumen['!cols'] = [{wch:26},{wch:22}];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws,       'Registros');
    XLSX.utils.book_append_sheet(wb, wsResumen,'Resumen');

    const fname = `asistencia_${stamp}.xlsx`;
    XLSX.writeFile(wb, fname);
    _registrarExport(fname, 'XLSX');
    mostrarToast(`✅ Excel exportado — ${attendanceLogs.length} registros`);
  }

  // Actualizar subtitle en admin menu
  const sub = document.getElementById('admin-export-sub');
  if(sub) sub.textContent = `${attendanceLogs.length} registros — ${formatDig(now.getHours())}:${formatDig(now.getMinutes())}`;
  logDiag('export_ok:'+fmt+':'+attendanceLogs.length);
}

function _descargarBlob(blob, fname){
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href=url; a.download=fname; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

function _registrarExport(fname, fmt){
  const now = new Date();
  exportLogs.push({
    id:               exportLogs.length+1,
    export_date:      `${now.getFullYear()}-${formatDig(now.getMonth()+1)}-${formatDig(now.getDate())} ${formatDig(now.getHours())}:${formatDig(now.getMinutes())}:${formatDig(now.getSeconds())}`,
    records_exported: attendanceLogs.length,
    format:           fmt,
    filename:         fname,
    exported_by:      'admin',
  });
}

// ═══════════════════════════════════════════════════════════
// MÓDULO D — SINCRONIZACIÓN ODOO
// POST a hr.attendance por cada registro no sincronizado
// ═══════════════════════════════════════════════════════════
async function mostrarSyncOdoo(){
  const pendientes = attendanceLogs.filter(r=>!r.synced);
  const url   = document.getElementById('cfg-odoo-url')?.value?.trim();
  const token = document.getElementById('cfg-odoo-token')?.value?.trim();
  const sub   = document.getElementById('admin-sync-sub');

  if(!pendientes.length){
    mostrarToast('Todo sincronizado — sin registros pendientes');
    if(sub) sub.textContent='Sin registros pendientes';
    return;
  }
  if(!url||!token){
    mostrarToast('Configurá la URL y Token de Odoo en Configuración');
    if(sub) sub.textContent='Configurar URL y Token primero';
    return;
  }
  if(sub) sub.textContent=`Sincronizando ${pendientes.length} registros...`;
  logDiag('odoo_sync_start:'+pendientes.length);

  let ok=0, fail=0;
  for(const r of pendientes){
    try{
      const deviceId = document.getElementById('cfg-device-id')?.value||'tablet_01';
      const body = {
        employee_id:     r.employee_code,
        timestamp:       r.timestamp,
        attendance_type: r.attendance_type,
        work_code:       r.work_code,
        verify_mode:     r.verify_mode,
        device_id:       deviceId,
        record_id:       r.record_id,
      };
      const res = await fetch(`${url}/api/attendance/record`, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if(res.ok){ r.synced=true; ok++; }
      else { fail++; console.warn('Odoo error:', res.status, await res.text()); }
    }catch(e){ fail++; console.warn('Odoo fetch error:', e.message); }
  }

  const msg = fail===0 ? `✅ ${ok} registros sincronizados` : `⚠️ ${ok} OK — ${fail} fallidos`;
  mostrarToast(msg);
  if(sub) sub.textContent=msg;
  actualizarEstadoSistema();
  logDiag(`odoo_sync_end:ok=${ok}:fail=${fail}`);
}

// ═══════════════════════════════════════════════════════════
// EVENTOS RECIENTES + ESTADO DEL SISTEMA
// ═══════════════════════════════════════════════════════════
const recentLogs = [];

function renderRecentEvents(){
  const lista=document.getElementById('recent-events-list');
  if(!lista) return;
  if(!recentLogs.length){
    lista.innerHTML='<div class="recent-empty">Sin eventos aún</div>'; return;
  }
  lista.innerHTML=recentLogs.map(r=>`
    <div class="recent-event-row">
      <span class="recent-event-time">${r.ts}</span>
      <span class="recent-event-text"><span class="recent-event-tipo">${r.tipo}</span>${r.nombre!=='Sin identificar'?' — '+r.nombre:''}</span>
    </div>`).join('');
}

function actualizarDotCamara(activa){
  const d=document.getElementById('dot-cam'); if(d) d.className='ind-dot '+(activa?'ok':'err');
  const l=document.querySelector('#ind-cam .ind-label'); if(l) l.textContent=activa?'Cámara activa':'Sin cámara';
}

function actualizarEstadoSistema(){
  // Dispositivo: siempre online si llegó hasta acá
  const dd=document.getElementById('dot-device'); if(dd) dd.className='ind-dot ok';
  // Cámara: según videoStream
  actualizarDotCamara(!!(videoStream&&videoStream.active));
  // Enrolados: muestra cuántos funcionarios tienen biometría
  const de=document.getElementById('dot-enroll');
  const le=document.getElementById('lbl-enroll');
  const nEnroll=enrolledPeople.length;
  if(de) de.className='ind-dot '+(nEnroll>0?'ok':'warn');
  if(le) le.textContent=nEnroll>0?`${nEnroll} enrolado${nEnroll>1?'s':''}`:'Sin enrolar';
  // Sync: verde=todo sincronizado, amarillo=hay pendientes, gris=sin registros
  const ds=document.getElementById('dot-sync');
  if(ds){
    const total=attendanceLogs.length;
    const pendientes=attendanceLogs.filter(l=>!l.synced).length;
    ds.className='ind-dot '+(total===0?'':'pendientes>0'?'warn':'ok');
    if(total===0) ds.className='ind-dot';
    else if(pendientes>0) ds.className='ind-dot warn';
    else ds.className='ind-dot ok';
    const ls=document.querySelector('#ind-sync .ind-label');
    if(ls){
      if(total===0) ls.textContent='Sin registros';
      else if(pendientes>0) ls.textContent=`${pendientes} pendientes`;
      else ls.textContent='Sincronizado';
    }
  }
}

// ═══════════════════════════════════════════════════════════
// LOG DE DIAGNÓSTICO — PDF punto 15
// Guarda los últimos 100 eventos en localStorage para soporte
// ═══════════════════════════════════════════════════════════
const DIAG_KEY='kiosk_diag_log';
function logDiag(evento){
  const ts=new Date().toISOString().substring(11,19);
  const entrada=`${ts} ${evento}`;
  console.log('[KIOSK]', entrada);
  try{
    const logs=JSON.parse(localStorage.getItem(DIAG_KEY)||'[]');
    logs.push(entrada);
    if(logs.length>100) logs.splice(0,logs.length-100); // mantener últimos 100
    localStorage.setItem(DIAG_KEY,JSON.stringify(logs));
  }catch(e){}
}

// ═══════════════════════════════════════════════════════════
// WATCHDOG DE CÁMARA — PDF punto 5
// Detecta si la cámara se bloqueó (suspensión, otra app, rotación)
// y la reinicia automáticamente
// ═══════════════════════════════════════════════════════════
let watchdogInterval=null;
function iniciarWatchdogCamara(){
  if(watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval=setInterval(async()=>{
    // Si hay un escaneo activo, no interferir
    if(scanActive) return;
    // Verificar si el stream se cortó
    const streamMuerto=!videoStream||!videoStream.active||
      videoStream.getTracks().every(t=>t.readyState==='ended');
    if(streamMuerto&&cameraPermissionState==='granted'){
      logDiag('camera_watchdog_restart');
      setBioStatus('warn','Reconectando cámara...');
      videoStream=null; globalVideo=null;
      const ok = await iniciarCamaraGlobal();
      if(ok) startFaceWakeUp();
    }
  }, 5000); // revisar cada 5 segundos
}

// Reanudar cámara cuando la pestaña vuelve a estar visible (PDF punto 5)
document.addEventListener('visibilitychange',async()=>{
  if(document.visibilityState==='visible'){
    logDiag('app_resumed');
    const streamMuerto=!videoStream||!videoStream.active||
      videoStream.getTracks().every(t=>t.readyState==='ended');
    if(streamMuerto&&cameraPermissionState==='granted'){
      logDiag('camera_restart_on_resume');
      videoStream=null; globalVideo=null;
      const ok2 = await iniciarCamaraGlobal();
      if(ok2) startFaceWakeUp();
    }
  } else {
    logDiag('app_paused');
  }
});

// ═══════════════════════════════════════════════════════════
// INIT — secuencia: permiso → modelos IA → cámara automática
// PDF punto 1: permiso al primer arranque, guardado permanente
// PDF punto 4: cámara activa sin que el usuario toque nada
// ═══════════════════════════════════════════════════════════
mostrarVista('view-main');
setBioRingState('waiting');
actualizarEstadoSistema();

// Pre-cargar voces TTS inmediatamente (Android necesita esto temprano)
if('speechSynthesis' in window){
  window.speechSynthesis.getVoices();
  window.speechSynthesis.onvoiceschanged=()=>window.speechSynthesis.getVoices();
}

window.addEventListener('load', arranqueKiosk);

async function arranqueKiosk(){
  // PASO 1 — Pedir permiso de cámara PRIMERO, antes de todo
  // localStorage puede estar bloqueado (Tracking Prevention en Edge/file://)
  let permGuardado = null;
  try{ permGuardado = localStorage.getItem('kiosk_cam_permission'); }catch(e){}
  if(permGuardado === 'granted'){
    logDiag('camera_permission_cached');
    cameraPermissionState = 'granted';
  } else {
    await solicitarPermisosCamara();
  }

  // PASO 2 — Cargar modelos IA (en paralelo con la espera del permiso ya resuelta)
  await cargarModelosIA();

  // PASO 3 — Abrir cámara automáticamente si hay permiso
  if(cameraPermissionState === 'granted'){
    logDiag('camera_autostart');
    await iniciarCamaraGlobal();
    iniciarWatchdogCamara();
    // Wake-Up arranca cuando los modelos terminen de cargar (en cargarModelosIA)
  }
}

// Carga modelos IA — llamada desde arranqueKiosk después de obtener permiso
// Se mantiene alias cargarModelosSinCamara para compatibilidad con otros usos
async function cargarModelosIA(){
  setBioStatus('loading','Cargando modelos IA...');
  setBioLabel('Inicializando reconocimiento...');
  document.getElementById('models-bar').style.display='block';
  logDiag('models_loading_start');
  try{
    let t=0; while(typeof faceapi==='undefined'&&t<50){await sleep(200);t++;}
    if(typeof faceapi==='undefined') throw new Error('face-api no cargó');
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODELS_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL),
    ]);
    document.getElementById('models-bar').style.display='none';
    faceApiReady=true;
    logDiag('models_loaded_ok');
    setBioLabel('Asistencia');
    setBioStatus('ok','Presione un botón para marcar asistencia');
    setBioRingState('waiting');
    actualizarEstadoSistema();
    cargarEnroladosSession(); // restaurar enrolados de sessionStorage
    // Iniciar Face Wake-Up ahora que los modelos están listos
    startFaceWakeUp();
  }catch(err){
    document.getElementById('models-bar').style.display='none';
    setBioStatus('error','Modelos no disponibles');
    setBioLabel('Modo manual');
    setBioRingState('waiting');
    logDiag('models_error:' + err.message);
    console.error('face-api error:',err);
  }
}
// Alias para compatibilidad con llamadas internas existentes
const cargarModelosSinCamara = cargarModelosIA;
// Exponer funciones para HTML
window.iniciarEscaneo = iniciarEscaneo;
window.mostrarLogin = mostrarLogin;
window.abrirEventos = abrirEventos;
window.verificarLogin = verificarLogin;
window.volverMain = volverMain;
