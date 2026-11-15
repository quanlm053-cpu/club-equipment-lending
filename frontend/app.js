const byId = (id) => document.getElementById(id);
const screens = ['session', 'login', 'equipment', 'management'];
let user = null;
let catalogRequest;
let checkingSession = false;
let loggingOut = false;

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
  catalogRequest?.abort();
  byId('assets').replaceChildren();
  byId('assets').hidden = true;
  for (const id of screens) byId(id).hidden = id !== screen;

  const manager = user?.role === 'MANAGER';
  byId('role').textContent = user ? (manager ? 'Quản lý' : 'Thành viên') : '';
  byId('logout').hidden = !user;
  byId('equipment-link').hidden = !user;
  byId('management-link').hidden = !manager;
  for (const id of ['equipment', 'management']) {
    const link = byId(id + '-link');
    if (id === screen) link.setAttribute('aria-current', 'page');
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

async function loadCatalog() {
  catalogRequest?.abort();
  const request = new AbortController();
  catalogRequest = request;
  byId('retry').hidden = true;
  message('catalog-status', 'Đang tải danh mục…');

  try {
    const equipment = await api('/equipment', { signal: request.signal });
    if (request.signal.aborted) return;
    const rows = equipment.map(({ id, asset_code, name }) => {
      const item = document.createElement('li');
      item.className = 'asset';
      item.dataset.equipmentId = id;
      const title = document.createElement('strong');
      title.textContent = name;
      item.append(title, document.createElement('br'), asset_code);
      return item;
    });
    byId('assets').replaceChildren(...rows);
    byId('assets').hidden = rows.length === 0;
    message('catalog-status', rows.length ? '' : 'Chưa có thiết bị.');
  } catch (error) {
    if (request.signal.aborted) return;
    if (error.status === 401) return expired();
    if (error.status === 403) return message('catalog-status', 'Bạn không có quyền truy cập.', true);
    message('catalog-status', 'Không tải được danh mục.', true);
    byId('retry').hidden = false;
  }
}

function showBusinessScreen() {
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
      else endSession(['#equipment', '#management'].includes(location.hash)
        ? 'Vui lòng đăng nhập để tiếp tục.' : '');
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
    history.replaceState(null, '', '#equipment');
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
byId('logout').addEventListener('click', logout);
window.addEventListener('hashchange', () => {
  if (checkingSession) return;
  if (user) showBusinessScreen();
  else if (!byId('login').hidden && !byId('submit').disabled) {
    endSession('Vui lòng đăng nhập để tiếp tục.');
  }
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void checkSession();
});
void checkSession();
