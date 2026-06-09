/* =====================================================
   app.js – نظام الدعوات الإلكترونية (النسخة المُصلَحة)
   ===================================================== */

// ======= إعدادات Supabase =======
const SUPABASE_URL = "https://gpaqcfhswfnudpqlxcfs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_WiQrWKnOxv0RZKLVgFChXQ_1Sb2LRRq";

const supabase = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// ======= الحالة العامة =======
let students = [];
let invitations = {};  // { [code]: { studentId, name, invNum, used, usedAt } }
let scanLog = [];
let entryTimeline = [];
let donutChart = null;
let lineChart = null;
let html5Qr = null;
let cameraRunning = false;
let autoCloseTimer = null;
let lastScanned = '';
let lastScanTime = 0;
let lastScanCode = '';
let scanDebounce = null;

// ======= AUDIO =======
let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { }
    }
    return audioCtx;
}

function playBeep(type) {
    try {
        const ctx = getAudioCtx();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === 'success') {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            osc.start();
            setTimeout(() => { osc.frequency.setValueAtTime(1320, ctx.currentTime); }, 80);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
            osc.stop(ctx.currentTime + 0.25);
        } else if (type === 'duplicate') {
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(220, ctx.currentTime);
            osc.frequency.linearRampToValueAtTime(110, ctx.currentTime + 0.35);
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
            osc.start();
            osc.stop(ctx.currentTime + 0.35);
        } else {
            osc.type = 'square';
            osc.frequency.setValueAtTime(150, ctx.currentTime);
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            osc.start();
            setTimeout(() => { osc.frequency.setValueAtTime(120, ctx.currentTime); }, 100);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
            osc.stop(ctx.currentTime + 0.4);
        }
    } catch (e) { /* تجاهل أخطاء الصوت */ }
}

// ======= توليد رمز الدعوة الحتمي =======
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

// ======= تحميل البيانات من Supabase =======
async function loadState() {
    if (!supabase) {
        console.warn('Supabase غير مُهيَّأ');
        return;
    }
    try {
        const { data: dbStudents, error: errS } = await supabase
            .from('students').select('*').order('created_at', { ascending: true });
        if (errS) throw errS;

        const { data: dbInvitations, error: errI } = await supabase
            .from('invitations').select('*');
        if (errI) throw errI;

        students = (dbStudents || []).map(s => ({
            id: s.id,
            name: s.name,
            inv1: genCode(s.id, 1),
            inv2: genCode(s.id, 2)
        }));

        invitations = {};
        (dbInvitations || []).forEach(i => {
            const studentObj = (dbStudents || []).find(s => s.id === i.student_id);
            invitations[i.code] = {
                studentId: i.student_id,
                name: studentObj ? studentObj.name : '—',
                invNum: i.inv_num,
                used: i.used,
                usedAt: i.used_at ? new Date(i.used_at).toLocaleTimeString('ar-SA') : null
            };
        });

        // استعادة السجل المحلي
        try {
            const sl = localStorage.getItem('inv_scanLog');
            const se = localStorage.getItem('inv_entryTimeline');
            if (sl) scanLog = JSON.parse(sl);
            if (se) entryTimeline = JSON.parse(se);
        } catch (e) { scanLog = []; entryTimeline = []; }

        // تحديث واجهة الطلاب
        const stSec = document.getElementById('students-section');
        if (students.length > 0 && stSec) {
            stSec.style.display = 'block';
        }
        renderStudentsTable();

        // تحديث واجهة QR إذا كانت الدعوات موجودة
        if (Object.keys(invitations).length > 0) {
            el('gen-idle') && (el('gen-idle').style.display = 'none');
            el('gen-actions') && (el('gen-actions').style.display = 'flex');
            renderQRPlaceholders();
        }

        renderLogFromState();
        updateHeader();
        updateStudentsCount();

    } catch (e) {
        console.error('خطأ في جلب البيانات السحابية:', e);
    }
}

// مساعد querySelector موجز
function el(id) { return document.getElementById(id); }

// ======= تبديل الألواح =======
window.showPanel = function (name, btn) {
    const panel = el('panel-' + name);
    if (!panel) return;

    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.sidebar-menu .tab').forEach(t => t.classList.remove('active'));

    panel.classList.add('active');
    if (btn) btn.classList.add('active');

    if (name === 'dash') refreshDash();

    if (name === 'scan') {
        if (el('manual-section') &&
            el('manual-section').style.display !== 'none') {
            el('scan-input') && el('scan-input').focus();
        }
    } else {
        stopCamera();
    }
};

// ======= وضع المسح =======
function setMode(mode) {
    const camBtn = el('mode-cam');
    const manBtn = el('mode-manual');
    const camSec = el('cam-section');
    const manSec = el('manual-section');

    if (camBtn) camBtn.className = 'btn ' + (mode === 'cam' ? 'btn-primary' : 'btn-ghost');
    if (manBtn) manBtn.className = 'btn ' + (mode === 'manual' ? 'btn-primary' : 'btn-ghost');
    if (camSec) camSec.style.display = mode === 'cam' ? 'block' : 'none';
    if (manSec) manSec.style.display = mode === 'manual' ? 'block' : 'none';

    if (mode === 'manual') {
        stopCamera();
        el('scan-input') && el('scan-input').focus();
    }
}

// ======= الكاميرا =======
function startCamera() {
    if (Object.keys(invitations).length === 0) {
        alert('يجب توليد الدعوات أولاً قبل المسح');
        return;
    }
    const readerEl = el('reader');
    if (!readerEl) return;
    readerEl.innerHTML = '';

    html5Qr = new Html5Qrcode('reader');
    const config = { fps: 15, qrbox: { width: 220, height: 220 }, aspectRatio: 1.0 };

    html5Qr.start(
        { facingMode: 'environment' },
        config,
        (decodedText) => { if (cameraRunning) doScan(decodedText.trim()); },
        () => { }
    ).then(() => {
        cameraRunning = true;
        el('btn-start-cam') && (el('btn-start-cam').style.display = 'none');
        el('btn-stop-cam') && (el('btn-stop-cam').style.display = 'flex');
        const st = el('cam-status');
        if (st) { st.textContent = 'الكاميرا تعمل — وجّه الباركود داخل الإطار'; st.style.color = 'var(--success)'; }
    }).catch(err => {
        const st = el('cam-status');
        if (st) { st.textContent = 'تعذر الوصول للكاميرا: ' + err; st.style.color = 'var(--danger)'; }
    });
}

function stopCamera() {
    if (html5Qr && cameraRunning) {
        html5Qr.stop().then(() => {
            cameraRunning = false;
            el('btn-start-cam') && (el('btn-start-cam').style.display = 'flex');
            el('btn-stop-cam') && (el('btn-stop-cam').style.display = 'none');
            const st = el('cam-status');
            if (st) { st.textContent = 'الكاميرا متوقفة'; st.style.color = 'var(--text-muted)'; }
        }).catch(() => { cameraRunning = false; });
    }
}

// ======= منطق المسح الرئيسي =======
async function doScan(code) {
    const now = Date.now();
    if (code === lastScanned && now - lastScanTime < 2500) return;
    lastScanned = code;
    lastScanTime = now;
    lastScanCode = code;

    const timeStr = new Date().toLocaleTimeString('ar-SA');

    if (!supabase) {
        alert('لا يوجد اتصال بقاعدة البيانات');
        return;
    }

    try {
        const { data: invData, error } = await supabase
            .from('invitations')
            .select('*, students(name)')
            .eq('code', code)
            .single();

        if (error || !invData) {
            playBeep('invalid');
            showResultOverlay('invalid', {});
            addToLog(code, 'باركود غير صالح', '—', 'bad', timeStr);
            return;
        }

        const studentName = invData.students ? invData.students.name : '—';

        if (invData.used) {
            const usedAt = invData.used_at
                ? new Date(invData.used_at).toLocaleTimeString('ar-SA')
                : timeStr;
            playBeep('duplicate');
            showResultOverlay('duplicate', {
                studentId: invData.student_id,
                name: studentName,
                invNum: invData.inv_num,
                usedAt
            });
            addToLog(code, 'دعوة مكرّرة', studentName, 'dup', timeStr);

            // تحديث الحالة المحلية إن لم تكن محدّثة
            if (invitations[code]) invitations[code].used = true;

        } else {
            const isoNow = new Date().toISOString();
            const { error: updErr } = await supabase
                .from('invitations')
                .update({ used: true, used_at: isoNow })
                .eq('code', code);
            if (updErr) throw updErr;

            // تحديث الحالة المحلية
            if (!invitations[code]) {
                invitations[code] = { studentId: invData.student_id, name: studentName, invNum: invData.inv_num };
            }
            invitations[code].used = true;
            invitations[code].usedAt = timeStr;

            entryTimeline.push({
                time: timeStr,
                count: Object.values(invitations).filter(i => i.used).length
            });

            playBeep('success');
            showResultOverlay('success', invitations[code]);
            addToLog(code, 'دخول مؤكد ✅', studentName, 'ok', timeStr);
            updateHeader();

            try {
                localStorage.setItem('inv_scanLog', JSON.stringify(scanLog));
                localStorage.setItem('inv_entryTimeline', JSON.stringify(entryTimeline));
            } catch (e) { }
        }
    } catch (e) {
        console.error('خطأ في المسح:', e);
        alert('خطأ في الاتصال السحابي! تحقق من الإنترنت وحاول مجدداً.');
    }
}

function autoScan(val) {
    clearTimeout(scanDebounce);
    if (val.length >= 10) {
        scanDebounce = setTimeout(() => {
            const inputEl = el('scan-input');
            doScan(val.trim()).then(() => {
                if (inputEl) inputEl.value = '';
            });
        }, 350);
    }
}

function manualScan() {
    const inputEl = el('scan-input');
    if (!inputEl) return;
    const val = inputEl.value.trim();
    if (val) {
        doScan(val).then(() => { inputEl.value = ''; inputEl.focus(); });
    }
}

// ======= Overlay نتيجة المسح =======
function showResultOverlay(type, data) {
    const overlay = el('result-overlay');
    if (!overlay) return;

    const icons = { success: '✅', duplicate: '⚠️', invalid: '❌' };
    const statsTx = { success: 'تم تسجيل الدخول بنجاح!', duplicate: 'هذه الدعوة مستخدمة مسبقاً!', invalid: 'باركود غير صالح!' };
    const statsCls = { success: 'ok', duplicate: 'dup', invalid: 'bad' };
    const ovCls = { success: 'success-ov', duplicate: 'duplicate-ov', invalid: 'invalid-ov' };

    const resIcon = el('res-icon');
    const stEl = el('res-status');
    if (resIcon) resIcon.textContent = icons[type];
    if (stEl) { stEl.textContent = statsTx[type]; stEl.className = 'result-status-text ' + statsCls[type]; }

    if (type !== 'invalid') {
        el('res-name') && (el('res-name').textContent = data.name || '—');
        el('res-sid') && (el('res-sid').textContent = 'رقم الطالب: ' + (data.studentId || '—'));
        const invEl = el('res-inv');
        if (invEl) {
            invEl.textContent = 'دعوة ' + (data.invNum === 1 ? 'الأولى' : 'الثانية');
            invEl.className = 'result-inv-badge ' + (data.invNum === 1 ? 'badge-info' : 'badge-success');
        }
        el('res-time') && (el('res-time').textContent =
            type === 'duplicate'
                ? 'سبق دخوله في: ' + (data.usedAt || '—')
                : 'وقت الدخول: ' + new Date().toLocaleTimeString('ar-SA'));
    } else {
        el('res-name') && (el('res-name').textContent = 'رمز غير معرّف');
        el('res-sid') && (el('res-sid').textContent = '');
        el('res-inv') && (el('res-inv').textContent = '');
        el('res-time') && (el('res-time').textContent = '');
    }

    el('res-code') && (el('res-code').textContent = lastScanCode);

    overlay.className = 'result-overlay show ' + ovCls[type];

    const bar = el('res-autobar');
    if (bar) {
        bar.style.transition = 'none';
        bar.style.width = '100%';
        setTimeout(() => { bar.style.transition = 'width 3s linear'; bar.style.width = '0%'; }, 50);
    }

    clearTimeout(autoCloseTimer);
    autoCloseTimer = setTimeout(dismissResult, 3000);
}

function dismissResult() {
    const overlay = el('result-overlay');
    if (overlay) overlay.className = 'result-overlay';
    clearTimeout(autoCloseTimer);
}

// ======= سجل المسح =======
function addToLog(code, status, name, type, time) {
    const logEl = el('scan-log');
    if (!logEl) return;

    const es = logEl.querySelector('.empty-state');
    if (es) es.remove();

    const icons = { ok: '✅', dup: '⚠️', bad: '❌' };
    const item = document.createElement('div');
    item.className = 'log-item ' + type;
    item.innerHTML =
        `<span>${icons[type] || '🔍'}</span>
         <span style="font-weight:600;flex:1">${name !== '—' ? name : code.substring(0, 20)}</span>
         <span class="badge badge-${type === 'ok' ? 'success' : type === 'dup' ? 'warning' : 'danger'}">${status}</span>
         <span class="log-time">${time}</span>`;
    logEl.insertBefore(item, logEl.firstChild);

    // تجنّب التكرار في المصفوفة
    if (!scanLog.some(l => l.code === code && l.time === time)) {
        scanLog.unshift({ code, status, name, type, time });
    }
}

function renderLogFromState() {
    const logEl = el('scan-log');
    if (!logEl || scanLog.length === 0) return;

    logEl.innerHTML = '';
    const icons = { ok: '✅', dup: '⚠️', bad: '❌' };
    scanLog.forEach(l => {
        const item = document.createElement('div');
        item.className = 'log-item ' + l.type;
        item.innerHTML =
            `<span>${icons[l.type] || '🔍'}</span>
             <span style="font-weight:600;flex:1">${l.name !== '—' ? l.name : l.code.substring(0, 20)}</span>
             <span class="badge badge-${l.type === 'ok' ? 'success' : l.type === 'dup' ? 'warning' : 'danger'}">${l.status}</span>
             <span class="log-time">${l.time}</span>`;
        logEl.appendChild(item);
    });
}

window.clearLog = function () {
    if (!confirm('مسح سجل الدخول؟')) return;
    const logEl = el('scan-log');
    if (logEl) logEl.innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>لا توجد عمليات مسح بعد</p></div>';
    scanLog = [];
    try { localStorage.removeItem('inv_scanLog'); } catch (e) { }
};

// ======= تحديث الهيدر =======
function updateHeader() {
    const total = Object.keys(invitations).length;
    const entered = Object.values(invitations).filter(i => i.used).length;
    const pct = total > 0 ? Math.round(entered / total * 100) : 0;

    const set = (id, txt) => { const e = el(id); if (e) e.textContent = txt; };
    set('hdr-total', total.toLocaleString('ar'));
    set('hdr-entered', entered.toLocaleString('ar'));
    set('hdr-pct', pct + '%');
    set('cnt-total', total.toLocaleString('ar'));
    set('cnt-entered', entered.toLocaleString('ar'));
    set('cnt-remaining', (total - entered).toLocaleString('ar'));
}

// ======= جدول الطلاب =======
function renderStudentsTable() {
    const tbody = el('students-tbody');
    if (!tbody) return;

    tbody.innerHTML = students.map((s, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><span class="badge badge-info">${s.id}</span></td>
          <td><strong>${s.name}</strong></td>
          <td style="font-size:10px;font-family:monospace;color:var(--text-muted)">${s.inv1 || '—'}</td>
          <td style="font-size:10px;font-family:monospace;color:var(--text-muted)">${s.inv2 || '—'}</td>
          <td><button class="btn btn-danger" style="padding:4px 10px;font-size:11px" onclick="removeStudent(${i})">🗑️ حذف</button></td>
        </tr>`).join('') ||
        '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:24px">لا يوجد طلاب مسجّلون بعد</td></tr>';
}

function updateStudentsCount() {
    const cEl = el('students-count');
    if (cEl) cEl.textContent = students.length + ' طالب';
}

// ======= Placeholders QR =======
function renderQRPlaceholders() {
    const previewEl = el('qr-preview');
    if (!previewEl) return;

    previewEl.innerHTML = '';
    students.forEach(s => {
        [1, 2].forEach(num => {
            const code = s['inv' + num];
            const card = document.createElement('div');
            card.className = 'qr-card';

            const b64 = s['qr' + num + '_base64'];
            if (b64) {
                const img = document.createElement('img');
                img.src = b64; img.alt = code;
                card.appendChild(img);
            } else {
                const ph = document.createElement('div');
                ph.style.cssText = 'width:114px;height:114px;background:#f1f5f9;border:1px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:10px;color:#94a3b8;border-radius:6px;margin:0 auto 8px;text-align:center;padding:8px;';
                ph.textContent = '⚡ اضغط توليد لإنشاء الباركود';
                card.appendChild(ph);
            }

            const nameDiv = document.createElement('div'); nameDiv.className = 'name'; nameDiv.textContent = s.name;
            const idDiv = document.createElement('div'); idDiv.className = 'inv-id'; idDiv.textContent = code;
            const bwrap = document.createElement('div'); bwrap.style.cssText = 'font-size:10px;margin-top:4px;';
            const badge = document.createElement('span');
            badge.className = 'badge badge-' + (num === 1 ? 'info' : 'success');
            badge.textContent = 'دعوة ' + (num === 1 ? 'الأولى' : 'الثانية');
            bwrap.appendChild(badge);
            card.appendChild(nameDiv); card.appendChild(idDiv); card.appendChild(bwrap);
            previewEl.appendChild(card);
        });
    });
}

// ======= لوحة التحكم (Dashboard) =======
window.refreshDash = async function () {
    if (supabase) await loadState();

    const total = students.length;
    const totalInv = Object.keys(invitations).length;
    const entered = Object.values(invitations).filter(i => i.used).length;
    const pending = totalInv - entered;
    const pct = totalInv > 0 ? Math.round(entered / totalInv * 100) : 0;

    const set = (id, txt) => { const e = el(id); if (e) e.textContent = txt; };
    set('d-students', total.toLocaleString('ar'));
    set('d-invitations', totalInv.toLocaleString('ar'));
    set('d-entered', entered.toLocaleString('ar'));
    set('d-entered-pct', pct + '%');
    set('d-pending', pending.toLocaleString('ar'));
    set('d-pending-pct', (100 - pct) + '%');

    renderDonut(entered, pending);
    renderLine();
    renderDashTable();
    updateHeader();
};

function renderDonut(e, p) {
    const canvas = el('chart-donut');
    if (!canvas) return;
    if (donutChart) donutChart.destroy();
    donutChart = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['دخلوا', 'لم يدخلوا'],
            datasets: [{
                data: [e || 0, p || 1],
                backgroundColor: ['#059669', '#dc2626'],
                borderWidth: 3,
                borderColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true, position: 'bottom',
                    labels: { font: { family: 'IBM Plex Sans Arabic', size: 12 } }
                }
            },
            cutout: '62%'
        }
    });
}

function renderLine() {
    const canvas = el('chart-line');
    if (!canvas) return;
    if (lineChart) lineChart.destroy();

    const labels = entryTimeline.length > 0 ? entryTimeline.map((_, i) => i + 1) : [0];
    const data = entryTimeline.length > 0 ? entryTimeline.map(e => e.count) : [0];

    lineChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'تراكم الدخول',
                data,
                borderColor: '#1a56db',
                backgroundColor: 'rgba(26,86,219,0.08)',
                fill: true,
                tension: 0.4,
                pointRadius: 3,
                pointBackgroundColor: '#1a56db'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.04)' } },
                x: { display: false }
            }
        }
    });
}

function renderDashTable() {
    const tbody = el('dash-tbody');
    if (!tbody) return;

    tbody.innerHTML = students.map(s => {
        const i1 = invitations[s.inv1];
        const i2 = invitations[s.inv2];
        const u1 = i1 && i1.used;
        const u2 = i2 && i2.used;
        const statusBadge = u1 && u2 ? 'badge-success' : (!u1 && !u2 ? 'badge-danger' : 'badge-warning');
        const statusText = u1 && u2 ? 'دخل بالدعوتين' : (!u1 && !u2 ? 'غائب' : 'دخل بدعوة واحدة');

        return `<tr>
          <td><span class="badge badge-info">${s.id}</span></td>
          <td><strong>${s.name}</strong></td>
          <td>
            <span class="badge ${u1 ? 'badge-success' : 'badge-danger'}">${u1 ? '✅ دخل' : '⏳ لم يدخل'}</span>
            ${u1 ? `<br><span style="font-size:10px;color:var(--text-muted)">${i1.usedAt || ''}</span>` : ''}
          </td>
          <td>
            <span class="badge ${u2 ? 'badge-success' : 'badge-danger'}">${u2 ? '✅ دخل' : '⏳ لم يدخل'}</span>
            ${u2 ? `<br><span style="font-size:10px;color:var(--text-muted)">${i2.usedAt || ''}</span>` : ''}
          </td>
          <td><span class="badge ${statusBadge}">${statusText}</span></td>
        </tr>`;
    }).join('') ||
        '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">لا توجد بيانات. أضف طلاباً من تبويب الطلاب.</td></tr>';
}

// ======= إدارة الطلاب =======
window.addManual = async function () {
    const idEl = el('inp-id');
    const nameEl = el('inp-name');
    if (!idEl || !nameEl) return;

    const id = idEl.value.trim();
    const name = nameEl.value.trim();
    if (!id || !name) { alert('أدخل رقم الطالب والاسم'); return; }

    await addStudent(id, name, true);
    idEl.value = ''; nameEl.value = ''; idEl.focus();
};

async function addStudent(id, name, shouldSave = true) {
    if (students.find(s => s.id === id)) { alert('رقم الطالب موجود بالفعل: ' + id); return; }

    const inv1 = genCode(id, 1);
    const inv2 = genCode(id, 2);

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
            alert('حدث خطأ أثناء الحفظ السحابي: ' + (e.message || e));
            return;
        }
    }

    students.push({ id, name, inv1, inv2 });
    invitations[inv1] = { studentId: id, name, invNum: 1, used: false, usedAt: null };
    invitations[inv2] = { studentId: id, name, invNum: 2, used: false, usedAt: null };

    const stSec = el('students-section');
    if (stSec) stSec.style.display = 'block';
    renderStudentsTable();
    updateStudentsCount();
    updateHeader();
}

window.removeStudent = async function (i) {
    const s = students[i];
    if (!s) return;
    if (!confirm(`هل أنت متأكد من حذف "${s.name}" وجميع دعواته؟`)) return;

    if (supabase) {
        try {
            const { error } = await supabase.from('students').delete().eq('id', s.id);
            if (error) throw error;
        } catch (e) {
            alert('تعذر الحذف من الخادم: ' + (e.message || e));
            return;
        }
    }

    delete invitations[s.inv1];
    delete invitations[s.inv2];
    students.splice(i, 1);
    renderStudentsTable();
    updateStudentsCount();
    updateHeader();

    if (students.length === 0) {
        const stSec = el('students-section');
        if (stSec) stSec.style.display = 'none';
    }
};

// ======= استيراد CSV =======
function parseCSVLine(line) {
    const result = [];
    let current = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQuotes = !inQuotes; }
        else if (c === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
        else { current += c; }
    }
    result.push(current.trim());
    return result;
}

window.loadSample = async function () {
    if (!supabase) return;
    const sampleData = [
        { id: '1001', name: 'أحمد محمد الغامدي' },
        { id: '1002', name: 'سارة عبدالله الزهراني' },
        { id: '1003', name: 'خالد إبراهيم العمري' },
        { id: '1004', name: 'نورة سعد القحطاني' },
        { id: '1005', name: 'عمر علي الشهري' },
        { id: '1006', name: 'ريم فهد الدوسري' },
        { id: '1007', name: 'محمد عبدالرحمن الحربي' },
        { id: '1008', name: 'لمى يوسف المالكي' },
    ];

    const toInsertS = [], toInsertI = [];
    sampleData.forEach(x => {
        if (!students.find(s => s.id === x.id)) {
            const inv1 = genCode(x.id, 1), inv2 = genCode(x.id, 2);
            toInsertS.push({ id: x.id, name: x.name });
            toInsertI.push({ code: inv1, student_id: x.id, inv_num: 1, used: false });
            toInsertI.push({ code: inv2, student_id: x.id, inv_num: 2, used: false });
        }
    });

    if (toInsertS.length === 0) { alert('البيانات التجريبية موجودة بالفعل.'); return; }

    try {
        await supabase.from('students').insert(toInsertS);
        await supabase.from('invitations').insert(toInsertI);
        await loadState();
        alert(`تم تحميل ${toInsertS.length} طالب تجريبي بنجاح!`);
    } catch (e) { alert('خطأ في تحميل البيانات التجريبية: ' + (e.message || e)); }
};

// معالج CSV
document.addEventListener('DOMContentLoaded', () => {
    const csvInput = el('csv-file');
    if (!csvInput) return;

    csvInput.addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async ev => {
            const lines = ev.target.result.split('\n').filter(l => l.trim());
            const toInsertS = [], toInsertI = [];

            for (let i = 1; i < lines.length; i++) {
                const parts = parseCSVLine(lines[i]);
                if (parts.length >= 2 && parts[0] && parts[1]) {
                    const id = parts[0].replace(/\D/g, '') || parts[0];
                    const name = parts[1];
                    if (!students.find(s => s.id === id) && !toInsertS.find(s => s.id === id)) {
                        const inv1 = genCode(id, 1), inv2 = genCode(id, 2);
                        toInsertS.push({ id, name });
                        toInsertI.push({ code: inv1, student_id: id, inv_num: 1, used: false });
                        toInsertI.push({ code: inv2, student_id: id, inv_num: 2, used: false });
                    }
                }
            }

            if (toInsertS.length === 0) { alert('لم يتم العثور على بيانات جديدة في الملف.'); csvInput.value = ''; return; }

            if (supabase) {
                try {
                    await supabase.from('students').insert(toInsertS);
                    await supabase.from('invitations').insert(toInsertI);
                    await loadState();
                    alert(`تم استيراد ${toInsertS.length} طالب بنجاح!`);
                } catch (e) { alert('خطأ أثناء الرفع: ' + (e.message || e)); }
            }
            csvInput.value = '';
        };
        reader.readAsText(file, 'UTF-8');
    });
});

// ======= تصفير وحذف البيانات =======
window.resetSystem = async function () {
    if (!confirm('⚠️ تحذير: سيتم حذف كافة البيانات نهائياً من السحاب. لا يمكن التراجع! هل أنت متأكد؟')) return;

    if (supabase && students.length > 0) {
        try {
            const ids = students.map(s => s.id);
            await supabase.from('students').delete().in('id', ids);
        } catch (e) { console.error('فشل المسح من الخادم:', e); }
    }

    students = []; invitations = {}; scanLog = []; entryTimeline = [];
    try { localStorage.clear(); } catch (e) { }

    el('students-section') && (el('students-section').style.display = 'none');
    el('students-tbody') && (el('students-tbody').innerHTML = '');
    el('qr-preview') && (el('qr-preview').innerHTML = '');
    el('gen-idle') && (el('gen-idle').style.display = 'block');
    el('gen-actions') && (el('gen-actions').style.display = 'none');
    el('gen-progress') && (el('gen-progress').style.display = 'none');
    el('gen-pbar') && (el('gen-pbar').style.width = '0%');
    el('scan-log') && (el('scan-log').innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>لا توجد عمليات مسح بعد</p></div>');

    updateHeader();
    updateStudentsCount();
    if (donutChart) { donutChart.destroy(); donutChart = null; }
    if (lineChart) { lineChart.destroy(); lineChart = null; }
    renderDonut(0, 1); renderLine();
    renderDashTable();
    alert('تم تفريغ النظام بالكامل.');
};

window.resetCheckins = async function () {
    if (!confirm('هل أنت متأكد من تصفير حالة الحضور لجميع الدعوات؟')) return;

    if (supabase) {
        try {
            const { error } = await supabase.from('invitations').update({ used: false, used_at: null }).neq('code', '');
            if (error) throw error;
        } catch (e) { alert('فشل تصفير الحضور: ' + (e.message || e)); return; }
    }

    Object.keys(invitations).forEach(code => {
        invitations[code].used = false;
        invitations[code].usedAt = null;
    });
    scanLog = []; entryTimeline = [];
    try {
        localStorage.removeItem('inv_scanLog');
        localStorage.removeItem('inv_entryTimeline');
    } catch (e) { }

    el('scan-log') && (el('scan-log').innerHTML = '<div class="empty-state"><div class="icon">📋</div><p>لا توجد عمليات مسح بعد</p></div>');
    refreshDash();
    alert('تم تصفير الحضور بنجاح.');
};

// ======= توليد QR =======
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function generateQRBase64(text) {
    return new Promise(resolve => {
        const container = document.createElement('div');
        container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
        document.body.appendChild(container);
        try {
            new QRCode(container, {
                text, width: 200, height: 200,
                colorDark: '#1a3a8f', colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch (e) { document.body.removeChild(container); resolve(''); return; }

        let attempts = 0;
        const check = () => {
            attempts++;
            const canvas = container.querySelector('canvas');
            const img = container.querySelector('img');
            if (canvas) {
                try {
                    const dataURL = canvas.toDataURL('image/png');
                    document.body.removeChild(container);
                    resolve(dataURL); return;
                } catch (e) { }
            }
            if (img && img.src && img.src.startsWith('data:image')) {
                document.body.removeChild(container);
                resolve(img.src); return;
            }
            if (attempts < 60) setTimeout(check, 20);
            else { document.body.removeChild(container); resolve(''); }
        };
        setTimeout(check, 10);
    });
}

window.generateAll = async function () {
    if (students.length === 0) { alert('أضف طلاباً أولاً من تبويب إدارة الطلاب'); return; }

    el('gen-idle') && (el('gen-idle').style.display = 'none');
    el('gen-progress') && (el('gen-progress').style.display = 'block');
    el('qr-preview') && (el('qr-preview').innerHTML = '');

    const total = students.length * 2;
    let done = 0;

    for (const s of students) {
        for (const num of [1, 2]) {
            const code = s['inv' + num];
            const base64 = await generateQRBase64(code);
            s['qr' + num + '_base64'] = base64;

            const card = document.createElement('div');
            card.className = 'qr-card';

            if (base64) {
                const img = document.createElement('img');
                img.src = base64; img.alt = 'QR ' + code;
                card.appendChild(img);
            } else {
                const ph = document.createElement('div');
                ph.style.cssText = 'width:114px;height:114px;background:#f1f5f9;border:1px solid #e2e8f0;display:flex;align-items:center;justify-content:center;font-size:10px;color:#94a3b8;border-radius:6px;margin:0 auto 8px;text-align:center;';
                ph.textContent = 'تعذّر التوليد';
                card.appendChild(ph);
            }

            const nameDiv = document.createElement('div'); nameDiv.className = 'name'; nameDiv.textContent = s.name;
            const idDiv = document.createElement('div'); idDiv.className = 'inv-id'; idDiv.textContent = code;
            const bwrap = document.createElement('div'); bwrap.style.cssText = 'font-size:10px;margin-top:4px;';
            const badge = document.createElement('span');
            badge.className = 'badge badge-' + (num === 1 ? 'info' : 'success');
            badge.textContent = 'دعوة ' + (num === 1 ? 'الأولى' : 'الثانية');
            bwrap.appendChild(badge);
            card.appendChild(nameDiv); card.appendChild(idDiv); card.appendChild(bwrap);
            el('qr-preview') && el('qr-preview').appendChild(card);

            done++;
            const pct = Math.round(done / total * 100);
            el('gen-pbar') && (el('gen-pbar').style.width = pct + '%');
            el('gen-status-text') && (el('gen-status-text').textContent = `جاري التوليد... ${done}/${total} (${pct}%)`);
        }
        await sleep(5);
    }

    el('gen-status-text') && (el('gen-status-text').textContent = `✅ تم توليد ${total} رمز QR لـ ${students.length} طالب بنجاح`);
    el('gen-actions') && (el('gen-actions').style.display = 'flex');
    updateHeader();
};

// ======= تصدير البيانات =======
function dl(content, name, type) {
    const b = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

window.exportCSV = function () {
    let c = '\uFEFF' + 'رقم الطالب,الاسم,رمز دعوة 1,رمز دعوة 2\n';
    students.forEach(s => { c += `${s.id},${s.name},${s.inv1},${s.inv2}\n`; });
    dl(c, 'invitations.csv', 'text/csv;charset=utf-8');
};

window.exportReport = function () {
    let c = '\uFEFF' + 'رقم الطالب,الاسم,دعوة 1,وقت الدخول 1,دعوة 2,وقت الدخول 2,الحضور\n';
    students.forEach(s => {
        const i1 = invitations[s.inv1], i2 = invitations[s.inv2];
        const u1 = i1 && i1.used, u2 = i2 && i2.used;
        c += `${s.id},${s.name},${u1 ? 'دخل' : 'لم يدخل'},${u1 ? (i1.usedAt || '') : ''},${u2 ? 'دخل' : 'لم يدخل'},${u2 ? (i2.usedAt || '') : ''},${u1 && u2 ? 'دخل بالدعوتين' : (u1 || u2 ? 'دخل بدعوة واحدة' : 'غائب')}\n`;
    });
    dl(c, 'attendance_report.csv', 'text/csv;charset=utf-8');
};

window.exportAbsent = function () {
    let c = '\uFEFF' + 'رقم الطالب,الاسم,رمز دعوة 1,رمز دعوة 2\n';
    students
        .filter(s => !(invitations[s.inv1] && invitations[s.inv1].used) && !(invitations[s.inv2] && invitations[s.inv2].used))
        .forEach(s => { c += `${s.id},${s.name},${s.inv1},${s.inv2}\n`; });
    dl(c, 'absent.csv', 'text/csv;charset=utf-8');
};

window.exportScanLog = function () {
    let c = '\uFEFF' + 'الاسم,رمز الدعوة,الحالة,الوقت\n';
    scanLog.forEach(l => { c += `${l.name},${l.code},${l.status},${l.time}\n`; });
    dl(c, 'scan_log.csv', 'text/csv;charset=utf-8');
};

// ======= طباعة البطاقات =======
window.printInvitations = function () {
    if (!students.length) { alert('لا توجد بيانات لطباعتها'); return; }
    const w = window.open('', '_blank');
    if (!w) { alert('تعذّر فتح نافذة الطباعة. تأكد من السماح بالنوافذ المنبثقة.'); return; }

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
            ${qrSrc
                ? `<img src="${qrSrc}" alt="QR">`
                : `<div style="font-size:10px;color:#aaa;text-align:center">الباركود غير متوفر<br>يرجى التوليد أولاً</div>`}
          </div>
          <div class="code">${s['inv' + n]}</div>
          <div class="num ${n === 1 ? 'n1' : 'n2'}">دعوة ${n === 1 ? 'الأولى' : 'الثانية'}</div>
        </div>`;
    }));

    h += `</body></html>`;
    w.document.write(h);
    w.document.close();
    setTimeout(() => w.print(), 300);
};

// ======= تسجيل الخروج =======
window.doLogout = function () {
    stopCamera();
    sessionStorage.clear();
    window.location.href = 'index.html';
};

// ======= التهيئة عند تحميل الصفحة =======
document.addEventListener('DOMContentLoaded', () => {
    loadState().then(() => {
        if (Object.keys(invitations).length === 0) {
            renderDonut(0, 1);
            renderLine();
        }
        renderDashTable();
    });
});
