const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const ui = { state: null, view: 'tracker', search: '', status: '', toastTimer: null };

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = options.text;
  if (options.value != null) node.value = options.value;
  if (options.href) { node.href = options.href; node.target = '_blank'; node.rel = 'noreferrer'; }
  for (const [name, value] of Object.entries(options.dataset || {})) node.dataset[name] = value;
  for (const child of children.filter(Boolean)) node.append(child);
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Career-Ops-UI': '1', ...(options.headers || {}) },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Career-Ops request failed.');
  return result;
}

function showToast(message, error = false) {
  const toast = $('#toast');
  clearTimeout(ui.toastTimer);
  toast.textContent = message;
  toast.classList.toggle('is-error', error);
  toast.hidden = false;
  ui.toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function showFormError(form, message = '') {
  const target = form.querySelector('[data-form-error]');
  target.textContent = message;
  target.hidden = !message;
}

function setBusy(form, busy) {
  for (const control of form.elements) {
    if (busy) control.dataset.wasDisabled = String(control.disabled);
    control.disabled = busy || control.dataset.wasDisabled === 'true';
    if (!busy) delete control.dataset.wasDisabled;
  }
}

function statusOptions(select, { all = false, selected = '' } = {}) {
  select.replaceChildren();
  if (all) select.append(element('option', { text: 'All statuses' }));
  for (const status of ui.state.statuses) select.append(element('option', { value: status.label, text: status.label }));
  select.value = selected;
}

function chooseView(view) {
  ui.view = view;
  for (const button of $$('.nav-item')) {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  $('#tracker-view').hidden = view !== 'tracker';
  $('#guide-view').hidden = view !== 'guide';
  $('#view-title').textContent = view === 'tracker' ? 'Job tracker' : 'How to use Career-Ops';
  $('#view-subtitle').textContent = view === 'tracker'
    ? 'Saved jobs and applications in one place. Update status directly in the table.'
    : 'A short reference for the normal workflow and resume choices.';
}

function missing(value, fallback = '—') { return value || fallback; }
function fileLink(path, label = 'Open PDF') { return element('a', { text: label, href: `/files?path=${encodeURIComponent(path)}` }); }

function inlineStatus(record) {
  const select = element('select', { className: 'status-select' });
  select.setAttribute('aria-label', `Status for ${record.company || record.role || 'job'}`);
  statusOptions(select, { selected: record.status });
  select.addEventListener('change', async () => {
    const previous = record.status;
    select.disabled = true;
    try {
      ui.state = await api('/api/records/update', {
        method: 'POST',
        body: JSON.stringify({ ...record, recordId: record.id, status: select.value }),
      });
      renderTracker();
      showToast(`Status updated to ${select.value}.`);
    } catch (error) {
      select.value = previous;
      select.disabled = false;
      showToast(error.message, true);
    }
  });
  return select;
}

function resumeCell(record) {
  const wrap = element('div', { className: 'resume-cell' });
  if (record.pdfPath) wrap.append(fileLink(record.pdfPath));
  else wrap.append(element('span', { className: 'missing', text: record.resumePlan === 'career-ops' ? 'Career-Ops review' : '—' }));
  if (record.resumePlan === 'career-ops') {
    const prepare = element('button', { className: 'button text', text: 'Prepare', dataset: { prepare: record.id } });
    wrap.append(prepare);
  }
  return wrap;
}

function renderTracker() {
  const query = ui.search;
  const records = ui.state.records.filter(record => {
    const haystack = [record.company, record.role, record.location, record.notes, record.url, record.compensation].join(' ').toLowerCase();
    return (!query || haystack.includes(query)) && (!ui.status || record.status === ui.status);
  });
  $('#record-count').textContent = ui.state.records.length;
  $('#record-result-count').textContent = `${records.length} ${records.length === 1 ? 'job' : 'jobs'}`;
  const body = $('#record-rows');
  body.replaceChildren();
  for (const record of records) {
    const company = element('td', { text: missing(record.company, 'Unknown company') });
    const role = element('td', {}, [element('span', { text: missing(record.role, 'Unspecified role') })]);
    if (record.notes) role.append(element('span', { className: 'cell-note', text: record.notes }));
    const url = element('td', {}, [record.url ? element('a', { text: 'Open job', href: record.url }) : element('span', { className: 'missing', text: '—' })]);
    const actions = element('td', { className: 'row-actions' }, [
      element('button', { className: 'button text', text: 'Edit', dataset: { edit: record.id } }),
      element('button', { className: 'button text danger-text', text: 'Delete', dataset: { delete: record.id } }),
    ]);
    body.append(element('tr', { dataset: { recordId: record.id } }, [
      company,
      role,
      element('td', {}, [inlineStatus(record)]),
      url,
      element('td', { className: 'date-cell', text: missing(record.dateSubmitted) }),
      element('td', { text: missing(record.location) }),
      element('td', { className: 'date-cell', text: missing(record.deadline) }),
      element('td', { text: missing(record.compensation) }),
      element('td', {}, [resumeCell(record)]),
      actions,
    ]));
  }
  $('#record-empty').hidden = records.length > 0;
}

function fillResumeOptions(select, record = {}) {
  select.replaceChildren();
  select.append(element('option', { value: 'none', text: 'No resume' }));
  select.append(element('option', { value: 'career-ops', text: 'Ask Career-Ops to decide' }));
  if (ui.state.baselines.length) {
    const group = element('optgroup');
    group.label = 'Baselines';
    for (const resume of ui.state.baselines) group.append(element('option', { value: `baseline:${resume.path}`, text: `${resume.directory}/${resume.name}` }));
    select.append(group);
  }
  if (ui.state.resumes.length) {
    const group = element('optgroup');
    group.label = 'Existing generated PDFs';
    for (const resume of ui.state.resumes) group.append(element('option', { value: `pdf:${resume.path}`, text: `${resume.directory}/${resume.name}` }));
    select.append(group);
  }
  const current = record.resumePlan === 'career-ops' ? 'career-ops'
    : record.resumePlan === 'baseline' && record.resumeSource ? `baseline:${record.resumeSource}`
      : record.pdfPath ? `pdf:${record.pdfPath}` : 'none';
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function openRecordDialog(record = null) {
  const form = $('#record-form');
  form.reset();
  showFormError(form);
  statusOptions(form.elements.status, { selected: record?.status || 'Saved' });
  fillResumeOptions(form.elements.resumeChoice, record || {});
  $('#record-dialog-title').textContent = record ? 'Edit job' : 'Add job';
  if (record) {
    form.elements.recordId.value = record.id;
    for (const name of ['company', 'role', 'url', 'dateSubmitted', 'location', 'deadline', 'compensation', 'notes']) {
      form.elements[name].value = record[name] === '?' || record[name] === 'Unspecified role' ? '' : (record[name] || '');
    }
  }
  $('#record-dialog').showModal();
  form.elements.company.focus();
}

function openDeleteDialog(record) {
  const form = $('#delete-form');
  form.reset();
  showFormError(form);
  form.elements.recordId.value = record.id;
  $('#delete-record-label').textContent = `${record.company || 'Unknown company'} · ${record.role || 'Unspecified role'}`;
  $('#delete-dialog').showModal();
}

function formObject(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  for (const checkbox of form.querySelectorAll('input[type="checkbox"]')) data[checkbox.name] = checkbox.checked;
  return data;
}

async function submitForm(form, path, successMessage) {
  const payload = formObject(form);
  showFormError(form);
  setBusy(form, true);
  try {
    ui.state = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    renderTracker();
    form.closest('dialog')?.close();
    showToast(successMessage);
    return true;
  } catch (error) {
    showFormError(form, error.message);
    showToast(error.message, true);
    return false;
  } finally {
    setBusy(form, false);
  }
}

async function refresh({ quiet = false } = {}) {
  try {
    const firstLoad = !ui.state;
    ui.state = await api('/api/state');
    statusOptions($('#status-filter'), { all: true, selected: ui.status });
    renderTracker();
    $('#loading-state').hidden = true;
    $('#tracker-view').hidden = false;
    chooseView(ui.view);
    if (!quiet && !firstLoad) showToast('Tracker refreshed.');
  } catch (error) {
    $('#loading-state').textContent = error.message;
    showToast(error.message, true);
  }
}

function bindEvents() {
  for (const button of $$('.nav-item')) button.addEventListener('click', () => chooseView(button.dataset.view));
  $('#refresh-button').addEventListener('click', () => refresh());
  $('#add-record-button').addEventListener('click', () => openRecordDialog());
  for (const button of $$('[data-open-record]')) button.addEventListener('click', () => openRecordDialog());
  for (const button of $$('[data-close-dialog]')) button.addEventListener('click', () => button.closest('dialog').close());
  for (const dialog of $$('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  $('#record-search').addEventListener('input', event => { ui.search = event.target.value.trim().toLowerCase(); renderTracker(); });
  $('#status-filter').addEventListener('change', event => { ui.status = event.target.value; renderTracker(); });

  $('#record-rows').addEventListener('click', async event => {
    const editId = event.target.closest('[data-edit]')?.dataset.edit;
    const deleteId = event.target.closest('[data-delete]')?.dataset.delete;
    const prepareId = event.target.closest('[data-prepare]')?.dataset.prepare;
    const record = ui.state.records.find(item => item.id === (editId || deleteId || prepareId));
    if (!record) return;
    if (editId) openRecordDialog(record);
    else if (deleteId) openDeleteDialog(record);
    else if (prepareId) {
      event.target.disabled = true;
      try {
        const result = await api('/api/powershell', { method: 'POST', body: JSON.stringify({ recordId: record.id }) });
        showToast(result.message);
      } catch (error) { showToast(error.message, true); }
      finally { event.target.disabled = false; }
    }
  });

  $('#record-form').addEventListener('submit', async event => {
    event.preventDefault();
    const editing = Boolean(event.currentTarget.elements.recordId.value);
    await submitForm(event.currentTarget, editing ? '/api/records/update' : '/api/records', editing ? 'Job updated.' : 'Job added.');
  });
  $('#delete-form').addEventListener('submit', async event => {
    event.preventDefault();
    await submitForm(event.currentTarget, '/api/records/delete', 'Tracker row deleted. Files were preserved.');
  });
  $('#powershell-button').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      const result = await api('/api/powershell', { method: 'POST', body: '{}' });
      showToast(result.message);
    } catch (error) { showToast(error.message, true); }
    finally { event.currentTarget.disabled = false; }
  });
}

bindEvents();
refresh({ quiet: true });
