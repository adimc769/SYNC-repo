// ================================================================================

import { createClient } from '@supabase/supabase-js';
import Chart from 'chart.js/auto';
import { Html5Qrcode, Html5QrcodeScanner } from 'html5-qrcode';
import gsap from 'gsap';
import Papa from 'papaparse';
import { jsPDF } from 'jspdf';
import { initBorderGlowCards } from './border-glow-init.js';
import { bindOtpSlotGroup, clearOtpSlots, bindDatePickerPopover } from './ui-widgets.js';

document.addEventListener('DOMContentLoaded', () => {

    const THEME_KEY = 'syncorg-theme';

    function applyTheme(theme) {
        const t = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', t);
        try {
            localStorage.setItem(THEME_KEY, t);
        } catch (e) { /* ignore */ }
        const loginLbl = document.getElementById('login-theme-label');
        if (loginLbl) loginLbl.textContent = t === 'dark' ? 'Dark mode' : 'Light mode';
        document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
            btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
            if (btn.getAttribute('role') === 'switch') {
                btn.setAttribute('aria-checked', t === 'dark' ? 'true' : 'false');
            }
        });
        document.dispatchEvent(new CustomEvent('syncorg-themechange', { detail: { theme: t } }));
    }

    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
            applyTheme(cur === 'dark' ? 'light' : 'dark');
        });
    });
    (function syncInitialThemeUi() {
        const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        const loginLbl = document.getElementById('login-theme-label');
        if (loginLbl) loginLbl.textContent = t === 'dark' ? 'Dark mode' : 'Light mode';
        document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
            btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
            if (btn.getAttribute('role') === 'switch') {
                btn.setAttribute('aria-checked', t === 'dark' ? 'true' : 'false');
            }
        });
    })();

    bindOtpSlotGroup('#signup-otp-slots', 'reg-otp');
    bindOtpSlotGroup('#login-otp-slots', 'login-otp-input');
    bindDatePickerPopover('history-date-trigger', 'history-date-popover', 'history-date', 'history-date-label');

    const SUPABASE_URL = 'https://yhiqtdgoeuctpybvjbrc.supabase.co'; 
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InloaXF0ZGdvZXVjdHB5YnZqYnJjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2MjIyOTMsImV4cCI6MjA5MTE5ODI5M30.4hjObsvtcrm5GRZ9MvA31xfgTqwHoalkuWa_5R9itrg';

    /** Admin signup passphrase. Default `2026` unless `VITE_ORG_SECRET` in `.env` overrides it (must match exactly). */
    const ORG_SECRET = String(import.meta.env.VITE_ORG_SECRET || '2026').trim();

    // Supabase email OTP: Dashboard → Auth → Email Templates → Magic Link must include {{ .Token }} for 6-digit codes.
    const OTP_RESEND_COOLDOWN_MS = 45 * 1000;

    /** Pending signup row data after Supabase sends the verification email (code verified server-side). */
    let pendingSignupPayload = null;
    let lastSignupOtpSendAt = 0;

    /** When IP changes at login, we verify email via Supabase before finishing session. */
    let pendingLoginAfterOtp = null;
    let lastLoginOtpSendAt = 0;

    function ipStorageKey(username, role) {
        return `syncorg_last_ip_${role}_${username.trim().toLowerCase()}`;
    }

    async function fetchClientIp() {
        try {
            const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
            if (!r.ok) return null;
            const j = await r.json();
            return j && j.ip ? String(j.ip) : null;
        } catch {
            return null;
        }
    }

    function maskEmail(email) {
        if (!email || !email.includes('@')) return email || '';
        const [u, d] = email.split('@');
        const vis = u.length <= 2 ? u[0] + '••' : u.slice(0, 2) + '•••' + u.slice(-1);
        return `${vis}@${d}`;
    }

    // Initialize Supabase client (PKCE + URL detection so Google OAuth redirect completes)
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
            detectSessionInUrl: true,
            flowType: 'pkce',
            persistSession: true,
            autoRefreshToken: true,
        },
    });

    function localDateStr(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    /**
     * Today’s display status: uses optional `last_check_in_at` (add column in Supabase when ready).
     * Same-day check-in before 8:30 → Present, after → Late; no check-in today → No Record; prior day without today → Absent.
     */
    function deriveDisplayStatus(emp, now = new Date()) {
        if (emp.status === 'Excused') return 'Excused';
        const today = localDateStr(now);
        let last = null;
        if (emp.last_check_in_at) {
            last = new Date(emp.last_check_in_at);
            if (Number.isNaN(last.getTime())) last = null;
        }
        if (last) {
            const lastDay = localDateStr(last);
            if (lastDay === today) {
                const mins = last.getHours() * 60 + last.getMinutes();
                return mins > 8 * 60 + 30 ? 'Late' : 'Present';
            }
            return 'Absent';
        }
        if (emp.status === 'Absent') return 'Absent';
        if (emp.status === 'Present') return 'Present';
        if (emp.status === 'Late') return 'Late';
        return 'No Record';
    }

    function statusBadgeHtml(label) {
        const map = {
            Present: 'badge-status badge-status--present',
            Late: 'badge-status badge-status--late',
            Absent: 'badge-status badge-status--absent',
            Excused: 'badge-status badge-status--excused',
            'No Record': 'badge-status badge-status--norecord',
        };
        const cls = map[label] || map['No Record'];
        return `<span class="${cls}">${label}</span>`;
    }

    async function upsertAttendanceDaily(employeeId, dayStr, status) {
        try {
            const { error } = await supabase.from('attendance_daily').upsert(
                {
                    employee_id: employeeId,
                    day: dayStr,
                    status,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'employee_id,day' },
            );
            if (error && !/relation|does not exist|schema|permission/i.test(String(error.message || ''))) {
                console.warn('attendance_daily:', error.message);
            }
        } catch (e) {
            console.warn('attendance_daily upsert', e);
        }
    }

    async function patchEmployee(id, fields) {
        let attempt = { ...fields };
        let { error } = await supabase.from('employees').update(attempt).eq('id', id);
        if (error && Object.prototype.hasOwnProperty.call(attempt, 'last_check_in_at') && /last_check_in_at|column|schema/i.test(String(error.message || ''))) {
            delete attempt.last_check_in_at;
            ({ error } = await supabase.from('employees').update(attempt).eq('id', id));
        }
        if (!error) {
            const { data: row } = await supabase.from('employees').select('*').eq('id', id).maybeSingle();
            if (row) {
                const merged = { ...row, ...attempt };
                const disp = deriveDisplayStatus(merged, new Date());
                await upsertAttendanceDaily(id, localDateStr(new Date()), disp);
            }
        }
        return { error };
    }

    function buildMonthlyAttendanceShell() {
        const monthKeys = [];
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            monthKeys.push({
                key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
                label: d.toLocaleString(undefined, { month: 'short' }),
            });
        }
        return {
            monthKeys,
            emptyResult: () => ({
                labels: monthKeys.map((m) => m.label),
                series: monthKeys.map(() => ({ present: 0, late: 0, absent: 0, excused: 0 })),
            }),
        };
    }

    /** Aggregates `attendance_daily` for the monthly chart (last 6 calendar months). Returns null only if the query fails (e.g. table missing). Empty rows → real zeros. */
    async function fetchMonthlyAttendanceFromSupabase() {
        const start = new Date();
        start.setMonth(start.getMonth() - 5);
        start.setDate(1);
        const fromStr = localDateStr(start);
        const { data, error } = await supabase.from('attendance_daily').select('day,status').gte('day', fromStr);
        const { monthKeys, emptyResult } = buildMonthlyAttendanceShell();
        if (error) return null;
        if (!data || !data.length) return emptyResult();

        const bucket = {};
        monthKeys.forEach((m) => {
            bucket[m.key] = { present: 0, late: 0, absent: 0, excused: 0 };
        });
        data.forEach((row) => {
            const d = row.day ? String(row.day).slice(0, 10) : '';
            if (!d) return;
            const mk = d.slice(0, 7);
            if (!bucket[mk]) return;
            const st = row.status;
            if (st === 'Present') bucket[mk].present += 1;
            else if (st === 'Late') bucket[mk].late += 1;
            else if (st === 'Absent') bucket[mk].absent += 1;
            else if (st === 'Excused') bucket[mk].excused += 1;
        });
        return {
            labels: monthKeys.map((m) => m.label),
            series: monthKeys.map((m) => bucket[m.key]),
        };
    }

    /** After Google OAuth redirect: map Supabase user email → admins/employees row and open dashboard. */
    async function tryMapOAuthToPortal(session) {
        if (currentUser || !session?.user?.email) return;
        const rawEmail = String(session.user.email).trim();

        const { data: admin } = await supabase.from('admins').select('*').eq('email', rawEmail).maybeSingle();
        if (admin) {
            await supabase.auth.signOut().catch(() => {});
            currentUser = { ...admin, accountType: 'admin' };
            initDashboard();
            return;
        }

        const { data: emp } = await supabase.from('employees').select('*').eq('email', rawEmail).maybeSingle();
        if (emp) {
            await supabase.auth.signOut().catch(() => {});
            currentUser = { ...emp, accountType: 'student' };
            initDashboard();
            return;
        }

        const errBox = document.getElementById('login-error');
        if (errBox) {
            errBox.innerText =
                'This Google account is not linked to a portal profile. Sign in with username and password, or ask an admin to use the same email in SYNC.';
            errBox.classList.remove('hidden');
        }
        await supabase.auth.signOut().catch(() => {});
    }

    supabase.auth.onAuthStateChange((event, session) => {
        if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
            tryMapOAuthToPortal(session);
        }
    });
    supabase.auth.getSession().then(({ data: { session } }) => {
        if (session) tryMapOAuthToPortal(session);
    });

    // ==================== QR + SPOTLIGHT VIRTUAL ID HELPERS ====================
    const SPOTLIGHT_COLOR = 'rgba(0, 229, 255, 0.22)';
    const ATT_DYNAMIC_TTL_MS = 45 * 1000;
    const ATT_DYNAMIC_REFRESH_MS = 25 * 1000;
    let attendanceQrInterval = null;

    function bindCardSpotlights() {
        document.querySelectorAll('.card-spotlight').forEach((el) => {
            if (el._spotlightBound) return;
            el._spotlightBound = true;
            el.style.setProperty('--spotlight-color', SPOTLIGHT_COLOR);
            el.addEventListener('mousemove', (e) => {
                const rect = el.getBoundingClientRect();
                el.style.setProperty('--mouse-x', `${e.clientX - rect.left}px`);
                el.style.setProperty('--mouse-y', `${e.clientY - rect.top}px`);
            });
        });
    }

    function setQrOnImage(imgEl, data, size = 200) {
        if (!imgEl) return;
        const str = String(data ?? '');
        if (!str) {
            imgEl.removeAttribute('src');
            return;
        }
        const enc = encodeURIComponent(str);
        const primary = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${enc}`;
        const fallback = `https://quickchart.io/qr?text=${enc}&size=${size}&margin=2`;
        imgEl.onerror = function () {
            imgEl.onerror = null;
            imgEl.src = fallback;
        };
        imgEl.src = primary;
    }

    /** Rolling QR payload. Expiry is base36 with `e` prefix so phone OS scanners (e.g. iOS) do not treat the code as a phone number. */
    function buildRollingAttendancePayload(empId) {
        const expMs = Date.now() + ATT_DYNAMIC_TTL_MS;
        return `SYNC_ORG|${empId}|e${expMs.toString(36)}`;
    }

    function renderDynamicAttendanceQr() {
        const img = document.getElementById('dynamic-attendance-qr');
        const timerEl = document.getElementById('qr-timer-text');
        if (!img || !currentUser || currentUser.accountType !== 'student') return;
        const empId = currentUser.emp_id || 'EV-000';
        setQrOnImage(img, buildRollingAttendancePayload(empId), 140);
        let sec = Math.ceil(ATT_DYNAMIC_REFRESH_MS / 1000);
        if (timerEl) timerEl.textContent = `Refreshes in ${sec}s`;
        if (window._qrTimerCountdown) clearInterval(window._qrTimerCountdown);
        window._qrTimerCountdown = setInterval(() => {
            sec -= 1;
            if (timerEl) timerEl.textContent = sec > 0 ? `Refreshes in ${sec}s` : 'Refreshing…';
            if (sec <= 0) {
                clearInterval(window._qrTimerCountdown);
                window._qrTimerCountdown = null;
            }
        }, 1000);
    }

    function startDynamicAttendanceQr() {
        stopDynamicAttendanceQr();
        if (!currentUser || currentUser.accountType !== 'student') return;
        renderDynamicAttendanceQr();
        attendanceQrInterval = setInterval(renderDynamicAttendanceQr, ATT_DYNAMIC_REFRESH_MS);
    }

    function stopDynamicAttendanceQr() {
        if (attendanceQrInterval) {
            clearInterval(attendanceQrInterval);
            attendanceQrInterval = null;
        }
        if (window._qrTimerCountdown) {
            clearInterval(window._qrTimerCountdown);
            window._qrTimerCountdown = null;
        }
    }

    /** Admin scanner: rolling attendance QR or legacy plain emp_id. Supports legacy numeric expiry and `e`+base36 expiry. */
    function parseScannedAttendancePayload(text) {
        const raw = String(text || '').trim();
        const parts = raw.split('|');
        if (parts.length >= 3 && parts[0] === 'SYNC_ORG') {
            const empId = parts[1];
            const token = parts[2];
            let expMs;
            if (/^\d{10,}$/.test(token)) {
                expMs = parseInt(token, 10);
            } else {
                const m = /^e([0-9a-z]+)$/i.exec(token);
                if (!m) return { error: 'bad_format' };
                expMs = parseInt(m[1], 36);
            }
            if (!Number.isFinite(expMs)) return { error: 'bad_format' };
            if (Date.now() > expMs) return { error: 'expired', empId };
            return { empId };
        }
        return { empId: raw };
    }

    function escJsQuoted(s) {
        return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    function escHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // ==================== GLOBAL STATE VARIABLES ====================
    // These variables track the current state of the application
    let currentUser = null;              // Stores logged-in user data {id, name, role, accountType, etc.}
    let allEmployees = [];               // Cache of all employees for fast access
    let activityFeedLogs = [];           // Array of activity feed entries for display
    let shiftInterval = null;            // Timer reference for real-time shift updates
    let calendarDate = new Date();       // Current date being viewed in calendar
    let html5QrcodeScanner = null;       // QR scanner instance reference (desktop)
    let html5QrCodeCamera = null;      // Html5Qrcode instance (mobile / back camera)
    let qrScanProcessing = false;      // Avoid duplicate decode while modal open or marking attendance
    let pendingQrCheckinEmp = null;    // Employee row waiting for Present/Late in admin QR modal

    // ==================== UI LOGIN PAGE CONTROLS ====================
    // Manages switching between Sign In and Sign Up form views
    // Uses CSS transform to slide forms in/out
    
    const loginBox = document.getElementById('container');

    function setAuthView(signup) {
        const tabIn = document.getElementById('auth-tab-signin');
        const tabUp = document.getElementById('auth-tab-signup');
        const panelIn = document.getElementById('auth-panel-signin');
        const panelUp = document.getElementById('auth-panel-signup');
        if (tabIn) {
            tabIn.classList.toggle('active', !signup);
            tabIn.setAttribute('aria-selected', signup ? 'false' : 'true');
        }
        if (tabUp) {
            tabUp.classList.toggle('active', !!signup);
            tabUp.setAttribute('aria-selected', signup ? 'true' : 'false');
        }
        if (panelIn) panelIn.classList.toggle('hidden', !!signup);
        if (panelUp) panelUp.classList.toggle('hidden', !signup);
        if (loginBox) loginBox.classList.toggle('auth-mode-signup', !!signup);
    }

    document.getElementById('auth-tab-signin')?.addEventListener('click', () => setAuthView(false));
    document.getElementById('auth-tab-signup')?.addEventListener('click', () => setAuthView(true));

    /**
     * Returns the base URL for OAuth redirects.
     * Uses the current browser origin so OAuth always returns to the
     * exact domain/environment the user is currently on.
     */
    function getAppBaseUrl() {
        const origin = window.location.origin;
        const finalUrl = origin.endsWith('/') ? origin : origin + '/';
        console.log('[Auth] Redirect URL payload:', finalUrl);
        return finalUrl;
    }

    function getOAuthRedirectTo() {
        return getAppBaseUrl();
    }

    async function startGoogleOAuth(errorBoxId) {
        const errBox = document.getElementById(errorBoxId);
        if (errBox) errBox.classList.add('hidden');
        const redirectTo = getOAuthRedirectTo();
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo },
        });
        if (error && errBox) {
            errBox.innerText = error.message || 'Google sign-in failed.';
            errBox.classList.remove('hidden');
        }
    }

    document.getElementById('login-google-btn')?.addEventListener('click', () => startGoogleOAuth('login-error'));
    document.getElementById('signup-google-btn')?.addEventListener('click', () => startGoogleOAuth('signup-error'));

    // ==================== ROLE-BASED FORM FIELD VISIBILITY ====================
    // Show/hide organization ID or student ID based on selected role
    const signupAdminRadio = document.getElementById('signup-admin');
    document.getElementById('signup-admin').addEventListener('change', updateSignupFields);
    document.getElementById('signup-student').addEventListener('change', updateSignupFields);
    updateSignupFields();

    /**
     * Updates signup form visibility based on selected role
     * Admin sees: Organization ID field
     * Student sees: Student/Employee ID field
     * */
    function updateSignupFields() {
        const hint = document.getElementById('org-code-hint');
        if (signupAdminRadio.checked) {
            document.getElementById('group-org-id').classList.remove('hidden');
            document.getElementById('group-student-id').classList.add('hidden');
            if (hint) hint.classList.remove('hidden');
        } else {
            document.getElementById('group-org-id').classList.add('hidden');
            document.getElementById('group-student-id').classList.remove('hidden');
            if (hint) hint.classList.add('hidden');
        }
    }

    // ==================== AUTHENTICATION LOGIC ====================
    // ==================== STEPPER SIGNUP HANDLER ====================
    // Multi-step signup: Choose Role -> Enter Details -> Complete
    
    let stepperCurrentStep = 1;
    const STEPPER_TOTAL_STEPS = 3;
    
    function updateStepperUI() {
        // Show/hide step content
        for (let i = 1; i <= STEPPER_TOTAL_STEPS; i++) {
            const stepEl = document.getElementById(`stepper-step-${i}`);
            if (stepEl) stepEl.classList.toggle('hidden', i !== stepperCurrentStep);
        }
        
        // Update step indicators
        const indicators = document.querySelectorAll('.step-indicator');
        indicators.forEach(ind => {
            const stepNum = parseInt(ind.dataset.step);
            const inner = ind.querySelector('.step-indicator-inner');
            if (!inner) return;
            inner.className = 'step-indicator-inner';
            if (stepNum < stepperCurrentStep) {
                inner.classList.add('complete');
                inner.innerHTML = '<svg class="step-check-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
            } else if (stepNum === stepperCurrentStep) {
                inner.classList.add('active');
                inner.innerHTML = '<div class="step-active-dot"></div>';
            } else {
                inner.classList.add('inactive');
                inner.innerHTML = `<span class="step-number">${stepNum}</span>`;
            }
        });
        
        // Update connectors
        const conn12 = document.getElementById('conn-1-2');
        const conn23 = document.getElementById('conn-2-3');
        if (conn12) conn12.classList.toggle('complete', stepperCurrentStep > 1);
        if (conn23) conn23.classList.toggle('complete', stepperCurrentStep > 2);
        
        // Update buttons
        const backBtn = document.getElementById('stepper-back-btn');
        const nextBtn = document.getElementById('stepper-next-btn');
        const navEl = document.getElementById('stepper-nav');
        if (backBtn) backBtn.classList.toggle('hidden', stepperCurrentStep === 1);
        if (navEl) navEl.className = `stepper-footer-nav ${stepperCurrentStep > 1 ? 'spread' : 'end'}`;
        if (nextBtn) nextBtn.innerText = stepperCurrentStep === STEPPER_TOTAL_STEPS ? 'Create account' : 'Next';

        const socialRow = document.getElementById('signup-social-row');
        if (socialRow) socialRow.classList.toggle('hidden', stepperCurrentStep === STEPPER_TOTAL_STEPS);

        // Hide error on step change
        const errBox = document.getElementById('signup-error');
        if (errBox) errBox.classList.add('hidden');
    }
    
    function validateStep(step) {
        const errBox = document.getElementById('signup-error');
        if (step === 1) {
            const isAdmin = signupAdminRadio.checked;
            if (isAdmin) {
                const orgId = document.getElementById('reg-org-id').value.trim();
                if (!orgId) {
                    errBox.innerText = 'Please enter your organization code.';
                    errBox.classList.remove('hidden');
                    return false;
                }
                if (orgId !== ORG_SECRET) {
                    errBox.innerText = 'That organization code is not valid. Use the passphrase your administrator gave you (for this build it must match the configured org secret).';
                    errBox.classList.remove('hidden');
                    return false;
                }
            } else {
                const studentId = document.getElementById('reg-student-id').value.trim();
                if (!studentId) { errBox.innerText = 'Please enter your Student ID.'; errBox.classList.remove('hidden'); return false; }
            }
        }
        if (step === 2) {
            const name = document.getElementById('reg-name').value.trim();
            const user = document.getElementById('reg-username').value.trim();
            const email = document.getElementById('reg-email').value.trim();
            const pass = document.getElementById('reg-password').value.trim();
            if (!name || !user || !email || !pass) {
                errBox.innerText = 'Please fill in all fields.'; errBox.classList.remove('hidden'); return false;
            }
            const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
            if (!emailOk) {
                errBox.innerText = 'Please enter a valid email address.'; errBox.classList.remove('hidden'); return false;
            }
        }
        return true;
    }

    let signupCompleteInFlight = false;

    /** Postgres unique / PK violations → readable copy; includes fix for desynced serial on `id`. */
    function formatSignupDbError(err) {
        const msg = (err && (err.message || err.details)) ? String(err.message || err.details) : String(err || '');
        const code = err && err.code;
        if (code === '23505' || /duplicate key/i.test(msg)) {
            if (/employees_pkey/i.test(msg)) {
                return 'Could not create the employee row: the next ID collides with an existing row. This usually means the employees id sequence is out of sync (e.g. after importing data). In Supabase → SQL Editor run:\n\nselect setval(pg_get_serial_sequence(\'employees\', \'id\'), coalesce((select max(id) from employees), 1));\n\nThen try Create account again. If Supabase Auth already created the user for this email, delete that auth user first or use a different email.';
            }
            if (/admins_pkey/i.test(msg)) {
                return 'Could not create the admin row: id sequence out of sync. In Supabase → SQL Editor run:\n\nselect setval(pg_get_serial_sequence(\'admins\', \'id\'), coalesce((select max(id) from admins), 1));\n\nThen try again.';
            }
            if (/username/i.test(msg)) return 'That username is already registered.';
            if (/email/i.test(msg)) return 'That email is already registered.';
            if (/emp_id/i.test(msg)) return 'That student / employee ID is already registered.';
        }
        return msg || 'Something went wrong.';
    }

    /** Before sending OTP: avoid wasted verification if username/email/emp_id already exists. */
    async function assertSignupIdentifiersFree() {
        const user = document.getElementById('reg-username').value.trim();
        const email = document.getElementById('reg-email').value.trim();
        if (signupAdminRadio.checked) {
            const { data: du } = await supabase.from('admins').select('id').eq('username', user).maybeSingle();
            if (du) throw new Error('That admin username is already taken.');
            const { data: de } = await supabase.from('admins').select('id').eq('email', email).maybeSingle();
            if (de) throw new Error('That email is already registered for an admin.');
            return;
        }
        const empId = document.getElementById('reg-student-id').value.trim();
        const { data: du } = await supabase.from('employees').select('id').eq('username', user).maybeSingle();
        if (du) throw new Error('That username is already taken.');
        const { data: de } = await supabase.from('employees').select('id').eq('email', email).maybeSingle();
        if (de) throw new Error('That email is already registered.');
        const { data: di } = await supabase.from('employees').select('id').eq('emp_id', empId).maybeSingle();
        if (di) throw new Error('That student / employee ID is already registered.');
    }

    async function sendSignupSupabaseOtp(isResend = false) {
        const now = Date.now();
        if (isResend && now - lastSignupOtpSendAt < OTP_RESEND_COOLDOWN_MS && lastSignupOtpSendAt > 0) {
            const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - lastSignupOtpSendAt)) / 1000);
            throw new Error(`Please wait ${wait}s before requesting another code.`);
        }
        const email = document.getElementById('reg-email').value.trim();
        const name = document.getElementById('reg-name').value.trim();
        const user = document.getElementById('reg-username').value.trim();
        const pass = document.getElementById('reg-password').value;
        const role = signupAdminRadio.checked ? 'admin' : 'student';
        const orgId = document.getElementById('reg-org-id').value.trim();
        const empId = document.getElementById('reg-student-id').value.trim();

        if (role === 'admin' && orgId !== ORG_SECRET) {
            throw new Error('Invalid organization code.');
        }

        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
                shouldCreateUser: true,
                emailRedirectTo: getAppBaseUrl(),
            },
        });
        if (error) throw new Error(error.message || 'Could not send verification email.');

        lastSignupOtpSendAt = Date.now();
        const phoneRaw = document.getElementById('reg-phone')?.value?.trim() ?? '';
        pendingSignupPayload = { role, name, email, user, pass, orgId, empId, phone: phoneRaw };
    }

    function validateOtpInputFormat() {
        const errBox = document.getElementById('signup-error');
        const input = document.getElementById('reg-otp').value.trim().replace(/\s+/g, '');
        if (!input || input.length < 6) {
            errBox.innerText = 'Enter the 6-digit code from your email.';
            errBox.classList.remove('hidden');
            return false;
        }
        if (!pendingSignupPayload) {
            errBox.innerText = 'No active verification. Go back to the previous step and continue again.';
            errBox.classList.remove('hidden');
            return false;
        }
        return true;
    }

    async function completeSignup() {
        const nextBtn = document.getElementById('stepper-next-btn');
        const errBox = document.getElementById('signup-error');
        if (!validateOtpInputFormat()) return;
        if (signupCompleteInFlight) return;
        signupCompleteInFlight = true;
        nextBtn.disabled = true;

        const token = document.getElementById('reg-otp').value.trim().replace(/\s+/g, '');
        const d = pendingSignupPayload;
        const role = d.role;
        const name = d.name;
        const email = d.email;
        const user = d.user;
        const pass = d.pass;

        nextBtn.innerText = 'Processing...';

        try {
            const { error: vErr } = await supabase.auth.verifyOtp({
                email,
                token,
                type: 'email',
            });
            if (vErr) throw new Error(vErr.message || 'Invalid or expired code.');

                if (role === 'admin') {
                const orgId = String(d.orgId ?? '').trim();
                if (orgId !== ORG_SECRET) throw new Error('Invalid organization code.');
                const phoneVal = d.phone && String(d.phone).trim() !== '' ? String(d.phone).trim() : null;
                const { error } = await supabase.from('admins').insert([{ org_id: orgId, admin_name: name, email, username: user, password: pass, phone: phoneVal }]);
                if (error) throw error;
            } else {
                const empIdVal = d.empId;
                const phoneVal = d.phone && String(d.phone).trim() !== '' ? String(d.phone).trim() : null;
                const { error } = await supabase.from('employees').insert([{ emp_id: empIdVal, full_name: name, email, phone: phoneVal, department: 'Student', role: 'Student Employee', status: 'No Record', username: user, password: pass, shift_status: 'Off-Shift', shift_seconds: 0, batch: 'Batch 1', team: 'Unassigned', bio: '' }]);
                if (error) throw error;
            }

            await supabase.auth.signOut();

            alert('Account created successfully!');
            setAuthView(false);
            pendingSignupPayload = null;
            stepperCurrentStep = 1;
            updateStepperUI();
            document.getElementById('reg-name').value = '';
            document.getElementById('reg-email').value = '';
            document.getElementById('reg-username').value = '';
            document.getElementById('reg-password').value = '';
            document.getElementById('reg-org-id').value = '';
            const regPhone = document.getElementById('reg-phone');
            if (regPhone) regPhone.value = '';
            const studentIdEl = document.getElementById('reg-student-id');
            if (studentIdEl) studentIdEl.value = '';
            const otpEl = document.getElementById('reg-otp');
            if (otpEl) otpEl.value = '';
            clearOtpSlots('#signup-otp-slots');
        } catch (err) {
            errBox.innerText = formatSignupDbError(err);
            errBox.classList.remove('hidden');
        } finally {
            signupCompleteInFlight = false;
            nextBtn.disabled = false;
            nextBtn.innerText = stepperCurrentStep === STEPPER_TOTAL_STEPS ? 'Create account' : 'Next';
        }
    }
    
    // Stepper button handlers
    const stepperNextBtn = document.getElementById('stepper-next-btn');
    if (stepperNextBtn) {
        stepperNextBtn.addEventListener('click', async () => {
            if (stepperCurrentStep < STEPPER_TOTAL_STEPS) {
                if (!validateStep(stepperCurrentStep)) return;
                if (stepperCurrentStep === 2) {
                    const nextBtn = document.getElementById('stepper-next-btn');
                    const errBox = document.getElementById('signup-error');
                    errBox.classList.add('hidden');
                    nextBtn.disabled = true;
                    nextBtn.innerText = 'Sending…';
                    try {
                        await assertSignupIdentifiersFree();
                        await sendSignupSupabaseOtp(false);
                        stepperCurrentStep++;
                        const disp = document.getElementById('otp-email-display');
                        if (disp) disp.textContent = document.getElementById('reg-email').value.trim();
                        updateStepperUI();
                    } catch (err) {
                        errBox.innerText = err.message || 'Could not send verification email.';
                        errBox.classList.remove('hidden');
                    } finally {
                        nextBtn.disabled = false;
                        nextBtn.innerText = stepperCurrentStep === STEPPER_TOTAL_STEPS ? 'Create account' : 'Next';
                    }
                    return;
                }
                stepperCurrentStep++;
                updateStepperUI();
            } else {
                completeSignup();
            }
        });
    }

    const signupResendOtp = document.getElementById('signup-resend-otp');
    if (signupResendOtp) {
        signupResendOtp.addEventListener('click', async () => {
            if (stepperCurrentStep !== 3) return;
            const errBox = document.getElementById('signup-error');
            errBox.classList.add('hidden');
            signupResendOtp.disabled = true;
            try {
                await sendSignupSupabaseOtp(true);
                errBox.innerText = 'A new code has been sent.';
                errBox.classList.remove('hidden');
                errBox.classList.add('signup-success-msg');
                setTimeout(() => {
                    errBox.classList.add('hidden');
                    errBox.classList.remove('signup-success-msg');
                }, 4000);
            } catch (e) {
                errBox.innerText = e.message || 'Resend failed.';
                errBox.classList.remove('hidden');
            } finally {
                signupResendOtp.disabled = false;
            }
        });
    }
    
    const stepperBackBtn = document.getElementById('stepper-back-btn');
    if (stepperBackBtn) {
        stepperBackBtn.addEventListener('click', () => {
            if (stepperCurrentStep > 1) {
                if (stepperCurrentStep === 3) {
                    pendingSignupPayload = null;
                    supabase.auth.signOut().catch(() => {});
                    clearOtpSlots('#signup-otp-slots');
                    const h = document.getElementById('reg-otp');
                    if (h) h.value = '';
                }
                stepperCurrentStep--;
                updateStepperUI();
            }
        });
    }

    // ==================== LOGIN HANDLER ====================
    // Password check against admins/employees; if public IP changed since last login, require Supabase email OTP.

    const loginForm = document.getElementById('login-form');
    const loginOtpPanel = document.getElementById('login-otp-panel');
    const loginOtpInput = document.getElementById('login-otp-input');
    const loginOtpError = document.getElementById('login-otp-error');
    const loginOtpEmailDisplay = document.getElementById('login-otp-email-display');
    const loginOtpVerifyBtn = document.getElementById('login-otp-verify-btn');
    const loginOtpResendBtn = document.getElementById('login-otp-resend-btn');
    const loginOtpCancelBtn = document.getElementById('login-otp-cancel-btn');

    function setLoginOtpPanelVisible(visible) {
        if (!loginOtpPanel || !loginForm) return;
        loginOtpPanel.classList.toggle('hidden', !visible);
        loginForm.classList.toggle('login-form-dimmed', visible);
        const inputs = loginForm.querySelectorAll('input, button[type="submit"], .btn-google');
        inputs.forEach((el) => {
            el.disabled = visible;
        });
        if (visible) {
            loginOtpError.classList.add('hidden');
            clearOtpSlots('#login-otp-slots');
            if (loginOtpInput) loginOtpInput.value = '';
            const firstSlot = document.querySelector('#login-otp-slots .otp-slot');
            if (firstSlot) firstSlot.focus();
        }
    }

    async function finishPasswordLogin(userRow, role, clientIp) {
        const user = document.getElementById('username').value;
        const key = ipStorageKey(user, role);
        if (clientIp) localStorage.setItem(key, clientIp);
        currentUser = { ...userRow, accountType: role };
        initDashboard();
    }

    async function sendLoginSupabaseOtp() {
        const now = Date.now();
        if (now - lastLoginOtpSendAt < OTP_RESEND_COOLDOWN_MS && lastLoginOtpSendAt > 0) {
            const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - lastLoginOtpSendAt)) / 1000);
            throw new Error(`Please wait ${wait}s before requesting another code.`);
        }
        if (!pendingLoginAfterOtp || !pendingLoginAfterOtp.data.email) {
            throw new Error('Missing account email for verification.');
        }
        await supabase.auth.signOut().catch(() => {});
        const email = pendingLoginAfterOtp.data.email.trim();
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
                shouldCreateUser: true,
                emailRedirectTo: getAppBaseUrl(),
            },
        });
        if (error) throw new Error(error.message || 'Could not send verification email.');
        lastLoginOtpSendAt = Date.now();
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const identifier = document.getElementById('username').value.trim();
        const pass = document.getElementById('password').value;
        const btn = e.target.querySelector('button[type="submit"]');
        const errBox = document.getElementById('login-error');

        btn.innerText = 'Verifying...';
        errBox.classList.add('hidden');

        try {
            // 1. Try to find in admins table first (Flexible search: email, username, or admin_name)
            let res = await supabase.from('admins')
                .select('*')
                .eq('password', pass)
                .or(`email.eq."${identifier}",username.eq."${identifier}",admin_name.eq."${identifier}"`)
                .maybeSingle();
            
            let role = 'admin';

            // 2. If not found, try employees table (Flexible search: email, username, or full_name)
            if (!res.data) {
                res = await supabase.from('employees')
                    .select('*')
                    .eq('password', pass)
                    .or(`email.eq."${identifier}",username.eq."${identifier}",full_name.eq."${identifier}"`)
                    .maybeSingle();
                role = 'student';
            }

            if (!res.data) throw new Error('Account not found. Please check credentials.');

            const clientIp = await fetchClientIp();
            const key = ipStorageKey(identifier, role);
            const prevIp = localStorage.getItem(key);
            const ipChanged = Boolean(clientIp && prevIp && prevIp !== clientIp);
            const hasEmail = Boolean(res.data.email && String(res.data.email).trim());

            if (ipChanged && hasEmail) {
                pendingLoginAfterOtp = { data: res.data, role };
                if (loginOtpEmailDisplay) loginOtpEmailDisplay.textContent = maskEmail(res.data.email);
                btn.innerText = 'Sending code...';
                try {
                    await sendLoginSupabaseOtp();
                    setLoginOtpPanelVisible(true);
                } catch (otpSendErr) {
                    pendingLoginAfterOtp = null;
                    errBox.innerText = otpSendErr.message || 'Could not send security code. Try again or use Cancel.';
                    errBox.classList.remove('hidden');
                }
                return;
            }

            if (ipChanged && !hasEmail) {
                await finishPasswordLogin(res.data, role, clientIp);
                return;
            }

            await finishPasswordLogin(res.data, role, clientIp);
        } catch (err) {
            errBox.innerText = err.message;
            errBox.classList.remove('hidden');
        } finally {
            btn.innerText = 'Log In';
        }
    });

    if (loginOtpVerifyBtn) {
        loginOtpVerifyBtn.addEventListener('click', async () => {
            if (!pendingLoginAfterOtp) return;
            loginOtpError.classList.add('hidden');
            const token = (loginOtpInput && loginOtpInput.value.trim().replace(/\s+/g, '')) || '';
            if (token.length < 6) {
                loginOtpError.innerText = 'Enter the 6-digit code from your email.';
                loginOtpError.classList.remove('hidden');
                return;
            }
            const email = pendingLoginAfterOtp.data.email.trim();
            loginOtpVerifyBtn.innerText = 'Verifying...';
            loginOtpVerifyBtn.disabled = true;
            try {
                const { error: vErr } = await supabase.auth.verifyOtp({
                    email,
                    token,
                    type: 'email',
                });
                if (vErr) throw new Error(vErr.message || 'Invalid or expired code.');

                await supabase.auth.signOut().catch(() => {});

                const user = document.getElementById('username').value;
                const role = pendingLoginAfterOtp.role;
                const clientIp = await fetchClientIp();
                const key = ipStorageKey(user, role);
                if (clientIp) localStorage.setItem(key, clientIp);

                const row = pendingLoginAfterOtp.data;
                pendingLoginAfterOtp = null;
                setLoginOtpPanelVisible(false);
                currentUser = { ...row, accountType: role };
                initDashboard();
            } catch (err) {
                loginOtpError.innerText = err.message;
                loginOtpError.classList.remove('hidden');
            } finally {
                loginOtpVerifyBtn.innerText = 'Verify code';
                loginOtpVerifyBtn.disabled = false;
            }
        });
    }

    if (loginOtpResendBtn) {
        loginOtpResendBtn.addEventListener('click', async () => {
            loginOtpError.classList.add('hidden');
            loginOtpResendBtn.disabled = true;
            try {
                await sendLoginSupabaseOtp();
                loginOtpError.innerText = 'A new code has been sent.';
                loginOtpError.classList.remove('hidden');
                loginOtpError.classList.add('login-otp-success-msg');
                setTimeout(() => {
                    loginOtpError.classList.add('hidden');
                    loginOtpError.classList.remove('login-otp-success-msg');
                }, 4000);
            } catch (e) {
                loginOtpError.innerText = e.message || 'Resend failed.';
                loginOtpError.classList.remove('hidden');
            } finally {
                loginOtpResendBtn.disabled = false;
            }
        });
    }

    if (loginOtpCancelBtn) {
        loginOtpCancelBtn.addEventListener('click', () => {
            pendingLoginAfterOtp = null;
            supabase.auth.signOut().catch(() => {});
            setLoginOtpPanelVisible(false);
        });
    }

    // ==================== LOGOUT FUNCTION ====================
    // Clears user session and returns to login page
    window.logout = function() {
        currentUser = null;              // Clear user data
        clearInterval(shiftInterval);    // Stop any active timers
        stopDynamicAttendanceQr();
        supabase.auth.signOut().catch(() => {});
        document.getElementById('app-page').classList.add('hidden');
        document.getElementById('login-page').classList.remove('hidden');
    }

    // ==================== DASHBOARD INITIALIZATION ====================
    // Called after successful login
    // Sets up the main dashboard based on user role (admin vs student)
    // Configures navigation, loads initial data, and starts services
    
    function initDashboard() {
        // Hide login page and show app page
        document.getElementById('login-page').classList.add('hidden');
        document.getElementById('app-page').classList.remove('hidden');
        
        const isAdm = currentUser.accountType === 'admin';
        
        // Update user display name
        document.getElementById('nav-user-name').innerText = isAdm ? currentUser.admin_name : currentUser.full_name;
        
        // Load and display profile picture
        // Falls back to default avatar if no custom image set
        const avatarSrc = currentUser.avatar_url && currentUser.avatar_url.trim() !== '' ? currentUser.avatar_url : 'https://i.pravatar.cc/150?img=11';
        const navAvatar = document.getElementById('nav-avatar');
        if (navAvatar) navAvatar.src = avatarSrc;

        document.getElementById('admin-nav').style.display = isAdm ? 'flex' : 'none';
        document.getElementById('student-nav').style.display = isAdm ? 'none' : 'flex';
        
        // Show edit profile button only for admins
        if(isAdm) document.getElementById('admin-edit-self-btn').classList.remove('hidden');
        else document.getElementById('admin-edit-self-btn').classList.add('hidden');

        // Hide all sections first
        document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
        
        // Update greeting with time of day (animated SplitText)
        updateGreetings();

        // Load role-specific data
        if (isAdm) {
            // ADMIN: Show dashboard home and load employee data
            document.getElementById('section-home').classList.remove('hidden');
            loadAdminData();
            startGlobalShiftTimer();  // Start real-time shift tracking
        } else {
            // STUDENT: Show student home and load own data
            document.getElementById('student-home').classList.remove('hidden');
            loadStudentData();
            startDynamicAttendanceQr();
        }
        
        // Initialize MagicBento effects on dashboard cards
        setTimeout(() => initMagicBento(), 200);
        
        setTimeout(() => bindCardSpotlights(), 300);
    }

    // ==================== DYNAMIC GREETING with SplitText Animation ====================
    // Replaces static greeting with animated character-by-character reveal
    // Uses GSAP for smooth staggered animation
    
    function updateGreetings() {
        const hour = new Date().getHours();
        let tod = "Morning";
        if (hour >= 12 && hour < 17) tod = "Afternoon";
        else if (hour >= 17) tod = "Evening";

        const isAdm = currentUser.accountType === 'admin';
        const name = isAdm ? currentUser.admin_name : currentUser.full_name;
        const text = `Good ${tod}, ${name}`;
        
        const targetId = isAdm ? 'admin-greeting-text' : 'student-greeting-text';
        const el = document.getElementById(targetId);
        if (!el) return;
        
        el.innerHTML = '';
        const words = text.split(/\s+/);
        words.forEach((word) => {
            const span = document.createElement('span');
            span.className = 'greeting-word';
            span.textContent = word;
            el.appendChild(span);
        });
        
        if (typeof gsap !== 'undefined') {
            gsap.fromTo(
                el.querySelectorAll('.greeting-word'),
                { opacity: 0, y: 18, filter: 'blur(10px)' },
                {
                    opacity: 1,
                    y: 0,
                    filter: 'blur(0px)',
                    duration: 0.72,
                    ease: 'power2.out',
                    stagger: 0.09,
                    delay: 0.12,
                }
            );
        }
    }

    const navBtns = document.querySelectorAll('.nav-btn[data-target]');
    navBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Remove active class from all nav buttons
            navBtns.forEach(n => n.classList.remove('active'));
            btn.classList.add('active');
            
            document.querySelectorAll('.view-section').forEach(s => s.classList.add('hidden'));
            
            const targetId = btn.getAttribute('data-target');
            document.getElementById(targetId).classList.remove('hidden');

            if(targetId === 'section-dashboards') void renderCharts();
            if(targetId === 'section-shift') renderShifts();
            if(targetId === 'section-portfolio') renderPortfolio('All');
            if(targetId === 'section-calendar') simulateAdminHistory();
            
            if(targetId === 'student-id-view') loadStudentData();
            if(targetId === 'student-home') startDynamicAttendanceQr();
            if(targetId === 'student-calendar-view') generateStudentCalendar();
            if(targetId === 'student-directory-view') renderStudentDirectory();
        });
    });

    // ==================== PROFILE PICTURE UPLOAD ====================
    // Allows users to upload custom profile pictures
    // Converts image to Base64 and stores in Supabase
    // Updates display immediately for better UX
    
    document.getElementById('profile-upload').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = async function(evt) {
                // Convert image to Base64 data URL
                const base64Img = evt.target.result;
                
                const navAv = document.getElementById('nav-avatar');
                if (navAv) navAv.src = base64Img;
                
                // If student, also update embedded virtual ID avatar
                if(currentUser.accountType === 'student') {
                    const vidAvatar = document.getElementById('embedded-vid-avatar');
                    if (vidAvatar) vidAvatar.src = base64Img;
                }

                // Save to database
                const table = currentUser.accountType === 'admin' ? 'admins' : 'employees';
                await supabase.from(table).update({ avatar_url: base64Img }).eq('id', currentUser.id);
                
                // Update currentUser object
                currentUser.avatar_url = base64Img;
                
                showToast("Profile picture updated!");
            }
            reader.readAsDataURL(file);
        }
    });

    // ==================== UTILITY: TOAST NOTIFICATIONS ====================
    // Shows temporary notification messages to user
    // Automatically hides after 3 seconds
    // Used for success messages, warnings, etc.
    //
    // USAGE: showToast("Your message here")
    
    let toastHideTimer = null;
    function showToast(msg, durationMs = 3200) {
        const t = document.getElementById('toast');
        const msgEl = document.getElementById('toast-msg');
        if (!t || !msgEl) return;
        if (toastHideTimer) clearTimeout(toastHideTimer);
        msgEl.innerText = msg;
        t.classList.remove('hidden');
        toastHideTimer = setTimeout(() => {
            t.classList.add('hidden');
            toastHideTimer = null;
        }, durationMs);
    }

    // ==================== UTILITY: ACTIVITY FEED LOGGING ====================
    // Adds entry to admin activity feed showing who did what and when
    // Entries show at top of feed (newest first)
    // Max 50 entries visible at once
    
    function addFeedLog(name, action) {
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        activityFeedLogs.unshift(`<div class="feed-item"><span class="feed-time">${timeStr}</span><b>${name}</b> ${action}</div>`);
        const feedEl = document.getElementById('admin-activity-feed');
        if (feedEl) feedEl.innerHTML = activityFeedLogs.join('');
    }

    // ================================ ADMIN-SPECIFIC FUNCTIONS ================================
    
    // ==================== ADMIN PROFILE EDITOR ====================
    // Allows admin to edit their own profile (name, username, email)
    // Modal-based edit form
    
    document.getElementById('admin-edit-self-btn').addEventListener('click', () => {
        // Populate form with current admin data
        document.getElementById('self-edit-name').value = currentUser.admin_name || '';
        document.getElementById('self-edit-user').value = currentUser.username || '';
        document.getElementById('self-edit-email').value = currentUser.email || '';
        const sp = document.getElementById('self-edit-phone');
        if (sp) sp.value = currentUser.phone != null ? String(currentUser.phone) : '';
        // Show modal
        document.getElementById('admin-self-edit-modal').classList.remove('hidden');
    });

    document.getElementById('admin-save-self-btn').addEventListener('click', async () => {
        // Collect updated values
        const updates = {
            admin_name: document.getElementById('self-edit-name').value,
            username: document.getElementById('self-edit-user').value,
            email: document.getElementById('self-edit-email').value,
            phone: document.getElementById('self-edit-phone')?.value?.trim() || null,
        };
        
        // Update in Supabase
        const { error } = await supabase.from('admins').update(updates).eq('id', currentUser.id);
        
        if(!error) {
            // Update local user object
            currentUser = { ...currentUser, ...updates };
            // Update display
            document.getElementById('nav-user-name').innerText = currentUser.admin_name;
            updateGreetings();
            // Close modal and show success
            document.getElementById('admin-self-edit-modal').classList.add('hidden');
            showToast("Admin profile updated successfully.");
        } else {
            alert("Error updating profile: " + error.message);
        }
    });

    // ==================== LOAD ADMIN DATA ====================
    // Fetches all employees from Supabase database
    // Caches data in allEmployees array for quick access
    
    async function fetchPendingExcuseRequests() {
        try {
            const { data, error } = await supabase
                .from('excuse_requests')
                .select('*')
                .eq('status', 'pending')
                .order('created_at', { ascending: false });
            if (error) throw error;
            return data || [];
        } catch {
            return null;
        }
    }

    async function loadAdminData() {
        const { data } = await supabase.from('employees').select('*');
        allEmployees = data || [];
        renderAdminRoster();
        const pendingExcuses = await fetchPendingExcuseRequests();
        renderPendingExcuseRequests(pendingExcuses);
    }

    function renderPendingExcuseRequests(rows) {
        const wrap = document.getElementById('admin-pending-excuses-body');
        if (!wrap) return;
        if (rows === null) {
            wrap.innerHTML = '<p class="text-muted text-sm">No pending excuse requests.</p>';
            return;
        }
        if (!rows.length) {
            wrap.innerHTML = '<p class="text-muted text-sm">No pending excuse requests.</p>';
            return;
        }
        wrap.innerHTML = rows
            .map((r) => {
                const emp = allEmployees.find((e) => e.id === r.employee_id);
                const name = emp?.full_name || 'Unknown student';
                const eid = emp?.emp_id || '';
                let fileLine = '<span class="text-muted text-xs">No attachment</span>';
                if (r.attachment_data_url && r.attachment_filename) {
                    const href = String(r.attachment_data_url).replace(/"/g, '&quot;');
                    fileLine = `<a class="text-primary text-sm underline" href="${href}" target="_blank" rel="noopener noreferrer">${escHtml(r.attachment_filename)}</a>`;
                }
                return `<div class="excuse-pending-row" style="padding:12px;margin-bottom:10px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--card-bg)">
                    <div class="flex justify-between gap-2 flex-wrap align-center">
                        <div><b>${escHtml(name)}</b> <span class="text-muted text-xs">${escHtml(eid)}</span></div>
                        <span class="badge-status badge-status--late">Pending</span>
                    </div>
                    <p class="text-sm mt-2">${escHtml(r.reason || '—')}</p>
                    <div class="mt-1">${fileLine}</div>
                    <div class="flex gap-2 mt-3 flex-wrap">
                        <button type="button" class="btn-primary text-xs flex-1" data-excuse-approve="${r.id}">Approve (mark Excused)</button>
                        <button type="button" class="btn-secondary text-xs flex-1" data-excuse-deny="${r.id}">Deny</button>
                    </div>
                </div>`;
            })
            .join('');

        wrap.querySelectorAll('[data-excuse-approve]').forEach((btn) => {
            btn.addEventListener('click', () => void approveExcuseRequest(parseInt(btn.getAttribute('data-excuse-approve'), 10)));
        });
        wrap.querySelectorAll('[data-excuse-deny]').forEach((btn) => {
            btn.addEventListener('click', () => void denyExcuseRequest(parseInt(btn.getAttribute('data-excuse-deny'), 10)));
        });
    }

    async function approveExcuseRequest(requestId) {
        const { data: row, error: fErr } = await supabase.from('excuse_requests').select('employee_id').eq('id', requestId).maybeSingle();
        if (fErr || !row) {
            alert('Could not load that request.');
            return;
        }
        const { error: upErr } = await patchEmployee(row.employee_id, {
            status: 'Excused',
            shift_status: 'Off-Shift',
            last_check_in_at: null,
        });
        if (upErr) {
            alert(upErr.message || 'Update failed');
            return;
        }
        await supabase
            .from('excuse_requests')
            .update({ status: 'approved', resolved_at: new Date().toISOString() })
            .eq('id', requestId);
        showToast('Excuse approved. Student is marked Excused.');
        if (currentUser?.accountType === 'admin') addFeedLog(currentUser.admin_name || 'Admin', `approved excuse request #${requestId}`);
        await loadAdminData();
    }

    async function denyExcuseRequest(requestId) {
        const { error } = await supabase
            .from('excuse_requests')
            .update({ status: 'denied', resolved_at: new Date().toISOString() })
            .eq('id', requestId);
        if (error) {
            alert(error.message || 'Could not update request.');
            return;
        }
        showToast('Excuse request denied.');
        await loadAdminData();
    }

    // ==================== RENDER ADMIN ROSTER TABLE ====================
    // Displays all employees in table format
    // Shows: Name, ID, Department, Team, Status, Edit button
    // Also updates KPI cards (total, present, absent)
    
    function renderAdminRoster() {
        const tbody = document.getElementById('admin-roster-body');
        if(!tbody) return;
        tbody.innerHTML = '';
        const now = new Date();

        allEmployees.forEach((emp) => {
            const disp = deriveDisplayStatus(emp, now);
            tbody.innerHTML += `
                <tr>
                    <td><b>${emp.full_name}</b><br><small class="text-muted">${emp.emp_id}</small></td>
                    <td><b>${emp.department}</b><br><small class="text-muted">${emp.team || 'Unassigned'}</small></td>
                    <td>${statusBadgeHtml(disp)}</td>
                    <td><button class="btn-secondary text-xs p-2" onclick="openAdminEdit(${emp.id})">Edit</button></td>
                </tr>
            `;
        });

        const kpiTotal = document.getElementById('kpi-total');
        if (kpiTotal) kpiTotal.innerText = allEmployees.length;

        const counts = { Present: 0, Late: 0, Absent: 0, Excused: 0, 'No Record': 0 };
        allEmployees.forEach((e) => {
            const d = deriveDisplayStatus(e, now);
            if (counts[d] !== undefined) counts[d] += 1;
        });

        const kpiPresent = document.getElementById('kpi-present');
        if (kpiPresent) kpiPresent.innerText = counts.Present;
        const kpiLate = document.getElementById('kpi-late');
        if (kpiLate) kpiLate.innerText = counts.Late;
        const kpiAbsent = document.getElementById('kpi-absent');
        if (kpiAbsent) kpiAbsent.innerText = counts.Absent;
        const kpiNo = document.getElementById('kpi-norecord');
        if (kpiNo) kpiNo.innerText = counts['No Record'];
    }

    // ==================== OPEN STUDENT EDITOR MODAL ====================
    // Called when admin clicks "Edit" button on roster
    // Populates modal with student data for editing
    
    window.openAdminEdit = function(id) {
        const emp = allEmployees.find(e => e.id === id);
        if (!emp) return;
        document.getElementById('edit-modal-id').value = emp.id;
        document.getElementById('edit-modal-empid').value = emp.emp_id;
        document.getElementById('edit-modal-name').value = emp.full_name;
        document.getElementById('edit-modal-status').value = emp.status || 'No Record';
        document.getElementById('edit-modal-dept').value = emp.department || 'Student';
        document.getElementById('edit-modal-batch').value = emp.batch || 'Batch 1';
        document.getElementById('edit-modal-team').value = emp.team || '';
        const phoneEl = document.getElementById('edit-modal-phone');
        if (phoneEl) phoneEl.value = emp.phone != null ? String(emp.phone) : '';
        document.getElementById('admin-edit-modal').classList.remove('hidden');
    };

    document.getElementById('admin-save-student-btn').addEventListener('click', async () => {
        const id = document.getElementById('edit-modal-id').value;
        const updates = {
            emp_id: document.getElementById('edit-modal-empid').value,
            full_name: document.getElementById('edit-modal-name').value,
            status: document.getElementById('edit-modal-status').value,
            department: document.getElementById('edit-modal-dept').value,
            batch: document.getElementById('edit-modal-batch').value,
            team: document.getElementById('edit-modal-team').value,
        };
        const phoneIn = document.getElementById('edit-modal-phone');
        if (phoneIn) updates.phone = phoneIn.value.trim() || null;
        if (updates.status === 'No Record' || updates.status === 'Absent') {
            updates.last_check_in_at = null;
        }
        const { error } = await patchEmployee(id, updates);
        if (error) {
            alert(error.message || 'Update failed');
            return;
        }
        document.getElementById('admin-edit-modal').classList.add('hidden');
        loadAdminData();
        showToast('Student updated!');
    });

    // ==================== ADMIN QR CODE SCANNER ====================
    // Uses webcam to scan student QR codes for attendance marking
    // Requires HTTPS or localhost to access camera
    // Scanned data must match student emp_id to mark them present
    
    function isMobileQrContext() {
        return window.innerWidth < 768 || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
    }

    function closeAdminQrCheckinModal() {
        pendingQrCheckinEmp = null;
        const m = document.getElementById('admin-qr-checkin-modal');
        if (m) m.classList.add('hidden');
        qrScanProcessing = false;
    }

    function openAdminQrCheckinModal(emp) {
        pendingQrCheckinEmp = emp;
        const now = new Date();
        const mins = now.getHours() * 60 + now.getMinutes();
        const suggested = mins > 8 * 60 + 30 ? 'Late' : 'Present';
        const nameEl = document.getElementById('admin-qr-checkin-name');
        const idEl = document.getElementById('admin-qr-checkin-empid');
        const sugEl = document.getElementById('admin-qr-checkin-suggest');
        if (nameEl) nameEl.textContent = emp.full_name || 'Student';
        if (idEl) idEl.textContent = emp.emp_id || '';
        if (sugEl) {
            sugEl.textContent =
                suggested === 'Present'
                    ? 'Recommended for this time: Present (before 8:30). Tap Present or Late to record check-in.'
                    : 'Recommended for this time: Late (after 8:30). Tap Present or Late to record check-in.';
        }
        const modal = document.getElementById('admin-qr-checkin-modal');
        if (modal) modal.classList.remove('hidden');
    }

    async function confirmAdminQrCheckin(statusChoice) {
        const emp = pendingQrCheckinEmp;
        if (!emp) return;
        const now = new Date();
        const { error: upErr } = await patchEmployee(emp.id, {
            status: statusChoice,
            shift_status: 'On-Shift',
            last_check_in_at: now.toISOString(),
        });
        if (upErr) {
            alert(upErr.message || 'Update failed');
            return;
        }
        showToast(`Checked in: ${emp.full_name} (${statusChoice})`);
        addFeedLog(emp.full_name, `checked in via QR (${statusChoice})`);
        closeAdminQrCheckinModal();
        await closeScanner();
        await loadAdminData();
    }

    async function handleAdminQrDecoded(decodedText) {
        if (qrScanProcessing) return;
        if (decodedText == null || String(decodedText).trim() === '') return;
        qrScanProcessing = true;
        let openedCheckinModal = false;
        try {
            const parsed = parseScannedAttendancePayload(decodedText);
            if (parsed.error === 'expired') {
                alert('This attendance QR has expired. Ask the student to wait for a fresh code on their dashboard.');
                await closeScanner();
                return;
            }
            if (parsed.error === 'bad_format') {
                alert('Could not read this QR code.');
                await closeScanner();
                return;
            }
            const lookupId = parsed.empId;
            const emp = allEmployees.find((e) => e.emp_id === lookupId);

            if (emp) {
                openedCheckinModal = true;
                openAdminQrCheckinModal(emp);
            } else {
                alert(`Unknown QR (no employee for ID): ${lookupId}`);
                await closeScanner();
            }
        } finally {
            if (!openedCheckinModal) qrScanProcessing = false;
        }
    }

    const qrBtn = document.getElementById('admin-open-qr-btn');
    if (qrBtn) {
        qrBtn.addEventListener('click', async () => {
            const readerEl = document.getElementById('reader');
            if (readerEl) readerEl.innerHTML = '';
            document.getElementById('qr-modal').classList.remove('hidden');

            const mobile = isMobileQrContext();
            const boxW = mobile ? Math.min(300, Math.max(200, window.innerWidth - 40)) : 250;

            if (mobile) {
                html5QrCodeCamera = new Html5Qrcode('reader');
                const config = { fps: 10, qrbox: { width: boxW, height: boxW }, aspectRatio: 1.0 };
                const cameraConfigs = [
                    { facingMode: 'environment' },
                    { facingMode: 'user' },
                ];
                let started = false;
                for (let i = 0; i < cameraConfigs.length && !started; i++) {
                    try {
                        await html5QrCodeCamera.start(
                            cameraConfigs[i],
                            config,
                            (text) => {
                                void handleAdminQrDecoded(text);
                            },
                            () => {},
                        );
                        started = true;
                    } catch (e) {
                        try {
                            await html5QrCodeCamera.stop();
                        } catch (e0) { /* ignore */ }
                        if (i === cameraConfigs.length - 1) {
                            console.warn('QR camera start failed', e);
                            alert('Could not start the camera. Allow camera access, use HTTPS, or try the file picker on this device.');
                            await closeScanner();
                        }
                    }
                }
            } else {
                html5QrcodeScanner = new Html5QrcodeScanner('reader', {
                    fps: 10,
                    qrbox: { width: boxW, height: boxW },
                    aspectRatio: 1,
                }, false);
                html5QrcodeScanner.render(
                    (decodedText) => {
                        void handleAdminQrDecoded(decodedText);
                    },
                    () => {},
                );
            }
        });
    }

    // ==================== CLOSE QR SCANNER ====================
    async function closeScanner() {
        closeAdminQrCheckinModal();
        if (html5QrCodeCamera) {
            try {
                await html5QrCodeCamera.stop();
                html5QrCodeCamera.clear();
            } catch (e) {
                try {
                    html5QrCodeCamera.clear();
                } catch (e2) { /* ignore */ }
            }
            html5QrCodeCamera = null;
        }
        if (html5QrcodeScanner) {
            try {
                html5QrcodeScanner.clear();
            } catch (e) { /* ignore */ }
            html5QrcodeScanner = null;
        }
        const readerEl = document.getElementById('reader');
        if (readerEl) readerEl.innerHTML = '';
        const modal = document.getElementById('qr-modal');
        if (modal) modal.classList.add('hidden');
    }
    
    const closeQrBtn = document.getElementById('close-qr-btn');
    if (closeQrBtn) closeQrBtn.addEventListener('click', () => void closeScanner());

    document.getElementById('admin-qr-apply-present')?.addEventListener('click', () => void confirmAdminQrCheckin('Present'));
    document.getElementById('admin-qr-apply-late')?.addEventListener('click', () => void confirmAdminQrCheckin('Late'));
    document.getElementById('admin-qr-checkin-cancel')?.addEventListener('click', () => {
        closeAdminQrCheckinModal();
    });

    const EXCUSE_ATTACH_MAX_BYTES = 380 * 1024;

    function resetStudentExcuseForm() {
        const r = document.getElementById('student-excuse-reason');
        const f = document.getElementById('student-excuse-file');
        if (r) r.value = '';
        if (f) f.value = '';
    }

    document.getElementById('std-open-excuse-btn')?.addEventListener('click', () => {
        resetStudentExcuseForm();
        document.getElementById('student-excuse-modal')?.classList.remove('hidden');
    });
    document.getElementById('student-excuse-cancel')?.addEventListener('click', () => {
        document.getElementById('student-excuse-modal')?.classList.add('hidden');
        resetStudentExcuseForm();
    });
    document.getElementById('student-excuse-submit')?.addEventListener('click', async () => {
        if (!currentUser || currentUser.accountType !== 'student') return;
        const reason = document.getElementById('student-excuse-reason')?.value?.trim() || '';
        const errBox = document.getElementById('student-excuse-error');
        if (errBox) errBox.classList.add('hidden');
        if (reason.length < 3) {
            if (errBox) {
                errBox.textContent = 'Please enter a short reason (at least 3 characters).';
                errBox.classList.remove('hidden');
            }
            return;
        }
        const fileIn = document.getElementById('student-excuse-file');
        const file = fileIn?.files?.[0];
        let attachmentDataUrl = null;
        let attachmentFilename = null;
        if (file) {
            if (file.size > EXCUSE_ATTACH_MAX_BYTES) {
                if (errBox) {
                    errBox.textContent = 'File is too large. Please use a file under 380 KB (or skip the attachment).';
                    errBox.classList.remove('hidden');
                }
                return;
            }
            try {
                attachmentDataUrl = await new Promise((resolve, reject) => {
                    const fr = new FileReader();
                    fr.onload = () => resolve(fr.result);
                    fr.onerror = () => reject(new Error('read failed'));
                    fr.readAsDataURL(file);
                });
                attachmentFilename = file.name || 'attachment';
            } catch {
                if (errBox) {
                    errBox.textContent = 'Could not read the file. Try another image or PDF.';
                    errBox.classList.remove('hidden');
                }
                return;
            }
        }
        const { data: pendingRow } = await supabase
            .from('excuse_requests')
            .select('id')
            .eq('employee_id', currentUser.id)
            .eq('status', 'pending')
            .maybeSingle();
        if (pendingRow) {
            if (errBox) {
                errBox.textContent = 'You already have a pending excuse request. Wait for an admin to review it.';
                errBox.classList.remove('hidden');
            }
            return;
        }
        const { error } = await supabase.from('excuse_requests').insert([
            {
                employee_id: currentUser.id,
                reason,
                attachment_data_url: attachmentDataUrl,
                attachment_filename: attachmentFilename,
                status: 'pending',
            },
        ]);
        if (error) {
            if (errBox) {
                errBox.textContent =
                    /relation|does not exist/i.test(String(error.message))
                        ? 'Excuse requests are currently unavailable. Please try again later.'
                        : error.message || 'Could not submit.';
                errBox.classList.remove('hidden');
            }
            return;
        }
        document.getElementById('student-excuse-modal')?.classList.add('hidden');
        resetStudentExcuseForm();
        showToast('Excuse request sent. An admin will review it.');
    });

    // ==================== GLOBAL SHIFT TIMER ====================
    // Updates work duration every 1 second for employees on-shift
    // Accumulates shift_seconds in database
    // Timer runs continuously until logout
    
    function startGlobalShiftTimer() {
        // Clear any existing timer
        if(shiftInterval) clearInterval(shiftInterval);
        
        // Increment shift seconds every 1 second for on-shift employees
        shiftInterval = setInterval(() => {
            let updated = false;
            allEmployees.forEach((e) => {
                const on = e.shift_status === 'On-Shift';
                const d = deriveDisplayStatus(e);
                if (on && (d === 'Present' || d === 'Late')) {
                    e.shift_seconds = (e.shift_seconds || 0) + 1;
                    updated = true;
                }
            });
            // Update display if shift tab is visible
            if(updated && !document.getElementById('section-shift').classList.contains('hidden')) {
                renderShifts();
            }
        }, 1000);
    }

    // ==================== RENDER SHIFT TABLE ====================
    // Displays real-time work duration for present employees
    // Format: HH:MM:SS (hours:minutes:seconds)
    
    function renderShifts() {
        const tbody = document.getElementById('shift-tbody');
        if(!tbody) return;
        tbody.innerHTML = '';
        
        allEmployees.filter((e) => {
            const d = deriveDisplayStatus(e);
            return (d === 'Present' || d === 'Late') && e.shift_status === 'On-Shift';
        }).forEach((emp) => {
            // Convert seconds to HH:MM:SS format
            const h = Math.floor(emp.shift_seconds / 3600).toString().padStart(2, '0');
            const m = Math.floor((emp.shift_seconds % 3600) / 60).toString().padStart(2, '0');
            const s = (emp.shift_seconds % 60).toString().padStart(2, '0');
            
            tbody.innerHTML += `<tr><td><b>${emp.full_name}</b></td><td><span class="badge-role">${emp.shift_status}</span></td><td class="font-mono">${h}:${m}:${s}</td></tr>`;
        });
    }

    // ==================== ADMIN ATTENDANCE HISTORY ====================
    // Shows attendance records filtered by selected date
    // Data is simulated - in production would fetch from database history table
    
    function simulateAdminHistory() {
        const dateInputEl = document.getElementById('history-date');
        if(!dateInputEl) return;
        const dateInput = dateInputEl.value;
        const tbody = document.getElementById('history-tbody');
        
        tbody.innerHTML = '';
        
        // If no date selected, show prompt
        if(!dateInput) { 
            tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">Select a date to view history.</td></tr>'; 
            return; 
        }
        
        // If no employees loaded, show message
        if(allEmployees.length === 0) { 
            tbody.innerHTML = '<tr><td colspan="3" class="text-center text-muted">No records found.</td></tr>'; 
            return; 
        }

        const todayStr = localDateStr(new Date());
        allEmployees.forEach((emp) => {
            let status;
            if (dateInput === todayStr) {
                status = deriveDisplayStatus(emp, new Date());
            } else {
                const r = Math.random();
                if (r > 0.88) status = 'Excused';
                else if (r > 0.55) status = 'Present';
                else if (r > 0.35) status = 'Late';
                else if (r > 0.15) status = 'Absent';
                else status = 'No Record';
            }
            tbody.innerHTML += `<tr><td><b>${emp.full_name}</b></td><td>${dateInput}</td><td>${statusBadgeHtml(status)}</td></tr>`;
        });
    }
    
    // Update history when date changes
    const histDate = document.getElementById('history-date');
    if(histDate) histDate.addEventListener('change', simulateAdminHistory);
    
    // ==================== PORTFOLIO FILTER FUNCTION ====================
    // Filters employee portfolio by department
    // Called when department filter button is clicked
    
    window.filterPortfolio = function(dept) {
        // Update active button styling
        document.querySelectorAll('#section-portfolio .btn-outline').forEach(b => {
            b.classList.remove('active');
            if(b.innerText === dept) b.classList.add('active');
        });
        renderPortfolio(dept);
    }

    // ==================== RENDER EMPLOYEE PORTFOLIO ====================
    // Displays all employees as clickable cards in grid layout
    // Can filter by department: 'All', 'SOFTDEV', '3D DESIGN TEAM'
    // Clicking card shows employee's virtual ID
    
    function renderPortfolio(deptFilter = 'All') {
        const grid = document.getElementById('portfolio-grid');
        if(!grid) return;
        grid.innerHTML = '';
        
        // Filter employees by department if specified
        let filtered = deptFilter !== 'All' ? allEmployees.filter(e => e.department === deptFilter) : allEmployees;

        if(filtered.length === 0) { 
            grid.innerHTML = `<p class="text-muted col-span-full">No employees found.</p>`; 
            return; 
        }
        
        // Render card for each employee
        filtered.forEach(emp => {
            const safeAvatar = emp.avatar_url && emp.avatar_url.trim() !== '' ? emp.avatar_url : 'https://i.pravatar.cc/150?img=11';
            // Escape single quotes in bio to prevent string injection
            const safeBio = emp.bio ? emp.bio.replace(/'/g, "\\'") : '';
            const safePhone = emp.phone != null ? escJsQuoted(emp.phone) : '';
            const safeEmpId = escJsQuoted(emp.emp_id);
            const safeName = escJsQuoted(emp.full_name);
            const safeRole = escJsQuoted(emp.role);
            const safeDept = escJsQuoted(emp.department);
            const safeTeam = escJsQuoted(emp.team || 'Unassigned');
            const safeAvatarJs = escJsQuoted(safeAvatar);
            
            grid.innerHTML += `
                <div class="emp-card" onclick="showVID('${safeEmpId}', '${safeName}', '${safeRole}', '${safeDept}', '${safeAvatarJs}', '${safeTeam}', '${safeBio}', '${safePhone}')">
                    <img src="${safeAvatar}" style="width:60px; height:60px; border-radius:50%; object-fit:cover; margin-bottom:10px;">
                    <h4>${emp.full_name}</h4>
                    <p class="text-xs text-muted">${emp.department}</p>
                    <p class="text-xs font-bold mt-2 text-muted">${emp.team || 'Unassigned'}</p>
                </div>
            `;
        });
    }

    // ==================== RENDER ANALYTICS CHARTS ====================
    // Creates Chart.js instances for attendance and department distribution
    // Called when admin clicks Reports/Dashboard tab
    // Shows: Attendance pie chart, Department bar chart
    
    function getChartThemeColors() {
        const cs = getComputedStyle(document.documentElement);
        return {
            axis: (cs.getPropertyValue('--chart-axis').trim() || '#a1a1aa'),
            grid: (cs.getPropertyValue('--chart-grid').trim() || 'rgba(63,63,70,0.55)'),
        };
    }

    const DEMO_MONTHLY_ATTENDANCE_ROWS = [
        { present: 180, late: 15, absent: 5, excused: 10 },
        { present: 195, late: 10, absent: 8, excused: 2 },
        { present: 170, late: 25, absent: 12, excused: 7 },
        { present: 210, late: 5, absent: 3, excused: 4 },
        { present: 185, late: 20, absent: 10, excused: 5 },
        { present: 160, late: 30, absent: 15, excused: 12 },
    ];

    function monthlySeriesHasAnyCount(series) {
        if (!series || !series.length) return false;
        return series.some((r) => (r.present || 0) + (r.late || 0) + (r.absent || 0) + (r.excused || 0) > 0);
    }

    async function renderCharts() {
        const { axis: chartAxisColor, grid: chartGridColor } = getChartThemeColors();
        const now = new Date();
        const c = { Present: 0, Late: 0, Absent: 0, Excused: 0, 'No Record': 0 };
        allEmployees.forEach((e) => {
            const d = deriveDisplayStatus(e, now);
            if (c[d] !== undefined) c[d] += 1;
        });
        const presentCount = c.Present;
        const lateCount = c.Late;
        const absentCount = c.Absent;
        const excusedCount = c.Excused;
        const noRec = c['No Record'];

        const attCtx = document.getElementById('attendanceChart');
        if (attCtx) {
            if (window.attChart) window.attChart.destroy();

            window.attChart = new Chart(attCtx.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: ['Team attendance'],
                    datasets: [
                        { label: 'Present', data: [presentCount], backgroundColor: '#22c55e', stack: 'a' },
                        { label: 'Late', data: [lateCount], backgroundColor: '#eab308', stack: 'a' },
                        { label: 'Absent', data: [absentCount], backgroundColor: '#ef4444', stack: 'a' },
                        { label: 'Excused', data: [excusedCount], backgroundColor: '#3b82f6', stack: 'a' },
                        { label: 'No Record', data: [noRec], backgroundColor: '#71717a', stack: 'a' },
                    ],
                },
                options: {
                    indexAxis: 'y',
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { labels: { color: chartAxisColor } },
                        title: { display: false },
                    },
                    scales: {
                        x: {
                            stacked: true,
                            ticks: { color: chartAxisColor, precision: 0 },
                            grid: { color: chartGridColor },
                        },
                        y: {
                            stacked: true,
                            ticks: { color: chartAxisColor },
                            grid: { display: false },
                        },
                    },
                },
            });
        }

        const deptCtx = document.getElementById('deptChart');
        if (deptCtx) {
            if (window.deptChart) window.deptChart.destroy();

            const inDept = (emp, key) => {
                if (key === 'soft') return emp.department === 'SOFTDEV';
                if (key === '3d') return emp.department === '3D DESIGN TEAM';
                return emp.department !== 'SOFTDEV' && emp.department !== '3D DESIGN TEAM';
            };
            const labels = ['SOFTDEV', '3D DESIGN', 'Unassigned'];
            const keys = ['soft', '3d', 'other'];
            const presentPer = keys.map((k) => allEmployees.filter((e) => inDept(e, k) && deriveDisplayStatus(e, now) === 'Present').length);
            const latePer = keys.map((k) => allEmployees.filter((e) => inDept(e, k) && deriveDisplayStatus(e, now) === 'Late').length);
            const absentPer = keys.map((k) => allEmployees.filter((e) => inDept(e, k) && deriveDisplayStatus(e, now) === 'Absent').length);
            const excusedPer = keys.map((k) => allEmployees.filter((e) => inDept(e, k) && deriveDisplayStatus(e, now) === 'Excused').length);

            window.deptChart = new Chart(deptCtx.getContext('2d'), {
                type: 'bar',
                data: {
                    labels,
                    datasets: [
                        { label: 'Present', data: presentPer, backgroundColor: '#22c55e', stack: 'd' },
                        { label: 'Late', data: latePer, backgroundColor: '#eab308', stack: 'd' },
                        { label: 'Absent', data: absentPer, backgroundColor: '#ef4444', stack: 'd' },
                        { label: 'Excused', data: excusedPer, backgroundColor: '#3b82f6', stack: 'd' },
                    ],
                },
                options: {
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { labels: { color: chartAxisColor } },
                    },
                    scales: {
                        x: {
                            stacked: true,
                            ticks: { color: chartAxisColor },
                            grid: { color: chartGridColor },
                        },
                        y: {
                            stacked: true,
                            ticks: { color: chartAxisColor, precision: 0 },
                            grid: { color: chartGridColor },
                        },
                    },
                },
            });
        }

        const monthlyCtx = document.getElementById('monthlyAttendanceChart');
        const monthlyBlurb = document.getElementById('monthly-chart-blurb');
        if (monthlyCtx) {
            if (window.monthlyAttChart) window.monthlyAttChart.destroy();
            let monthLabels;
            let rows;
            let blurbText =
                'Present, late, absent, and excused by month. Sample data is shown when the database query fails or there are no monthly counts yet.';
            try {
                const remote = await fetchMonthlyAttendanceFromSupabase();
                if (remote && monthlySeriesHasAnyCount(remote.series)) {
                    monthLabels = remote.labels;
                    rows = remote.series;
                    blurbText =
                        'Present, late, absent, and excused by month from your organization’s saved attendance (last six months).';
                } else if (remote) {
                    monthLabels = remote.labels;
                    rows = DEMO_MONTHLY_ATTENDANCE_ROWS;
                    blurbText =
                        'Attendance is connected, but there are no daily totals in range yet—showing sample bars so the chart is visible. Data will fill in as check-ins are recorded.';
                } else {
                    monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
                    rows = DEMO_MONTHLY_ATTENDANCE_ROWS;
                }
            } catch (e) {
                console.warn('Monthly attendance chart:', e);
                monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
                rows = DEMO_MONTHLY_ATTENDANCE_ROWS;
            }
            if (monthlyBlurb) monthlyBlurb.textContent = blurbText;
            window.monthlyAttChart = new Chart(monthlyCtx.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: monthLabels,
                    datasets: [
                        { label: 'Present', data: rows.map((m) => m.present), backgroundColor: '#22c55e', borderRadius: 4 },
                        { label: 'Late', data: rows.map((m) => m.late), backgroundColor: '#eab308', borderRadius: 4 },
                        { label: 'Absent', data: rows.map((m) => m.absent), backgroundColor: '#ef4444', borderRadius: 4 },
                        { label: 'Excused', data: rows.map((m) => m.excused), backgroundColor: '#3b82f6', borderRadius: 4 },
                    ],
                },
                options: {
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { labels: { color: chartAxisColor, usePointStyle: true, padding: 16 } },
                        tooltip: { mode: 'index', intersect: false },
                    },
                    scales: {
                        x: {
                            ticks: { color: chartAxisColor },
                            grid: { display: false },
                        },
                        y: {
                            beginAtZero: true,
                            ticks: { color: chartAxisColor, precision: 0 },
                            grid: { color: chartGridColor },
                        },
                    },
                },
            });
        }

        await new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
        [window.attChart, window.deptChart, window.monthlyAttChart].forEach((ch) => {
            if (ch && typeof ch.resize === 'function') ch.resize();
        });
    }

    document.addEventListener('syncorg-themechange', () => {
        const sec = document.getElementById('section-dashboards');
        if (sec && !sec.classList.contains('hidden')) void renderCharts();
    });

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    const expBtn = document.getElementById('export-csv-btn');
    if (expBtn) {
        expBtn.addEventListener('click', async () => {
            showToast('Generating CSV…', 5000);
            await sleep(320);
            const now = new Date();
            const rows = allEmployees.map((emp) => ({
                'Employee ID': emp.emp_id,
                'Full Name': emp.full_name,
                Department: emp.department,
                Batch: emp.batch || 'Batch 1',
                Team: emp.team || 'Unassigned',
                Status: deriveDisplayStatus(emp, now),
            }));
            const csv = Papa.unparse(rows);
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'attendance_report.csv';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            showToast('CSV ready — download started.');
        });
    }

    const expPdfBtn = document.getElementById('export-pdf-btn');
    if (expPdfBtn) {
        expPdfBtn.addEventListener('click', async () => {
            showToast('Generating PDF…', 8000);
            await sleep(400);
            const doc = new jsPDF({ unit: 'pt', format: 'a4' });
            const margin = 48;
            let y = margin;
            doc.setFontSize(14);
            doc.text('SYNC — Attendance export', margin, y);
            y += 28;
            doc.setFontSize(9);
            doc.setTextColor(120, 120, 120);
            doc.text(`Generated ${new Date().toLocaleString()}`, margin, y);
            y += 22;
            doc.setTextColor(0, 0, 0);
            allEmployees.forEach((emp) => {
                const line = `${emp.emp_id}  |  ${emp.full_name}  |  ${emp.department}  |  ${emp.status || 'Absent'}`;
                if (y > 760) {
                    doc.addPage();
                    y = margin;
                }
                doc.text(line, margin, y);
                y += 14;
            });
            doc.save('attendance_report.pdf');
            showToast('PDF ready — download started.');
        });
    }


    // ================================ STUDENT-SPECIFIC FUNCTIONS ================================
    
    // ==================== LOAD STUDENT DATA ====================
    // Fetches and displays student's own data in dashboard
    // Updates: Profile fields, virtual ID card, current status, schedule
    // Called on dashboard load and when data needs refreshing
    
    async function loadStudentData() {
        // Fetch fresh student data from Supabase (syncs admin changes immediately)
        const { data, error } = await supabase.from('employees').select('*').eq('id', currentUser.id).single();
        if (data && !error) currentUser = { ...currentUser, ...data }; 

        // === SAFE DOM UPDATES (Prevents "Cannot set properties of null" errors) ===
        // Each element is checked for existence before updating
        
        // 1. Dashboard Tab - Profile Settings
        const elUser = document.getElementById('std-edit-username');
        if(elUser) elUser.value = currentUser.username || '';
        
        const elBio = document.getElementById('std-edit-bio');
        if(elBio) elBio.value = currentUser.bio || '';

        const elPhone = document.getElementById('std-edit-phone');
        if (elPhone) elPhone.value = currentUser.phone != null ? String(currentUser.phone) : '';
        
        const elShift = document.getElementById('std-shift-select');
        if(elShift) elShift.value = currentUser.shift_status || 'Off-Shift';
        
        // Update attendance status with color coding
        const stat = document.getElementById('std-current-status');
        if (stat) {
            const d = deriveDisplayStatus(currentUser);
            stat.className = 'std-status-badge-wrap';
            stat.innerHTML = statusBadgeHtml(d);
        }

        // 2. Virtual ID Tab - ID Card Display
        const vidName = document.getElementById('embedded-vid-name');
        if(vidName) vidName.innerText = currentUser.full_name || 'Name';
        
        const vidRole = document.getElementById('embedded-vid-role');
        if(vidRole) vidRole.innerText = currentUser.role || 'Student Employee';
        
        const vidDept = document.getElementById('embedded-vid-dept');
        if(vidDept) vidDept.innerText = currentUser.department || 'Student';
        
        const vidEmpId = document.getElementById('embedded-vid-empid');
        if(vidEmpId) vidEmpId.innerText = currentUser.emp_id || 'EV-000';

        const vidPhone = document.getElementById('embedded-vid-phone');
        if(vidPhone) {
            const p = currentUser.phone;
            vidPhone.innerText = (p != null && String(p).trim() !== '') ? String(p).trim() : 'Not on file';
        }
        
        const vidTeam = document.getElementById('embedded-vid-team');
        if(vidTeam) vidTeam.innerText = currentUser.team || 'Unassigned';
        
        const avatarUrl = currentUser.avatar_url && currentUser.avatar_url.trim() !== '' ? currentUser.avatar_url : 'https://i.pravatar.cc/150?img=11';
        const vidAvatar = document.getElementById('embedded-vid-avatar');
        if(vidAvatar) vidAvatar.src = avatarUrl;
        
        const safeEmpId = currentUser.emp_id || 'EV-000';
        const vidQr = document.getElementById('embedded-vid-qr');
        setQrOnImage(vidQr, safeEmpId, 200);

        bindCardSpotlights();

        // Generate weekly schedule based on batch
        generateStudentSchedule(currentUser.batch || 'Batch 1');
    }

    // ==================== SAVE STUDENT PROFILE ====================
    // Saves username and bio changes to database
    // Also triggers virtual ID refresh
    
    const saveProfBtn = document.getElementById('std-save-profile-btn');
    if(saveProfBtn) {
        saveProfBtn.addEventListener('click', async () => {
            const nu = document.getElementById('std-edit-username').value;
            const nb = document.getElementById('std-edit-bio').value;
            const np = document.getElementById('std-edit-phone')?.value?.trim() ?? '';
            
            // Update in Supabase
            await supabase.from('employees').update({ username: nu, bio: nb, phone: np || null }).eq('id', currentUser.id);
            
            // Update local user object
            currentUser.username = nu; 
            currentUser.bio = nb;
            currentUser.phone = np || null;
            
            showToast("Profile & Bio saved.");
            // Refresh virtual ID card immediately
            loadStudentData();
        });
    }

    // ==================== MARK ATTENDANCE BUTTON ====================
    // Allows student to manually mark themselves as present
    // Sets status to "Present" and shift to "On-Shift"
    // Adds entry to admin activity feed
    
    const markBtn = document.getElementById('std-mark-btn');
    if(markBtn) {
        markBtn.addEventListener('click', async () => {
            try {
                // Update status in database
                const now = new Date();
                const mins = now.getHours() * 60 + now.getMinutes();
                const st = mins > 8 * 60 + 30 ? 'Late' : 'Present';
                const { error } = await patchEmployee(currentUser.id, {
                    status: st,
                    shift_status: 'On-Shift',
                    last_check_in_at: now.toISOString(),
                });

                if (error) throw error;

                currentUser.status = st;
                currentUser.shift_status = 'On-Shift';
                currentUser.last_check_in_at = now.toISOString();
                
                // Refresh UI
                await loadStudentData();
                addFeedLog(currentUser.full_name, "marked attendance manually");
                showToast("Attendance Recorded.");
            } catch (err) {
                console.error(err);
                alert("Database Error: " + err.message);
            }
        });
    }

    // ==================== SHOW QR CODE BUTTON ====================
    // Displays student's virtual ID card with QR code in modal
    
    const showQrBtn = document.getElementById('std-show-qr-btn');
    if(showQrBtn) {
        showQrBtn.addEventListener('click', () => {
            showVID(currentUser.emp_id, currentUser.full_name, currentUser.role, currentUser.department, currentUser.avatar_url, currentUser.team, currentUser.bio, currentUser.phone);
        });
    }

    // ==================== SUBMIT ACTIVITY LOG ====================
    // Logs student's shift status and optional comments
    // Used to track when students go on/off shift or take breaks
    
    const submitLogBtn = document.getElementById('std-submit-log-btn');
    if(submitLogBtn) {
        submitLogBtn.addEventListener('click', async () => {
            const ns = document.getElementById('std-shift-select').value;
            
            // Update shift status in database
            await supabase.from('employees').update({ shift_status: ns }).eq('id', currentUser.id);
            
            // Update local state
            currentUser.shift_status = ns;
            
            // Log activity
            addFeedLog(currentUser.full_name, `updated shift to ${ns}`);
            
            // Show appropriate message
            if(ns === 'Off-Shift') showToast("Shift ended. Email Notification sent.");
            else showToast("Activity logged.");
            
            // Clear comment field
            const commentInput = document.getElementById('std-comment-input');
            if(commentInput) commentInput.value = '';
        });
    }

    function generateStudentSchedule(batch) {
        const grid = document.getElementById('student-schedule-grid');
        if(!grid) return;
        grid.innerHTML = '';
        const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        days.forEach((day, index) => {
            let isOnline = false;
            if (batch === 'Batch 1') isOnline = (index % 2 !== 0); 
            if (batch === 'Batch 2') isOnline = (index % 2 === 0); 
            const mode = isOnline ? 'Online' : 'Face to Face';
            const badgeClass = isOnline ? 'text-muted' : 'text-success';
            grid.innerHTML += `<div class="card p-4 text-center"><h4 class="mb-2">${day}</h4><p class="text-xs text-muted mb-2">08:00 AM - 06:00 PM</p><span class="font-bold ${badgeClass}">${mode}</span></div>`;
        });
    }

    async function renderStudentDirectory() {
        const grid = document.getElementById('student-directory-grid');
        if(!grid) return;
        grid.innerHTML = '<p class="text-muted">Loading directory...</p>';
        const { data } = await supabase.from('employees').select('id, full_name, role, department, team, bio, avatar_url').neq('id', currentUser.id);
        
        grid.innerHTML = '';
        if(!data || data.length === 0) { grid.innerHTML = '<p class="text-muted">No other students found.</p>'; return; }

        data.forEach(emp => {
            const bioSafe = emp.bio ? emp.bio.replace(/'/g, "\\'") : '';
            grid.innerHTML += `
                <div class="emp-card" onclick="showPublicProfile('${emp.full_name}', '${emp.role}', '${emp.department}', '${emp.avatar_url}', '${emp.team}', '${bioSafe}')">
                    <img src="${emp.avatar_url || 'https://i.pravatar.cc/150?img=11'}" style="width:60px; height:60px; border-radius:50%; object-fit:cover; margin-bottom:10px;">
                    <h4>${emp.full_name}</h4>
                    <p class="text-xs text-muted mb-2">${emp.department}</p>
                    <span class="badge bg-light text-muted border-color" style="border: 1px solid;">${emp.team || 'Unassigned'}</span>
                </div>
            `;
        });
    }

    window.showPublicProfile = function(name, role, dept, avatar, team, bio) {
        document.getElementById('pub-name').innerText = name;
        document.getElementById('pub-role').innerText = role || 'Student Employee';
        document.getElementById('pub-dept').innerText = dept || 'Student';
        document.getElementById('pub-team').innerText = team || 'Unassigned';
        document.getElementById('pub-bio').innerText = bio ? `"${bio}"` : '"No bio provided."';
        document.getElementById('pub-avatar').src = avatar || 'https://i.pravatar.cc/150?img=11';
        document.getElementById('public-profile-modal').classList.remove('hidden');
    }

    // SHARED VID MODAL LOGIC (Used by Admin clicking Portfolio AND Student clicking 'Show QR')
    window.showVID = function(id, name, role, dept, avatar, team, bio, phone) {
        document.getElementById('vid-name').innerText = name;
        document.getElementById('vid-role').innerText = role || 'Student Employee';
        document.getElementById('vid-dept').innerText = dept || 'Student';
        document.getElementById('vid-empid').innerText = id || 'EV-000';
        document.getElementById('vid-team').innerText = team || 'Unassigned';
        const phoneEl = document.getElementById('vid-phone');
        if (phoneEl) {
            phoneEl.innerText = (phone != null && String(phone).trim() !== '') ? String(phone).trim() : 'Not on file';
        }
        document.getElementById('vid-bio').innerText = bio ? `"${bio}"` : '"No bio provided."';
        
        const safeAvatar = avatar && avatar.trim() !== '' ? avatar : 'https://i.pravatar.cc/150?img=11';
        document.getElementById('vid-avatar').src = safeAvatar;
        
        const safeId = id || 'EV-000';
        setQrOnImage(document.getElementById('vid-qr'), safeId, 200);
        
        document.getElementById('vid-modal').classList.remove('hidden');
        bindCardSpotlights();
    }

    const calPrev = document.getElementById('cal-prev');
    if(calPrev) calPrev.addEventListener('click', () => { calendarDate.setMonth(calendarDate.getMonth() - 1); generateStudentCalendar(); });
    
    const calNext = document.getElementById('cal-next');
    if(calNext) calNext.addEventListener('click', () => { calendarDate.setMonth(calendarDate.getMonth() + 1); generateStudentCalendar(); });

    function generateStudentCalendar() {
        const year = calendarDate.getFullYear();
        const month = calendarDate.getMonth();
        const grid = document.getElementById('student-calendar-grid');
        if(!grid) return;
        
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        document.getElementById('current-month-display').innerText = `${monthNames[month]} ${year}`;
        grid.innerHTML = '';
        
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const today = new Date();
        const isCurrentMonth = today.getMonth() === month && today.getFullYear() === year;

        for(let i = 0; i < firstDay; i++) grid.innerHTML += `<div class="cal-day empty"></div>`;
        for(let day = 1; day <= daysInMonth; day++) {
            const isToday = isCurrentMonth && day === today.getDate();
            let classes = 'cal-day bg-gray text-main';
            if (isToday) {
                classes += ' cal-day--today';
                if (currentUser.status === 'Present') classes += ' cal-day--status-present';
                else if (currentUser.status === 'Late') classes += ' cal-day--status-late';
            }
            grid.innerHTML += `<div class="${classes}">${day}</div>`;
        }
    }

    // ==================== ProfileCard QR Button ====================
    const pcShowQrBtn = document.getElementById('pc-show-qr-btn');
    if(pcShowQrBtn) {
        pcShowQrBtn.addEventListener('click', () => {
            if (currentUser) {
                showVID(currentUser.emp_id, currentUser.full_name, currentUser.role, currentUser.department, currentUser.avatar_url, currentUser.team, currentUser.bio, currentUser.phone);
            }
        });
    }

    // ================================ REACTBITS COMPONENT ENGINES ================================
    // Login + dashboard background: React Bits ColorBends (src/color-bends-react.jsx).

    // ==================== MAGIC BENTO - Interactive Dashboard Cards ====================
    // Global spotlight + BorderGlow-style edge highlight (see border-glow-init.js)
    
    const BENTO_GLOW_COLOR = '59, 130, 246';
    const BENTO_SPOTLIGHT_RADIUS = 400;

    function initMagicBento() {
        const cards = document.querySelectorAll('.card, .kpi-card');
        cards.forEach((card) => {
            if (!card.classList.contains('magic-bento-card')) {
                card.classList.add('magic-bento-card');
                card.style.setProperty('--glow-color', BENTO_GLOW_COLOR);
            }
        });
        setupBentoSpotlight();
        initBorderGlowCards();
        setupBentoRipples();
    }

    function setupBentoRipples() {
        document.querySelectorAll('.magic-bento-card .border-glow-inner').forEach((inner) => {
            const card = inner.closest('.magic-bento-card');
            if (!card || card._bentoRipple) return;
            card._bentoRipple = true;
            inner.style.position = 'relative';
            inner.addEventListener('click', (e) => {
                const rect = inner.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const maxDistance = Math.max(
                    Math.hypot(x, y),
                    Math.hypot(x - rect.width, y),
                    Math.hypot(x, y - rect.height),
                    Math.hypot(x - rect.width, y - rect.height)
                );
                const ripple = document.createElement('div');
                ripple.style.cssText = `position:absolute;width:${maxDistance * 2}px;height:${maxDistance * 2}px;border-radius:50%;background:radial-gradient(circle,rgba(${BENTO_GLOW_COLOR},0.35) 0%,rgba(${BENTO_GLOW_COLOR},0.15) 30%,transparent 70%);left:${x - maxDistance}px;top:${y - maxDistance}px;pointer-events:none;z-index:50;`;
                inner.appendChild(ripple);
                if (typeof gsap !== 'undefined') {
                    gsap.fromTo(ripple, { scale: 0, opacity: 1 }, { scale: 1, opacity: 0, duration: 0.8, ease: 'power2.out', onComplete: () => ripple.remove() });
                } else {
                    setTimeout(() => ripple.remove(), 800);
                }
            });
        });
    }
    
    function setupBentoSpotlight() {
        // Create global spotlight element
        let spotlight = document.querySelector('.global-spotlight');
        if (!spotlight) {
            spotlight = document.createElement('div');
            spotlight.className = 'global-spotlight';
            spotlight.style.background = `radial-gradient(circle, rgba(${BENTO_GLOW_COLOR}, 0.15) 0%, rgba(${BENTO_GLOW_COLOR}, 0.08) 15%, rgba(${BENTO_GLOW_COLOR}, 0.04) 25%, rgba(${BENTO_GLOW_COLOR}, 0.02) 40%, transparent 70%)`;
            document.body.appendChild(spotlight);
        }
        
        const proximity = BENTO_SPOTLIGHT_RADIUS * 0.5;
        const fadeDistance = BENTO_SPOTLIGHT_RADIUS * 0.75;
        
        document.addEventListener('mousemove', (e) => {
            const dashBody = document.querySelector('.dashboard-body');
            if (!dashBody) return;
            
            const rect = dashBody.getBoundingClientRect();
            const mouseInside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
            
            const cards = document.querySelectorAll('.magic-bento-card');
            
            if (!mouseInside) {
                if (typeof gsap !== 'undefined') {
                    gsap.to(spotlight, { opacity: 0, duration: 0.3, ease: 'power2.out' });
                }
                cards.forEach(card => card.style.setProperty('--glow-intensity', '0'));
                return;
            }
            
            let minDistance = Infinity;
            cards.forEach(card => {
                const cardRect = card.getBoundingClientRect();
                const centerX = cardRect.left + cardRect.width / 2;
                const centerY = cardRect.top + cardRect.height / 2;
                const distance = Math.hypot(e.clientX - centerX, e.clientY - centerY) - Math.max(cardRect.width, cardRect.height) / 2;
                const effectiveDistance = Math.max(0, distance);
                
                minDistance = Math.min(minDistance, effectiveDistance);
                
                let glowIntensity = 0;
                if (effectiveDistance <= proximity) {
                    glowIntensity = 1;
                } else if (effectiveDistance <= fadeDistance) {
                    glowIntensity = (fadeDistance - effectiveDistance) / (fadeDistance - proximity);
                }
                
                const relativeX = ((e.clientX - cardRect.left) / cardRect.width) * 100;
                const relativeY = ((e.clientY - cardRect.top) / cardRect.height) * 100;
                
                card.style.setProperty('--glow-x', `${relativeX}%`);
                card.style.setProperty('--glow-y', `${relativeY}%`);
                card.style.setProperty('--glow-intensity', glowIntensity.toString());
                card.style.setProperty('--glow-radius', `${BENTO_SPOTLIGHT_RADIUS}px`);
            });
            
            if (typeof gsap !== 'undefined') {
                gsap.to(spotlight, { left: e.clientX, top: e.clientY, duration: 0.1, ease: 'power2.out' });
                const targetOpacity = minDistance <= proximity ? 0.8 : (minDistance <= fadeDistance ? ((fadeDistance - minDistance) / (fadeDistance - proximity)) * 0.8 : 0);
                gsap.to(spotlight, { opacity: targetOpacity, duration: 0.2, ease: 'power2.out' });
            }
        });
    }

});

