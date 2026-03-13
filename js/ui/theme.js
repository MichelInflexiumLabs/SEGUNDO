//MODO OSCURO / CLARO
// ═══════════════════════════════════════════════════════════
let darkMode = true;
function toggleTheme(){
  darkMode = !darkMode;
  document.body.classList.toggle('light', !darkMode);
  const tog  = document.getElementById('toggle-theme');
  const icon = document.getElementById('theme-icon');
  const lbl  = document.getElementById('theme-label');
  if(darkMode){ tog.classList.add('on'); icon.textContent='🌙'; lbl.textContent='Modo Oscuro'; }
  else        { tog.classList.remove('on'); icon.textContent='☀️'; lbl.textContent='Modo Claro'; }
  try{ localStorage.setItem('kiosk-theme', darkMode?'dark':'light'); }catch(e){}
}
(function initTheme(){
  try{
    const saved = localStorage.getItem('kiosk-theme');
    if(saved === 'light'){ darkMode=false; document.body.classList.add('light');
      document.getElementById('toggle-theme').classList.remove('on');
      document.getElementById('theme-icon').textContent='☀️';
      document.getElementById('theme-label').textContent='Modo Claro';
    }
  }catch(e){}
})();

// ═══════════════════════════════════════════════════════════
// SELECTOR DE MODO (pantalla)
// ═══════════════════════════════════════════════════════════
function setMode(mode){
  document.body.className = document.body.className
    .replace(/\bmode-\S+/g,'').replace(/\blight\b/,'').trim();
  if(!darkMode) document.body.classList.add('light');
  if(mode !== 'default') document.body.classList.add('mode-'+mode);
  document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('btn-mode-'+mode).classList.add('active');
}

// ═══════════════════════════════════════════════════════════
// 