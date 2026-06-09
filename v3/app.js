// ======= CONFIG & STATE =======
// ⚠️ ضع هنا الرابط والمفتاح العام اللذين نسختهما من إعدادات Supabase الخاصة بك
const SUPABASE_URL = "https://gpaqcfhswfnudpqlxcfs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_WiQrWKnOxv0RZKLVgFChXQ_1Sb2LRRq";

// إنشاء عميل الاتصال بالسحاب
const supabase = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

let students = [], invitations = {}, scanLog = [], entryTimeline = [];
let donutChart = null, lineChart = null, html5Qr = null, cameraRunning = false;
let autoCloseTimer = null;

// ======= AUDIO =======
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playBeep(type) {
    try {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);

        if (type === 'success') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, audioCtx.currentTime);
            gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
            osc.start();
            setTimeout(() => { osc.frequency.setValueAtTime(1320, audioCtx.currentTime); }, 80);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.25);
            osc.stop(audioCtx.currentTime + 0.25);
        } else if (type === 'duplicate') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(220, audioCtx.currentTime);
            osc.frequency.linearRampToValueAtTime(110, audioCtx.currentTime + 0.35);
            gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.35);
            osc.start(); osc.stop(audioCtx.currentTime + 0.35);
        } else {
            osc.type = 'square';
            osc.frequency.setValueAtTime(150, audioCtx.currentTime);
            gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
            osc.start();
            setTimeout(() => { osc.frequency.setValueAtTime(120, audioCtx.currentTime); }, 100);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
            osc.stop(audioCtx.currentTime + 0.4);
        }
    } catch (e) { }
}

// ======= CLOUD STORAGE (SUPABASE) =======
async function loadState() {
    if (!supabase) return;
    try {
        const { data: dbStudents, error: errS } = await supabase.from('students').select('*').order('created_at', { ascending: true });
        if (errS) throw errS;

        const { data: dbInvitations, error: errI } = await supabase.from('invitations').select('*');
        if (errI) throw errI;

        students = dbStudents.map(s => ({
            id: s.id, name: s.name, inv1: genCode(s.id, 1), inv2: genCode(s.id, 2)
        }));

        invitations = {};
        dbInvitations.forEach(i => {
            const studentObj = dbStudents.find(s => s.id === i.student_id);
            invitations[i.code] = {
                studentId: i.student_id,
                name: studentObj ? studentObj.name : '—',
                invNum: i.inv_num,
                used: i.used,
                usedAt: i.used_at ? new Date(i.used_at).toLocaleTimeString('ar-SA') : null
            };
        });

        const sl = localStorage.getItem('inv_scanLog');
        const se = localStorage.getItem('inv_entryTimeline');
        if (sl) scanLog = JSON.parse(sl);
        if (se) entryTimeline = JSON.parse(se);

        // الحماية: التحقق من وجود العناصر قبل تعديل خصائصها
        if (students.length > 0) {
            const stSec = document.getElementById('students-section');
            if (stSec) stSec.style.display = 'block';

            renderStudentsTable();

            if (Object.keys(invitations).length > 0) {
                const genIdle = document.getElementById('gen-idle');
                const genActions = document.getElementById('gen-actions');
                if (genIdle) genIdle.style.display = 'none';
                if (genActions) genActions.style.display = 'flex';
                renderQRPlaceholders();
            }
        }
        renderLogFromState();
        updateHeader();
    } catch (e) {
        console.error('خطأ في جلب البيانات السحابية:', e);
    }
}

// ======= TABS =======
function showPanel(name, el) {
    const panel = document.getElementById('panel-' + name);
    if (!panel) return;

    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

    panel.classList.add('active');
    if (el) el.classList.add('active');

    if (name === 'dash') refreshDash();

    const scanInp = document.getElementById('scan-input');
    if (name === 'scan' && document.getElementById('mode-manual')?.classList.contains('active') && scanInp) {
        scanInp.focus();
    }
    if (name !== 'scan') stopCamera();
}

// ======= MODE TOGGLE =======
function setMode(mode) {
    const camBtn = document.getElementById('mode-cam');
    const manBtn = document.getElementById('mode-manual');
    const camSec = document.getElementById('cam-section');
    const manSec = document.getElementById('manual-section');
    const scanInp = document.getElementById('scan-input');

    if (camBtn) camBtn.classList.toggle('active', mode === 'cam');
    if (manBtn) manBtn.classList.toggle('active', mode === 'manual');
    if (camSec) camSec.style.display = mode === 'cam' ? 'block' : 'none';
    if (manSec) manSec.style.display = mode === 'manual' ? 'block' : 'none';

    if (mode === 'manual') {
        stopCamera();
        if (scanInp) scanInp.focus();
    }
}

// ======= CAMERA =======
function startCamera() {
    if (Object.keys(invitations).length === 0) { alert('يجب توليد الدعوات أولاً قبل المسح'); return; }
    const readerEl = document.getElementById('reader'); readerEl.innerHTML = '';
    html5Qr = new Html5Qrcode('reader');
    const config = { fps: 15, qrbox: { width: 220, height: 220 }, aspectRatio: 1.0 };
    html5Qr.start(
        { facingMode: 'environment' }, config,
        (decodedText) => { if (!cameraRunning) return; doScan(decodedText.trim()); },
        () => { }
    ).then(() => {
        cameraRunning = true;
        document.getElementById('btn-start-cam').style.display = 'none';
        document.getElementById('btn-stop-cam').style.display = 'flex';
        document.getElementById('cam-status').textContent = 'الكاميرا تعمل — وجّه الباركود داخل الإطار';
        document.getElementById('cam-status').style.color = 'var(--success)';
    }).catch(err => {
        document.getElementById('cam-status').textContent = 'تعذر الوصول للكاميرا: ' + err;
        document.getElementById('cam-status').style.color = 'var(--danger)';
    });
}

function stopCamera() {
    if (html5Qr && cameraRunning) {
        html5Qr.stop().then(() => {
            cameraRunning = false;
            document.getElementById('btn-start-cam').style.display = 'flex';
            document.getElementById('btn-stop-cam').style.display = 'none';
            document.getElementById('cam-status').textContent = 'الكاميرا متوقفة';
            document.getElementById('cam-status').style.color = 'var(--text-muted)';
        }).catch(() => { });
    }
}

// ======= SCAN RESULT =======
function showResultOverlay(type, data) {
    const overlay = document.getElementById('result-overlay');
    if (!overlay) return;

    const icons = { success: '✅', duplicate: '⚠️', invalid: '❌' };
    const statusTx = { success: 'تم تسجيل الدخول بنجاح!', duplicate: 'هذه الدعوة مستخدمة مسبقاً!', invalid: 'باركود غير صالح!' };
    const statusCls = { success: 'ok', duplicate: 'dup', invalid: 'bad' };
    const overlayC = { success: 'success-ov', duplicate: 'duplicate-ov', invalid: 'invalid-ov' };

    const resIcon = document.getElementById('res-icon');
    const stEl = document.getElementById('res-status');
    if (resIcon) resIcon.textContent = icons[type];
    if (stEl) { stEl.textContent = statusTx[type]; stEl.className = 'result-status-text ' + statusCls[type]; }

    const resName = document.getElementById('res-name');
    const resSid = document.getElementById('res-sid');
    const invEl = document.getElementById('res-inv');
    const resTime = document.getElementById('res-time');

    if (type !== 'invalid') {
        if (resName) resName.textContent = data.name;
        if (resSid) resSid.textContent = 'رقم الطالب: ' + data.studentId;
        if (invEl) {
            invEl.textContent = 'دعوة ' + (data.invNum === 1 ? 'الأولى' : 'الثانية');
            invEl.className = 'result-inv-badge ' + (data.invNum === 1 ? 'badge-info' : 'badge-success');
        }
        if (resTime) resTime.textContent = type === 'duplicate' ? 'سبق دخوله في: ' + data.usedAt : 'وقت الدخول: ' + new Date().toLocaleTimeString('ar-SA');
    } else {
        if (resName) resName.textContent = 'رمز غير معرّف';
        if (resSid) resSid.textContent = '';
        if (invEl) invEl.textContent = '';
        if (resTime) resTime.textContent = '';
    }

    const resCode = document.getElementById('res-code');
    if (resCode) resCode.textContent = lastScanCode;
    overlay.className = 'result-overlay show ' + overlayC[type];

    const bar = document.getElementById('res-autobar');
    if (bar) {
        bar.style.transition = 'none'; bar.style.width = '100%';
        setTimeout(() => { bar.style.transition = 'width 3s linear'; bar.style.width = '0%'; }, 50);
    }
    clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(() => dismissResult(), 3000);
}

function addLog(code, status, name, type, time) {
    const logEl = document.getElementById('scan-log');
    if (!logEl) return;

    const es = logEl.querySelector('.empty-state'); if (es) es.remove();
    const icons = { ok: '✅', dup: '⚠️', bad: '❌' };
    const item = document.createElement('div'); item.className = 'log-item ' + type;
    item.innerHTML = `<span>${icons[type]}</span>
    <span style="font-weight:600;flex:1">${name !== '—' ? name : code.substring(0, 16)}</span>
    <span class="badge badge-${type === 'ok' ? 'success' : type === 'dup' ? 'warning' : 'danger'}">${status}</span>
    <span class="log-time">${time}</span>`;
    logEl.insertBefore(item, logEl.firstChild);

    // تجنب التكرار في المصفوفة المحلية
    if (!scanLog.some(l => l.code === code && l.time === time)) {
        scanLog.unshift({ code, status, name, type, time });
    }
}

function updateHeader() {
    const total = Object.keys(invitations).length;
    const entered = Object.values(invitations).filter(i => i.used).length;
    const pct = total > 0 ? Math.round(entered / total * 100) : 0;

    const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };

    setTxt('hdr-total', total.toLocaleString('ar'));
    setTxt('hdr-entered', entered.toLocaleString('ar'));
    setTxt('hdr-pct', pct + '%');
    setTxt('cnt-total', total.toLocaleString('ar'));
    setTxt('cnt-entered', entered.toLocaleString('ar'));
    setTxt('cnt-remaining', (total - entered).toLocaleString('ar'));
}

function renderStudentsTable() {
    const tbody = document.getElementById('students-tbody');
    if (!tbody) return;

    tbody.innerHTML = students.map((s, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><span class="badge badge-info">${s.id}</span></td>
      <td><strong>${s.name}</strong></td>
      <td style="font-size:10px;font-family:monospace;color:var(--text-muted)">${s.inv1 || '—'}</td>
      <td style="font-size:10px;font-family:monospace;color:var(--text-muted)">${s.inv2 || '—'}</td>
      <td><button class="btn btn-danger" style="padding:4px 10px;font-size:11px" onclick="removeStudent(${i})">🗑️</button></td>
    </tr>`).join('');
}

function renderQRPlaceholders() {
    const previewEl = document.getElementById('qr-preview');
    if (!previewEl) return;

    previewEl.innerHTML = '';
    students.forEach(s => {
        [1, 2].forEach(num => {
            const code = s['inv' + num];
            const card = document.createElement('div'); card.className = 'qr-card';
            const b64 = s['qr' + num + '_base64'];
            if (b64) {
                const img = document.createElement('img'); img.src = b64; img.alt = code; card.appendChild(img);
            } else {
                const ph = document.createElement('div');
                ph.style.cssText = 'width:114px;height:114px;background:#f1f5f9;border:1px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:10px;color:#94a3b8;border-radius:6px;margin:0 auto 8px;text-align:center;padding:8px;';
                ph.textContent = '⚡ اضغط توليد لإعادة إنشاء الباركود'; card.appendChild(ph);
            }
            const nameDiv = document.createElement('div'); nameDiv.className = 'name'; nameDiv.textContent = s.name;
            const idDiv = document.createElement('div'); idDiv.className = 'inv-id'; idDiv.textContent = code;
            const bwrap = document.createElement('div'); bwrap.style.cssText = 'font-size:10px;margin-top:4px';
            const badge = document.createElement('span');
            badge.className = 'badge badge-' + (num === 1 ? 'info' : 'success'); badge.textContent = 'دعوة ' + (num === 1 ? 'الأولى' : 'الثانية');
            bwrap.appendChild(badge); card.appendChild(nameDiv); card.appendChild(idDiv); card.appendChild(bwrap);
            previewEl.appendChild(card);
        });
    });
}

function renderLogFromState() {
    const logEl = document.getElementById('scan-log');
    if (!logEl) return;
    if (scanLog.length === 0) return;

    logEl.innerHTML = '';
    const icons = { ok: '✅', dup: '⚠️', bad: '❌' };
    scanLog.forEach(l => {
        const item = document.createElement('div'); item.className = 'log-item ' + l.type;
        item.innerHTML = `<span>${icons[l.type] || '🔍'}</span>
      <span style="font-weight:600;flex:1">${l.name !== '—' ? l.name : l.code.substring(0, 16)}</span>
      <span class="badge badge-${l.type === 'ok' ? 'success' : l.type === 'dup' ? 'warning' : 'danger'}">${l.status}</span>
      <span class="log-time">${l.time}</span>`;
        logEl.appendChild(item);
    });
}

// ======= REALTIME LIVE SCAN LOGIC =======
let lastScanned = '', lastScanTime = 0;
async function doScan(code) {
    const now = Date.now();
    if (code === lastScanned && now - lastScanTime < 2000) return;
    lastScanned = code; lastScanTime = now; lastScanCode = code;
    const timeStr = new Date().toLocaleTimeString('ar-SA');

    if (!supabase) return;

    try {
        const { data: invData, error } = await supabase.from('invitations').select('*, students(name)').eq('code', code).single();

        if (error || !invData) {
            playBeep('invalid');
            showResultOverlay('invalid', {});
            addLog(code, 'باركود غير صالح', '—', 'bad', timeStr);
            return;
        }

        const studentName = invData.students ? invData.students.name : '—';

        if (invData.used) {
            const formattedUsedAt = invData.used_at ? new Date(invData.used_at).toLocaleTimeString('ar-SA') : timeStr;
            playBeep('duplicate');
            showResultOverlay('duplicate', { studentId: invData.student_id, name: studentName, invNum: invData.inv_num, usedAt: formattedUsedAt });
            addLog(code, 'مكرر', studentName, 'dup', timeStr);
            invitations[code].used = true;
        } else {
            const isoNow = new Date().toISOString();
            const { error: updateErr } = await supabase.from('invitations').update({ used: true, used_at: isoNow }).eq('code', code);
            if (updateErr) throw updateErr;

            playBeep('success');
            invitations[code] = { studentId: invData.student_id, name: studentName, invNum: invData.inv_num, used: true, usedAt: timeStr };

            entryTimeline.push({ time: timeStr, count: Object.values(invitations).filter(i => i.used).length });
            showResultOverlay('success', invitations[code]);
            addLog(code, 'دخول مؤكد', studentName, 'ok', timeStr);
            updateHeader();

            localStorage.setItem('inv_scanLog', JSON.stringify(scanLog));
            localStorage.setItem('inv_entryTimeline', JSON.stringify(entryTimeline));
        }
    } catch (e) {
        console.error(e);
        alert('خطأ في شبكة الاتصال السحابية!');
    }
}

let scanTimeout = null;
function autoScan(val) {
    clearTimeout(scanTimeout);
    if (val.length >= 10) scanTimeout = setTimeout(() => doScan(val.trim()), 400);
}
function manualScan() {
    const val = document.getElementById('scan-input').value.trim();
    if (val) doScan(val);
}

function addLog(code, status, name, type, time) {
    const logEl = document.getElementById('scan-log');
    const es = logEl.querySelector('.empty-state'); if (es) es.remove();
    const icons = { ok: '✅', dup: '⚠️', bad: '❌' };
    const item = document.createElement('div'); item.className = 'log-item ' + type;
    item.innerHTML = `<span>${icons[type]}</span>
    <span style="font-weight:600;flex:1">${name !== '—' ? name : code.substring(0, 16)}</span>
    <span class="badge badge-${type === 'ok' ? 'success' : type === 'dup' ? 'warning' : 'danger'}">${status}</span>
    <span class="log-time">${time}</span>`;
    logEl.insertBefore(item, logEl.firstChild);
    scanLog.unshift({ code, status, name, type, time });
}

// جعل الدوال العالمية متاحة للـ HTML المباشر عند استدعائها من الأزرار
window.clearLog = function () {
    if (!confirm('مسح سجل الدخول؟')) return;
    document.getElementById('scan-log').innerHTML =
        '<div class="empty-state" style="padding:24px"><div class="icon">📋</div><p>لا توجد عمليات مسح بعد</p></div>';
    scanLog = []; localStorage.removeItem('inv_scanLog');
}

// ======= DETERMINISTIC CODE GENERATION =======
function genCode(studentId, num) {
    const seed = String(studentId) + '::INV::' + num;
    let hash = 5381;
    for (let i = 0; i < seed.length; i++) {
        hash = ((hash << 5) + hash) + seed.charCodeAt(i);
        hash = hash & 0xFFFFFFFF;
    }
    const suffix = (Math.abs(hash) >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(-4);
    return `INV-${String(studentId).padStart(4, '0')}-${num}-${suffix}`;
}

function updateHeader() {
    const total = Object.keys(invitations).length;
    const entered = Object.values(invitations).filter(i => i.used).length;
    const pct = total > 0 ? Math.round(entered / total * 100) : 0;
    document.getElementById('hdr-total').textContent = total.toLocaleString('ar');
    document.getElementById('hdr-entered').textContent = entered.toLocaleString('ar');
    document.getElementById('hdr-pct').textContent = pct + '%';
    document.getElementById('cnt-total').textContent = total.toLocaleString('ar');
    document.getElementById('cnt-entered').textContent = entered.toLocaleString('ar');
    document.getElementById('cnt-remaining').textContent = (total - entered).toLocaleString('ar');
}

// ======= DATA SEEDING & INPUT =======
window.loadSample = async function () {
    if (!supabase) return;
    const s = [
        { id: '1001', name: 'أحمد محمد الغامدي' }, { id: '1002', name: 'سارة عبدالله الزهراني' },
        { id: '1003', name: 'خالد إبراهيم العمري' }, { id: '1004', name: 'نورة سعد القحطاني' },
        { id: '1005', name: 'عمر علي الشهري' }, { id: '1006', name: 'ريم فهد الدوسري' },
        { id: '1007', name: 'محمد عبدالرحمن الحربي' }, { id: '1008', name: 'لمى يوسف المالكي' },
    ];

    let studentsToInsert = [], invitationsToInsert = [];
    s.forEach(x => {
        if (!students.find(st => st.id === x.id)) {
            const inv1 = genCode(x.id, 1), inv2 = genCode(x.id, 2);
            studentsToInsert.push({ id: x.id, name: x.name });
            invitationsToInsert.push({ code: inv1, student_id: x.id, inv_num: 1, used: false });
            invitationsToInsert.push({ code: inv2, student_id: x.id, inv_num: 2, used: false });
        }
    });

    if (studentsToInsert.length > 0) {
        try {
            await supabase.from('students').insert(studentsToInsert);
            await supabase.from('invitations').insert(invitationsToInsert);
            await loadState();
            alert('تم تحميل البيانات التجريبية سحابياً بنجاح!');
        } catch (e) { alert('خطأ في تحميل العينات: ' + e.message); }
    }
}

window.addManual = async function () {
    const id = document.getElementById('inp-id').value.trim();
    const name = document.getElementById('inp-name').value.trim();
    if (!id || !name) { alert('أدخل رقم الطالب والاسم'); return; }
    await addStudent(id, name, true);
    document.getElementById('inp-id').value = '';
    document.getElementById('inp-name').value = '';
}

async function addStudent(id, name, shouldSave = true) {
    if (students.find(s => s.id === id)) { alert('الرقم موجود: ' + id); return; }
    const inv1 = genCode(id, 1), inv2 = genCode(id, 2);

    if (shouldSave && supabase) {
        try {
            const { error: errS } = await supabase.from('students').insert([{ id, name }]);
            if (errS) throw errS;
            const { error: errI } = await supabase.from('invitations').insert([
                { code: inv1, student_id: id, inv_num: 1, used: false },
                { code: inv2, student_id: id, inv_num: 2, used: false }
            ]);
            if (errI) throw errI;
        } catch (e) {
            alert('حدث خطأ أثناء الحفظ السحابي: ' + e.message);
            return;
        }
    }

    students.push({ id, name, inv1, inv2 });
    invitations[inv1] = { studentId: id, name, invNum: 1, used: false, usedAt: null };
    invitations[inv2] = { studentId: id, name, invNum: 2, used: false, usedAt: null };

    renderStudentsTable();
    document.getElementById('students-section').style.display = 'block';
    updateHeader();
}

window.removeStudent = async function (i) {
    if (!confirm('هل أنت متأكد من حذف هذا الطالب وجميع دعواته سحابياً؟')) return;
    const s = students[i];
    if (supabase) {
        try {
            const { error } = await supabase.from('students').delete().eq('id', s.id);
            if (error) throw error;
        } catch (e) {
            alert('تعذر الحذف من السيرفر: ' + e.message);
            return;
        }
    }
    delete invitations[s.inv1]; delete invitations[s.inv2];
    students.splice(i, 1); renderStudentsTable(); updateHeader();
}

function renderStudentsTable() {
    document.getElementById('students-tbody').innerHTML = students.map((s, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><span class="badge badge-info">${s.id}</span></td>
      <td><strong>${s.name}</strong></td>
      <td style="font-size:10px;font-family:monospace;color:var(--text-muted)">${s.inv1 || '—'}</td>
      <td style="font-size:10px;font-family:monospace;color:var(--text-muted)">${s.inv2 || '—'}</td>
      <td><button class="btn btn-danger" style="padding:4px 10px;font-size:11px" onclick="removeStudent(${i})">🗑️</button></td>
    </tr>`).join('');
}

// إعداد مستمع ملف الـ CSV
document.addEventListener('DOMContentLoaded', () => {
    const csvInput = document.getElementById('csv-file');
    if (csvInput) {
        csvInput.addEventListener('change', function (e) {
            const file = e.target.files[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = async ev => {
                const lines = ev.target.result.split('\n').filter(l => l.trim());
                let studentsToInsert = [], invitationsToInsert = [];

                for (let i = 0; i < lines.length; i++) {
                    if (i === 0) continue;
                    const parts = parseCSVLine(lines[i]);
                    if (parts.length >= 2 && parts[0] && parts[1]) {
                        const id = parts[0], name = parts[1];
                        if (!students.find(s => s.id === id) && !studentsToInsert.find(s => s.id === id)) {
                            const inv1 = genCode(id, 1), inv2 = genCode(id, 2);
                            studentsToInsert.push({ id, name });
                            invitationsToInsert.push({ code: inv1, student_id: id, inv_num: 1, used: false });
                            invitationsToInsert.push({ code: inv2, student_id: id, inv_num: 2, used: false });
                        }
                    }
                }

                if (studentsToInsert.length > 0 && supabase) {
                    try {
                        const { error: errS } = await supabase.from('students').insert(studentsToInsert);
                        if (errS) throw errS;
                        const { error: errI } = await supabase.from('invitations').insert(invitationsToInsert);
                        if (errI) throw errI;

                        await loadState();
                        alert(`تم استيراد ومزامنة ${studentsToInsert.length} طالب سحابياً بنجاح!`);
                    } catch (e) { alert('حدث خطأ أثناء الرفع الجماعي: ' + e.message); }
                } else { alert('لم يتم العثور على بيانات جديدة لرفعها.'); }
            };
            reader.readAsText(file, 'UTF-8');
        });
    }
});

function parseCSVLine(line) {
    const result = []; let current = ''; let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
        else { current += char; }
    }
    result.push(current.trim()); return result;
}

// ======= SATELLITE SYSTEM CLEANERS =======
window.resetSystem = async function () {
    if (!confirm('🚨 تحذير: هل أنت متأكد من حذف كافة بيانات الطلاب والدعوات من السحاب نهائياً؟ لا يمكن التراجع!')) return;
    if (supabase && students.length > 0) {
        try {
            const studentIds = students.map(s => s.id);
            const { error } = await supabase.from('students').delete().in('id', studentIds);
            if (error) throw error;
        } catch (e) { console.error('فشل المسح من السيرفر:', e); }
    }
    students = []; invitations = {}; scanLog = []; entryTimeline = []; localStorage.clear();
    document.getElementById('students-section').style.display = 'none';
    document.getElementById('students-tbody').innerHTML = '';
    document.getElementById('qr-preview').innerHTML = '';
    document.getElementById('gen-idle').style.display = 'block';
    document.getElementById('gen-actions').style.display = 'none';
    document.getElementById('gen-progress').style.display = 'none';
    document.getElementById('gen-pbar').style.width = '0%';
    document.getElementById('scan-log').innerHTML = '<div class="empty-state" style="padding:24px"><div class="icon">📋</div><p>لا توجد عمليات مسح بعد</p></div>';
    updateHeader();
    if (donutChart) donutChart.destroy();
    if (lineChart) lineChart.destroy();
    renderDonut(0, 1); renderLine();
    alert('تم تفريغ النظام سحابياً بالكامل.');
}

window.resetCheckins = async function () {
    if (!confirm('هل أنت متأكد من تصفير وإعادة ضبط حالة جميع الحضور سحابياً إلى "لم يدخل"؟')) return;
    if (supabase && students.length > 0) {
        try {
            const { error } = await supabase.from('invitations').update({ used: false, used_at: null }).neq('code', '');
            if (error) throw error;
        } catch (e) { alert('فشل تصفير الحضور سحابياً: ' + e.message); return; }
    }
    Object.keys(invitations).forEach(code => { invitations[code].used = false; invitations[code].usedAt = null; });
    scanLog = []; entryTimeline = [];
    localStorage.removeItem('inv_scanLog'); localStorage.removeItem('inv_entryTimeline');
    document.getElementById('scan-log').innerHTML = '<div class="empty-state" style="padding:24px"><div class="icon">📋</div><p>لا توجد عمليات مسح بعد</p></div>';
    refreshDash(); alert('تم إعادة ضبط الحضور بنجاح.');
}

// ======= QR ENGINE GENERATION =======
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function generateQRBase64(text) {
    return new Promise((resolve) => {
        const container = document.createElement('div');
        container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
        document.body.appendChild(container);
        try {
            new QRCode(container, { text: text, width: 200, height: 200, colorDark: '#1a3a8f', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
        } catch (e) { document.body.removeChild(container); resolve(''); return; }

        let attempts = 0;
        const check = () => {
            attempts++;
            const canvas = container.querySelector('canvas');
            const img = container.querySelector('img');
            if (canvas) {
                try { const dataURL = canvas.toDataURL('image/png'); document.body.removeChild(container); resolve(dataURL); return; } catch (e) { }
            }
            if (img && img.src && img.src.startsWith('data:image')) { document.body.removeChild(container); resolve(img.src); return; }
            if (attempts < 50) { setTimeout(check, 20); } else { document.body.removeChild(container); resolve(''); }
        };
        setTimeout(check, 10);
    });
}

window.generateAll = async function () {
    if (students.length === 0) { alert('أضف طلاباً أولاً'); return; }
    document.getElementById('gen-idle').style.display = 'none';
    document.getElementById('gen-progress').style.display = 'block';
    document.getElementById('qr-preview').innerHTML = '';

    const total = students.length * 2; let done = 0;

    for (const s of students) {
        for (const num of [1, 2]) {
            const code = s['inv' + num];
            const base64 = await generateQRBase64(code);
            s['qr' + num + '_base64'] = base64;

            const card = document.createElement('div'); card.className = 'qr-card';
            if (base64) {
                const img = document.createElement('img'); img.src = base64; img.alt = 'QR ' + code; card.appendChild(img);
            } else {
                const ph = document.createElement('div');
                ph.style.cssText = 'width:114px;height:114px;background:#f1f5f9;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#94a3b8;border-radius:6px;margin:0 auto 8px;text-align:center;';
                ph.textContent = 'تعذّر التوليد'; card.appendChild(ph);
            }

            const nameDiv = document.createElement('div'); nameDiv.className = 'name'; nameDiv.textContent = s.name;
            const idDiv = document.createElement('div'); idDiv.className = 'inv-id'; idDiv.textContent = code;
            const bwrap = document.createElement('div'); bwrap.style.cssText = 'font-size:10px;margin-top:4px';
            const badge = document.createElement('span');
            badge.className = 'badge badge-' + (num === 1 ? 'info' : 'success'); badge.textContent = 'دعوة ' + (num === 1 ? 'الأولى' : 'الثانية');
            bwrap.appendChild(badge); card.appendChild(nameDiv); card.appendChild(idDiv); card.appendChild(bwrap);
            document.getElementById('qr-preview').appendChild(card);

            done++; const pct = Math.round(done / total * 100);
            document.getElementById('gen-pbar').style.width = pct + '%';
            document.getElementById('gen-status-text').textContent = `جاري التوليد... ${done}/${total} (${pct}%)`;
        }
        await sleep(5);
    }
    document.getElementById('gen-status-text').textContent = `✅ تم توليد وتجهيز ${total} باركود لـ ${students.length} طالب بنجاح`;
    document.getElementById('gen-actions').style.display = 'flex';
    updateHeader();
}

function renderQRPlaceholders() {
    const previewEl = document.getElementById('qr-preview'); previewEl.innerHTML = '';
    students.forEach(s => {
        [1, 2].forEach(num => {
            const code = s['inv' + num];
            const card = document.createElement('div'); card.className = 'qr-card';
            const b64 = s['qr' + num + '_base64'];
            if (b64) {
                const img = document.createElement('img'); img.src = b64; img.alt = code; card.appendChild(img);
            } else {
                const ph = document.createElement('div');
                ph.style.cssText = 'width:114px;height:114px;background:#f1f5f9;border:1px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:10px;color:#94a3b8;border-radius:6px;margin:0 auto 8px;text-align:center;padding:8px;';
                ph.textContent = '⚡ اضغط توليد لإعادة إنشاء الباركود'; card.appendChild(ph);
            }
            const nameDiv = document.createElement('div'); nameDiv.className = 'name'; nameDiv.textContent = s.name;
            const idDiv = document.createElement('div'); idDiv.className = 'inv-id'; idDiv.textContent = code;
            const bwrap = document.createElement('div'); bwrap.style.cssText = 'font-size:10px;margin-top:4px';
            const badge = document.createElement('span');
            badge.className = 'badge badge-' + (num === 1 ? 'info' : 'success'); badge.textContent = 'دعوة ' + (num === 1 ? 'الأولى' : 'الثانية');
            bwrap.appendChild(badge); card.appendChild(nameDiv); card.appendChild(idDiv); card.appendChild(bwrap);
            previewEl.appendChild(card);
        });
    });
}

function renderLogFromState() {
    const logEl = document.getElementById('scan-log'); logEl.innerHTML = '';
    const icons = { ok: '✅', dup: '⚠️', bad: '❌' };
    scanLog.slice().reverse().forEach(l => {
        const item = document.createElement('div'); item.className = 'log-item ' + l.type;
        item.innerHTML = `<span>${icons[l.type] || '🔍'}</span>
      <span style="font-weight:600;flex:1">${l.name !== '—' ? l.name : l.code.substring(0, 16)}</span>
      <span class="badge badge-${l.type === 'ok' ? 'success' : l.type === 'dup' ? 'warning' : 'danger'}">${l.status}</span>
      <span class="log-time">${l.time}</span>`;
        logEl.appendChild(item);
    });
}

// ======= SYNCED DASHBOARD =======
window.refreshDash = async function () {
    if (supabase) { await loadState(); }
    const total = students.length, totalInv = Object.keys(invitations).length;
    const entered = Object.values(invitations).filter(i => i.used).length;
    const pending = totalInv - entered;
    const pct = totalInv > 0 ? Math.round(entered / totalInv * 100) : 0;

    const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };

    setTxt('d-students', total.toLocaleString('ar'));
    setTxt('d-invitations', totalInv.toLocaleString('ar'));
    setTxt('d-entered', entered.toLocaleString('ar'));
    setTxt('d-entered-pct', pct + '%');
    setTxt('d-pending', pending.toLocaleString('ar'));
    setTxt('d-pending-pct', (100 - pct) + '%');

    renderDonut(entered, pending); renderLine(); renderDashTable(); updateHeader();
}

function renderDonut(e, p) {
    const canvas = document.getElementById('chart-donut');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (donutChart) donutChart.destroy();
    donutChart = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: ['دخلوا', 'لم يدخلوا'], datasets: [{ data: [e || 0, p || 1], backgroundColor: ['#059669', '#dc2626'], borderWidth: 3, borderColor: '#fff' }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'bottom', labels: { font: { family: 'IBM Plex Sans Arabic', size: 12 } } } }, cutout: '62%' }
    });
}

function renderLine() {
    const canvas = document.getElementById('chart-line');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (lineChart) lineChart.destroy();
    const labels = entryTimeline.length > 0 ? entryTimeline.map((_, i) => i + 1) : [0];
    const data = entryTimeline.length > 0 ? entryTimeline.map(e => e.count) : [0];
    lineChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: [{ label: 'تراكم الدخول', data, borderColor: '#1a56db', backgroundColor: 'rgba(26,86,219,0.08)', fill: true, tension: 0.4, pointRadius: 3, pointBackgroundColor: '#1a56db' }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.04)' } }, x: { display: false } } }
    });
}

function renderDashTable() {
    const tbody = document.getElementById('dash-tbody');
    if (!tbody) return;

    tbody.innerHTML = students.map(s => {
        const i1 = invitations[s.inv1], i2 = invitations[s.inv2];
        const u1 = i1 && i1.used, u2 = i2 && i2.used;
        return `<tr>
      <td><span class="badge badge-info">${s.id}</span></td>
      <td><strong>${s.name}</strong></td>
      <td><span class="badge ${u1 ? 'badge-success' : 'badge-danger'}">${u1 ? '✅ دخل' : '⏳ لم يدخل'}</span>${u1 ? `<br><span style="font-size:10px;color:var(--text-muted)">${i1.usedAt}</span>` : ''}</td>
      <td><span class="badge ${u2 ? 'badge-success' : 'badge-danger'}">${u2 ? '✅ دخل' : '⏳ لم يدخل'}</span>${u2 ? `<br><span style="font-size:10px;color:var(--text-muted)">${i2.usedAt}</span>` : ''}</td>
      <td><span class="badge ${u1 && u2 ? 'badge-success' : !u1 && !u2 ? 'badge-danger' : 'badge-warning'}">${u1 && u2 ? 'دخل بالدعوتين' : !u1 && !u2 ? 'غائب' : 'دخل بدعوة واحدة'}</span></td>
    </tr>`;
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">لا توجد بيانات سحابية</td></tr>';
}

// ======= DATA EXPORTS =======
function dl(content, name, type) {
    const b = new Blob([content], { type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click();
}
window.exportCSV = function () {
    let c = '\uFEFF' + 'رقم الطالب,الاسم,رمز دعوة 1,رمز دعوة 2\n';
    students.forEach(s => c += `${s.id},${s.name},${s.inv1},${s.inv2}\n`);
    dl(c, 'invitations.csv', 'text/csv;charset=utf-8');
}
window.exportReport = function () {
    let c = '\uFEFF' + 'رقم الطالب,الاسم,دعوة 1,وقت الدخول 1,دعوة 2,وقت الدخول 2,الحضور\n';
    students.forEach(s => {
        const i1 = invitations[s.inv1], i2 = invitations[s.inv2];
        const u1 = i1 && i1.used, u2 = i2 && i2.used;
        c += `${s.id},${s.name},${u1 ? 'دخل' : 'لم يدخل'},${u1 ? i1.usedAt : ''},${u2 ? 'دخل' : 'لم يدخل'},${u2 ? i2.usedAt : ''},${u1 && u2 ? 'دخل بالدعوتين' : u1 || u2 ? 'دخل بدعوة واحدة' : 'غائب'}\n`;
    });
    dl(c, 'report.csv', 'text/csv;charset=utf-8');
}
window.exportAbsent = function () {
    let c = '\uFEFF' + 'رقم الطالب,الاسم,رمز دعوة 1,رمز دعوة 2\n';
    students.filter(s => !(invitations[s.inv1] && invitations[s.inv1].used) && !(invitations[s.inv2] && invitations[s.inv2].used))
        .forEach(s => c += `${s.id},${s.name},${s.inv1},${s.inv2}\n`);
    dl(c, 'absent.csv', 'text/csv;charset=utf-8');
}
window.exportScanLog = function () {
    let c = '\uFEFF' + 'الاسم,رمز الدعوة,الحالة,الوقت\n';
    scanLog.forEach(l => c += `${l.name},${l.code},${l.status},${l.time}\n`);
    dl(c, 'scan_log.csv', 'text/csv;charset=utf-8');
}

window.printInvitations = function () {
    if (!students.length) { alert('لا توجد بيانات لطباعتها'); return; }
    const w = window.open('', '_blank');
    let h = `<html dir="rtl"><head><meta charset="UTF-8"><title>الدعوات المطبوعة</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;700&display=swap');
    body{font-family:'IBM Plex Sans Arabic',Arial,sans-serif;direction:rtl;background:#fff;padding:20px;margin:0}
    .inv{border:2px solid #1a3a8f;border-radius:12px;padding:20px;margin:12px;display:inline-block;width:260px;vertical-align:top;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.08);background:#fff}
    h3{color:#1a3a8f;margin:0 0 3px;font-size:17px;font-weight:700}
    .sid{font-size:12px;color:#64748b;margin-bottom:10px}
    .qr-wrap{width:140px;height:140px;border:1px solid #e2e8f0;border-radius:8px;display:flex;align-items:center;justify-content:center;margin:10px auto;background:#f8fafc;padding:6px}
    .qr-wrap img{width:128px;height:128px}
    .code{font-family:monospace;font-size:10px;color:#94a3b8;margin-top:6px;letter-spacing:1px}
    .num{display:inline-block;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700;margin-top:6px}
    .n1{background:#eff6ff;color:#1a3a8f} .n2{background:#ecfdf5;color:#059669}
    @media print{.inv{page-break-inside:avoid;box-shadow:none}}
  </style></head><body>`;

    students.forEach(s => [1, 2].forEach(n => {
        const qrSrc = s['qr' + n + '_base64'];
        h += `<div class="inv">
      <h3>${s.name}</h3>
      <p class="sid">رقم الطالب: ${s.id}</p>
      <div class="qr-wrap">
        ${qrSrc ? `<img src="${qrSrc}" alt="QR">` : `<div style="font-size:10px;color:#aaa;text-align:center">الباركود غير متوفر<br>يرجى التوليد أولاً</div>`}
      </div>
      <div class="code">${s['inv' + n]}</div>
      <div class="num ${n === 1 ? 'n1' : 'n2'}">دعوة ${n === 1 ? 'الأولى' : 'الثانية'}</div>
    </div>`;
    }));
    h += `</body></html>`; w.document.write(h); w.document.close();
    setTimeout(() => { w.print(); }, 300);
}

// تشغيل جلب البيانات عند بدء تحميل النظام تلقائياً
loadState().then(() => {
    if (Object.keys(invitations).length === 0) { renderDonut(0, 1); renderLine(); }
});