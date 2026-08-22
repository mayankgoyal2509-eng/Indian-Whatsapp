let me = null;
let token = null;
let socket = null;
let activeChat = null; // { type: 'user'|'group', id, name }
let onlineUserIds = [];
let contacts = [];
let groups = [];
let typingTimeout = null;
let pendingUpload = null; // { fileOrBlob, filename, objectUrl }

const loginScreen = document.getElementById('login-screen');
const appScreen = document.getElementById('app-screen');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const authError = document.getElementById('auth-error');
const myNameEl = document.getElementById('my-name');
const myProfileEl = document.getElementById('my-profile');
const myAvatarEl = document.getElementById('my-avatar');
const contactListEl = document.getElementById('contact-list');
const appContainerEl = document.querySelector('.app-container');
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

// Renders an avatar as an <img> if the user has a photo, or a circle with
// their initial otherwise. sizeClass controls the CSS sizing (e.g.
// 'contact-avatar', 'header-avatar', 'profile-avatar-preview-circle').
function avatarHtml(user, sizeClass) {
  if (user && user.avatar_url) {
    return `<img class="${sizeClass}" src="${user.avatar_url}" alt="" />`;
  }
  const initial = user && user.name ? user.name.charAt(0).toUpperCase() : '?';
  return `<div class="${sizeClass}">${initial}</div>`;
}

// Turns http(s)/www links in already-HTML-escaped text into clickable,
// one-click-to-open anchors, so links never need to be manually copied.
function linkify(escapedText) {
  const urlRegex = /((https?:\/\/|www\.)[^\s<]+)/gi;
  return escapedText.replace(urlRegex, (match) => {
    const trailingMatch = match.match(/[),.!?;:'"]+$/);
    let urlPart = match;
    let trailing = '';
    if (trailingMatch) {
      trailing = trailingMatch[0];
      urlPart = match.slice(0, -trailing.length);
    }
    const href = /^https?:\/\//i.test(urlPart) ? urlPart : `https://${urlPart}`;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="msg-link">${urlPart}</a>${trailing}`;
  });
}

// ---------- App start ----------
function startApp() {
  loginScreen.classList.add('hidden');
  appScreen.classList.remove('hidden');
  myNameEl.textContent = me.name;
  myAvatarEl.innerHTML = avatarHtml(me, 'header-avatar');

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

  socket.on('message_deleted', ({ id, otherId, groupId }) => {
    const inThisChat =
      activeChat &&
      ((activeChat.type === 'user' && otherId === activeChat.id) ||
        (activeChat.type === 'group' && groupId === activeChat.id));
    if (inThisChat) markMessageDeleted(id);
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
  const res = await fetch('/api/contacts', { headers: authHeaders() });
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

document.getElementById('logout-btn').addEventListener('click', () => {
  if (socket) socket.disconnect();
  logout();
});

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
      ${avatarHtml(c, 'contact-avatar')}
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
  document.getElementById('chat-header-avatar').innerHTML = avatarHtml(contact, 'header-avatar');
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
  document.getElementById('chat-header-avatar').innerHTML = avatarHtml({ name: group.name }, 'header-avatar');

  const res = await fetch(`/api/groups/${group.id}/messages`, { headers: authHeaders() });
  const history = await res.json();
  messagesEl.innerHTML = '';
  history.forEach(renderMessage);
  scrollToBottom();
}

function showChatPanel(name, isGroup) {
  clearPendingUpload();
  uploadPreview.classList.add('hidden');
  chatEmpty.classList.add('hidden');
  chatActive.classList.remove('hidden');
  chatContactName.textContent = name;
  chatContactStatus.textContent = isGroup ? 'group chat' : '';
  typingIndicator.classList.add('hidden');
  appContainerEl.classList.add('chat-open'); // mobile: switch to chat view
}

function updateActiveStatus() {
  if (!activeChat || activeChat.type !== 'user') return;
  const isOnline = onlineUserIds.includes(activeChat.id);
  chatContactStatus.textContent = isOnline ? 'online' : 'offline';
}

// ---------- Mobile back navigation ----------
document.getElementById('back-btn').addEventListener('click', () => {
  appContainerEl.classList.remove('chat-open');
});

// ---------- Delete chat (clears history for you only) ----------
document.getElementById('delete-chat-btn').addEventListener('click', async () => {
  if (!activeChat) return;
  const otherSide = activeChat.type === 'group' ? 'Other members' : 'The other person';
  const ok = confirm(
    `Delete this chat? This clears the conversation for you only — ${otherSide} will still see the messages on their side.`
  );
  if (!ok) return;

  const chatKey = activeChat.type === 'group' ? `group:${activeChat.id}` : activeChat.id;
  await fetch(`/api/chats/${encodeURIComponent(chatKey)}/clear`, { method: 'POST', headers: authHeaders() });

  messagesEl.innerHTML = '';
  chatActive.classList.add('hidden');
  chatEmpty.classList.remove('hidden');
  activeChat = null;
  appContainerEl.classList.remove('chat-open');
  loadContacts();
  loadGroups();
});

// ---------- Messages ----------
function renderMessage(msg) {
  const isOut = msg.from_user === me.id;
  const div = document.createElement('div');
  div.dataset.id = msg.id;
  div.className = 'msg ' + (isOut ? 'out' : 'in') + (msg.deleted ? ' deleted' : '');
  messagesEl.appendChild(div);
  paintMessage(div, msg, isOut);
}

function paintMessage(div, msg, isOut) {
  if (msg.deleted) {
    div.innerHTML = `<span class="deleted-text">This message was deleted</span>`;
    return;
  }

  const time = new Date(Number(msg.timestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  let ticksHtml = '';
  if (isOut && activeChat.type === 'user') {
    let ticks = '✓';
    let cls = 'sent';
    if (msg.delivered) { ticks = '✓✓'; cls = 'delivered'; }
    if (msg.read) { ticks = '✓✓'; cls = 'read'; }
    ticksHtml = `<span class="msg-ticks ${cls}">${ticks}</span>`;
  }

  let mediaHtml = '';
  if (msg.media_url) {
    if (msg.media_type === 'image') {
      mediaHtml = `<img class="msg-media-image" src="${msg.media_url}" onclick="window.open('${msg.media_url}', '_blank')" />`;
    } else if (msg.media_type === 'audio') {
      mediaHtml = `<audio class="msg-media-audio" controls src="${msg.media_url}"></audio>`;
    } else if (msg.media_type === 'video') {
      mediaHtml = `<video class="msg-media-image" controls src="${msg.media_url}"></video>`;
    } else {
      mediaHtml = `<a class="msg-media-file" href="${msg.media_url}" target="_blank">📎 Download file</a>`;
    }
  }

  const textHtml = msg.text ? linkify(escapeHtml(msg.text)) : '';
  const deleteBtnHtml = isOut ? `<button type="button" class="msg-delete-btn" title="Delete message">🗑</button>` : '';

  div.innerHTML = `${mediaHtml}${textHtml}<span class="msg-time">${time}${ticksHtml}${deleteBtnHtml}</span>`;

  if (isOut) {
    div.querySelector('.msg-delete-btn').addEventListener('click', () => deleteMessage(msg.id));
  }
}

function markMessageDeleted(id) {
  const div = messagesEl.querySelector(`[data-id="${id}"]`);
  if (div) {
    div.classList.add('deleted');
    div.innerHTML = `<span class="deleted-text">This message was deleted</span>`;
  }
}

async function deleteMessage(id) {
  if (!confirm('Delete this message? This removes it for everyone.')) return;
  const res = await fetch(`/api/messages/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (res.ok) {
    markMessageDeleted(id);
  } else {
    const data = await res.json().catch(() => ({}));
    alert(data.error || 'Could not delete message');
  }
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function sendMessage({ text, mediaUrl, mediaType }) {
  if (!activeChat) return;
  if (activeChat.type === 'user') {
    socket.emit('send_message', { to: activeChat.id, text, mediaUrl, mediaType });
    socket.emit('stop_typing', { to: activeChat.id });
  } else {
    socket.emit('send_group_message', { groupId: activeChat.id, text, mediaUrl, mediaType });
  }
}

messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !activeChat) return;
  sendMessage({ text });
  messageInput.value = '';
});

messageInput.addEventListener('input', () => {
  if (!activeChat || activeChat.type !== 'user') return;
  socket.emit('typing', { to: activeChat.id });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit('stop_typing', { to: activeChat.id }), 1500);
});

// ---------- File / media upload (preview + confirm before sending) ----------
const uploadPreview = document.getElementById('upload-preview');
const uploadPreviewContent = document.getElementById('upload-preview-content');
const uploadCancelBtn = document.getElementById('upload-cancel-btn');
const uploadSendBtn = document.getElementById('upload-send-btn');
const fileInput = document.getElementById('file-input');

document.getElementById('attach-btn').addEventListener('click', () => {
  if (!activeChat) return alert('Select a chat first');
  fileInput.click();
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (file) showUploadPreview(file, file.name);
});

function showUploadPreview(fileOrBlob, filename) {
  clearPendingUpload();

  const objectUrl = URL.createObjectURL(fileOrBlob);
  const mimetype = fileOrBlob.type || '';
  pendingUpload = { fileOrBlob, filename, objectUrl };

  if (mimetype.startsWith('image/')) {
    uploadPreviewContent.innerHTML = `<img src="${objectUrl}" class="upload-preview-image" />`;
  } else if (mimetype.startsWith('audio/')) {
    uploadPreviewContent.innerHTML = `<audio controls src="${objectUrl}"></audio><div class="upload-preview-filename">${escapeHtml(filename)}</div>`;
  } else if (mimetype.startsWith('video/')) {
    uploadPreviewContent.innerHTML = `<video controls src="${objectUrl}" class="upload-preview-image"></video>`;
  } else {
    uploadPreviewContent.innerHTML = `<div class="upload-preview-filename">📎 ${escapeHtml(filename)}</div>`;
  }

  uploadCancelBtn.classList.remove('hidden');
  uploadSendBtn.classList.remove('hidden');
  uploadPreview.classList.remove('hidden');
}

function clearPendingUpload() {
  if (pendingUpload) {
    URL.revokeObjectURL(pendingUpload.objectUrl);
    pendingUpload = null;
  }
  uploadPreviewContent.innerHTML = '';
}

uploadCancelBtn.addEventListener('click', () => {
  clearPendingUpload();
  uploadPreview.classList.add('hidden');
});

uploadSendBtn.addEventListener('click', async () => {
  if (!pendingUpload) return;
  const { fileOrBlob, filename } = pendingUpload;
  pendingUpload = null; // keep object URL alive until upload finishes rendering isn't needed anymore
  await uploadAndSend(fileOrBlob, filename);
});

async function uploadAndSend(fileOrBlob, filename) {
  if (!activeChat) return;

  uploadPreviewContent.innerHTML = `<span>Uploading ${escapeHtml(filename || 'file')}…</span>`;
  uploadCancelBtn.classList.add('hidden');
  uploadSendBtn.classList.add('hidden');
  uploadPreview.classList.remove('hidden');

  const formData = new FormData();
  formData.append('file', fileOrBlob, filename || 'upload');

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    uploadPreview.classList.add('hidden');

    if (!res.ok) {
      alert(data.error || 'Upload failed');
      return;
    }
    sendMessage({ text: '', mediaUrl: data.url, mediaType: data.mediaType });
  } catch (err) {
    uploadPreview.classList.add('hidden');
    alert('Upload failed — connection was interrupted, possibly because the file is large. Try a smaller file or check your internet connection.');
  }
}

// ---------- Voice recording (preview + confirm before sending) ----------
let mediaRecorder = null;
let recordedChunks = [];
const micBtn = document.getElementById('mic-btn');

micBtn.addEventListener('click', async () => {
  if (!activeChat) return alert('Select a chat first');

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      micBtn.classList.remove('recording');
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      showUploadPreview(blob, `voice-note-${Date.now()}.webm`);
    };

    mediaRecorder.start();
    micBtn.classList.add('recording');
  } catch (err) {
    alert('Could not access microphone. Check browser permissions.');
  }
});

// ---------- Add contact modal ----------
const contactModal = document.getElementById('contact-modal');
const contactPhoneInput = document.getElementById('contact-phone-input');
const contactAddError = document.getElementById('contact-add-error');

document.getElementById('add-contact-btn').addEventListener('click', () => {
  contactPhoneInput.value = '';
  contactAddError.classList.add('hidden');
  contactModal.classList.remove('hidden');
});

document.getElementById('contact-cancel-btn').addEventListener('click', () => {
  contactModal.classList.add('hidden');
});

document.getElementById('contact-add-btn').addEventListener('click', async () => {
  const phone = contactPhoneInput.value.trim();
  if (!phone) return;

  const res = await fetch('/api/contacts', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ phone }),
  });
  const data = await res.json();

  if (!res.ok) {
    contactAddError.textContent = data.error || 'Could not add contact';
    contactAddError.classList.remove('hidden');
    return;
  }

  contactModal.classList.add('hidden');
  loadContacts();
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

// ---------- Profile modal ----------
const profileModal = document.getElementById('profile-modal');
const profileNameInput = document.getElementById('profile-name-input');
const profilePhoneInput = document.getElementById('profile-phone-input');
const profileError = document.getElementById('profile-error');
const profileSuccess = document.getElementById('profile-success');
const profileCurrentPassword = document.getElementById('profile-current-password');
const profileNewPassword = document.getElementById('profile-new-password');
const passwordError = document.getElementById('password-error');
const passwordSuccess = document.getElementById('password-success');

myProfileEl.addEventListener('click', () => {
  profileNameInput.value = me.name;
  profilePhoneInput.value = me.phone;
  profileCurrentPassword.value = '';
  profileNewPassword.value = '';
  document.getElementById('profile-avatar-preview').innerHTML = avatarHtml(me, 'profile-avatar-preview-circle');
  [profileError, profileSuccess, passwordError, passwordSuccess].forEach((el) => el.classList.add('hidden'));
  profileModal.classList.remove('hidden');
});

document.getElementById('change-avatar-btn').addEventListener('click', () => {
  document.getElementById('avatar-file-input').click();
});

document.getElementById('avatar-file-input').addEventListener('change', async () => {
  const avatarFileInput = document.getElementById('avatar-file-input');
  const file = avatarFileInput.files[0];
  avatarFileInput.value = '';
  if (!file) return;

  profileError.classList.add('hidden');
  profileSuccess.classList.add('hidden');

  const formData = new FormData();
  formData.append('file', file, file.name);

  try {
    const res = await fetch('/api/profile/avatar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();

    if (!res.ok) {
      profileError.textContent = data.error || 'Could not upload photo';
      profileError.classList.remove('hidden');
      return;
    }

    me = { ...me, avatar_url: data.avatar_url };
    localStorage.setItem('indichat_user', JSON.stringify(me));
    myAvatarEl.innerHTML = avatarHtml(me, 'header-avatar');
    document.getElementById('profile-avatar-preview').innerHTML = avatarHtml(me, 'profile-avatar-preview-circle');
    profileSuccess.textContent = 'Photo updated!';
    profileSuccess.classList.remove('hidden');
  } catch (err) {
    profileError.textContent = 'Upload failed. Check your connection and try again.';
    profileError.classList.remove('hidden');
  }
});

document.getElementById('profile-close-btn').addEventListener('click', () => {
  profileModal.classList.add('hidden');
});

document.getElementById('profile-save-btn').addEventListener('click', async () => {
  const name = profileNameInput.value.trim();
  const phone = profilePhoneInput.value.trim();
  profileError.classList.add('hidden');
  profileSuccess.classList.add('hidden');
  if (!name || !phone) return;

  const res = await fetch('/api/profile', {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ name, phone }),
  });
  const data = await res.json();

  if (!res.ok) {
    profileError.textContent = data.error || 'Could not save changes';
    profileError.classList.remove('hidden');
    return;
  }

  me = { ...me, name: data.name, phone: data.phone };
  localStorage.setItem('indichat_user', JSON.stringify(me));
  myNameEl.textContent = me.name;
  profileSuccess.textContent = 'Saved!';
  profileSuccess.classList.remove('hidden');
});

document.getElementById('password-change-btn').addEventListener('click', async () => {
  const currentPassword = profileCurrentPassword.value;
  const newPassword = profileNewPassword.value;
  passwordError.classList.add('hidden');
  passwordSuccess.classList.add('hidden');
  if (!currentPassword || !newPassword) return;

  const res = await fetch('/api/profile/password', {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  const data = await res.json();

  if (!res.ok) {
    passwordError.textContent = data.error || 'Could not change password';
    passwordError.classList.remove('hidden');
    return;
  }

  profileCurrentPassword.value = '';
  profileNewPassword.value = '';
  passwordSuccess.textContent = 'Password changed!';
  passwordSuccess.classList.remove('hidden');
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
