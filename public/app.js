let me = null;
let token = null;
let socket = null;
let activeChat = null; // { type: 'user'|'group', id, name }
let onlineUserIds = [];
let contacts = [];
let groups = [];
let typingTimeout = null;

const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const authError = document.getElementById('auth-error');
const myNameEl = document.getElementById('my-name');
const contactListEl = document.getElementById('contact-list');
const chatEmpty = document.getElementById('chat-empty');
const chatActive = document.getElementById('chat-active');
const chatContactName = document.getElementById('chat-contact-name');
const chatContactStatus = document.getElementById('chat-contact-status');
const messagesEl = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const typingIndicator = document.getElementById('typing-indicator');

// ---------- Auth tab switching ----------
document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    authError.classList.add('hidden');
    if (tab.dataset.tab === 'login') {
      loginForm.classList.remove('hidden');
      registerForm.classList.add('hidden');
    } else {
      registerForm.classList.remove('hidden');
      loginForm.classList.add('hidden');
    }
  });
});

function showAuthError(msg) {
  authError.textContent = msg;
  authError.classList.remove('hidden');
}

// ---------- Restore session ----------
window.addEventListener('DOMContentLoaded', () => {
  const savedToken = localStorage.getItem('indichat_token');
  const savedUser = localStorage.getItem('indichat_user');
  if (savedToken && savedUser) {
    token = savedToken;
    me = JSON.parse(savedUser);
    startApp();
  }
});

// ---------- Login ----------
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('login-phone').value.trim();
  const password = document.getElementById('login-password').value;

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error || 'Login failed');

  me = data.user;
  token = data.token;
  localStorage.setItem('indichat_user', JSON.stringify(me));
  localStorage.setItem('indichat_token', token);
  startApp();
});

// ---------- Register ----------
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('register-name').value.trim();
  const phone = document.getElementById('register-phone').value.trim();
  const password = document.getElementById('register-password').value;

  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, phone, password }),
  });
  const data = await res.json();
  if (!res.ok) return showAuthError(data.error || 'Sign up failed');

  me = data.user;
  token = data.token;
  localStorage.setItem('indichat_user', JSON.stringify(me));
  localStorage.setItem('indichat_token', token);
  startApp();
});

function authHeaders() {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ---------- App start ----------
function startApp() {
  loginScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  myNameEl.textContent = me.name;

  socket = io({ auth: { token } });

  socket.on('presence_update', (ids) => {
    onlineUserIds = ids;
    renderContactList();
    updateActiveStatus();
  });

  socket.on('receive_message', (msg) => {
    if (activeChat && activeChat.type === 'user' && msg.from_user === activeChat.id) {
      renderMessage(msg);
      scrollToBottom();
      markRead(activeChat.id);
    }
  });

  socket.on('message_sent', (msg) => {
    if (activeChat && activeChat.type === 'user' && msg.to_user === activeChat.id) {
      renderMessage(msg);
      scrollToBottom();
    }
  });

  socket.on('receive_group_message', (msg) => {
    if (activeChat && activeChat.type === 'group' && msg.group_id === activeChat.id) {
      renderMessage(msg);
      scrollToBottom();
    }
  });

  socket.on('group_message_sent', (msg) => {
    if (activeChat && activeChat.type === 'group' && msg.group_id === activeChat.id) {
      renderMessage(msg);
      scrollToBottom();
    }
  });

  socket.on('messages_read', ({ by }) => {
    if (activeChat && activeChat.type === 'user' && by === activeChat.id) {
      document.querySelectorAll('.msg.out .msg-ticks').forEach((el) => {
        el.textContent = '✓✓';
        el.className = 'msg-ticks read';
      });
    }
  });

  socket.on('typing', ({ from }) => {
    if (activeChat && activeChat.type === 'user' && from === activeChat.id) {
      typingIndicator.classList.remove('hidden');
    }
  });

  socket.on('stop_typing', ({ from }) => {
    if (activeChat && activeChat.type === 'user' && from === activeChat.id) {
      typingIndicator.classList.add('hidden');
    }
  });

  loadContacts();
  loadGroups();
  setInterval(() => {
    loadContacts();
    loadGroups();
  }, 5000);
}

// ---------- Contacts + Groups ----------
async function loadContacts() {
  const res = await fetch('/api/users', { headers: authHeaders() });
  if (res.status === 401) return logout();
  contacts = await res.json();
  renderContactList();
}

async function loadGroups() {
  const res = await fetch('/api/groups', { headers: authHeaders() });
  if (res.status === 401) return logout();
  groups = await res.json();
  renderContactList();
}

function logout() {
  localStorage.removeItem('indichat_token');
  localStorage.removeItem('indichat_user');
  location.reload();
}

function renderContactList() {
  contactListEl.innerHTML = '';

  groups.forEach((g) => {
    const div = document.createElement('div');
    div.className = 'contact' + (activeChat && activeChat.type === 'group' && activeChat.id === g.id ? ' active' : '');
    div.innerHTML = `
      <div class="contact-avatar">${g.name.charAt(0).toUpperCase()}</div>
      <div class="contact-info">
        <div class="contact-name">${escapeHtml(g.name)} <span class="contact-badge">Group</span></div>
        <div class="contact-sub">Group chat</div>
      </div>
    `;
    div.addEventListener('click', () => openGroupChat(g));
    contactListEl.appendChild(div);
  });

  contacts.forEach((c) => {
    const isOnline = onlineUserIds.includes(c.id);
    const div = document.createElement('div');
    div.className = 'contact' + (activeChat && activeChat.type === 'user' && activeChat.id === c.id ? ' active' : '');
    div.innerHTML = `
      <div class="contact-avatar">${c.name.charAt(0).toUpperCase()}</div>
      <div class="contact-info">
        <div class="contact-name">${escapeHtml(c.name)}</div>
        <div class="contact-sub">${isOnline ? 'Online' : 'Offline'}</div>
      </div>
      <div class="dot ${isOnline ? 'online' : ''}"></div>
    `;
    div.addEventListener('click', () => openUserChat(c));
    contactListEl.appendChild(div);
  });
}

// ---------- 1-to-1 chat ----------
async function openUserChat(contact) {
  activeChat = { type: 'user', id: contact.id, name: contact.name };
  renderContactList();
  showChatPanel(contact.name);
  updateActiveStatus();

  const res = await fetch(`/api/messages/${contact.id}`, { headers: authHeaders() });
  const history = await res.json();
  messagesEl.innerHTML = '';
  history.forEach(renderMessage);
  scrollToBottom();
  markRead(contact.id);
}

function markRead(otherId) {
  fetch(`/api/messages/${otherId}/read`, { method: 'POST', headers: authHeaders() });
}

// ---------- Group chat ----------
async function openGroupChat(group) {
  activeChat = { type: 'group', id: group.id, name: group.name };
  renderContactList();
  showChatPanel(group.name, true);

  const res = await fetch(`/api/groups/${group.id}/messages`, { headers: authHeaders() });
  const history = await res.json();
  messagesEl.innerHTML = '';
  history.forEach(renderMessage);
  scrollToBottom();
}

function showChatPanel(name, isGroup) {
  chatEmpty.classList.add('hidden');
  chatActive.classList.remove('hidden');
  chatContactName.textContent = name;
  chatContactStatus.textContent = isGroup ? 'group chat' : '';
  typingIndicator.classList.add('hidden');
}

function updateActiveStatus() {
  if (!activeChat || activeChat.type !== 'user') return;
  const isOnline = onlineUserIds.includes(activeChat.id);
  chatContactStatus.textContent = isOnline ? 'online' : 'offline';
}

// ---------- Messages ----------
function renderMessage(msg) {
  const isOut = msg.from_user === me.id;
  const div = document.createElement('div');
  div.className = 'msg ' + (isOut ? 'out' : 'in');
  const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let ticksHtml = '';
  if (isOut && activeChat.type === 'user') {
    let ticks = '✓';
    let cls = 'sent';
    if (msg.delivered) { ticks = '✓✓'; cls = 'delivered'; }
    if (msg.read) { ticks = '✓✓'; cls = 'read'; }
    ticksHtml = `<span class="msg-ticks ${cls}">${ticks}</span>`;
  }

  div.innerHTML = `${escapeHtml(msg.text)}<span class="msg-time">${time}${ticksHtml}</span>`;
  messagesEl.appendChild(div);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !activeChat) return;

  if (activeChat.type === 'user') {
    socket.emit('send_message', { to: activeChat.id, text });
    socket.emit('stop_typing', { to: activeChat.id });
  } else {
    socket.emit('send_group_message', { groupId: activeChat.id, text });
  }
  messageInput.value = '';
});

messageInput.addEventListener('input', () => {
  if (!activeChat || activeChat.type !== 'user') return;
  socket.emit('typing', { to: activeChat.id });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('stop_typing', { to: activeChat.id }), 1500);
});

// ---------- New group modal ----------
const groupModal = document.getElementById('group-modal');
const groupMemberList = document.getElementById('group-member-list');
const groupNameInput = document.getElementById('group-name-input');

document.getElementById('new-group-btn').addEventListener('click', () => {
  groupNameInput.value = '';
  groupMemberList.innerHTML = '';
  contacts.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'group-member-row';
    row.innerHTML = `<input type="checkbox" value="${c.id}" id="member-${c.id}" /> <label for="member-${c.id}">${escapeHtml(c.name)}</label>`;
    groupMemberList.appendChild(row);
  });
  groupModal.classList.remove('hidden');
});

document.getElementById('group-cancel-btn').addEventListener('click', () => {
  groupModal.classList.add('hidden');
});

document.getElementById('group-create-btn').addEventListener('click', async () => {
  const name = groupNameInput.value.trim();
  const memberIds = Array.from(groupMemberList.querySelectorAll('input:checked')).map((i) => i.value);
  if (!name || memberIds.length === 0) {
    alert('Enter a group name and select at least one member.');
    return;
  }

  const res = await fetch('/api/groups', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, memberIds }),
  });
  if (res.ok) {
    groupModal.classList.add('hidden');
    loadGroups();
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
