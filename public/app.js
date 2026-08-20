const state = { user: null, csrfToken: '', capabilities: [], pendingDelete: null, importProposals: [], importFileName: '', importGeneration: 0, importAbortController: null };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 2400);
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(method) && state.csrfToken) headers.set('X-CSRF-Token', state.csrfToken);
  const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw new Error(data.error?.message || data.error || data.message || `请求失败（${response.status}）`);
  }
  return data;
}

function listFrom(data, key) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.[key]) ? data[key] : Array.isArray(data?.items) ? data.items : [];
}

function normalizeCapability(item) {
  return {
    ...item,
    kind: item.kind || item.type,
    content: item.content || item.instructions,
    authorUsername: item.authorUsername || item.contributor?.displayName || ''
  };
}

function showLogin() {
  state.user = null;
  state.csrfToken = '';
  if ($('#import-dialog').open) $('#import-dialog').close();
  resetImport();
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

function showApp(session) {
  if (!session?.authenticated || !session.user) return showLogin();
  state.user = session.user;
  state.csrfToken = session.csrfToken;
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#current-user').textContent = session.user.displayName || session.user.email;
  $('#current-role').textContent = session.user.role === 'ADMIN' ? '管理员' : '成员';
  $('#avatar').textContent = (session.user.displayName || session.user.email).slice(0, 1).toUpperCase();
  $$('[data-admin]').forEach((el) => el.classList.toggle('hidden', session.user.role !== 'ADMIN'));
  navigate('library');
  refreshCompanyCapabilities();
  if (session.user.role === 'ADMIN') refreshReviewCount();
}

async function bootstrap() {
  try { showApp(await api('/api/session')); } catch { showLogin(); }
}

function navigate(page) {
  const titles = { library: ['CONTRIBUTE', '我的能力库'], provider: ['ADMIN', '上游模型'], company: ['ADMIN', '公司能力库'], reviews: ['ADMIN', '投稿审核'], users: ['ADMIN', '员工账号'] };
  $$('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
  $$('#nav button').forEach((el) => el.classList.toggle('active', el.dataset.page === page));
  $('#page-kicker').textContent = titles[page][0];
  $('#page-title').textContent = titles[page][1];
  if (page === 'library') loadCapabilities('PERSONAL');
  if (page === 'provider') loadProvider();
  if (page === 'company') loadCapabilities('COMPANY');
  if (page === 'reviews') loadSubmissions();
  if (page === 'users') loadUsers();
}

function empty(container, message) {
  container.replaceChildren();
  const el = document.createElement('div');
  el.className = 'empty';
  el.textContent = message;
  container.append(el);
}

function button(text, className, action) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = text;
  el.addEventListener('click', action);
  return el;
}

function renderCapabilities(items, scope) {
  const container = scope === 'COMPANY' ? $('#company-list') : $('#personal-list');
  container.replaceChildren();
  if (!items.length) return empty(container, scope === 'COMPANY' ? '还没有正式发布的公司能力。' : '还没有个人能力，从一个好点子开始吧。');
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'card cap-card';
    const header = document.createElement('header');
    const titleBox = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = item.name;
    const author = document.createElement('small'); author.className = 'muted'; author.textContent = item.authorUsername ? `贡献者：${item.authorUsername}` : '';
    titleBox.append(title, author);
    const kind = document.createElement('span'); kind.className = 'kind'; kind.textContent = item.kind;
    header.append(titleBox, kind);
    const description = document.createElement('p'); description.textContent = item.description;
    const meta = document.createElement('div'); meta.className = 'meta';
    const status = document.createElement('span'); status.textContent = item.enabled ? '● 已启用' : '○ 已停用';
    const priority = document.createElement('span'); priority.textContent = `优先级 ${item.priority}`;
    const slug = document.createElement('span'); slug.textContent = item.slug || item.id;
    meta.append(status, priority, slug);
    const actions = document.createElement('div'); actions.className = 'card-actions';
    actions.append(button('编辑', 'secondary', () => openCapability(scope, item)));
    if (scope === 'PERSONAL') actions.append(button('提交审核', 'primary', () => submitCapability(item.id)));
    actions.append(button('删除', 'danger', () => deleteCapability(item.id, scope)));
    card.append(header, description, meta, actions);
    container.append(card);
  }
}

async function loadCapabilities(scope) {
  try {
    const data = await api(`/api/capabilities?scope=${scope.toLowerCase()}`);
    const items = listFrom(data, 'capabilities').map(normalizeCapability);
    renderCapabilities(items, scope);
  } catch (error) { toast(error.message); }
}

async function openCapability(scope, item = null) {
  await refreshCompanyCapabilities();
  const form = $('#capability-form');
  form.reset();
  form.elements.scope.value = scope;
  form.elements.id.value = item?.id || '';
  form.elements.kind.value = item?.kind || 'AGENT';
  form.elements.name.value = item?.name || '';
  form.elements.slug.value = item?.slug || '';
  form.elements.description.value = item?.description || '';
  form.elements.content.value = item?.content || '';
  form.elements.priority.value = item?.priority ?? 100;
  form.elements.enabled.checked = item?.enabled ?? true;
  form.elements.alwaysOn.checked = item?.alwaysOn ?? item?.kind !== 'AGENT';
  const skillSelect = form.elements.skillIds;
  skillSelect.replaceChildren();
  for (const skill of state.capabilities.filter((capability) => capability.kind === 'SKILL')) {
    const option = document.createElement('option');
    option.value = skill.id;
    option.textContent = skill.name;
    option.selected = (item?.skillIds || []).includes(skill.id);
    skillSelect.append(option);
  }
  updateCapabilityFields();
  $('#dialog-title').textContent = item ? '编辑能力' : scope === 'COMPANY' ? '发布公司能力' : '创建个人能力';
  $('#capability-dialog').showModal();
}

async function saveCapability(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    type: form.elements.kind.value,
    name: form.elements.name.value.trim(),
    slug: form.elements.slug.value.trim(),
    description: form.elements.description.value.trim(),
    instructions: form.elements.content.value.trim(),
    priority: Number(form.elements.priority.value),
    enabled: form.elements.enabled.checked,
    alwaysOn: form.elements.kind.value === 'PROMPT' || form.elements.alwaysOn.checked,
    skillIds: [...form.elements.skillIds.selectedOptions].map((option) => option.value),
    scope: form.elements.scope.value.toLowerCase()
  };
  const id = form.elements.id.value;
  try {
    const requestPayload = { ...payload };
    if (id) delete requestPayload.scope;
    await api(id ? `/api/capabilities/${id}` : '/api/capabilities', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(requestPayload) });
    $('#capability-dialog').close();
    toast('能力已保存');
    await loadCapabilities(payload.scope.toUpperCase());
    refreshCompanyCapabilities();
  } catch (error) { toast(error.message); }
}

async function deleteCapability(id, scope) {
  state.pendingDelete = { id, scope };
  $('#confirm-dialog').showModal();
}

async function performDelete() {
  const pending = state.pendingDelete;
  if (!pending) return;
  try { await api(`/api/capabilities/${pending.id}`, { method: 'DELETE' }); toast('已删除'); loadCapabilities(pending.scope); refreshCompanyCapabilities(); }
  catch (error) { toast(error.message); }
  finally { state.pendingDelete = null; $('#confirm-dialog').close(); }
}

async function submitCapability(id) {
  try { await api(`/api/capabilities/${id}/submit`, { method: 'POST' }); toast('已提交给管理员审核'); }
  catch (error) { toast(error.message); }
}

async function loadSubmissions() {
  try {
    const items = listFrom(await api('/api/submissions'), 'submissions').filter((item) => item.status === 'PENDING').map((item) => ({
      ...item.snapshot,
      id: item.id,
      kind: item.snapshot.type,
      content: item.snapshot.instructions,
      authorUsername: item.author?.displayName || item.author?.email || '员工投稿'
    }));
    const container = $('#submission-list'); container.replaceChildren();
    if (!items.length) return empty(container, '当前没有待审核投稿。');
    for (const item of items) {
      const card = document.createElement('article'); card.className = 'card review-card';
      const body = document.createElement('div');
      const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = `${item.kind} · ${item.authorUsername || '员工投稿'}`;
      const title = document.createElement('h3'); title.textContent = item.name;
      const description = document.createElement('p'); description.className = 'muted'; description.textContent = item.description;
      const content = document.createElement('div'); content.className = 'review-content'; content.textContent = item.content;
      body.append(eyebrow, title, description, content);
      const actions = document.createElement('div'); actions.className = 'review-actions';
      actions.append(button('批准并发布', 'primary', () => openReview(item.id, 'APPROVED')), button('退回修改', 'danger', () => openReview(item.id, 'REJECTED')));
      card.append(body, actions); container.append(card);
    }
  } catch (error) { toast(error.message); }
}

function openReview(id, decision) {
  const form = $('#review-form');
  form.reset();
  form.elements.submissionId.value = id;
  form.elements.decision.value = decision;
  form.elements.note.required = decision === 'REJECTED';
  $('#review-dialog-title').textContent = decision === 'APPROVED' ? '批准并发布' : '退回修改';
  $('#review-dialog').showModal();
}

async function reviewSubmission(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.submissionId.value;
  const decision = form.elements.decision.value;
  const note = form.elements.note.value.trim();
  try {
    await api(`/api/submissions/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, note }) });
    $('#review-dialog').close();
    toast(decision === 'APPROVED' ? '已发布到公司能力库' : '已退回给投稿人');
    loadSubmissions(); refreshReviewCount(); refreshCompanyCapabilities();
  } catch (error) { toast(error.message); }
}

async function refreshReviewCount() {
  try {
    const items = listFrom(await api('/api/submissions'), 'submissions').filter((item) => item.status === 'PENDING');
    const badge = $('#review-count'); badge.textContent = String(items.length); badge.classList.toggle('hidden', !items.length);
  } catch { /* navigation remains usable */ }
}

async function loadProvider() {
  try {
    const data = await api('/api/provider');
    const provider = data.provider || data;
    const form = $('#provider-form');
    form.elements.baseUrl.value = provider.baseUrl || '';
    form.elements.model.value = provider.model || '';
    form.elements.apiKey.value = '';
    form.elements.apiKey.placeholder = provider.hasApiKey ? '已安全保存；留空表示保持不变' : '输入供应商 API Key';
  } catch (error) { toast(error.message); }
}

async function saveProvider(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = { baseUrl: form.elements.baseUrl.value.trim(), model: form.elements.model.value.trim() };
  if (form.elements.apiKey.value) payload.apiKey = form.elements.apiKey.value;
  try { await api('/api/provider', { method: 'PUT', body: JSON.stringify(payload) }); form.elements.apiKey.value = ''; toast('模型配置已保存'); loadProvider(); }
  catch (error) { toast(error.message); }
}

function resetImport() {
  state.importGeneration += 1;
  state.importAbortController?.abort();
  state.importAbortController = null;
  state.importProposals = [];
  state.importFileName = '';
  const form = $('#import-form');
  form.reset();
  $('#import-file-status').textContent = '支持 TXT、Markdown、JSON、YAML、TOML、XML、CSV，最大 100 KB；文件内容不会原样入库。';
  $('#import-empty').classList.remove('hidden');
  $('#import-analysis').classList.add('hidden');
  $('#import-summary').textContent = '';
  $('#import-proposals').replaceChildren();
  $('#install-import').classList.add('hidden');
  $('#install-import').disabled = false;
  $('#install-import').textContent = '安装所选到公司能力库';
  $('#analyze-import').disabled = false;
  $('#analyze-import').textContent = '让 AI 识别并评分';
}

function openImport() {
  resetImport();
  $('#import-dialog').showModal();
}

async function loadImportFile(event) {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  const allowed = /\.(txt|md|markdown|json|ya?ml|toml|xml|csv)$/i;
  if (!allowed.test(file.name)) {
    event.currentTarget.value = '';
    return toast('暂不支持这种文件格式，请上传文本类配置文件');
  }
  if (file.size > 100_000) {
    event.currentTarget.value = '';
    return toast('文件不能超过 100 KB');
  }
  try {
    const text = await file.text();
    if (!text.trim()) throw new Error('文件内容为空');
    $('#import-form').elements.sourceText.value = text;
    state.importFileName = file.name;
    $('#import-file-status').textContent = `已读取 ${file.name}（${file.size} 字节），点击分析后发送给公司上游 AI。`;
  } catch (error) { toast(error.message || '无法读取文件'); }
}

function verdictText(value) {
  return { RECOMMENDED: '推荐安装', NEEDS_REVIEW: '需要复核', REJECT: '不建议安装' }[value] || value;
}

function renderImportProposals(analysis) {
  state.importProposals = analysis.proposals;
  $('#import-summary').textContent = analysis.summary;
  const container = $('#import-proposals'); container.replaceChildren();
  analysis.proposals.forEach((proposal, index) => {
    const card = document.createElement('article'); card.className = `proposal-card${proposal.verdict === 'REJECT' ? ' reject' : ''}`;
    const heading = document.createElement('div'); heading.className = 'proposal-heading';
    const select = document.createElement('input'); select.type = 'checkbox'; select.dataset.proposalIndex = String(index);
    select.checked = false; select.disabled = proposal.verdict === 'REJECT'; select.setAttribute('aria-label', `选择 ${proposal.name}`);
    const titleBox = document.createElement('div');
    const title = document.createElement('h4'); title.textContent = proposal.name;
    const description = document.createElement('p'); description.className = 'muted'; description.textContent = `${proposal.type} · ${proposal.slug} · ${proposal.description}`;
    titleBox.append(title, description);
    const total = document.createElement('div'); total.className = 'score-total'; total.textContent = String(proposal.scores.overall); total.title = 'AI 综合评分';
    heading.append(select, titleBox, total);
    const verdict = document.createElement('span'); verdict.className = `verdict${proposal.verdict === 'REJECT' ? ' reject' : ''}`; verdict.textContent = verdictText(proposal.verdict);
    const scores = document.createElement('div'); scores.className = 'score-grid';
    for (const [label, value] of [['清晰度', proposal.scores.clarity], ['复用性', proposal.scores.reusability], ['安全性', proposal.scores.safety]]) {
      const item = document.createElement('span'); item.textContent = `${label} ${value}`; scores.append(item);
    }
    const rationale = document.createElement('p'); rationale.className = 'muted'; rationale.textContent = proposal.rationale;
    const instructions = document.createElement('div'); instructions.className = 'proposal-instructions'; instructions.textContent = proposal.instructions;
    const injectionMode = proposal.type === 'PROMPT' || proposal.alwaysOn ? '每次请求注入' : proposal.type === 'AGENT' ? '选择该 Agent 时注入' : '仅被 Agent 绑定时注入';
    const installMeta = document.createElement('p'); installMeta.className = 'proposal-install-meta';
    installMeta.textContent = `优先级 ${proposal.priority} · 安装后立即启用 · ${injectionMode}`;
    card.append(heading, verdict, scores, rationale, installMeta);
    if (proposal.type === 'AGENT') {
      const bindings = document.createElement('p'); bindings.className = 'proposal-bindings';
      bindings.textContent = `关联 Skills：${proposal.skillSlugs.length ? proposal.skillSlugs.join('、') : '无'}`;
      card.append(bindings);
    }
    card.append(instructions);
    if (proposal.risks.length) {
      const risks = document.createElement('ul'); risks.className = 'proposal-risks';
      for (const risk of proposal.risks) { const item = document.createElement('li'); item.textContent = risk; risks.append(item); }
      card.append(risks);
    }
    container.append(card);
  });
  $('#import-empty').classList.add('hidden');
  $('#import-analysis').classList.remove('hidden');
  $('#install-import').classList.remove('hidden');
  $('#analyze-import').textContent = '按补充要求重新分析';
}

async function analyzeImport(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const sourceText = form.elements.sourceText.value.trim();
  if (!sourceText) return toast('请粘贴文字或上传文件');
  state.importAbortController?.abort();
  const controller = new AbortController();
  state.importAbortController = controller;
  const generation = ++state.importGeneration;
  const button = $('#analyze-import'); button.disabled = true; button.textContent = 'AI 正在识别与评分…';
  const payload = { sourceText };
  if (state.importFileName) payload.fileName = state.importFileName;
  if (form.elements.guidance.value.trim()) payload.guidance = form.elements.guidance.value.trim();
  if (state.importProposals.length) payload.currentProposals = state.importProposals;
  try {
    const data = await api('/api/admin/capability-import/analyze', { method: 'POST', body: JSON.stringify(payload), signal: controller.signal });
    if (generation !== state.importGeneration || state.user?.role !== 'ADMIN' || !$('#import-dialog').open) return;
    renderImportProposals(data.analysis);
  } catch (error) {
    if (generation === state.importGeneration && error.name !== 'AbortError') toast(error.message);
  } finally {
    if (generation === state.importGeneration) {
      state.importAbortController = null;
      button.disabled = false;
      button.textContent = state.importProposals.length ? '按补充要求重新分析' : '让 AI 识别并评分';
    }
  }
}

async function installImport() {
  const indexes = [...document.querySelectorAll('[data-proposal-index]:checked')].map((input) => Number(input.dataset.proposalIndex));
  const selected = indexes.map((index) => state.importProposals[index]).filter(Boolean);
  if (!selected.length) return toast('请至少选择一个可安装候选项');
  const button = $('#install-import'); button.disabled = true; button.textContent = '正在安装…';
  try {
    const result = await api('/api/admin/capability-import/install', { method: 'POST', body: JSON.stringify({ proposals: selected }) });
    const installed = listFrom(result, 'capabilities').length;
    const skipped = listFrom(result, 'skippedSlugs').length;
    await loadCapabilities('COMPANY'); await refreshCompanyCapabilities();
    $('#import-dialog').close();
    toast(`已安装 ${installed} 项${skipped ? `，跳过 ${skipped} 个同名能力` : ''}`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = '安装所选到公司能力库'; }
}

async function refreshCompanyCapabilities() {
  try {
    const companyData = await api('/api/capabilities?scope=company');
    const items = listFrom(companyData, 'capabilities').map((item) => ({ ...normalizeCapability(item), scope: 'COMPANY' })).filter((item) => item.enabled);
    state.capabilities = items;
  } catch { /* capability pages report their own loading errors */ }
}

function updateCapabilityFields() {
  const kind = $('#capability-form').elements.kind.value;
  $('#skill-binding-field').classList.toggle('hidden', kind !== 'AGENT');
  $('#always-on-field').classList.toggle('hidden', kind === 'AGENT');
}

async function loadUsers() {
  try {
    const users = listFrom(await api('/api/admin/users'), 'users');
    const container = $('#user-list'); container.replaceChildren();
    for (const user of users) {
      const row = document.createElement('div'); row.className = 'user-row';
      const name = document.createElement('strong'); name.textContent = user.displayName || user.email;
      const role = document.createElement('small'); role.textContent = user.role === 'ADMIN' ? '管理员' : '成员';
      row.append(name, role); container.append(row);
    }
  } catch (error) { toast(error.message); }
}

async function createUser(event) {
  event.preventDefault(); const form = event.currentTarget;
  try { await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value.trim(), displayName: form.elements.displayName.value.trim(), password: form.elements.password.value }) }); form.reset(); toast('员工账号已创建'); loadUsers(); }
  catch (error) { toast(error.message); }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; $('#login-error').textContent = '';
  try { showApp(await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value.trim(), password: form.elements.password.value }) })); form.reset(); }
  catch (error) { $('#login-error').textContent = error.message; }
});
$('#logout').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST' }); } finally { showLogin(); } });
$('#nav').addEventListener('click', (event) => { const target = event.target.closest('[data-page]'); if (target) navigate(target.dataset.page); });
$$('[data-open-capability]').forEach((el) => el.addEventListener('click', () => openCapability(el.dataset.scope)));
$$('[data-close-dialog]').forEach((el) => el.addEventListener('click', () => $('#capability-dialog').close()));
$('#capability-form').addEventListener('submit', saveCapability);
$('#capability-form').elements.kind.addEventListener('change', updateCapabilityFields);
$('#review-form').addEventListener('submit', reviewSubmission);
$$('[data-close-review]').forEach((el) => el.addEventListener('click', () => $('#review-dialog').close()));
$('#confirm-form').addEventListener('submit', (event) => { event.preventDefault(); performDelete(); });
$$('[data-close-confirm]').forEach((el) => el.addEventListener('click', () => { state.pendingDelete = null; $('#confirm-dialog').close(); }));
$('#provider-form').addEventListener('submit', saveProvider);
$('#open-import').addEventListener('click', openImport);
$('#import-form').addEventListener('submit', analyzeImport);
$('#import-form').elements.sourceFile.addEventListener('change', loadImportFile);
$('#install-import').addEventListener('click', installImport);
$$('[data-close-import]').forEach((el) => el.addEventListener('click', () => $('#import-dialog').close()));
$('#import-dialog').addEventListener('close', resetImport);
$('#user-form').addEventListener('submit', createUser);

bootstrap();
