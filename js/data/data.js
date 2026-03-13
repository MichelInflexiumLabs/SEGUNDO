//BASE DE DATOS LOCAL
// ═══════════════════════════════════════════════════════════
let employees = [
  { id:1, odoo_employee_id:1015, name:'María González',    iniciales:'MG', color:'#c2185b', active:true, enrolled:false },
  { id:2, odoo_employee_id:1022, name:'Carlos Rodríguez',  iniciales:'CR', color:'#1565c0', active:true, enrolled:false },
  { id:3, odoo_employee_id:1008, name:'Ana Martínez',      iniciales:'AM', color:'#00695c', active:true, enrolled:false },
  { id:4, odoo_employee_id:1031, name:'Luis Fernández',    iniciales:'LF', color:'#6a1b9a', active:true, enrolled:false },
  { id:5, odoo_employee_id:1019, name:'Rosa Silva',        iniciales:'RS', color:'#e65100', active:true, enrolled:false },
];
const attendanceLogs = [];
// enrolledPeople: { employee_id, name, matcher (FaceMatcher) }
const enrolledPeople = [];

function generateUUID(){
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
    const r=Math.random()*16|0; return(c==='x'?r:r&0x3|0x8).toString(16);
  });
}
// export_logs: auditoría de exportaciones
const exportLogs = [];

// attendance_type: 0=Entrada,1=Salida,2=Descanso,3=Retorno
// work_code: 0=normal, 10=Médico, 11=Salida transitoria, 12=Comisión, 13=HS Extra inicio, 14=HS Extra fin, 15=Reunión externa
function registrarLog(employeeId, verifyMode, attendanceType, workCode){
  const now = new Date();
  const date = `${now.getFullYear()}-${formatDig(now.getMonth()+1)}-${formatDig(now.getDate())}`;
  const time = `${formatDig(now.getHours())}:${formatDig(now.getMinutes())}:${formatDig(now.getSeconds())}`;
  const ts   = `${date} ${time}`;
  // Buscar employee_code (odoo_employee_id) a partir del id interno
  const emp  = employees.find(e=>e.id===employeeId);
  const empCode = emp ? emp.odoo_employee_id : (employeeId||0);
  const log  = {
    record_id:       generateUUID(),
    employee_id:     employeeId||0,
    employee_code:   empCode,
    date, time,
    timestamp:       ts,
    verify_mode:     verifyMode||9,
    attendance_type: attendanceType||0,
    work_code:       workCode||0,
    device_id:       'tablet_01',
    synced:          false,
    created_at:      ts,
  };
  attendanceLogs.push(log);
  console.log('📋 Registro:', log);
  return log;
}

// ═══════════════════════════════════════════════════════════
// 