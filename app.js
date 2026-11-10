require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const XLSX = require('@e965/xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const FileStore = require('session-file-store')(session);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const APP_NAME = process.env.APP_NAME || 'Admin Performance Management System';
const rootDir = __dirname;
const dataDir = path.join(rootDir, 'data');
const uploadsDir = process.env.UPLOADS_DIR ? path.resolve(rootDir, process.env.UPLOADS_DIR) : path.join(rootDir, 'uploads');
const dbPath = process.env.DB_PATH ? path.resolve(rootDir, process.env.DB_PATH) : path.join(dataDir, 'management_admin.db');
const sessionDir = path.join(path.dirname(dbPath), 'sessions');
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;
const trustedProxy = process.env.TRUST_PROXY
  ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY)
  : false;

for (const key of ['DEMO_ADMIN_USERNAME', 'DEMO_ADMIN_PASSWORD', 'DEMO_OWNER_USERNAME', 'DEMO_OWNER_PASSWORD']) {
  const value = process.env[key];
  if (!value || /^(replace|change|your|example)[-_]/i.test(value)) {
    throw new Error(`Set ${key} to a real, unique value before starting the application.`);
  }
}
if (process.env.DEMO_ADMIN_USERNAME === process.env.DEMO_OWNER_USERNAME) {
  throw new Error('DEMO_ADMIN_USERNAME and DEMO_OWNER_USERNAME must be different.');
}
if (isProduction && process.env.DEMO_ADMIN_PASSWORD === process.env.DEMO_OWNER_PASSWORD) {
  throw new Error('Production admin and owner passwords must be different.');
}

if (isProduction) {
  if (!sessionSecret || sessionSecret.length < 32 || /^(replace|change|your|example)[-_]/i.test(sessionSecret)) {
    throw new Error('Production requires SESSION_SECRET to contain at least 32 characters.');
  }
  if (!process.env.DEMO_ADMIN_USERNAME || !process.env.DEMO_OWNER_USERNAME ||
      process.env.DEMO_ADMIN_USERNAME === process.env.DEMO_OWNER_USERNAME ||
      ['admin', 'owner', 'controller'].includes(process.env.DEMO_ADMIN_USERNAME.toLowerCase()) ||
      ['admin', 'owner', 'controller'].includes(process.env.DEMO_OWNER_USERNAME.toLowerCase())) {
    throw new Error('Production requires distinct DEMO_ADMIN_USERNAME and DEMO_OWNER_USERNAME values.');
  }
  for (const key of ['DEMO_ADMIN_PASSWORD', 'DEMO_OWNER_PASSWORD']) {
    const password = process.env[key];
    if (!password || password.length < 12 || /^(replace|change|your|example)[-_]/i.test(password) ||
        ['admin123', 'owner123', 'password123'].includes(password.toLowerCase())) {
      throw new Error(`Production requires a unique ${key} of at least 12 characters.`);
    }
  }
}

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

const evidenceTypes = {
  'image/jpeg': { extension: '.jpg', signature: (buffer) => buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  'image/png': { extension: '.png', signature: (buffer) => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { extension: '.webp', signature: (buffer) => buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' },
  'application/pdf': { extension: '.pdf', signature: (buffer) => buffer.toString('ascii', 0, 5) === '%PDF-' }
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${evidenceTypes[file.mimetype].extension}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!evidenceTypes[file.mimetype]) {
      const error = new Error('Unsupported evidence type');
      error.status = 415;
      return cb(error);
    }
    cb(null, true);
  }
});

let db;

async function openDatabase() {
  const SQL = await initSqlJs();
  const fileExists = fs.existsSync(dbPath);
  const fileBuffer = fileExists ? fs.readFileSync(dbPath) : null;
  db = new SQL.Database(fileBuffer || undefined);
  if (!fileExists || fileBuffer.length === 0) {
    ensureTables();
    seedData();
  }
  migrateSchema();
  migrateUserRoles();
  migrateLoginAccounts();
  saveDatabase();
}

function migrateUserRoles() {
  db.run("UPDATE users SET role = 'admin' WHERE role NOT IN ('owner', 'admin')");
}

function migrateLoginAccounts() {
  const ownerUsername = process.env.DEMO_OWNER_USERNAME;
  const adminUsername = process.env.DEMO_ADMIN_USERNAME;
  if (ownerUsername === adminUsername) {
    throw new Error('DEMO_OWNER_USERNAME and DEMO_ADMIN_USERNAME must be different.');
  }
  const owners = getAll('SELECT id FROM users WHERE role = ? ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END, id', ['owner', ownerUsername]);
  const admins = getAll('SELECT id FROM users WHERE role = ? ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END, CASE WHEN admin_id IS NULL THEN 0 ELSE 1 END, id', ['admin', adminUsername]);
  if (!owners.length || !admins.length) {
    throw new Error('Exactly one owner and one admin account are required to complete account migration.');
  }

  const keepIds = [Number(owners[0].id), Number(admins[0].id)];
  const placeholders = keepIds.map(() => '?').join(', ');
  db.run(`DELETE FROM users WHERE id NOT IN (${placeholders})`, keepIds);
  db.run("UPDATE users SET role = 'owner' WHERE id = ?", [keepIds[0]]);
  db.run("UPDATE users SET role = 'admin' WHERE id = ?", [keepIds[1]]);

  const credentialsMigrated = getOne('SELECT id FROM settings WHERE key_name = ?', ['login_credentials_migrated']);
  if (!credentialsMigrated) {
    const configuredAccounts = [
      [keepIds[0], ownerUsername, process.env.DEMO_OWNER_PASSWORD],
      [keepIds[1], adminUsername, process.env.DEMO_ADMIN_PASSWORD || process.env.DEMO_CONTROLLER_PASSWORD]
    ];
    for (const [id, username, password] of configuredAccounts) {
      if (password) {
        db.run('UPDATE users SET username = ?, password_hash = ? WHERE id = ?', [username, bcrypt.hashSync(password, 12), id]);
      } else {
        db.run('UPDATE users SET username = ? WHERE id = ?', [username, id]);
      }
    }
    db.run('INSERT INTO settings (key_name, value_text) VALUES (?, ?)', ['login_credentials_migrated', 'true']);
  }
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  const temporaryPath = `${dbPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, buffer, { mode: 0o600 });
    fs.renameSync(temporaryPath, dbPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function execute(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  stmt.step();
  stmt.free();
  saveDatabase();
}

function getOne(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function getAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function addDays(dateValue, amount) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function getAssessmentPeriodKey(scheduleType, dateValue) {
  if (scheduleType === 'weekly') {
    const date = new Date(`${dateValue}T00:00:00.000Z`);
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - weekday);
    const year = date.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return `weekly:${year}-W${String(week).padStart(2, '0')}`;
  }
  if (scheduleType === 'monthly') return `monthly:${dateValue.slice(0, 7)}`;
  return `daily:${dateValue}`;
}

function runTransaction(callback) {
  db.run('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.run('COMMIT');
    saveDatabase();
    return result;
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

function insertChangeHistory(module, adminId, summary, actor) {
  db.run('INSERT INTO change_history (module, admin_id, summary, changed_by) VALUES (?, ?, ?, ?)', [
    module, adminId || null, summary, actor
  ]);
}

function insertAssessmentHistory({ assessmentId, adminId, jobdeskId, assessedOn, actor, oldStatus, newStatus, note }) {
  db.run(`
    INSERT INTO assessment_history
      (assessment_id, admin_id, jobdesk_id, assessed_on, changed_by, old_status, new_status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [assessmentId || null, adminId, jobdeskId, assessedOn, actor, oldStatus || null, newStatus, note || null]);
}

function getPeriodRange(month, year) {
  const firstDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const nextMonth = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const lastDate = addDays(nextMonth, -1);
  return { firstDate, lastDate, nextMonth, daysInMonth: Number(lastDate.slice(-2)) };
}

function getJobdeskDueDates(jobdesk, month, year) {
  const { firstDate, lastDate, daysInMonth } = getPeriodRange(month, year);
  if (jobdesk.schedule_type === 'monthly') return [`${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`];
  if (jobdesk.schedule_type === 'weekly') {
    const dueDates = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dateValue = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (new Date(`${dateValue}T00:00:00.000Z`).getUTCDay() === 0) dueDates.push(dateValue);
    }
    return dueDates;
  }
  return Array.from({ length: daysInMonth }, (_, index) =>
    `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`
  ).filter((dateValue) => dateValue >= firstDate && dateValue <= lastDate);
}

function isJobdeskEffectiveOn(jobdesk, dateValue) {
  const startsOn = jobdesk.effective_from || jobdesk.created_at?.slice(0, 10) || '0000-00-00';
  return startsOn <= dateValue && (!jobdesk.effective_to || dateValue < jobdesk.effective_to);
}

function getKpiReport(month, year, selectedAdminId = '', asOfDate = formatLocalDate()) {
  const { firstDate, lastDate } = getPeriodRange(month, year);
  const jobs = getAll(`
    SELECT jd.*, a.name AS employee_name
    FROM jobdesks jd JOIN admins a ON a.id = jd.admin_id
    ${selectedAdminId ? 'WHERE jd.admin_id = ?' : ''}
    ORDER BY jd.admin_id, jd.sort_order, jd.id
  `, selectedAdminId ? [selectedAdminId] : []);
  const assessments = getAll(`
    SELECT * FROM performance_assessments
    WHERE assessed_on >= ? AND assessed_on <= ?
    ${selectedAdminId ? 'AND admin_id = ?' : ''}
    ORDER BY id
  `, selectedAdminId ? [addDays(firstDate, -6), lastDate, selectedAdminId] : [addDays(firstDate, -6), lastDate]);
  const assessmentByPeriod = new Map();
  for (const assessment of assessments) {
    assessmentByPeriod.set(`${assessment.jobdesk_id}:${assessment.period_key}`, assessment);
  }

  const obligations = [];
  for (const jobdesk of jobs) {
    for (const dueDate of getJobdeskDueDates(jobdesk, month, year)) {
      const periodKey = getAssessmentPeriodKey(jobdesk.schedule_type, dueDate);
      const assessment = assessmentByPeriod.get(`${jobdesk.id}:${periodKey}`) || null;
      const activityDate = assessment ? assessment.assessed_on : dueDate;
      const obligationIsDue = dueDate <= asOfDate;
      if ((!obligationIsDue && !assessment) || !isJobdeskEffectiveOn(jobdesk, activityDate)) continue;
      obligations.push({
        admin_id: Number(jobdesk.admin_id),
        admin_name: jobdesk.employee_name,
        jobdesk_id: Number(jobdesk.id),
        job_name: assessment?.jobdesk_name_snapshot || jobdesk.name,
        period_type: jobdesk.schedule_type || 'daily',
        period_key: periodKey,
        due_date: dueDate,
        assessed_on: assessment?.assessed_on || null,
        status: assessment?.status || null,
        note: assessment?.note || '',
        assessment_id: assessment ? Number(assessment.id) : null
      });
    }
  }

  const totals = { required: obligations.length, completed: 0, incomplete: 0, unassessed: 0 };
  const byAdminMap = new Map();
  for (const obligation of obligations) {
    if (!byAdminMap.has(obligation.admin_id)) {
      byAdminMap.set(obligation.admin_id, {
        admin_id: obligation.admin_id,
        name: obligation.admin_name,
        required: 0,
        completed: 0,
        incomplete: 0,
        unassessed: 0
      });
    }
    const summary = byAdminMap.get(obligation.admin_id);
    summary.required += 1;
    if (obligation.status === 'Selesai') {
      totals.completed += 1;
      summary.completed += 1;
    } else if (obligation.status) {
      totals.incomplete += 1;
      summary.incomplete += 1;
    } else {
      totals.unassessed += 1;
      summary.unassessed += 1;
    }
  }

  const admins = getAll(selectedAdminId
    ? 'SELECT id, name FROM admins WHERE id = ? ORDER BY id'
    : 'SELECT id, name FROM admins WHERE active = 1 ORDER BY id', selectedAdminId ? [selectedAdminId] : []);
  for (const admin of admins) {
    if (!byAdminMap.has(Number(admin.id))) {
      byAdminMap.set(Number(admin.id), {
        admin_id: Number(admin.id), name: admin.name, required: 0, completed: 0, incomplete: 0, unassessed: 0
      });
    }
  }
  const byAdmin = [...byAdminMap.values()]
    .map((item) => ({ ...item, percent: item.required ? Number((item.completed / item.required * 100).toFixed(1)) : 0 }))
    .sort((left, right) => right.percent - left.percent || left.name.localeCompare(right.name));

  const { daysInMonth } = getPeriodRange(month, year);
  const dailyTrend = [];
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateValue = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (dateValue > asOfDate) break;
    const activeObligations = obligations.filter((item) =>
      item.due_date <= dateValue || (item.assessed_on && item.assessed_on <= dateValue)
    );
    const completedByDate = activeObligations.filter((item) => item.status === 'Selesai' && item.assessed_on <= dateValue).length;
    const hasAssessmentByDate = activeObligations.some((item) => item.assessed_on && item.assessed_on <= dateValue);
    if (hasAssessmentByDate) {
      dailyTrend.push({
        month_label: String(day),
        avg_kpi: activeObligations.length ? Number((completedByDate / activeObligations.length * 100).toFixed(1)) : 0
      });
    }
  }
  return { obligations, totals, byAdmin, dailyTrend, firstDate, lastDate };
}

function getRevenueData(month, year, selectedAdminId = '', selectedUnitId = '') {
  const { firstDate, lastDate } = getPeriodRange(month, year);
  const params = [firstDate, lastDate];
  const adminCondition = selectedAdminId ? 'AND re.admin_id = ?' : '';
  const unitCondition = selectedUnitId ? 'AND re.unit_id = ?' : '';
  if (selectedAdminId) params.push(selectedAdminId);
  if (selectedUnitId) params.push(selectedUnitId);
  const entries = getAll(`
    SELECT re.*, a.name AS admin_name, du.name AS unit_name
    FROM revenue_entries re
    JOIN admins a ON a.id = re.admin_id
    JOIN device_units du ON du.id = re.unit_id
    WHERE re.entry_date >= ? AND re.entry_date <= ? ${adminCondition} ${unitCondition}
    ORDER BY re.entry_date DESC, re.id DESC
  `, params);
  const totalAmount = entries.reduce((sum, entry) => sum + Number(entry.amount_rupiah || 0), 0);
  const totalTransactions = entries.reduce((sum, entry) => sum + Number(entry.transaction_count || 0), 0);
  const byAdmin = new Map();
  const byUnit = new Map();
  const byDate = new Map();
  const byWeek = new Map();
  for (const entry of entries) {
    const adminTotal = byAdmin.get(entry.admin_id) || { admin_id: Number(entry.admin_id), name: entry.admin_name, amount: 0 };
    adminTotal.amount += Number(entry.amount_rupiah || 0);
    byAdmin.set(entry.admin_id, adminTotal);
    const unitTotal = byUnit.get(entry.unit_id) || { unit_id: Number(entry.unit_id), name: entry.unit_name, amount: 0 };
    unitTotal.amount += Number(entry.amount_rupiah || 0);
    byUnit.set(entry.unit_id, unitTotal);
    const dateTotal = byDate.get(entry.entry_date) || 0;
    byDate.set(entry.entry_date, dateTotal + Number(entry.amount_rupiah || 0));
    const weekKey = getAssessmentPeriodKey('weekly', entry.entry_date);
    const weekTotal = byWeek.get(weekKey) || 0;
    byWeek.set(weekKey, weekTotal + Number(entry.amount_rupiah || 0));
  }
  return {
    entries,
    totalAmount,
    totalTransactions,
    byAdmin: [...byAdmin.values()].sort((left, right) => right.amount - left.amount),
    byUnit: [...byUnit.values()].sort((left, right) => right.amount - left.amount),
    daily: [...byDate.entries()].sort(([left], [right]) => left.localeCompare(right)),
    byWeek: [...byWeek.entries()].sort(([left], [right]) => left.localeCompare(right))
  };
}

function getAssessmentPageData(adminId, month, year, asOfDate = formatLocalDate()) {
  const { firstDate, lastDate, daysInMonth } = getPeriodRange(month, year);
  const jobs = getAll(`
    SELECT jd.*, a.name AS employee_name
    FROM jobdesks jd JOIN admins a ON a.id = jd.admin_id
    WHERE jd.admin_id = ?
      AND COALESCE(jd.effective_from, date(jd.created_at)) <= ?
      AND (jd.effective_to IS NULL OR jd.effective_to > ?)
    ORDER BY jd.sort_order, jd.id
  `, [adminId, lastDate, firstDate]);
  const jobIds = jobs.map((job) => Number(job.id));
  const assessmentRows = jobIds.length
    ? getAll(`
      SELECT * FROM performance_assessments
      WHERE admin_id = ? AND assessed_on >= ? AND assessed_on <= ?
        AND jobdesk_id IN (${jobIds.map(() => '?').join(', ')})
      ORDER BY id
    `, [adminId, addDays(firstDate, -6), lastDate, ...jobIds])
    : [];
  const byPeriod = new Map();
  for (const row of assessmentRows) byPeriod.set(`${row.jobdesk_id}:${row.period_key}`, row);

  const calendarDays = Array.from({ length: daysInMonth }, (_, index) => {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`;
    const weekday = new Intl.DateTimeFormat('id-ID', { weekday: 'short', timeZone: 'UTC' })
      .format(new Date(`${date}T00:00:00.000Z`));
    return { day: index + 1, date, weekday, isFuture: date > asOfDate };
  });
  const tasks = jobs.map((job) => {
    const cells = calendarDays.map((day) => {
      const periodKey = getAssessmentPeriodKey(job.schedule_type, day.date);
      const record = byPeriod.get(`${job.id}:${periodKey}`) || null;
      const isRecordedDate = record && record.assessed_on === day.date;
      const periodAlreadyAssessed = Boolean(record);
      return {
        ...day,
        periodKey,
        assessmentId: isRecordedDate ? Number(record.id) : null,
        status: isRecordedDate ? record.status : null,
        note: isRecordedDate ? record.note || '' : '',
        editable: !day.isFuture && (
          isRecordedDate || (!periodAlreadyAssessed && isJobdeskEffectiveOn(job, day.date))
        )
      };
    });
    return {
      id: Number(job.id),
      admin_id: Number(job.admin_id),
      name: job.name,
      schedule_type: job.schedule_type || 'daily',
      weight: Number(job.weight || 0),
      cells
    };
  });

  const history = getAll(`
    SELECT ah.*, a.name AS employee_name, jd.name AS jobdesk_name
    FROM assessment_history ah
    JOIN admins a ON a.id = ah.admin_id
    JOIN jobdesks jd ON jd.id = ah.jobdesk_id
    WHERE ah.admin_id = ? AND ah.assessed_on >= ? AND ah.assessed_on <= ?
    ORDER BY ah.created_at DESC, ah.id DESC
    LIMIT 250
  `, [adminId, firstDate, lastDate]);
  const audits = getAll(`
    SELECT ar.*, jd.name AS job_name
    FROM audit_records ar
    LEFT JOIN jobdesks jd ON jd.id = ar.jobdesk_id
    WHERE ar.admin_id = ? AND ar.audit_date >= ? AND ar.audit_date <= ?
    ORDER BY ar.audit_date DESC, ar.id DESC
    LIMIT 250
  `, [adminId, firstDate, lastDate]);
  const report = getKpiReport(month, year, String(adminId), asOfDate);
  return {
    tasks,
    calendarDays,
    history,
    audits,
    summary: report.byAdmin[0] || {
      admin_id: Number(adminId), name: '', required: 0, completed: 0, incomplete: 0, unassessed: 0, percent: 0
    },
    hasTasks: jobs.length > 0,
    firstDate,
    lastDate
  };
}

function getMonthlyReportData(month, year, adminId = '', unitId = '') {
  const kpi = getKpiReport(month, year, adminId);
  const revenue = getRevenueData(month, year, adminId, unitId);
  const audits = getAll(`
    SELECT ar.admin_id, COUNT(*) AS audit_count,
           SUM(CASE WHEN ar.follow_up_status IN ('Perlu Perbaikan', 'Tidak Lolos Audit') THEN 1 ELSE 0 END) AS findings
    FROM audit_records ar
    WHERE ar.audit_date >= ? AND ar.audit_date <= ?
    ${adminId ? 'AND ar.admin_id = ?' : ''}
    GROUP BY ar.admin_id
  `, adminId ? [kpi.firstDate, kpi.lastDate, adminId] : [kpi.firstDate, kpi.lastDate]);
  const auditByAdmin = new Map(audits.map((row) => [Number(row.admin_id), row]));
  const details = getAll(`
    SELECT pa.admin_id, pa.assessed_on AS entry_date, pa.jobdesk_name_snapshot AS job_name,
           pa.period_type, pa.period_key, pa.status, pa.note,
           pa.employee_name_snapshot AS admin_name
    FROM performance_assessments pa
    WHERE pa.assessed_on >= ? AND pa.assessed_on <= ?
    ${adminId ? 'AND pa.admin_id = ?' : ''}
    ORDER BY pa.assessed_on, pa.admin_id, pa.jobdesk_id, pa.id
  `, adminId ? [kpi.firstDate, kpi.lastDate, adminId] : [kpi.firstDate, kpi.lastDate]);
  const summaries = kpi.byAdmin.map((row) => {
    const audit = auditByAdmin.get(row.admin_id) || {};
    const employeeRevenue = revenue.byAdmin.find((item) => item.admin_id === row.admin_id);
    const remaining = row.incomplete + row.unassessed;
    return {
      ...row,
      findings: Number(audit.findings || 0),
      audit_count: Number(audit.audit_count || 0),
      total_revenue: employeeRevenue ? employeeRevenue.amount : 0,
      conclusion: !row.required
        ? 'Belum ada kewajiban KPI'
        : remaining === 0
          ? 'Seluruh KPI wajib selesai'
          : `${remaining} KPI perlu ditindaklanjuti`
    };
  });
  return {
    month,
    year,
    adminId,
    kpi,
    revenue,
    summaries,
    details,
    auditByAdmin,
    byUnit: revenue.byUnit
  };
}

function ensureTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      full_name TEXT NOT NULL,
      admin_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position TEXT,
      department TEXT DEFAULT 'Admin',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS jobdesks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      target_value REAL DEFAULT 1,
      weekly_target REAL DEFAULT 1,
      monthly_target REAL DEFAULT 1,
      weight INTEGER DEFAULT 10,
      schedule_type TEXT DEFAULT 'daily',
      schedule_days TEXT,
      due_time TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS work_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      jobdesk_id INTEGER NOT NULL,
      entry_date TEXT NOT NULL,
      name TEXT,
      target_value REAL DEFAULT 0,
      actual_result REAL DEFAULT 0,
      status TEXT DEFAULT 'Proses',
      percentage REAL DEFAULT 0,
      kpi_score REAL DEFAULT 0,
      notes TEXT,
      evidence_path TEXT,
      created_by TEXT,
      checked_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL,
      jobdesk_id INTEGER,
      audit_date TEXT NOT NULL,
      task_name TEXT NOT NULL,
      inspection_result TEXT,
      sop_match TEXT,
      evidence_path TEXT,
      findings TEXT,
      recommendation TEXT,
      auditor TEXT,
      follow_up_status TEXT DEFAULT 'Menunggu Pemeriksaan',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS change_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL,
      admin_id INTEGER,
      summary TEXT NOT NULL,
      changed_by TEXT,
      changed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_name TEXT UNIQUE NOT NULL,
      value_text TEXT
    );
  `);
}

function ensureColumn(table, column, definition) {
  const columns = db.exec(`PRAGMA table_info(${table})`)[0]?.values || [];
  if (!columns.some((row) => row[1] === column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateSchema() {
  db.run('PRAGMA foreign_keys = ON');
  ensureColumn('jobdesks', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('jobdesks', 'effective_from', 'TEXT');
  ensureColumn('jobdesks', 'effective_to', 'TEXT');
  db.run('UPDATE jobdesks SET sort_order = id WHERE sort_order = 0');
  db.run("UPDATE jobdesks SET effective_from = COALESCE(date(created_at), date('now')) WHERE effective_from IS NULL OR effective_from = ''");
  db.run(`
    CREATE TABLE IF NOT EXISTS performance_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER NOT NULL REFERENCES admins(id),
      jobdesk_id INTEGER NOT NULL REFERENCES jobdesks(id),
      period_key TEXT NOT NULL,
      period_type TEXT NOT NULL,
      assessed_on TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('Selesai', 'Belum Selesai')),
      note TEXT,
      employee_name_snapshot TEXT NOT NULL,
      jobdesk_name_snapshot TEXT NOT NULL,
      target_value_snapshot REAL DEFAULT 0,
      weight_snapshot INTEGER DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_assessments_period ON performance_assessments(admin_id, assessed_on, jobdesk_id);
    CREATE INDEX IF NOT EXISTS idx_assessments_key ON performance_assessments(jobdesk_id, period_key, id);

    CREATE TABLE IF NOT EXISTS assessment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assessment_id INTEGER,
      admin_id INTEGER NOT NULL REFERENCES admins(id),
      jobdesk_id INTEGER NOT NULL REFERENCES jobdesks(id),
      assessed_on TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_assessment_history_date ON assessment_history(assessed_on, created_at);

    CREATE TABLE IF NOT EXISTS device_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS revenue_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_key TEXT NOT NULL UNIQUE,
      admin_id INTEGER NOT NULL REFERENCES admins(id),
      unit_id INTEGER NOT NULL REFERENCES device_units(id),
      entry_date TEXT NOT NULL,
      transaction_count INTEGER NOT NULL DEFAULT 1 CHECK(transaction_count >= 0),
      amount_rupiah INTEGER NOT NULL CHECK(amount_rupiah >= 0),
      note TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_revenue_date_admin ON revenue_entries(entry_date, admin_id, unit_id);
  `);

  const migrated = getOne('SELECT id FROM settings WHERE key_name = ?', ['legacy_assessments_migrated']);
  if (!migrated) {
    const legacyEntries = getAll(`
      SELECT we.*, a.name AS employee_name, jd.name AS current_jobdesk_name,
             jd.schedule_type, jd.target_value AS current_target, jd.weight AS current_weight
      FROM work_entries we
      JOIN admins a ON a.id = we.admin_id
      JOIN jobdesks jd ON jd.id = we.jobdesk_id
      ORDER BY we.id
    `);
    for (const entry of legacyEntries) {
      const periodType = ['daily', 'weekly', 'monthly'].includes(entry.schedule_type) ? entry.schedule_type : 'daily';
      db.run(`
        INSERT INTO performance_assessments
          (admin_id, jobdesk_id, period_key, period_type, assessed_on, status, note,
           employee_name_snapshot, jobdesk_name_snapshot, target_value_snapshot, weight_snapshot, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        entry.admin_id,
        entry.jobdesk_id,
        getAssessmentPeriodKey(periodType, entry.entry_date),
        periodType,
        entry.entry_date,
        entry.status === 'Selesai' ? 'Selesai' : 'Belum Selesai',
        [entry.status, entry.notes].filter(Boolean).join(' — '),
        entry.employee_name,
        entry.name || entry.current_jobdesk_name,
        Number(entry.target_value || entry.current_target || 0),
        Number(entry.current_weight || 0),
        entry.checked_by || entry.created_by || 'Migrasi data lama'
      ]);
    }
    db.run('INSERT INTO settings (key_name, value_text) VALUES (?, ?)', ['legacy_assessments_migrated', 'true']);
  }
}

function seedData() {
  if (getOne('SELECT COUNT(*) AS count FROM users')) {
    const countRow = getOne('SELECT COUNT(*) AS count FROM users');
    if (Number(countRow.count) > 0) return;
  }

  const seedDemoEmployees = process.env.SEED_DEMO_EMPLOYEES === 'true';
  const adminData = seedDemoEmployees ? [
    [1, 'Admin 1', 'Customer Service', 'Operations'],
    [2, 'Admin 2', 'Sales & WhatsApp', 'Sales'],
    [3, 'Admin 3', 'Live & SOP', 'Operations'],
    [4, 'Admin 4', 'Booking & Admin Villa', 'Operations'],
    [5, 'Admin 5', 'Social Media', 'Marketing']
  ] : [];

  for (const [id, name, position, department] of adminData) {
    execute('INSERT INTO admins (id, name, position, department) VALUES (?, ?, ?, ?)', [id, name, position, department]);
  }

  const users = [
    [process.env.DEMO_ADMIN_USERNAME, process.env.DEMO_ADMIN_PASSWORD, 'admin', 'Admin', null],
    [process.env.DEMO_OWNER_USERNAME, process.env.DEMO_OWNER_PASSWORD, 'owner', 'Owner', null],
  ];

  for (const [username, password, role, name, adminId] of users) {
    execute('INSERT INTO users (username, password_hash, role, full_name, admin_id) VALUES (?, ?, ?, ?, ?)', [username, bcrypt.hashSync(password, 12), role, name, adminId]);
  }

  const jobdeskSeed = seedDemoEmployees ? [
    [1, 'SOP Handphone', 1, 5, 20, 15, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:00'],
    [1, 'Memaksimalkan Sales', 2, 8, 30, 18, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '18:00'],
    [1, 'Update Status WhatsApp', 1, 5, 20, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:30'],
    [1, 'Membalas Semua Chat', 3, 10, 40, 20, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '11:00'],
    [1, 'Rekap Telepon Customer', 2, 6, 25, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '16:00'],
    [1, 'Live Streaming', 1, 4, 15, 10, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '20:00'],
    [1, 'Memastikan Katalog Villa', 1, 4, 15, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '12:00'],
    [1, 'Report Komplain', 1, 3, 10, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '17:00'],
    [2, 'SOP Handphone', 1, 5, 20, 15, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:00'],
    [2, 'Memaksimalkan Sales', 2, 8, 30, 18, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '18:00'],
    [2, 'Update Status WhatsApp', 1, 5, 20, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:30'],
    [2, 'Rekap Telepon Customer', 2, 6, 25, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '16:00'],
    [2, 'Live Streaming', 1, 4, 15, 10, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '20:00'],
    [2, 'Memastikan Katalog Villa', 1, 4, 15, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '12:00'],
    [2, 'Konfirmasi Kehadiran Tamu', 1, 3, 12, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '17:00'],
    [3, 'SOP Handphone', 1, 5, 20, 15, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:00'],
    [3, 'Memaksimalkan Sales', 2, 8, 30, 18, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '18:00'],
    [3, 'Update Status WhatsApp', 1, 5, 20, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:30'],
    [3, 'Membalas Semua Chat', 3, 10, 40, 20, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '11:00'],
    [3, 'Rekap Telepon Customer', 2, 6, 25, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '16:00'],
    [3, 'Host Live Utama', 1, 3, 12, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '19:30'],
    [3, 'IP Putih', 1, 2, 8, 6, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '10:00'],
    [3, 'Live Streaming', 1, 4, 15, 10, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '20:00'],
    [3, 'Report Komplain', 1, 3, 10, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '17:00'],
    [3, 'Clearing Barang Tamu', 1, 2, 8, 6, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '15:30'],
    [3, 'Partisipasi Grup Squad', 1, 3, 10, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '13:00'],
    [3, 'Sales TikTok', 2, 8, 30, 18, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '18:30'],
    [3, 'Google Rating', 1, 2, 6, 5, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '12:30'],
    [4, 'SOP Handphone', 1, 5, 20, 15, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:00'],
    [4, 'Memaksimalkan Sales', 2, 8, 30, 18, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '18:00'],
    [4, 'Update Status WhatsApp', 1, 5, 20, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:30'],
    [4, 'Membalas Semua Chat', 3, 10, 40, 20, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '11:00'],
    [4, 'Rekap Telepon Customer', 2, 6, 25, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '16:00'],
    [4, 'Update Tanggal Booking', 2, 4, 15, 10, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '10:30'],
    [4, 'Update Bukti Pembayaran', 1, 4, 15, 10, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '12:30'],
    [4, 'Update Kalender Online 3x', 3, 9, 30, 18, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '08:00'],
    [4, 'Membuat Kwitansi', 1, 3, 12, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '14:00'],
    [4, 'Update Simbol Tanggal Booking List', 1, 3, 12, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '15:00'],
    [4, 'Update Transaksi Customer', 1, 3, 12, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '17:00'],
    [4, 'Upload Semua Villa Baru', 1, 3, 12, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '18:00'],
    [4, 'Pemesanan Catering', 1, 2, 8, 6, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '11:30'],
    [4, 'Penyewaan Properti Villa', 1, 2, 8, 6, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '17:30'],
    [4, 'Report Kebersihan Kantor', 1, 2, 8, 6, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '15:30'],
    [4, 'Share List Booking', 1, 1, 5, 4, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '22:00'],
    [4, 'Follow Up Booking Grup Villa Mitra', 1, 3, 12, 8, 'weekly', 'Mon,Thu', '09:00'],
    [5, 'SOP Handphone', 1, 5, 20, 15, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:00'],
    [5, 'Update Status WhatsApp', 1, 5, 20, 12, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:30'],
    [5, 'Update TikTok', 2, 8, 30, 18, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '13:00'],
    [5, 'Live Streaming', 1, 4, 15, 10, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '20:00'],
    [5, 'Konten Media Sosial', 3, 9, 30, 20, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '10:00'],
    [5, 'Posting 3 Konten Feed', 3, 9, 30, 20, 'weekly', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '10:00'],
    [5, 'Desain Hari Besar', 1, 3, 10, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '21:00'],
    [5, 'Balas Chat Semua Platform', 3, 10, 40, 20, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '11:00'],
    [5, 'ACC Kolaborasi', 1, 2, 8, 6, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '09:45'],
    [5, 'Share Video ke Grup Squad', 2, 8, 30, 18, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '15:00'],
    [5, 'Akun Agoda Airbnb Booking.com', 1, 3, 12, 8, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '16:00'],
    [5, 'Like dan Komen Konten', 2, 8, 30, 18, 'daily', 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', '19:00']
  ] : [];

  for (const [adminId, name, targetValue, weeklyTarget, monthlyTarget, weight, scheduleType, scheduleDays, dueTime] of jobdeskSeed) {
    execute('INSERT INTO jobdesks (admin_id, name, target_value, weekly_target, monthly_target, weight, schedule_type, schedule_days, due_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [adminId, name, targetValue, weeklyTarget, monthlyTarget, weight, scheduleType, scheduleDays, dueTime]);
  }

  const jobdeskList = getAll('SELECT id, admin_id, name, target_value FROM jobdesks ORDER BY admin_id, id');
  const statusList = ['Selesai', 'Proses', 'Belum Selesai', 'Terlambat', 'Tidak Sesuai SOP', 'Tidak Berlaku'];
  const today = new Date();

  for (let i = 0; i < jobdeskList.length; i += 1) {
    const job = jobdeskList[i];
    const date = new Date(today);
    date.setDate(today.getDate() - (i % 6));
    const status = statusList[(i + Number(job.admin_id)) % statusList.length];
    const actualResult = status === 'Belum Selesai' ? 0 : status === 'Terlambat' ? Math.max(0.5, Number(job.target_value) * 0.9) : Number(job.target_value);
    const percentage = status === 'Tidak Berlaku' ? 0 : Math.min(100, Math.round((actualResult / Math.max(Number(job.target_value), 1)) * 100));
    const kpiScore = status === 'Terlambat' ? 75 : status === 'Selesai' ? 100 : status === 'Proses' ? 60 : status === 'Tidak Sesuai SOP' ? 30 : 0;
    execute('INSERT INTO work_entries (admin_id, jobdesk_id, entry_date, name, target_value, actual_result, status, percentage, kpi_score, notes, created_by, checked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [job.admin_id, job.id, date.toISOString().slice(0, 10), job.name, job.target_value, actualResult, status, percentage, kpiScore, `Catatan ${status.toLowerCase()} untuk ${job.name}`, 'controller', 'owner']);
  }

  const auditRows = seedDemoEmployees ? [
    [1, 1, '2026-11-01', 'SOP Handphone', 'Pemeriksaan dilakukan sesuai SOP', 'Sesuai', 'Tidak ada temuan', 'Lanjutkan prosedur standar', 'controller', 'Lolos Audit'],
    [2, 2, '2026-11-01', 'Memaksimalkan Sales', 'Ada pencapaian', 'Sesuai', 'Cek target sales', 'Tingkatkan follow-up', 'controller', 'Perlu Perbaikan'],
    [3, 3, '2026-11-01', 'Live Streaming', 'Memenuhi SOP', 'Sesuai', 'Tidak ada temuan', 'Pertahankan performa', 'controller', 'Lolos Audit'],
    [4, 4, '2026-11-01', 'Update Tanggal Booking', 'Terdapat ketidaksesuaian ringan', 'Perlu Perbaikan', 'Format tanggal belum konsisten', 'Perbaiki format booking', 'controller', 'Perlu Perbaikan'],
    [5, 5, '2026-11-01', 'Posting 3 Konten Feed', 'Konten sudah ada', 'Sesuai', 'Waktu posting perlu konsisten', 'Perbaiki jadwal posting', 'controller', 'Lolos Audit']
  ] : [];

  for (const [adminId, jobdeskId, auditDate, taskName, inspectionResult, sopMatch, findings, recommendation, auditor, status] of auditRows) {
    execute('INSERT INTO audit_records (admin_id, jobdesk_id, audit_date, task_name, inspection_result, sop_match, findings, recommendation, auditor, follow_up_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [adminId, jobdeskId, auditDate, taskName, inspectionResult, sopMatch, findings, recommendation, auditor, status]);
  }

  execute('INSERT INTO settings (key_name, value_text) VALUES (?, ?)', ['google_sheets_configured', 'false']);
  execute('INSERT INTO settings (key_name, value_text) VALUES (?, ?)', ['report_period', 'monthly']);
}

function toTitleCase(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  const account = getOne('SELECT role, password_hash FROM users WHERE id = ?', [req.session.user.id]);
  if (!account || account.password_hash !== req.session.user.passwordHash) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  req.session.user.role = account.role;
  if (req.session.user.admin_id) {
    const admin = getOne('SELECT active FROM admins WHERE id = ?', [req.session.user.admin_id]);
    if (!admin || Number(admin.active) !== 1) {
      return req.session.destroy(() => res.redirect('/login'));
    }
  }
  next();
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).send('Akses ditolak. Role Anda tidak memiliki izin untuk halaman ini.');
    }
    next();
  };
}

function getFilters(req) {
  const now = new Date();
  const requestedMonth = Number(req.query.month);
  const requestedYear = Number(req.query.year);
  const month = Number.isInteger(requestedMonth) && requestedMonth >= 1 && requestedMonth <= 12
    ? requestedMonth : now.getMonth() + 1;
  const year = Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
    ? requestedYear : now.getFullYear();
  return {
    month,
    year,
    date: isValidDate(req.query.date) ? req.query.date : '',
    fromDate: isValidDate(req.query.fromDate) ? req.query.fromDate : '',
    toDate: isValidDate(req.query.toDate) ? req.query.toDate : '',
    adminId: /^\d+$/.test(String(req.query.adminId || '')) ? String(req.query.adminId) : '',
    unitId: /^\d+$/.test(String(req.query.unitId || '')) ? String(req.query.unitId) : '',
    status: req.query.status || '',
    jobdesk: req.query.jobdesk || ''
  };
}

function getAdminOptions() {
  return getAll('SELECT id, name FROM admins WHERE active = 1 ORDER BY id');
}

function getJobdeskOptions() {
  return getAll('SELECT id, admin_id, name FROM jobdesks WHERE is_active = 1 ORDER BY admin_id, sort_order, id');
}

function getStatusOptions() {
  return ['Selesai', 'Proses', 'Belum Selesai', 'Terlambat', 'Tidak Sesuai SOP', 'Tidak Berlaku'];
}

function buildEntryQuery(filters) {
  const conditions = [];
  const params = [];

  if (filters.date) {
    conditions.push('we.entry_date = ?');
    params.push(filters.date);
  } else {
    if (filters.month) {
      conditions.push('CAST(strftime("%m", we.entry_date) AS INTEGER) = ?');
      params.push(filters.month);
    }
    if (filters.year) {
      conditions.push('CAST(strftime("%Y", we.entry_date) AS INTEGER) = ?');
      params.push(filters.year);
    }
  }

  if (filters.adminId) {
    conditions.push('we.admin_id = ?');
    params.push(filters.adminId);
  }

  if (filters.status) {
    conditions.push('we.status = ?');
    params.push(filters.status);
  }

  if (filters.jobdesk) {
    conditions.push('jd.name LIKE ?');
    params.push(`%${filters.jobdesk}%`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `
    SELECT we.*, a.name AS admin_name, jd.name AS job_name
    FROM work_entries we
    JOIN admins a ON a.id = we.admin_id
    JOIN jobdesks jd ON jd.id = we.jobdesk_id
    ${where}
    ORDER BY we.entry_date DESC, we.admin_id ASC
  `;

  return { sql, params };
}

async function getDashboardData(req) {
  const filters = getFilters(req);
  const report = getKpiReport(filters.month, filters.year, filters.adminId);
  const revenue = getRevenueData(filters.month, filters.year, filters.adminId);
  const activeKpiCount = getOne(`
    SELECT COUNT(*) AS count
    FROM jobdesks jd JOIN admins a ON a.id = jd.admin_id
    WHERE jd.is_active = 1 AND a.active = 1${filters.adminId ? ' AND jd.admin_id = ?' : ''}
  `, filters.adminId ? [filters.adminId] : []);
  const todayRevenue = getOne(`
    SELECT COALESCE(SUM(amount_rupiah), 0) AS amount
    FROM revenue_entries WHERE entry_date = ?${filters.adminId ? ' AND admin_id = ?' : ''}
  `, filters.adminId ? [formatLocalDate(), filters.adminId] : [formatLocalDate()]);
  const byAdmin = report.byAdmin.map((item) => ({
    ...item,
    avg_kpi: item.percent,
    total_tasks: item.required
  }));
  const rankedAdmins = byAdmin.filter((item) => item.required > 0);
  const auditParams = [`${filters.year}-${String(filters.month).padStart(2, '0')}-01`,
    `${filters.year}-${String(filters.month).padStart(2, '0')}-${String(getPeriodRange(filters.month, filters.year).daysInMonth).padStart(2, '0')}`];
  const adminCondition = filters.adminId ? ' AND admin_id = ?' : '';
  if (filters.adminId) auditParams.push(filters.adminId);
  const auditCount = Number(getOne(`
    SELECT COUNT(*) AS count FROM audit_records
    WHERE audit_date >= ? AND audit_date <= ?${adminCondition}
  `, auditParams).count);

  return {
    entries: report.obligations,
    totalAdmin: filters.adminId
      ? Number(getOne('SELECT COUNT(*) AS count FROM admins WHERE id = ? AND active = 1', [filters.adminId]).count)
      : Number(getOne('SELECT COUNT(*) AS count FROM admins WHERE active = 1').count),
    totalTasks: report.totals.required,
    totalKpis: Number(activeKpiCount.count || 0),
    completed: report.totals.completed,
    pending: report.totals.incomplete + report.totals.unassessed,
    unassessed: report.totals.unassessed,
    late: 0,
    kpiAverage: report.totals.required
      ? Number((report.totals.completed / report.totals.required * 100).toFixed(1))
      : 0,
    bestAdmin: rankedAdmins[0]
      ? { name: rankedAdmins[0].name, avg_kpi: rankedAdmins[0].percent }
      : { name: 'Belum ada penilaian', avg_kpi: 0 },
    worstAdmin: rankedAdmins.length
      ? { name: rankedAdmins[rankedAdmins.length - 1].name, avg_kpi: rankedAdmins[rankedAdmins.length - 1].percent }
      : { name: 'Belum ada penilaian', avg_kpi: 0 },
    auditCount,
    byAdmin,
    monthlyTrend: report.dailyTrend,
    revenue,
    totalRevenue: revenue.totalAmount,
    todayRevenue: Number(todayRevenue.amount || 0),
    totalTransactions: revenue.totalTransactions,
    filters
  };
}

app.set('view engine', 'ejs');
app.set('views', path.join(rootDir, 'views'));
app.set('trust proxy', trustedProxy);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  }
}));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));
app.use('/public', express.static(path.join(rootDir, 'public'), { maxAge: isProduction ? '1d' : 0 }));
app.use(session({
  name: 'apms.sid',
  secret: sessionSecret || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  store: new FileStore({
    path: sessionDir,
    ttl: 60 * 60 * 8,
    reapInterval: 60 * 60,
    retries: 0
  }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 8,
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax'
  }
}));

app.use((req, res, next) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.user = req.session.user || null;
  res.locals.isOwner = req.session.user?.role === 'owner';
  next();
});

function validateCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  if (req.is('multipart/form-data')) return next();
  return verifyCsrfToken(req, res, next);
}

function validateMultipartCsrf(req, res, next) {
  return verifyCsrfToken(req, res, next);
}

function verifyCsrfToken(req, res, next) {
  const submittedToken = req.body && req.body._csrf;
  const expectedToken = req.session.csrfToken;
  const rejectRequest = () => {
    const respond = () => res.status(403).send('Permintaan ditolak. Muat ulang halaman lalu coba kembali.');
    if (!req.file) return respond();
    fs.unlink(req.file.path, (error) => {
      if (error) return next(error);
      respond();
    });
  };
  if (typeof submittedToken !== 'string' || typeof expectedToken !== 'string') {
    return rejectRequest();
  }
  const submitted = Buffer.from(submittedToken);
  const expected = Buffer.from(expectedToken);
  if (submitted.length !== expected.length || !crypto.timingSafeEqual(submitted, expected)) {
    return rejectRequest();
  }
  next();
}

async function validateEvidenceUpload(req, res, next) {
  if (!req.file) return next();
  const type = evidenceTypes[req.file.mimetype];
  let fileHandle;
  try {
    fileHandle = await fs.promises.open(req.file.path, 'r');
    const signature = Buffer.alloc(12);
    const { bytesRead } = await fileHandle.read(signature, 0, signature.length, 0);
    if (!type.signature(signature.subarray(0, bytesRead))) {
      await fileHandle.close();
      fileHandle = null;
      await fs.promises.unlink(req.file.path);
      return res.status(415).send('Format bukti tidak valid. Unggah file JPEG, PNG, WebP, atau PDF yang sesuai.');
    }
    await fs.promises.chmod(req.file.path, 0o600);
    await fileHandle.close();
    fileHandle = null;
    next();
  } catch (error) {
    if (fileHandle) await fileHandle.close();
    await fs.promises.unlink(req.file.path).catch(() => {});
    next(error);
  }
}

async function rejectUploadedInput(req, res, status, message) {
  if (req.file) {
    try {
      await fs.promises.unlink(req.file.path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return res.status(status).send(message);
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).render('login', {
    error: 'Terlalu banyak percobaan masuk. Tunggu 15 menit lalu coba kembali.'
  })
});

app.use(validateCsrf);

app.get('/uploads/:filename', requireAuth, (req, res, next) => {
  const isNewUpload = /^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/i.test(req.params.filename);
  const isLegacyUpload = /^[0-9]{13}-[^<>:"/\\|?*\x00-\x1f]{1,180}\.(jpg|jpeg|png|webp|pdf)$/i.test(req.params.filename);
  if (!isNewUpload && !isLegacyUpload) {
    return res.sendStatus(404);
  }
  res.set('Cache-Control', 'private, no-store');
  res.sendFile(path.join(uploadsDir, req.params.filename), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', loginLimiter, (req, res, next) => {
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 256) {
    return res.status(401).render('login', { error: 'Username atau password tidak valid.' });
  }
  const user = getOne('SELECT * FROM users WHERE username = ?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { error: 'Username atau password tidak valid.' });
  }
  if (user.admin_id) {
    const admin = getOne('SELECT active FROM admins WHERE id = ?', [user.admin_id]);
    if (!admin || Number(admin.active) !== 1) {
      return res.status(401).render('login', { error: 'Akun admin ini sudah dinonaktifkan.' });
    }
  }

  req.session.regenerate((error) => {
    if (error) return next(error);
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      admin_id: user.admin_id,
      passwordHash: user.password_hash
    };
    req.session.save((saveError) => {
      if (saveError) return next(saveError);
      res.redirect('/dashboard');
    });
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', requireAuth, (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', requireAuth, async (req, res) => {
  const dashboard = await getDashboardData(req);
  res.render('dashboard', {
    dashboard,
    adminOptions: getAdminOptions(),
    user: req.session.user,
    pageTitle: 'Dashboard'
  });
});

app.get('/performance', requireAuth, (req, res) => res.redirect(`/assessments${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`));
app.get('/audit', requireAuth, (req, res) => res.redirect(`/assessments${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`));

app.get('/assessments', requireAuth, (req, res) => {
  const filters = getFilters(req);
  const adminOptions = getAdminOptions();
  const requestedAdminId = filters.adminId || String(adminOptions[0]?.id || '');
  const assessmentData = requestedAdminId
    ? getAssessmentPageData(requestedAdminId, filters.month, filters.year)
    : null;
  res.render('performance', {
    assessmentData,
    filters,
    adminOptions,
    user: req.session.user,
    pageTitle: 'Penilaian Kinerja Admin'
  });
});

app.post('/assessments/save', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const adminId = Number(req.body.admin_id);
  const jobdeskId = Number(req.body.jobdesk_id);
  const assessedOn = req.body.assessed_on;
  const status = req.body.status;
  const note = String(req.body.note || '').trim();
  if (!Number.isInteger(adminId) || !Number.isInteger(jobdeskId) ||
      !isValidDate(assessedOn) || assessedOn > formatLocalDate() ||
      !['Selesai', 'Belum Selesai'].includes(status) || note.length > 2000) {
    return res.status(400).json({ error: 'Data penilaian tidak valid. Periksa kembali status, tanggal, dan catatan.' });
  }
  const jobdesk = getOne('SELECT * FROM jobdesks WHERE id = ? AND admin_id = ?', [jobdeskId, adminId]);
  const employee = getOne('SELECT id, name, active FROM admins WHERE id = ?', [adminId]);
  if (!jobdesk || !employee || Number(employee.active) !== 1 || !isJobdeskEffectiveOn(jobdesk, assessedOn)) {
    return res.status(404).json({ error: 'Admin atau KPI tidak aktif pada tanggal penilaian tersebut.' });
  }
  const periodType = ['daily', 'weekly', 'monthly'].includes(jobdesk.schedule_type) ? jobdesk.schedule_type : 'daily';
  const periodKey = getAssessmentPeriodKey(periodType, assessedOn);
  const actor = req.session.user.full_name;
  let assessmentId;
  let unchanged = false;
  let oldStatus = null;
  try {
    runTransaction(() => {
      const current = getOne(`
        SELECT * FROM performance_assessments
        WHERE jobdesk_id = ? AND period_key = ?
        ORDER BY id DESC LIMIT 1
      `, [jobdeskId, periodKey]);
      oldStatus = current?.status || null;
      if (current && current.status === status && (current.note || '') === note && current.assessed_on === assessedOn) {
        assessmentId = Number(current.id);
        unchanged = true;
        return;
      }
      if (current) {
        assessmentId = Number(current.id);
        db.run(`
          UPDATE performance_assessments
          SET assessed_on = ?, status = ?, note = ?, employee_name_snapshot = ?,
              jobdesk_name_snapshot = ?, target_value_snapshot = ?, weight_snapshot = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [assessedOn, status, note, employee.name, jobdesk.name, Number(jobdesk.target_value || 0), Number(jobdesk.weight || 0), assessmentId]);
      } else {
        db.run(`
          INSERT INTO performance_assessments
            (admin_id, jobdesk_id, period_key, period_type, assessed_on, status, note,
             employee_name_snapshot, jobdesk_name_snapshot, target_value_snapshot, weight_snapshot, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [adminId, jobdeskId, periodKey, periodType, assessedOn, status, note, employee.name, jobdesk.name,
          Number(jobdesk.target_value || 0), Number(jobdesk.weight || 0), actor]);
        assessmentId = Number(getOne('SELECT last_insert_rowid() AS id').id);
      }
      insertAssessmentHistory({
        assessmentId, adminId, jobdeskId, assessedOn, actor, oldStatus, newStatus: status, note
      });
      insertChangeHistory(
        'assessment',
        adminId,
        `${jobdesk.name} (${assessedOn}): ${oldStatus || 'Belum dinilai'} → ${status}`,
        actor
      );
    });
  } catch (error) {
    console.error('Failed to save KPI assessment:', error);
    return res.status(500).json({ error: 'Penilaian gagal disimpan. Coba lagi.' });
  }
  res.json({ success: true, assessmentId, periodKey, status, note, assessedOn, unchanged });
});

const saveAuditHandler = (req, res) => {
  const adminId = Number(req.body.admin_id);
  const jobdeskId = req.body.jobdesk_id ? Number(req.body.jobdesk_id) : null;
  const auditDate = req.body.audit_date;
  const taskName = String(req.body.task_name || '').trim();
  if (!Number.isInteger(adminId) || !isValidDate(auditDate) || auditDate > formatLocalDate() || !taskName || taskName.length > 200) {
    return rejectUploadedInput(req, res, 400, 'Data audit tidak valid. Periksa admin, tanggal, dan nama pekerjaan.');
  }
  if (req.body.jobdesk_id && (!Number.isInteger(jobdeskId) || jobdeskId < 1)) {
    return rejectUploadedInput(req, res, 400, 'KPI terkait tidak valid.');
  }
  const employee = getOne('SELECT id, active FROM admins WHERE id = ?', [adminId]);
  if (!employee || Number(employee.active) !== 1) return rejectUploadedInput(req, res, 400, 'Pilih admin yang masih aktif.');
  if (jobdeskId && !getOne('SELECT id FROM jobdesks WHERE id = ? AND admin_id = ?', [jobdeskId, adminId])) {
    return rejectUploadedInput(req, res, 400, 'KPI tidak sesuai dengan admin yang dipilih.');
  }
  const evidencePath = req.file ? `/uploads/${req.file.filename}` : '';
  const actor = req.session.user.full_name;
  runTransaction(() => {
    db.run(`INSERT INTO audit_records
      (admin_id, jobdesk_id, audit_date, task_name, inspection_result, sop_match, evidence_path,
       findings, recommendation, auditor, follow_up_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      adminId, jobdeskId, auditDate, taskName,
      String(req.body.inspection_result || '').slice(0, 1000),
      String(req.body.sop_match || '').slice(0, 100),
      evidencePath,
      String(req.body.findings || '').slice(0, 1000),
      String(req.body.recommendation || '').slice(0, 1000),
      String(req.body.auditor || actor).slice(0, 100),
      String(req.body.follow_up_status || 'Menunggu Pemeriksaan').slice(0, 100)
    ]);
    insertChangeHistory('audit', adminId, `Audit ${taskName} pada ${auditDate}`, actor);
  });
  res.redirect(`/assessments?adminId=${adminId}&month=${Number(auditDate.slice(5, 7))}&year=${auditDate.slice(0, 4)}#audit-history`);
};

app.post('/assessments/audit', requireAuth, requireRole(['owner', 'admin']),
  upload.single('evidence'), validateMultipartCsrf, validateEvidenceUpload, saveAuditHandler);
app.post('/audit/save', requireAuth, requireRole(['owner', 'admin']),
  upload.single('evidence'), validateMultipartCsrf, validateEvidenceUpload, saveAuditHandler);

app.get('/performance/new', requireAuth, (req, res) => res.redirect('/assessments'));
app.get('/performance/:id/edit', requireAuth, (req, res) => res.redirect('/assessments'));
app.get('/performance/:id/detail', requireAuth, (req, res) => res.redirect('/assessments'));

app.get('/admins', requireAuth, (req, res) => {
  const admins = getAll('SELECT * FROM admins ORDER BY id');
  const result = admins.map((admin) => {
    const summary = getOne(`
      SELECT COUNT(*) AS total_tasks,
             SUM(CASE WHEN status = 'Selesai' THEN 1 ELSE 0 END) AS completed,
             ROUND(AVG(CASE WHEN status = 'Selesai' THEN 100 ELSE 0 END), 1) AS avg_kpi
      FROM performance_assessments
      WHERE admin_id = ?
    `, [admin.id]);
    const jobdeskCount = getOne('SELECT COUNT(*) AS count FROM jobdesks WHERE admin_id = ? AND is_active = 1', [admin.id]);
    const hasRelatedData = getOne(`
      SELECT 1 AS found FROM performance_assessments WHERE admin_id = ?
      UNION ALL SELECT 1 FROM assessment_history WHERE admin_id = ?
      UNION ALL SELECT 1 FROM audit_records WHERE admin_id = ?
      UNION ALL SELECT 1 FROM revenue_entries WHERE admin_id = ?
      UNION ALL SELECT 1 FROM work_entries WHERE admin_id = ?
      UNION ALL SELECT 1 FROM users WHERE admin_id = ?
      LIMIT 1
    `, [admin.id, admin.id, admin.id, admin.id, admin.id, admin.id]);
    return {
      ...admin,
      ...(summary || { total_tasks: 0, completed: 0, avg_kpi: 0 }),
      jobdesk_count: Number(jobdeskCount.count || 0),
      can_delete: !hasRelatedData
    };
  });

  res.render('admins', {
    admins: result,
    user: req.session.user,
    pageTitle: 'Data Karyawan',
    canManageAdmins: true
  });
});

app.get('/admin/:id/edit', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const admin = getOne('SELECT * FROM admins WHERE id = ?', [Number(req.params.id)]);
  if (!admin) return res.status(404).send('Data admin tidak ditemukan.');
  res.render('admin-form', { admin, user: req.session.user, pageTitle: `Edit ${admin.name}`, formAction: `/admin/${admin.id}/edit` });
});

app.get('/admin/new', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  res.render('admin-form', { admin: null, user: req.session.user, pageTitle: 'Tambah Karyawan', formAction: '/admin' });
});

app.post('/admin', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const name = String(req.body.name || '').trim();
  const position = String(req.body.position || '').trim();
  const department = String(req.body.department || '').trim();
  if (!name || name.length > 120 || position.length > 120 || department.length > 120) {
    return res.status(400).send('Nama wajib diisi dan setiap kolom maksimal 120 karakter.');
  }
  runTransaction(() => {
    db.run('INSERT INTO admins (name, position, department) VALUES (?, ?, ?)', [name, position || null, department || null]);
    const employee = getOne('SELECT last_insert_rowid() AS id');
    insertChangeHistory('admins', employee.id, `Menambahkan karyawan ${name}`, req.session.user.full_name);
  });
  res.redirect('/admins');
});

app.post('/admin/:id/edit', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const adminId = Number(req.params.id);
  const currentAdmin = getOne('SELECT * FROM admins WHERE id = ?', [adminId]);
  if (!currentAdmin) return res.status(404).send('Data admin tidak ditemukan.');

  const name = String(req.body.name || '').trim();
  const position = String(req.body.position || '').trim();
  const department = String(req.body.department || '').trim();
  if (!name || name.length > 120 || position.length > 120 || department.length > 120) {
    return res.status(400).send('Nama wajib diisi dan setiap kolom maksimal 120 karakter.');
  }
  runTransaction(() => {
    db.run('UPDATE admins SET name = ?, position = ?, department = ? WHERE id = ?', [name, position || null, department || null, adminId]);
    db.run('UPDATE users SET full_name = ? WHERE admin_id = ?', [name, adminId]);
    insertChangeHistory('admins', adminId, `Memperbarui profil ${currentAdmin.name} menjadi ${name}`, req.session.user.full_name);
  });
  res.redirect('/admins');
});

app.post('/admin/:id/status', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const adminId = Number(req.params.id);
  const admin = getOne('SELECT id, name, active FROM admins WHERE id = ?', [adminId]);
  if (!admin) return res.status(404).send('Data admin tidak ditemukan.');

  const nextActive = Number(admin.active) === 1 ? 0 : 1;
  runTransaction(() => {
    db.run('UPDATE admins SET active = ? WHERE id = ?', [nextActive, adminId]);
    insertChangeHistory('admins', adminId, `${nextActive ? 'Mengaktifkan kembali' : 'Menonaktifkan'} ${admin.name}`, req.session.user.full_name);
  });
  res.redirect('/admins');
});

app.post('/admin/:id/delete', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const adminId = Number(req.params.id);
  const admin = getOne('SELECT id, name FROM admins WHERE id = ?', [adminId]);
  if (!admin) return res.status(404).send('Data karyawan tidak ditemukan.');
  const hasRelatedData = getOne(`
    SELECT 1 AS found FROM performance_assessments WHERE admin_id = ?
    UNION ALL SELECT 1 FROM assessment_history WHERE admin_id = ?
    UNION ALL SELECT 1 FROM audit_records WHERE admin_id = ?
    UNION ALL SELECT 1 FROM revenue_entries WHERE admin_id = ?
    UNION ALL SELECT 1 FROM work_entries WHERE admin_id = ?
    UNION ALL SELECT 1 FROM users WHERE admin_id = ?
    LIMIT 1
  `, [adminId, adminId, adminId, adminId, adminId, adminId]);
  if (hasRelatedData) return res.status(409).send('Karyawan memiliki data terkait. Nonaktifkan karyawan agar riwayat tetap terjaga.');
  runTransaction(() => {
    insertChangeHistory('admins', adminId, `Menghapus karyawan ${admin.name}`, req.session.user.full_name);
    db.run('DELETE FROM jobdesks WHERE admin_id = ?', [adminId]);
    db.run('DELETE FROM admins WHERE id = ?', [adminId]);
  });
  res.redirect('/admins');
});

app.get('/admin/:id', requireAuth, (req, res) => {
  const adminId = Number(req.params.id);
  const admin = getOne('SELECT * FROM admins WHERE id = ?', [adminId]);
  if (!admin) return res.redirect('/admins');

  const entries = getAll(`
    SELECT we.*, jd.name AS job_name
    FROM work_entries we
    JOIN jobdesks jd ON jd.id = we.jobdesk_id
    WHERE we.admin_id = ?
    ORDER BY we.entry_date DESC
  `, [adminId]);

  res.render('admin-detail', { admin, entries, user: req.session.user, pageTitle: `Kinerja ${admin.name}` });
});

app.get('/reports', requireAuth, (req, res) => {
  const filters = getFilters(req);
  const report = getMonthlyReportData(filters.month, filters.year, filters.adminId, filters.unitId);
  const units = getAll('SELECT id, name FROM device_units WHERE active = 1 ORDER BY name');
  const editRevenueId = /^\d+$/.test(String(req.query.editRevenueId || '')) ? Number(req.query.editRevenueId) : 0;
  const revenueToEdit = editRevenueId
    ? getOne('SELECT * FROM revenue_entries WHERE id = ?', [editRevenueId])
    : null;
  res.render('reports', {
    report,
    filters,
    adminOptions: getAdminOptions(),
    units,
    revenueToEdit,
    requestKey: crypto.randomUUID(),
    notice: String(req.query.notice || ''),
    user: req.session.user,
    pageTitle: 'Laporan Bulanan'
  });
});

app.post('/revenue/save', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const entryId = req.body.id ? Number(req.body.id) : 0;
  const adminId = Number(req.body.admin_id);
  const entryDate = req.body.entry_date;
  const unitName = String(req.body.unit_name || '').trim();
  const transactionCount = Number(req.body.transaction_count || 0);
  const amount = Number(req.body.amount_rupiah);
  const note = String(req.body.note || '').trim();
  if (!Number.isInteger(adminId) || !getOne('SELECT id FROM admins WHERE id = ? AND active = 1', [adminId]) ||
      !isValidDate(entryDate) || entryDate > formatLocalDate() ||
      !unitName || unitName.length > 100 ||
      !Number.isSafeInteger(transactionCount) || transactionCount < 0 ||
      !Number.isSafeInteger(amount) || amount < 0 || note.length > 1000) {
    return res.status(400).send('Data omset tidak valid. Periksa tanggal, karyawan, unit, transaksi, nominal, dan catatan.');
  }
  const existing = entryId ? getOne('SELECT * FROM revenue_entries WHERE id = ?', [entryId]) : null;
  if (entryId && !existing) return res.status(404).send('Catatan omset tidak ditemukan.');
  const requestKey = String(req.body.request_key || '');
  if (!entryId && !/^[0-9a-f-]{36}$/i.test(requestKey)) {
    return res.status(400).send('Kunci pencatatan omset tidak valid. Muat ulang halaman lalu coba kembali.');
  }
  if (!entryId && getOne('SELECT id FROM revenue_entries WHERE request_key = ?', [requestKey])) {
    return res.redirect(`/reports?month=${Number(entryDate.slice(5, 7))}&year=${entryDate.slice(0, 4)}&adminId=${adminId}&notice=revenueSaved#revenue`);
  }

  runTransaction(() => {
    db.run('INSERT OR IGNORE INTO device_units (name) VALUES (?)', [unitName]);
    const unit = getOne('SELECT id FROM device_units WHERE name = ? COLLATE NOCASE', [unitName]);
    if (entryId) {
      db.run(`UPDATE revenue_entries
        SET admin_id = ?, unit_id = ?, entry_date = ?, transaction_count = ?, amount_rupiah = ?, note = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`, [adminId, unit.id, entryDate, transactionCount, amount, note || null, entryId]);
      insertChangeHistory('revenue', adminId, `Memperbarui omset unit ${unitName} pada ${entryDate}`, req.session.user.full_name);
    } else {
      db.run(`INSERT INTO revenue_entries
        (request_key, admin_id, unit_id, entry_date, transaction_count, amount_rupiah, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        requestKey, adminId, unit.id, entryDate, transactionCount, amount, note || null, req.session.user.full_name
      ]);
      insertChangeHistory('revenue', adminId, `Mencatat omset unit ${unitName} pada ${entryDate}`, req.session.user.full_name);
    }
  });
  res.redirect(`/reports?month=${Number(entryDate.slice(5, 7))}&year=${entryDate.slice(0, 4)}&adminId=${adminId}&notice=revenueSaved#revenue`);
});

app.post('/revenue/:id/delete', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const id = Number(req.params.id);
  const entry = getOne(`
    SELECT re.id, re.admin_id, re.entry_date, re.amount_rupiah, du.name AS unit_name
    FROM revenue_entries re JOIN device_units du ON du.id = re.unit_id WHERE re.id = ?
  `, [id]);
  if (!entry) return res.status(404).send('Catatan omset tidak ditemukan.');
  runTransaction(() => {
    insertChangeHistory('revenue', entry.admin_id, `Menghapus catatan omset unit ${entry.unit_name} pada ${entry.entry_date}`, req.session.user.full_name);
    db.run('DELETE FROM revenue_entries WHERE id = ?', [id]);
  });
  res.redirect(`/reports?month=${Number(entry.entry_date.slice(5, 7))}&year=${entry.entry_date.slice(0, 4)}&adminId=${entry.admin_id}#revenue`);
});

app.get('/reports/export/pdf', requireAuth, (req, res, next) => {
  try {
    const filters = getFilters(req);
    const report = getMonthlyReportData(filters.month, filters.year, filters.adminId, filters.unitId);
    const doc = new PDFDocument({ margin: 42, size: 'A4' });
    const fileName = `laporan-apms-${filters.year}-${String(filters.month).padStart(2, '0')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    doc.on('error', next);
    doc.pipe(res);
    doc.fontSize(18).text('Laporan Kinerja Bulanan', { align: 'center' });
    doc.moveDown(0.35).fontSize(10).text(`Periode: ${String(filters.month).padStart(2, '0')}/${filters.year}`);
    doc.text(`Dibuat: ${formatLocalDate()}`);
    doc.moveDown().fontSize(12).text('Ringkasan Kinerja');
    doc.fontSize(9).text('Karyawan | Wajib | Selesai | Belum selesai | Pencapaian | Omset | Temuan audit | Kesimpulan');
    doc.moveDown(0.3);
    for (const row of report.summaries) {
      doc.text(`${row.name} | ${row.required} | ${row.completed} | ${row.incomplete + row.unassessed} | ${row.percent}% | Rp ${Number(row.total_revenue).toLocaleString('id-ID')} | ${row.findings} | ${row.conclusion}`);
    }
    doc.moveDown().fontSize(12).text('Detail Penilaian');
    doc.fontSize(9);
    for (const item of report.kpi.obligations) {
      doc.text(`${item.due_date} | ${item.admin_name} | ${item.job_name} | ${item.status || 'Belum dinilai'}${item.note ? ` | ${item.note}` : ''}`);
      if (doc.y > 745) doc.addPage();
    }
    doc.moveDown().fontSize(12).text('Rekap Omset per Unit');
    doc.fontSize(9);
    for (const item of report.byUnit) doc.text(`${item.name}: Rp ${Number(item.amount).toLocaleString('id-ID')}`);
    doc.moveDown().fontSize(12).text('Omset Mingguan');
    doc.fontSize(9);
    for (const item of report.revenue.byWeek) doc.text(`${item[0].replace('weekly:', '')}: Rp ${Number(item[1]).toLocaleString('id-ID')}`);
    doc.end();
  } catch (error) {
    next(error);
  }
});

app.get('/reports/export/excel', requireAuth, (req, res, next) => {
  try {
    const filters = getFilters(req);
    const report = getMonthlyReportData(filters.month, filters.year, filters.adminId, filters.unitId);
    const workbook = XLSX.utils.book_new();
    const sheetFromRows = (rows, headers) =>
      rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([headers]);
    const summaryRows = report.summaries.map((row) => ({
      'ID Admin': row.admin_id,
      Karyawan: row.name,
      'Total KPI Wajib': row.required,
      Selesai: row.completed,
      'Belum Selesai': row.incomplete + row.unassessed,
      'Belum Dinilai': row.unassessed,
      'Pencapaian (%)': row.percent,
      'Total Omset (Rp)': row.total_revenue,
      'Jumlah Audit': row.audit_count,
      'Temuan Audit': row.findings,
      Kesimpulan: row.conclusion
    })).map(sanitizeExportRow);
    const assessmentRows = report.kpi.obligations.map((item) => ({
      'ID Admin': item.admin_id,
      Tanggal: item.due_date,
      'Tanggal Penilaian': item.assessed_on || '',
      Karyawan: item.admin_name,
      'KPI / Jobdesk': item.job_name,
      Frekuensi: item.period_type,
      Status: item.status || 'Belum dinilai',
      Catatan: item.note
    })).map(sanitizeExportRow);
    const revenueRows = report.revenue.entries.map((item) => ({
      Tanggal: item.entry_date,
      Karyawan: item.admin_name,
      Unit: item.unit_name,
      Transaksi: Number(item.transaction_count),
      'Omset (Rp)': Number(item.amount_rupiah),
      Catatan: item.note || ''
    })).map(sanitizeExportRow);
    const weeklyRevenueRows = report.revenue.byWeek.map(([week, amount]) => ({
      Pekan: week.replace('weekly:', ''),
      'Total Omset (Rp)': amount
    })).map(sanitizeExportRow);
    XLSX.utils.book_append_sheet(workbook, sheetFromRows(summaryRows, Object.keys(summaryRows[0] || {
      'ID Admin': '', Karyawan: '', 'Total KPI Wajib': '', Selesai: '', 'Belum Selesai': '',
      'Belum Dinilai': '', 'Pencapaian (%)': '', 'Total Omset (Rp)': '', 'Jumlah Audit': '', 'Temuan Audit': '', Kesimpulan: ''
    })), 'Rekap');
    XLSX.utils.book_append_sheet(workbook, sheetFromRows(assessmentRows, Object.keys(assessmentRows[0] || {
      'ID Admin': '', Tanggal: '', 'Tanggal Penilaian': '', Karyawan: '', 'KPI / Jobdesk': '',
      Frekuensi: '', Status: '', Catatan: ''
    })), 'Detail KPI');
    XLSX.utils.book_append_sheet(workbook, sheetFromRows(revenueRows, Object.keys(revenueRows[0] || {
      Tanggal: '', Karyawan: '', Unit: '', Transaksi: '', 'Omset (Rp)': '', Catatan: ''
    })), 'Omset');
    XLSX.utils.book_append_sheet(workbook, sheetFromRows(weeklyRevenueRows, Object.keys(weeklyRevenueRows[0] || {
      Pekan: '', 'Total Omset (Rp)': ''
    })), 'Omset Mingguan');
    const auditRows = getAll(`
      SELECT ar.audit_date AS Tanggal, a.name AS Karyawan, COALESCE(jd.name, ar.task_name) AS Aktivitas,
             ar.follow_up_status AS Status, ar.findings AS Temuan, ar.recommendation AS Rekomendasi
      FROM audit_records ar
      JOIN admins a ON a.id = ar.admin_id
      LEFT JOIN jobdesks jd ON jd.id = ar.jobdesk_id
      WHERE ar.audit_date >= ? AND ar.audit_date <= ?
      ${filters.adminId ? 'AND ar.admin_id = ?' : ''}
      ORDER BY ar.audit_date, ar.id
    `, filters.adminId
      ? [report.kpi.firstDate, report.kpi.lastDate, filters.adminId]
      : [report.kpi.firstDate, report.kpi.lastDate]).map(sanitizeExportRow);
    XLSX.utils.book_append_sheet(workbook, sheetFromRows(auditRows, Object.keys(auditRows[0] || {
      Tanggal: '', Karyawan: '', Aktivitas: '', Status: '', Temuan: '', Rekomendasi: ''
    })), 'Audit');
    for (const summary of report.summaries) {
      if (filters.adminId) break;
      const sheetRows = assessmentRows.filter((row) => Number(row['ID Admin']) === Number(summary.admin_id));
      const shortName = summary.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 22) || 'Admin';
      const sheetName = `${shortName}-${summary.admin_id}`.slice(0, 31);
      XLSX.utils.book_append_sheet(workbook, sheetFromRows(sheetRows, Object.keys(assessmentRows[0] || {
        'ID Admin': '', Tanggal: '', 'Tanggal Penilaian': '', Karyawan: '', 'KPI / Jobdesk': '',
        Frekuensi: '', Status: '', Catatan: ''
      })), sheetName);
    }
    const fileName = `laporan-apms-${filters.year}-${String(filters.month).padStart(2, '0')}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })));
  } catch (error) {
    next(error);
  }
});

app.get('/jobdesk', requireAuth, (req, res) => {
  const selectedAdminId = /^\d+$/.test(String(req.query.adminId || '')) ? String(req.query.adminId) : '';
  const jobdesks = getAll(`
    SELECT jd.*, a.name AS admin_name
    FROM jobdesks jd
    JOIN admins a ON a.id = jd.admin_id
    ${selectedAdminId ? 'WHERE jd.admin_id = ?' : ''}
    ORDER BY jd.admin_id, jd.sort_order, jd.id
  `, selectedAdminId ? [selectedAdminId] : []);
  const editId = /^\d+$/.test(String(req.query.edit || '')) ? Number(req.query.edit) : 0;
  const editJobdesk = editId ? getOne('SELECT * FROM jobdesks WHERE id = ?', [editId]) : null;
  res.render('jobdesk', {
    jobdesks,
    adminOptions: getAdminOptions(),
    selectedAdminId,
    editJobdesk,
    canManage: ['owner', 'admin'].includes(req.session.user.role),
    user: req.session.user,
    pageTitle: 'Manajemen Jobdesk'
  });
});

app.post('/jobdesk/save', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const id = req.body.id ? Number(req.body.id) : 0;
  const adminId = Number(req.body.admin_id);
  const name = String(req.body.name || '').trim();
  const targetValue = Number(req.body.target_value);
  const weeklyTarget = Number(req.body.weekly_target);
  const monthlyTarget = Number(req.body.monthly_target);
  const weight = Number(req.body.weight);
  const scheduleType = req.body.schedule_type;
  const dueTime = String(req.body.due_time || '');
  if (!Number.isInteger(adminId) || !getOne('SELECT id FROM admins WHERE id = ? AND active = 1', [adminId]) ||
      !name || name.length > 180 || !Number.isFinite(targetValue) || targetValue < 0 ||
      !Number.isFinite(weeklyTarget) || weeklyTarget < 0 || !Number.isFinite(monthlyTarget) || monthlyTarget < 0 ||
      !Number.isInteger(weight) || weight < 0 || weight > 100 ||
      !['daily', 'weekly', 'monthly'].includes(scheduleType) ||
      (dueTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dueTime))) {
    return res.status(400).send('Data KPI tidak valid. Periksa karyawan, target, bobot, frekuensi, dan batas waktu.');
  }
  const current = id ? getOne('SELECT * FROM jobdesks WHERE id = ?', [id]) : null;
  if (id && !current) return res.status(404).send('Jobdesk tidak ditemukan.');
  if (current) {
    const hasHistory = getOne(`
      SELECT 1 AS found FROM performance_assessments WHERE jobdesk_id = ?
      UNION ALL SELECT 1 FROM assessment_history WHERE jobdesk_id = ?
      UNION ALL SELECT 1 FROM audit_records WHERE jobdesk_id = ?
      UNION ALL SELECT 1 FROM work_entries WHERE jobdesk_id = ?
      LIMIT 1
    `, [id, id, id, id]);
    runTransaction(() => {
      if (hasHistory) {
        const effectiveFrom = addDays(formatLocalDate(), 1);
        db.run('UPDATE jobdesks SET is_active = 0, effective_to = ? WHERE id = ?', [effectiveFrom, id]);
        const maxOrder = getOne('SELECT COALESCE(MAX(sort_order), 0) AS value FROM jobdesks WHERE admin_id = ?', [adminId]);
        db.run(`INSERT INTO jobdesks
          (admin_id, name, target_value, weekly_target, monthly_target, weight, schedule_type, due_time, sort_order, effective_from, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, [
          adminId, name, targetValue, weeklyTarget, monthlyTarget, weight, scheduleType, dueTime || null,
          Number(maxOrder.value) + 1, effectiveFrom
        ]);
      } else {
        db.run(`UPDATE jobdesks
          SET admin_id = ?, name = ?, target_value = ?, weekly_target = ?, monthly_target = ?,
              weight = ?, schedule_type = ?, due_time = ?
          WHERE id = ?`, [adminId, name, targetValue, weeklyTarget, monthlyTarget, weight, scheduleType, dueTime || null, id]);
      }
      insertChangeHistory('jobdesk', adminId, `Memperbarui KPI ${current.name} menjadi ${name}`, req.session.user.full_name);
    });
  } else {
    runTransaction(() => {
      const maxOrder = getOne('SELECT COALESCE(MAX(sort_order), 0) AS value FROM jobdesks WHERE admin_id = ?', [adminId]);
      db.run(`INSERT INTO jobdesks
        (admin_id, name, target_value, weekly_target, monthly_target, weight, schedule_type, due_time, sort_order, effective_from)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        adminId, name, targetValue, weeklyTarget, monthlyTarget, weight, scheduleType, dueTime || null,
        Number(maxOrder.value) + 1, formatLocalDate()
      ]);
      insertChangeHistory('jobdesk', adminId, `Menambahkan KPI ${name}`, req.session.user.full_name);
    });
  }
  res.redirect('/jobdesk');
});

app.post('/jobdesk/status/:id', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const jobdeskId = Number(req.params.id);
  const job = getOne('SELECT id, admin_id, name, is_active FROM jobdesks WHERE id = ?', [jobdeskId]);
  if (!job) return res.status(404).send('Jobdesk tidak ditemukan.');
  const nextActive = Number(job.is_active) === 1 ? 0 : 1;
  runTransaction(() => {
    const hasHistory = getOne(`
      SELECT 1 AS found FROM performance_assessments WHERE jobdesk_id = ?
      UNION ALL SELECT 1 FROM assessment_history WHERE jobdesk_id = ?
      UNION ALL SELECT 1 FROM audit_records WHERE jobdesk_id = ?
      UNION ALL SELECT 1 FROM work_entries WHERE jobdesk_id = ?
      LIMIT 1
    `, [jobdeskId, jobdeskId, jobdeskId, jobdeskId]);
    if (!nextActive) {
      db.run('UPDATE jobdesks SET is_active = 0, effective_to = ? WHERE id = ?', [addDays(formatLocalDate(), 1), jobdeskId]);
    } else if (hasHistory) {
      const maxOrder = getOne('SELECT COALESCE(MAX(sort_order), 0) AS value FROM jobdesks WHERE admin_id = ?', [job.admin_id]);
      db.run('INSERT INTO jobdesks (admin_id, name, target_value, weekly_target, monthly_target, weight, schedule_type, schedule_days, due_time, is_active, sort_order, effective_from) SELECT admin_id, name, target_value, weekly_target, monthly_target, weight, schedule_type, schedule_days, due_time, 1, ?, ? FROM jobdesks WHERE id = ?', [
        Number(maxOrder.value) + 1, addDays(formatLocalDate(), 1), jobdeskId
      ]);
    } else {
      db.run('UPDATE jobdesks SET is_active = 1, effective_to = NULL, effective_from = ? WHERE id = ?', [addDays(formatLocalDate(), 1), jobdeskId]);
    }
    insertChangeHistory('jobdesk', job.admin_id, `${nextActive ? 'Mengaktifkan' : 'Menonaktifkan'} KPI ${job.name}`, req.session.user.full_name);
  });
  res.redirect('/jobdesk');
});

app.post('/jobdesk/reorder/:id', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const jobdeskId = Number(req.params.id);
  const direction = req.body.direction;
  if (!['up', 'down'].includes(direction)) return res.status(400).send('Arah pengurutan tidak valid.');
  const job = getOne('SELECT id, admin_id FROM jobdesks WHERE id = ?', [jobdeskId]);
  if (!job) return res.status(404).send('Jobdesk tidak ditemukan.');
  const siblings = getAll('SELECT id FROM jobdesks WHERE admin_id = ? ORDER BY sort_order, id', [job.admin_id]);
  const index = siblings.findIndex((item) => Number(item.id) === jobdeskId);
  const otherIndex = index + (direction === 'up' ? -1 : 1);
  if (otherIndex >= 0 && otherIndex < siblings.length) {
    [siblings[index], siblings[otherIndex]] = [siblings[otherIndex], siblings[index]];
    runTransaction(() => {
      siblings.forEach((item, position) => db.run('UPDATE jobdesks SET sort_order = ? WHERE id = ?', [position + 1, item.id]));
      insertChangeHistory('jobdesk', job.admin_id, 'Mengubah urutan KPI', req.session.user.full_name);
    });
  }
  res.redirect('/jobdesk');
});

app.post('/jobdesk/delete/:id', requireAuth, requireRole(['owner', 'admin']), (req, res) => {
  const id = Number(req.params.id);
  const job = getOne('SELECT id, admin_id, name FROM jobdesks WHERE id = ?', [id]);
  if (!job) return res.status(404).send('Jobdesk tidak ditemukan.');
  const hasHistory = getOne(`
    SELECT 1 AS found FROM performance_assessments WHERE jobdesk_id = ?
    UNION ALL SELECT 1 FROM assessment_history WHERE jobdesk_id = ?
    UNION ALL SELECT 1 FROM audit_records WHERE jobdesk_id = ?
    UNION ALL SELECT 1 FROM work_entries WHERE jobdesk_id = ?
    LIMIT 1
  `, [id, id, id, id]);
  if (hasHistory) {
    runTransaction(() => {
      db.run('UPDATE jobdesks SET is_active = 0, effective_to = ? WHERE id = ?', [addDays(formatLocalDate(), 1), id]);
      insertChangeHistory('jobdesk', job.admin_id, `Menonaktifkan KPI ${job.name} karena memiliki riwayat`, req.session.user.full_name);
    });
  } else {
    runTransaction(() => {
      insertChangeHistory('jobdesk', job.admin_id, `Menghapus KPI ${job.name}`, req.session.user.full_name);
      db.run('DELETE FROM jobdesks WHERE id = ?', [id]);
    });
  }
  res.redirect('/jobdesk');
});

app.get('/history', requireAuth, (req, res) => {
  const history = getAll(`
    SELECT ch.*, a.name AS admin_name
    FROM change_history ch
    LEFT JOIN admins a ON a.id = ch.admin_id
    ORDER BY ch.changed_at DESC
  `);
  res.render('history', { history, user: req.session.user, pageTitle: 'Riwayat Perubahan' });
});

function renderSettings(req, res, status = 200) {
  const googleConfig = getOne('SELECT value_text FROM settings WHERE key_name = ?', ['google_sheets_configured']);
  const adminAccount = req.session.user.role === 'owner'
    ? getOne("SELECT id, username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
    : null;
  const messages = {
    passwordUpdated: 'Sandi akun Anda berhasil diperbarui.',
    adminPasswordUpdated: 'Sandi akun admin berhasil direset.',
    currentPasswordInvalid: 'Sandi saat ini tidak sesuai.',
    passwordTooShort: 'Sandi baru minimal 12 karakter.',
    passwordConfirmationMismatch: 'Konfirmasi sandi tidak sama.',
    adminAccountMissing: 'Akun admin tidak ditemukan.'
  };
  const notice = messages[req.query.notice] || '';
  res.status(status).render('settings', {
    googleConfig: googleConfig ? googleConfig.value_text : 'false',
    adminAccount,
    notice,
    noticeIsError: ['currentPasswordInvalid', 'passwordTooShort', 'passwordConfirmationMismatch', 'adminAccountMissing'].includes(req.query.notice),
    user: req.session.user,
    pageTitle: 'Pengaturan Akun'
  });
}

app.get('/settings', requireAuth, (req, res) => {
  renderSettings(req, res);
});

app.post('/settings/password', requireAuth, (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  const account = getOne('SELECT password_hash FROM users WHERE id = ?', [req.session.user.id]);
  if (!account || !bcrypt.compareSync(String(current_password || ''), account.password_hash)) {
    return res.redirect('/settings?notice=currentPasswordInvalid');
  }
  if (typeof new_password !== 'string' || new_password.length < 12) {
    return res.redirect('/settings?notice=passwordTooShort');
  }
  if (new_password !== confirm_password) {
    return res.redirect('/settings?notice=passwordConfirmationMismatch');
  }
  const passwordHash = bcrypt.hashSync(new_password, 12);
  execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.session.user.id]);
  req.session.user.passwordHash = passwordHash;
  res.redirect('/settings?notice=passwordUpdated');
});

app.post('/settings/admin-password', requireAuth, requireRole(['owner']), (req, res) => {
  const { new_password, confirm_password } = req.body;
  const adminAccount = getOne("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (!adminAccount) return res.redirect('/settings?notice=adminAccountMissing');
  if (typeof new_password !== 'string' || new_password.length < 12) {
    return res.redirect('/settings?notice=passwordTooShort');
  }
  if (new_password !== confirm_password) {
    return res.redirect('/settings?notice=passwordConfirmationMismatch');
  }
  const passwordHash = bcrypt.hashSync(new_password, 12);
  execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, adminAccount.id]);
  res.redirect('/settings?notice=adminPasswordUpdated');
});

app.get('/export', requireAuth, (req, res) => res.redirect('/reports'));
app.get('/export/excel', requireAuth, (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(`/reports/export/excel${query}`);
});
app.get('/export/csv', requireAuth, (req, res) => {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(`/reports/export/excel${query}`);
});

app.post('/settings/google', requireAuth, requireRole(['owner']), (req, res) => {
  const value = req.body.google_enabled || 'false';
  const existing = getOne('SELECT id FROM settings WHERE key_name = ?', ['google_sheets_configured']);
  if (existing) {
    execute('UPDATE settings SET value_text = ? WHERE key_name = ?', [value, 'google_sheets_configured']);
  } else {
    execute('INSERT INTO settings (key_name, value_text) VALUES (?, ?)', ['google_sheets_configured', value]);
  }
  res.redirect('/settings');
});

function sanitizeExportRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) {
      return [key, `'${value}`];
    }
    return [key, value];
  }));
}

app.use((error, req, res, next) => {
  if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  if (error.status === 415) {
    return res.status(415).send('Format bukti tidak didukung. Gunakan JPEG, PNG, WebP, atau PDF.');
  }
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 415;
    return res.status(status).send(status === 413
      ? 'File bukti terlalu besar. Batas ukuran adalah 5 MB.'
      : 'Format bukti tidak didukung. Gunakan JPEG, PNG, WebP, atau PDF.');
  }
  console.error('Request failed:', error);
  res.status(500).send('Terjadi kesalahan internal. Silakan coba kembali.');
});

openDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Admin Performance Management System running on http://localhost:${PORT}`);
  });
}).catch((error) => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});
