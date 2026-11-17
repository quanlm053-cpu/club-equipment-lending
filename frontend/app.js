const byId = (id) => document.getElementById(id);
const screens = ['session', 'login', 'equipment', 'availability', 'management',
  'requests', 'request-new', 'request-detail'];
const device = byId('device');
const fromInput = byId('from');
const toInput = byId('to');
const clubOffset = '+07:00';
const clubTime = {
  timeZone: clubOffset,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
};
const minuteFormat = new Intl.DateTimeFormat('vi-VN', clubTime);
const secondFormat = new Intl.DateTimeFormat('vi-VN', { ...clubTime, second: '2-digit' });
let user = null;
let catalogRequest;
let availabilityRequest;
let checkingSession = false;
let loggingOut = false;
let loanView;
let loanLoginRoute;

class ApiError extends Error {
  constructor(response, code) {
    super(code);
    this.status = response.status;
    this.retryAfter = Number(response.headers.get('Retry-After'));
  }
}

async function api(path, options) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (response.status === 204) return;
  if (response.ok) return response.json();
  const body = await response.json().catch(() => null);
  throw new ApiError(response, body?.code);
}

function message(id, text, error = false) {
  const node = byId(id);
  node.textContent = text;
  node.classList.toggle('error', error);
}

function show(screen) {
  loanView?.abort();
  byId('request-rows').replaceChildren();
  byId('request-data').hidden = true;
  for (const id of ['detail-device', 'detail-created', 'detail-start', 'detail-end', 'request-badge']) {
    byId(id).textContent = '';
  }
  byId('request-form').reset();
  byId('request-device').replaceChildren();
  catalogRequest?.abort();
  clearAvailability();
  byId('lookup').reset();
  device.replaceChildren();
  byId('lookup-fields').disabled = true;
  byId('app-panel').classList.toggle('panel-wide', screen === 'availability');
  byId('assets').replaceChildren();
  byId('assets').hidden = true;
  for (const id of screens) byId(id).hidden = id !== screen;

  const manager = user?.role === 'MANAGER';
  byId('role').textContent = user ? (manager ? 'Quản lý' : 'Thành viên') : '';
  byId('logout').hidden = !user;
  byId('equipment-link').hidden = !user;
  byId('management-link').hidden = !manager;
  byId('requests-link').hidden = user?.role !== 'MEMBER';
  for (const id of ['equipment', 'management', 'requests']) {
    const link = byId(id + '-link');
    if (id === screen || (id === 'equipment' && screen === 'availability')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  byId(screen + '-title').focus();
}

function endSession(text = '') {
  user = null;
  history.replaceState(null, '', '#login');
  byId('password').value = '';
  message('action-status', '');
  show('login');
  message('login-status', text, Boolean(text));
}

function expired() {
  endSession('Phiên đã hết hạn. Vui lòng đăng nhập lại.');
}

async function loadCatalog(selectedId) {
  catalogRequest?.abort();
  const request = new AbortController();
  catalogRequest = request;
  const forLookup = selectedId !== undefined;
  const statusId = forLookup ? 'lookup-catalog-status' : 'catalog-status';
  const retry = byId(forLookup ? 'lookup-catalog-retry' : 'retry');
  retry.hidden = true;
  message(statusId, 'Đang tải danh mục…');

  try {
    const equipment = await api('/equipment', { signal: request.signal });
    if (request.signal.aborted) return;
    if (forLookup) {
      const options = equipment.map(({ id, name, asset_code }) => new Option(name + ' · ' + asset_code, id));
      device.replaceChildren(...options);
      device.value = selectedId;
      const missing = options.length > 0 && device.selectedIndex < 0;
      if (missing) {
        const placeholder = new Option('Chọn thiết bị', '');
        placeholder.disabled = true;
        device.prepend(placeholder);
        device.value = '';
      }
      byId('lookup-fields').disabled = options.length === 0;
      message(statusId, options.length === 0 ? 'Chưa có thiết bị để tra cứu.'
        : missing ? 'Thiết bị đã chọn không còn khả dụng. Hãy chọn thiết bị trong danh mục.' : '');
      return;
    }
    const rows = equipment.map(({ id, asset_code, name }) => {
      const item = document.createElement('li');
      item.className = 'asset';
      item.dataset.equipmentId = id;
      const title = document.createElement('strong');
      title.textContent = name;
      const details = document.createElement('div');
      details.append(title, document.createElement('br'), asset_code);
      const link = document.createElement('a');
      link.href = '#availability/' + encodeURIComponent(id);
      link.textContent = 'Xem lịch';
      link.setAttribute('aria-label', 'Xem lịch · ' + name + ' · ' + asset_code);
      item.append(details, link);
      return item;
    });
    byId('assets').replaceChildren(...rows);
    byId('assets').hidden = rows.length === 0;
    message(statusId, rows.length ? '' : 'Chưa có thiết bị để tra cứu.');
  } catch (error) {
    if (request.signal.aborted) return;
    if (error.status === 401) return expired();
    if (error.status === 403) return message(statusId, 'Bạn không có quyền truy cập.', true);
    message(statusId, 'Không tải được danh mục.', true);
    retry.hidden = false;
  }
}

function fieldError(input, text = '') {
  message(input.id + '-error', text, Boolean(text));
  input.setAttribute('aria-invalid', String(Boolean(text)));
}

function clearAvailability(text = '') {
  availabilityRequest?.abort();
  for (const id of ['lookup-context', 'lookup-updated', 'slots']) byId(id).replaceChildren();
  for (const id of ['slots', 'lookup-retry', 'reload-catalog']) byId(id).hidden = true;
  for (const input of [device, fromInput, toInput]) fieldError(input);
  message('lookup-status', text);
}

function toClubInstant(input) {
  if (!input.validity.valid || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.value)) return;
  const instant = new Date(input.value + ':00' + clubOffset);
  if (instant.getUTCFullYear() >= 1 && instant.getUTCFullYear() <= 9999) return instant;
}

function formatClubTime(value) {
  const instant = new Date(value);
  const millis = instant.getUTCMilliseconds();
  if (millis) {
    const fraction = String(millis).padStart(3, '0');
    return secondFormat.formatToParts(instant).map(({ type, value }) =>
      type === 'second' ? value + ',' + fraction : value).join('');
  }
  return (instant.getUTCSeconds() ? secondFormat : minuteFormat).format(instant);
}

async function lookupAvailability(event) {
  event.preventDefault();
  if (byId('lookup-fields').disabled || byId('availability').hidden) return;
  clearAvailability();
  const from = toClubInstant(fromInput);
  const to = toClubInstant(toInput);
  fieldError(device, device.value ? '' : 'Chọn thiết bị để tra cứu.');
  fieldError(fromInput, from ? '' : 'Nhập ngày giờ bắt đầu hợp lệ.');
  fieldError(toInput, !to ? 'Nhập ngày giờ kết thúc hợp lệ.'
    : to <= from ? 'Giờ kết thúc phải sau giờ bắt đầu.' : '');
  const invalid = byId('lookup').querySelector('[aria-invalid="true"]');
  if (invalid) {
    invalid.focus();
    return;
  }

  const request = new AbortController();
  availabilityRequest = request;
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const selected = device.selectedOptions[0];
  message('lookup-status', 'Đang tải lịch…');
  try {
    const { as_of, available } = await api('/equipment/' + encodeURIComponent(selected.value)
      + '/availability?' + query, { signal: request.signal });
    if (request.signal.aborted) return;
    const rows = available.map(({ start_at, end_at }) => {
      const row = document.createElement('li');
      row.append(formatClubTime(start_at) + ' → ' + formatClubTime(end_at));
      if (user.role === 'MEMBER') {
        const link = document.createElement('a');
        link.href = '#request/new?' + new URLSearchParams({ equipment_id: selected.value, start_at, end_at });
        link.textContent = 'Gửi yêu cầu';
        row.append(link);
      }
      return row;
    });
    const updated = formatClubTime(as_of);
    message('lookup-context', selected.text + ' · ' + formatClubTime(from) + ' → ' + formatClubTime(to));
    byId('slots').replaceChildren(...rows);
    byId('slots').hidden = rows.length === 0;
    message('lookup-status', rows.length ? '' : 'Không có khung giờ trống trong khoảng đã chọn.');
    message('lookup-updated', 'Cập nhật lúc ' + updated);
  } catch (error) {
    if (request.signal.aborted) return;
    switch (error.status) {
      case 400:
        return message('lookup-status', 'Kiểm tra thiết bị và ngày giờ đã nhập.', true);
      case 401:
        return expired();
      case 403:
        return message('lookup-status', 'Tài khoản thiếu quyền xem lịch.', true);
      case 404:
        byId('reload-catalog').hidden = false;
        return message('lookup-status', 'Thiết bị không còn khả dụng.', true);
      default:
        byId('lookup-retry').hidden = false;
        message('lookup-status', 'Chưa tải được lịch. Hãy thử lại.', true);
    }
  }
}

const loanLabels = {
  PENDING: 'Chờ duyệt',
  APPROVED: 'Đã duyệt',
  REJECTED: 'Đã từ chối',
  HANDED_OVER: 'Đã giao',
  RETURNED: 'Đã trả',
};
const loanDevice = byId('request-device');
const loanStart = byId('request-start');
const loanEnd = byId('request-end');

function showLoanScreen(confirmedId) {
  const [path, query] = location.hash.split('?');
  const screen = path === '#requests' ? 'requests' : path === '#request/new' ? 'request-new' : 'request-detail';
  show(screen);
  const view = new AbortController();
  loanView = view;
  const member = user.role === 'MEMBER';
  byId('new-request-link').hidden = !member;
  byId('request-badge').hidden = true;
  byId('request-detail-title').textContent = 'Chi tiết yêu cầu';
  byId('request-form').hidden = true;
  byId('request-catalog-retry').hidden = true;
  for (const retry of document.querySelectorAll('[data-request-retry]')) retry.hidden = true;
  const confirmation = byId('request-confirmation');
  confirmation.hidden = true;
  message('request-confirmation', '');
  const statusId = screen === 'request-new' ? 'request-catalog-status' : screen + '-status';
  message(statusId, '');
  if (!member) return message(statusId, 'Bạn không có quyền truy cập.', true);

  if (screen === 'request-new') {
    const params = new URLSearchParams(query);
    for (const [field, key] of [[loanStart, 'start_at'], [loanEnd, 'end_at']]) {
      const utc = params.get(key);
      if (utc && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(utc)) {
        const clubLocal = new Date(Date.parse(utc) + 7 * 60 * 60 * 1000);
        if (clubLocal.getUTCFullYear() >= 1 && clubLocal.getUTCFullYear() <= 9999) {
          field.value = clubLocal.toISOString().slice(0, -1);
        }
      }
    }
    for (const field of [loanDevice, loanStart, loanEnd]) fieldError(field);
    message('request-submit-status', '');
    byId('request-form').hidden = false;
    void loadLoanCatalog(view, params.get('equipment_id') || '');
    return;
  }

  const id = /^#request\/(\d+)$/.exec(path)?.[1];
  if (screen === 'request-detail' && !(Number(id) > 0 && Number(id) <= 2147483647)) {
    return message(statusId, 'Không tìm thấy yêu cầu.', true);
  }
  if (confirmedId === Number(id)) {
    confirmation.hidden = false;
    message('request-confirmation', 'Đã gửi yêu cầu.');
  }
  const retry = byId(screen).querySelector('[data-request-retry]');
  retry.onclick = () => {
    byId(screen + '-title').focus();
    void loadLoans(view, screen, id);
  };
  void loadLoans(view, screen, id);
}

async function loadLoans(view, screen, id) {
  const statusId = screen + '-status';
  const { signal } = view;
  const retry = byId(screen).querySelector('[data-request-retry]');
  retry.hidden = true;
  message(statusId, 'Đang tải yêu cầu…');
  try {
    const result = await api(id ? '/loan-requests/' + Number(id) : '/loan-requests', { signal });
    if (signal.aborted) return;
    if (!id && result.length === 0) return message(statusId, 'Bạn chưa có yêu cầu nào.');
    const catalog = await api('/equipment', { signal }).catch(error => {
      if (error.status === 401) throw error;
      return [];
    });
    if (signal.aborted) return;
    const names = new Map(catalog.map(({ id, name, asset_code }) => [id, name + ' · ' + asset_code]));
    const deviceName = item => names.get(item.equipment_id) || 'Thiết bị #' + item.equipment_id;
    if (id) {
      byId('request-detail-title').textContent = 'Yêu cầu #' + result.id;
      const badge = byId('request-badge');
      badge.textContent = loanLabels[result.status];
      badge.hidden = false;
      message('detail-device', deviceName(result));
      message('detail-created', formatClubTime(result.created_at));
      message('detail-start', formatClubTime(result.start_at));
      message('detail-end', formatClubTime(result.end_at));
      byId('request-data').hidden = false;
      return message(statusId, '');
    }
    const rows = result.map(item => {
      const row = document.createElement('li');
      row.className = 'asset';
      const cell = document.createElement('div');
      const link = document.createElement('a');
      link.href = '#request/' + item.id;
      link.textContent = '#' + item.id + ' · ' + deviceName(item);
      const times = document.createElement('div');
      times.className = 'muted';
      times.textContent = formatClubTime(item.start_at) + ' – ' + formatClubTime(item.end_at);
      cell.append(link, times);
      const badge = document.createElement('span');
      badge.className = 'request-badge';
      badge.textContent = loanLabels[item.status];
      row.append(cell, badge);
      return row;
    });
    byId('request-rows').replaceChildren(...rows);
    message(statusId, '');
  } catch (error) {
    if (signal.aborted) return;
    if (error.status === 401) return expired();
    if (error.status === 403) return message(statusId, 'Bạn không có quyền truy cập.', true);
    if (id && error.status === 404) return message(statusId, 'Không tìm thấy yêu cầu.', true);
    message(statusId, 'Không tải được yêu cầu. Hãy thử lại.', true);
    retry.hidden = false;
  }
}

async function loadLoanCatalog(view, selectedId, missing = false) {
  const fields = byId('request-fields');
  const retry = byId('request-catalog-retry');
  const statusId = 'request-catalog-status';
  fields.disabled = true;
  retry.hidden = true;
  message(statusId, 'Đang tải danh mục…');
  try {
    const catalog = await api('/equipment', { signal: view.signal });
    if (view.signal.aborted) return;
    const placeholder = new Option('Chọn thiết bị', '');
    placeholder.disabled = true;
    loanDevice.replaceChildren(placeholder,
      ...catalog.map(({ id, name, asset_code }) => new Option(name + ' · ' + asset_code, id)));
    const available = catalog.some(item => String(item.id) === selectedId);
    loanDevice.value = available ? selectedId : '';
    fields.disabled = catalog.length === 0;
    message(statusId, catalog.length ? '' : 'Chưa có thiết bị để chọn.');
    if (missing || (selectedId && !available)) {
      fieldError(loanDevice, 'Thiết bị không còn khả dụng. Hãy chọn lại.');
      if (!fields.disabled) loanDevice.focus();
    }
  } catch (error) {
    if (view.signal.aborted) return;
    if (error.status === 401) return expired();
    if (error.status === 403) return message(statusId, 'Bạn không có quyền truy cập.', true);
    message(statusId, 'Không tải được danh mục. Hãy thử lại.', true);
    retry.hidden = false;
  }
}

function loanInstant(input) {
  const value = input.value;
  if (!input.validity.valid || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) return;
  const instant = new Date(value + clubOffset);
  if (instant.getUTCFullYear() >= 1 && instant.getUTCFullYear() <= 9999) return instant;
}

async function submitLoan(event) {
  event.preventDefault();
  const fields = byId('request-fields');
  if (fields.disabled || loggingOut || byId('request-new').hidden || user?.role !== 'MEMBER') return;
  const statusId = 'request-submit-status';
  message(statusId, '');
  const start = loanInstant(loanStart);
  const end = loanInstant(loanEnd);
  fieldError(loanDevice, loanDevice.value ? '' : 'Chọn thiết bị.');
  fieldError(loanStart, start ? '' : 'Nhập ngày giờ bắt đầu hợp lệ.');
  fieldError(loanEnd, !end ? 'Nhập ngày giờ kết thúc hợp lệ.'
    : start && end <= start ? 'Giờ kết thúc phải sau giờ bắt đầu.' : '');
  const invalid = fields.querySelector('[aria-invalid="true"]');
  if (invalid) return invalid.focus();

  const view = loanView;
  const route = location.hash;
  const data = { equipment_id: Number(loanDevice.value), start_at: start.toISOString(), end_at: end.toISOString() };
  fields.disabled = true;
  message(statusId, 'Đang gửi…');
  try {
    const created = await api('/loan-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': user.csrf_token },
      body: JSON.stringify(data),
    });
    if (view.signal.aborted || route !== location.hash) return;
    history.pushState(null, '', '#request/' + created.id);
    showLoanScreen(created.id);
  } catch (error) {
    if (view.signal.aborted || route !== location.hash) return;
    fields.disabled = false;
    if (error.status === 401) return expired();
    if (error.status === 404) {
      message(statusId, '');
      loanDevice.value = '';
      fieldError(loanDevice, 'Thiết bị không còn khả dụng. Hãy chọn lại.');
      return loadLoanCatalog(view, '', true);
    }
    if (error.status === 400) return message(statusId, 'Vui lòng kiểm tra thiết bị và khoảng giờ.', true);
    if (error.message === 'CSRF_INVALID') {
      return message(statusId, 'Mã xác thực phiên không hợp lệ. Hãy tải lại trang trước khi gửi lại.', true);
    }
    if (error.status === 403) return message(statusId, 'Bạn không có quyền gửi yêu cầu.', true);
    message(statusId, 'Chưa xác nhận được kết quả. Hãy kiểm tra danh sách trước khi gửi lại.', true);
  }
}

function isLoanRoute(hash) {
  return hash === '#requests' || hash.startsWith('#request/');
}

function showBusinessScreen() {
  if (isLoanRoute(location.hash)) {
    showLoanScreen();
    return;
  }
  const availabilityRoute = /^#availability\/(\d+)$/.exec(location.hash);
  if (availabilityRoute) {
    show('availability');
    message('lookup-status', 'Chọn khoảng thời gian rồi xem lịch trống.');
    void loadCatalog(availabilityRoute[1]);
    return;
  }
  if (location.hash === '#management') {
    show('management');
    message('management-status', user.role === 'MANAGER'
      ? 'Hàng đợi yêu cầu sẽ có trong Story #114.'
      : 'Bạn không có quyền truy cập.', user.role !== 'MANAGER');
    return;
  }
  history.replaceState(null, '', '#equipment');
  show('equipment');
  void loadCatalog();
}

async function checkSession() {
  if (checkingSession || loggingOut) return;
  checkingSession = true;
  const hadSession = Boolean(user);
  user = null;
  show('session');
  byId('session-retry').hidden = true;
  message('session-status', 'Đang kiểm tra phiên…');
  try {
    user = await api('/auth/me');
    showBusinessScreen();
  } catch (error) {
    if (error.status === 401) {
      if (hadSession) expired();
      else {
        if (isLoanRoute(location.hash)) loanLoginRoute = location.hash;
        endSession((loanLoginRoute || ['#equipment', '#management'].includes(location.hash) || location.hash.startsWith('#availability/'))
          ? 'Vui lòng đăng nhập để tiếp tục.' : '');
      }
    } else {
      message('session-status', 'Không kiểm tra được phiên đăng nhập.', true);
      byId('session-retry').hidden = false;
    }
  } finally {
    checkingSession = false;
  }
}

function loginError(error) {
  switch (error.message) {
    case 'INVALID_CREDENTIALS':
      return 'Tên đăng nhập hoặc mật khẩu không đúng.';
    case 'INVALID_INPUT':
      return 'Vui lòng kiểm tra tên đăng nhập và mật khẩu.';
    case 'LOGIN_RATE_LIMITED':
      return error.retryAfter > 0
        ? 'Quá nhiều lần thử. Vui lòng thử lại sau ' + error.retryAfter + ' giây.'
        : 'Quá nhiều lần thử. Vui lòng thử lại sau.';
    case 'ORIGIN_FORBIDDEN':
      return 'Địa chỉ ứng dụng không được phép đăng nhập.';
    default:
      return 'Chưa thể đăng nhập. Vui lòng thử lại.';
  }
}

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = byId('submit');
  if (submit.disabled) return;
  const username = byId('username').value.trim();
  if (!username) {
    message('login-status', 'Vui lòng nhập tên đăng nhập.', true);
    byId('username').focus();
    return;
  }
  submit.disabled = true;
  message('login-status', 'Đang đăng nhập…');
  const password = byId('password').value;
  byId('password').value = '';
  try {
    user = await api('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    history.replaceState(null, '', loanLoginRoute || '#equipment');
    loanLoginRoute = undefined;
    showBusinessScreen();
  } catch (error) {
    byId('password').value = '';
    message('login-status', loginError(error), true);
    byId('password').focus();
  } finally {
    submit.disabled = false;
  }
});

async function logout() {
  if (!user || loggingOut) return;
  const session = user;
  loggingOut = true;
  byId('logout').disabled = true;
  message('action-status', 'Đang đăng xuất…');
  try {
    await api('/auth/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': session.csrf_token },
    });
    if (user === session) endSession();
  } catch (error) {
    if (user !== session) return;
    if (error.status === 401) return expired();
    if (error.message === 'CSRF_INVALID') {
      try {
        const refreshed = await api('/auth/me');
        if (user !== session) return;
        user = refreshed;
      } catch (refreshError) {
        if (refreshError.status === 401) return expired();
      }
      if (user) showBusinessScreen();
    }
    if (user) message('action-status', error.message === 'FORBIDDEN'
      ? 'Bạn không có quyền thực hiện thao tác này.'
      : 'Chưa xác nhận được đăng xuất. Vui lòng thử lại.', true);
  } finally {
    loggingOut = false;
    byId('logout').disabled = false;
  }
}

for (const button of document.querySelectorAll('[data-demo]')) {
  button.addEventListener('click', () => {
    byId('username').value = button.dataset.demo;
    byId('password').value = '';
    byId('password').focus();
  });
}
byId('retry').addEventListener('click', () => {
  byId('equipment-title').focus();
  void loadCatalog();
});
byId('session-retry').addEventListener('click', checkSession);
byId('lookup-catalog-retry').addEventListener('click', () => {
  byId('availability-title').focus();
  void loadCatalog(location.hash.slice('#availability/'.length));
});
byId('lookup').addEventListener('submit', lookupAvailability);
byId('lookup-retry').addEventListener('click', () => {
  byId('lookup').querySelector('button').focus();
  byId('lookup').requestSubmit();
});
byId('lookup').addEventListener('input', () => {
  clearAvailability('Lựa chọn đã thay đổi. Xem lịch trống để cập nhật.');
});
byId('logout').addEventListener('click', logout);
byId('request-form').addEventListener('submit', submitLoan);
byId('request-form').addEventListener('input', (event) => fieldError(event.target));
byId('request-catalog-retry').addEventListener('click', () => {
  const params = new URLSearchParams(location.hash.split('?')[1]);
  void loadLoanCatalog(loanView, loanDevice.value || (!loanDevice.options.length && params.get('equipment_id')) || '');
});
window.addEventListener('hashchange', () => {
  if (checkingSession) return;
  if (user) showBusinessScreen();
  else if (!byId('login').hidden && !byId('submit').disabled) {
    if (isLoanRoute(location.hash)) loanLoginRoute = location.hash;
    endSession('Vui lòng đăng nhập để tiếp tục.');
  }
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void checkSession();
});
void checkSession();
