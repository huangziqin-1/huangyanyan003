// 核心常量：标准时段
const TIME_WINDOWS = {
  morning: { start: '08:30', end: '12:00', hours: 3.5 },
  afternoon: { start: '13:30', end: '17:30', hours: 4.0 },
  night: { start: '18:00', end: '22:00', hours: 4.0 },
};

const MEAL_RULES = {
  lunch: { threshold: 8, amount: 15 },
  snack: { threshold: 4, amount: 10 },
};

// 工具: 时间字符串与Date互转(仅当日)
function toDate(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function toTimeStr(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function parseTime(timeStr) {
  // 允许 "8:30" / "08:30" / "8:30:00"
  const parts = timeStr.trim().split(':').map(Number);
  const hh = parts[0];
  const mm = parts[1] || 0;
  return { hh, mm };
}

function minutesBetween(a, b) {
  return Math.max(0, (b - a) / (1000 * 60));
}

function overlapMinutes(dateStr, actualStart, actualEnd, winStartStr, winEndStr) {
  const winStart = toDate(dateStr, winStartStr);
  const winEnd = toDate(dateStr, winEndStr);
  const start = new Date(Math.max(actualStart.getTime(), winStart.getTime()));
  const end = new Date(Math.min(actualEnd.getTime(), winEnd.getTime()));
  const mins = minutesBetween(start, end);
  return Math.max(0, mins);
}

// 解析Excel：期望列名示例：姓名, 日期(YYYY-MM-DD), 上午上班, 上午下班, 下午上班, 下午下班, 晚班上班, 晚班下班
// 日期可为 2025/08/01 或 2025-08-01，时间可为 8:30 / 08:30
function parseExcelToRows(workbook) {
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows;
}

// 清洗并统一格式
function toHalfWidth(str) {
  if (!str) return '';
  return String(str).replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 0x30))
    .replace(/[\uFF1A]/g, ':') // ：
    .replace(/[\uFF0D]/g, '-') // －
    .replace(/[\uFF5E]/g, '~') // ～
    .replace(/[\uFF0E]/g, '.') // ．
    .replace(/[\u3001\u3002]/g, '.') // 、 。 -> .
    .replace(/[\u2013\u2014]/g, '-') // – — -> -
    .replace(/[\uFF1B]/g, ';');
}
function normalizeTimeRange(v) {
  if (v === null || v === undefined) return null;
  const raw = toHalfWidth(String(v).trim());
  // 兼容 到/至/—/~
  const m = raw.match(/(\d{1,2}[:\.：]?\d{1,2})(?:\s*(?:[\-~–—]|到|至)\s*)(\d{1,2}[:\.：]?\d{1,2})/);
  if (m) {
    const a = normalizeTime(m[1]);
    const b = normalizeTime(m[2]);
    if (a && b) return [a, b];
  }
  return null;
}

// 从任意列中抽取时间片段，自动配对
function extractSegments(row) {
  const segments = [];
  const ins = [];
  const outs = [];
  const times = [];
  const inKey = /(上班|签到|打卡上|上班打卡|开始|in)/i;
  const outKey = /(下班|签退|打卡下|下班打卡|结束|out)/i;

  for (const [key, val] of Object.entries(row)) {
    if (val === null || val === undefined || val === '') continue;
    // 先尝试识别成时间段
    const range = normalizeTimeRange(val);
    if (range) {
      const [a, b] = range;
      if (a && b) { segments.push([a, b]); continue; }
    }
    // 单个时间
    const t = normalizeTime(val);
    if (!t) continue;
    if (inKey.test(String(key))) ins.push(t);
    else if (outKey.test(String(key))) outs.push(t);
    else times.push(t);
  }

  // 根据in/out配对
  const sortAsc = (a, b) => a.localeCompare(b);
  ins.sort(sortAsc); outs.sort(sortAsc); times.sort(sortAsc);

  // 配对相同数量的in/out
  const len = Math.min(ins.length, outs.length);
  for (let i = 0; i < len; i++) {
    if (outs[i] > ins[i]) segments.push([ins[i], outs[i]]);
  }

  // 若无明确in/out，使用时间序列相邻配对
  if (segments.length === 0 && times.length >= 2) {
    for (let i = 0; i + 1 < times.length; i += 2) {
      if (times[i+1] > times[i]) segments.push([times[i], times[i+1]]);
    }
  }
  return segments;
}

function normalizeRow(row) {
  const name = String(row['姓名'] || row['员工'] || row['员工姓名'] || '').trim();
  const dateRaw = (row['日期'] ?? row['打卡日期'] ?? row['出勤日期'] ?? '');

  // 时间字段映射（包含常见别名）
  const fields = {
    morningIn: row['上午上班'] || row['上班(上午)'] || row['上午打卡开始'] || '',
    morningOut: row['上午下班'] || row['下班(上午)'] || row['上午打卡结束'] || '',
    afternoonIn: row['下午上班'] || row['上班(下午)'] || row['下午打卡开始'] || '',
    afternoonOut: row['下午下班'] || row['下班(下午)'] || row['下午打卡结束'] || '',
    nightIn: row['晚班上班'] || row['加班开始'] || row['晚班打卡开始'] || '',
    nightOut: row['晚班下班'] || row['加班结束'] || row['晚班打卡结束'] || '',
    // 通用上/下班（整天）
    genericIn: row['上班时间'] || row['上班'] || row['签到时间'] || row['签到'] || row['第一打卡'] || row['第一次打卡'] || row['打卡开始'] || row['上班打卡'] || row['打卡上班'] || row['考勤开始'] || '',
    genericOut: row['下班时间'] || row['下班'] || row['签退时间'] || row['签退'] || row['最后打卡'] || row['最后一次打卡'] || row['打卡结束'] || row['下班打卡'] || row['打卡下班'] || row['考勤结束'] || '',
  };

  const date = normalizeDate(dateRaw);
  const base = { name, date, ...normalizeTimes(fields) };

  // 扩展：从任意列自动抽取segments
  const segments = extractSegments(row);
  base.segments = segments;

  // 若显示用的上午/下午/晚班时间都为空，但segments存在，填充用于表格展示
  if (segments.length) {
    // 选择一段覆盖到各标准窗口时，回填显示
    for (const [st, en] of segments) {
      // simple backfill: 如果该窗口还未填，且该段与窗口存在顺序上可能的交集，就回填
      if (!base.morningIn && !base.morningOut) { base.morningIn = st; base.morningOut = en; }
      else if (!base.afternoonIn && !base.afternoonOut) { base.afternoonIn = st; base.afternoonOut = en; }
      else if (!base.nightIn && !base.nightOut) { base.nightIn = st; base.nightOut = en; }
    }
  }
  return base;
}

function normalizeDate(s) {
  if (s === null || s === undefined) return '';
  if (typeof s === 'number') {
    const date = XLSX.SSF.parse_date_code(s);
    if (!date) return '';
    const y = date.y;
    const m = String(date.m).padStart(2, '0');
    const d = String(date.d).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const raw0 = String(s).trim();
  const raw = toHalfWidth(raw0);
  // 若是纯数字字符串，也按Excel序列解析
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    const date = XLSX.SSF.parse_date_code(n);
    if (date) {
      const y = date.y;
      const m = String(date.m).padStart(2, '0');
      const d = String(date.d).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  // 兼容 2025年8月1日、2025-8-1、2025/8/1、2025.8.1
  const str = raw.replace(/\./g, '-').replace(/\//g, '-').replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '');
  const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = m[1];
    const mm = String(m[2]).padStart(2, '0');
    const dd = String(m[3]).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }
  return '';
}

function normalizeTimes(fields) {
  const out = {};
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    out[k] = normalizeTime(v);
  }
  return out;
}

function normalizeTime(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    const minutes = Math.round(v * 24 * 60);
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  const raw0 = String(v).trim();
  const raw = toHalfWidth(raw0);
  if (raw === '-' || raw === '--' || raw === '—') return '';
  
  // 处理 "日期 时间" 格式，如 "2025-07-23 07:45:19"
  const dateTimeMatch = raw.match(/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (dateTimeMatch) {
    const hh = String(parseInt(dateTimeMatch[1], 10)).padStart(2, '0');
    const mm = String(parseInt(dateTimeMatch[2], 10)).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  
  // 纯数字/小数视为Excel时间分数（排除0830这种HHmm）
  if (/^\d+(?:\.\d+)?$/.test(raw) && !/^\d{3,4}$/.test(raw)) {
    const num = Number(raw);
    const minutes = Math.round(num * 24 * 60);
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  // HHmm 或 Hmm -> HH:MM
  if (/^\d{3,4}$/.test(raw)) {
    const mm = raw.slice(-2);
    const hh = raw.slice(0, raw.length - 2);
    const hhn = String(parseInt(hh, 10)).padStart(2, '0');
    const mmn = String(parseInt(mm, 10)).padStart(2, '0');
    return `${hhn}:${mmn}`;
  }
  // 支持 中文 上午/下午 前缀
  const zhAmp = raw.match(/^(上午|下午)\s*(\d{1,2})[:.\.：]?(\d{1,2})?$/);
  if (zhAmp) {
    let h = parseInt(zhAmp[2] || '0', 10);
    const m = String(parseInt(zhAmp[3] || '0', 10)).padStart(2, '0');
    if (zhAmp[1] === '下午' && h < 12) h += 12;
    if (zhAmp[1] === '上午' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  // 支持 AM/PM 格式
  const amp = raw.match(/^(\d{1,2})[:.\.：](\d{1,2})\s*([AP]M)$/i);
  if (amp) {
    let h = parseInt(amp[1], 10);
    const m = String(parseInt(amp[2], 10)).padStart(2, '0');
    const ap = amp[3].toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  // 8:30 / 8.30 / 8：30
  const m1 = raw.match(/^(\d{1,2})[:.\.：](\d{1,2})(?::\d{1,2})?$/);
  if (m1) {
    const hh = String(parseInt(m1[1], 10)).padStart(2, '0');
    const mm = String(parseInt(m1[2], 10)).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  // 8点30分 / 8时30分 / 8点
  const m2 = raw.match(/^(\d{1,2})\s*[点时]\s*(\d{1,2})?\s*(?:分)?$/);
  if (m2) {
    const hh = String(parseInt(m2[1], 10)).padStart(2, '0');
    const mm = String(parseInt(m2[2] || '0', 10)).padStart(2, '0');
    return `${hh}:${mm}`;
  }
  return '';
}

// 计算单日工时
function computeDay(record) {
  const { name, date, morningIn, morningOut, afternoonIn, afternoonOut, nightIn, nightOut, genericIn, genericOut, segments } = record;
  let morningMins = 0, afternoonMins = 0, nightMins = 0;

  // 优先使用segments；否则使用具体时段；再否则使用通用上下班
  const segs = Array.isArray(segments) && segments.length ? segments.slice() : [];
  if (!segs.length) {
    if (morningIn && morningOut) segs.push([morningIn, morningOut]);
    if (afternoonIn && afternoonOut) segs.push([afternoonIn, afternoonOut]);
    if (nightIn && nightOut) segs.push([nightIn, nightOut]);
    if (!segs.length && genericIn && genericOut) segs.push([genericIn, genericOut]);
  }

  for (const [st, en] of segs) {
    const aStart = toDate(date, st);
    const aEnd = toDate(date, en);
    if (aEnd > aStart) {
      morningMins += overlapMinutes(date, aStart, aEnd, TIME_WINDOWS.morning.start, TIME_WINDOWS.morning.end);
      afternoonMins += overlapMinutes(date, aStart, aEnd, TIME_WINDOWS.afternoon.start, TIME_WINDOWS.afternoon.end);
      nightMins += overlapMinutes(date, aStart, aEnd, TIME_WINDOWS.night.start, TIME_WINDOWS.night.end);
    }
  }

  const dayWhiteHours = (morningMins + afternoonMins) / 60;
  const dayOvertimeHours = nightMins / 60;

  const lunchAllowance = dayWhiteHours >= MEAL_RULES.lunch.threshold ? MEAL_RULES.lunch.amount : 0;
  const snackAllowance = dayOvertimeHours >= MEAL_RULES.snack.threshold ? MEAL_RULES.snack.amount : 0;
  const totalAllowance = lunchAllowance + snackAllowance;

  const attendance = (dayWhiteHours > 0 || dayOvertimeHours > 0) ? 1 : 0;

  return {
    name, date,
    morningIn, morningOut, afternoonIn, afternoonOut, nightIn, nightOut,
    dayWhiteHours: round2(dayWhiteHours),
    dayOvertimeHours: round2(dayOvertimeHours),
    lunchAllowance,
    snackAllowance,
    totalAllowance,
    attendance,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

// 按天、按人汇总到月
function aggregateMonthly(dayRows) {
  const map = new Map(); // key: name + month
  for (const r of dayRows) {
    const month = r.date.slice(0, 7);
    const key = `${r.name}__${month}`;
    if (!map.has(key)) {
      map.set(key, {
        name: r.name,
        month,
        attendanceDays: 0,
        whiteHours: 0,
        overtimeHours: 0,
        mealAllowance: 0,
      });
    }
    const item = map.get(key);
    item.whiteHours += r.dayWhiteHours;
    item.overtimeHours += r.dayOvertimeHours;
    item.mealAllowance += r.totalAllowance;
    item.attendanceDays += r.attendance;
  }

  const rows = [];
  for (const val of map.values()) {
    const totalHours = val.whiteHours + val.overtimeHours;
    const avgDailyHours = val.attendanceDays > 0 ? totalHours / val.attendanceDays : 0;
    rows.push({
      name: val.name,
      month: val.month,
      attendanceDays: val.attendanceDays,
      whiteHours: round2(val.whiteHours),
      overtimeHours: round2(val.overtimeHours),
      avgDailyHours: round2(avgDailyHours),
      mealAllowance: round2(val.mealAllowance),
    });
  }
  return rows;
}

// 公司层面统计
function aggregateCompany(dayRows) {
  const employees = new Set(dayRows.map(r => r.name).filter(Boolean));
  const totalEmployees = employees.size;
  const totalAttendance = dayRows.reduce((sum, r) => sum + r.attendance, 0);
  const totalLunchAllowance = dayRows.reduce((sum, r) => sum + (r.lunchAllowance || 0), 0);
  const totalSnackAllowance = dayRows.reduce((sum, r) => sum + (r.snackAllowance || 0), 0);
  const totalWhiteHours = dayRows.reduce((sum, r) => sum + (r.dayWhiteHours || 0), 0);
  const totalOvertimeHours = dayRows.reduce((sum, r) => sum + (r.dayOvertimeHours || 0), 0);
  const totalHours = totalWhiteHours + totalOvertimeHours;
  return {
    totalEmployees,
    totalAttendance,
    totalLunchAllowance: round2(totalLunchAllowance),
    totalSnackAllowance: round2(totalSnackAllowance),
    totalOvertimeHours: round2(totalOvertimeHours),
    totalHours: round2(totalHours)
  };
}

// 渲染函数
function renderDailyTable(rows) {
  const tbody = document.querySelector('#dailyTable tbody');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.date)}</td>
      <td>${formatPair(r.morningIn, r.morningOut)}</td>
      <td>${formatPair(r.afternoonIn, r.afternoonOut)}</td>
      <td>${formatPair(r.nightIn, r.nightOut)}</td>
      <td>${r.dayWhiteHours}</td>
      <td>${r.dayOvertimeHours}</td>
      <td>${r.lunchAllowance}</td>
      <td>${r.snackAllowance}</td>
      <td>${r.totalAllowance}</td>
    </tr>
  `).join('');
}

function renderMonthlyTable(rows) {
  const tbody = document.querySelector('#monthlyTable tbody');
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.month)}</td>
      <td>${r.attendanceDays}</td>
      <td>${r.whiteHours}</td>
      <td>${r.overtimeHours}</td>
      <td>${r.avgDailyHours}</td>
      <td>${r.mealAllowance}</td>
    </tr>
  `).join('');
}

function renderCompanySummary(summary) {
  document.getElementById('totalEmployees').textContent = `${summary.totalEmployees}`;
  document.getElementById('totalAttendance').textContent = `${summary.totalAttendance}`;
  const lunchEl = document.getElementById('totalLunchAllowance');
  const snackEl = document.getElementById('totalSnackAllowance');
  const otEl = document.getElementById('totalOvertimeHours');
  const totalEl = document.getElementById('totalHours');
  if (lunchEl) lunchEl.textContent = `${summary.totalLunchAllowance}元`;
  if (snackEl) snackEl.textContent = `${summary.totalSnackAllowance}元`;
  if (otEl) otEl.textContent = `${summary.totalOvertimeHours}小时`;
  if (totalEl) totalEl.textContent = `${summary.totalHours}小时`;
}

function formatPair(a, b) { return a && b ? `${a} - ${b}` : '-'; }

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[s]));
}

// 导出 Excel
function exportToExcel(dailyRows, monthlyRows) {
  const wb = XLSX.utils.book_new();
  const dailySheet = XLSX.utils.json_to_sheet(dailyRows.map(r => ({
    姓名: r.name,
    日期: r.date,
    上午打卡: formatPair(r.morningIn, r.morningOut),
    下午打卡: formatPair(r.afternoonIn, r.afternoonOut),
    晚班打卡: formatPair(r.nightIn, r.nightOut),
    白班工时: r.dayWhiteHours,
    加班工时: r.dayOvertimeHours,
    午餐补贴: r.lunchAllowance,
    夜宵补贴: r.snackAllowance,
    总补贴: r.totalAllowance,
  })));
  XLSX.utils.book_append_sheet(wb, dailySheet, '日统计');

  const monthlySheet = XLSX.utils.json_to_sheet(monthlyRows.map(r => ({
    姓名: r.name,
    月份: r.month,
    出勤天数: r.attendanceDays,
    月度白班工时: r.whiteHours,
    月度加班工时: r.overtimeHours,
    平均日工时: r.avgDailyHours,
    月度餐补: r.mealAllowance,
  })));
  XLSX.utils.book_append_sheet(wb, monthlySheet, '月统计');

  XLSX.writeFile(wb, '考勤统计报表.xlsx');
}

// 交互：文件上传和拖拽
let currentDailyRows = [];
let currentMonthlyRows = [];

function showModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

function showResultsSection(show) {
  document.getElementById('resultsSection').style.display = show ? '' : 'none';
}

function setActiveTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelector(`.tab-btn[data-tab="${tab}"]`).classList.add('active');
  document.getElementById('dailyTab').classList.toggle('active', tab === 'daily');
  document.getElementById('monthlyTab').classList.toggle('active', tab === 'monthly');
}

document.addEventListener('DOMContentLoaded', () => {
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');
  const uploadBtn = document.getElementById('uploadBtn');
  const exportBtn = document.getElementById('exportBtn');
  const clearBtn = document.getElementById('clearBtn');

  uploadArea.addEventListener('click', () => fileInput.click());
  uploadBtn.addEventListener('click', () => fileInput.click());

  uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  });

  exportBtn.addEventListener('click', () => {
    if (!currentDailyRows.length) return;
    exportToExcel(currentDailyRows, currentMonthlyRows);
  });
  clearBtn.addEventListener('click', () => {
    currentDailyRows = [];
    currentMonthlyRows = [];
    showResultsSection(false);
  });
});

async function handleFile(file) {
  try {
    showModal('loadingModal');
    const arrayBuffer = await file.arrayBuffer();
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const rawRows = parseExcelToRows(wb);

    // 转换为内部记录结构
    const normalized = rawRows.map(normalizeRow).filter(r => r.name && r.date);
    if (!normalized.length) {
      throw new Error('未识别到有效数据行，请检查：1) 列名是否为"姓名/日期/上午上班/上午下班/下午上班/下午下班/晚班上班/晚班下班"；2) 日期是否为Excel日期或YYYY-MM-DD/YYYY/MM/DD；3) 时间是否为08:30或Excel时间格式。');
    }

    // 按 (name, date) 聚合多条记录（如跨时段分多行）
    const merged = mergeByNameDate(normalized);

    // 计算每日日统计
    const dailyRows = merged.map(computeDay);

    // 计算月度汇总
    const monthlyRows = aggregateMonthly(dailyRows);

    // 公司汇总
    const company = aggregateCompany(dailyRows);

    // 渲染
    currentDailyRows = dailyRows;
    currentMonthlyRows = monthlyRows;

    renderDailyTable(dailyRows);
    renderMonthlyTable(monthlyRows);
    renderCompanySummary(company);
    showResultsSection(true);
  } catch (err) {
    console.error(err);
    document.getElementById('errorMessage').textContent = err.message || '文件解析失败，请检查Excel格式';
    showModal('errorModal');
  } finally {
    closeModal('loadingModal');
  }
}

function mergeByNameDate(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.name}__${r.date}`;
    if (!map.has(key)) {
      map.set(key, { name: r.name, date: r.date, morningIn: '', morningOut: '', afternoonIn: '', afternoonOut: '', nightIn: '', nightOut: '', segments: [] });
    }
    const item = map.get(key);
    // 合并逻辑：优先取最早的上班，最晚的下班（在各自时段内）
    item.morningIn = pickEarlier(item.morningIn, r.morningIn);
    item.morningOut = pickLater(item.morningOut, r.morningOut);
    item.afternoonIn = pickEarlier(item.afternoonIn, r.afternoonIn);
    item.afternoonOut = pickLater(item.afternoonOut, r.afternoonOut);
    item.nightIn = pickEarlier(item.nightIn, r.nightIn);
    item.nightOut = pickLater(item.nightOut, r.nightOut);
    // 合并自动识别的segments
    if (Array.isArray(r.segments) && r.segments.length) {
      item.segments = item.segments.concat(r.segments);
    }
  }
  // 简单去重segments
  for (const v of map.values()) {
    const uniq = new Map();
    for (const [a,b] of v.segments) uniq.set(`${a}-${b}`, [a,b]);
    v.segments = Array.from(uniq.values());
  }
  return Array.from(map.values());
}

function pickEarlier(a, b) {
  if (!a) return b || '';
  if (!b) return a || '';
  return a <= b ? a : b;
}
function pickLater(a, b) {
  if (!a) return b || '';
  if (!b) return a || '';
  return a >= b ? a : b;
}