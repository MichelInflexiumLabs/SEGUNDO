//RELOJ
// ═══════════════════════════════════════════════════════════
const CONFIG = { formato24:true, password:'1234' };
let autoResetTimer=null, detectedPerson=null, lastConfidence=null;

function formatDig(n){ return String(n).padStart(2,'0'); }
function actualizarReloj(){
  const now=new Date(), h24=now.getHours();
  let h=h24; const ampm=h24>=12?'PM':'AM';
  if(!CONFIG.formato24) h=h%12||12;
  document.getElementById('horas').textContent=formatDig(h);
  document.getElementById('minutos').textContent=formatDig(now.getMinutes());
  document.getElementById('segundos').textContent=formatDig(now.getSeconds());
  const b=document.getElementById('ampm-badge');
  if(!CONFIG.formato24){b.style.display='';b.textContent=ampm;}else b.style.display='none';
  const dias=['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const meses=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  document.getElementById('fecha-display').textContent=`${dias[now.getDay()]}, ${now.getDate()} de ${meses[now.getMonth()]} de ${now.getFullYear()}`;
}
setInterval(actualizarReloj,1000); actualizarReloj();

// ═══════════════════════════════════════════════════════════
// 