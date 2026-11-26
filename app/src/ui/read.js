// "Read a Korean sign": type or paste Korean text, or choose a photo, and get a card with what it means in
// English and what to do. All AI work goes through the engine (engine.runTask('sign', ...)); this file only
// prepares the input and draws the card the app defines (it never asks the AI for screen code).
// No camera: the photo comes from a file the person chooses (the site sends Permissions-Policy camera=()).

const MAX_SIDE = 1600; // larger photos are scaled down before they are read (phone photos are 4000 px wide)
const KEEP_TYPES = ['image/jpeg', 'image/png']; // the on-device model takes these two as they are
export function setupRead({ $, el, toast, engine, results }) {
  const form = $('read-form');
  const textBox = $('read-text');
  const fileBox = $('read-photo');
  const card = $('read-card');
  let busy = false;

  showEmpty();

  form.addEventListener('submit', (e) => { e.preventDefault(); run({ text: textBox.value }); });
  textBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run({ text: textBox.value }); } });
  fileBox.addEventListener('change', async () => {
    const f = fileBox.files?.[0];
    fileBox.value = '';
    if (!f) return;
    let image;
    try { image = await photoOf(f); } catch (err) { toast(err.message); return; }
    run({ image });
  });
  $('read-clear').addEventListener('click', () => { textBox.value = ''; showEmpty(); textBox.focus(); });

  function showEmpty() {
    card.className = 'read-card empty';
    card.removeAttribute('data-id');
    card.replaceChildren(
      el('h2', { text: 'What does this Korean say?' }),
      el('p', { className: 'muted', text: 'Paste or type the Korean words from a sign, menu or notice, or choose a photo of it. You get the meaning in English, line by line, and what to do.' }),
      el('ul', { className: 'ready' },
        el('li', { className: 'ok' }, el('strong', { text: 'One line of typed text:' }), ' read by the on-device AI on this computer, even with no internet.'),
        el('li', { className: 'ok' }, el('strong', { text: 'Several lines (a menu, a notice):' }), ' read by the cloud AI while you are online. With no internet, the on-device AI reads them, but it may explain dish names less well.'),
        el('li', { className: 'ok' }, el('strong', { text: 'Photos:' }), ' read by the cloud AI while you are online. With no internet, type or paste the words instead.')),
    );
  }

  async function run(input) {
    const eng = engine();
    if (!eng) { toast('The app is still starting. Try again in a moment.'); return; }
    if (busy) return;
    busy = true;
    form.classList.add('busy');
    const offlineAtAsk = !navigator.onLine;
    drawWorking(input);
    let r;
    try {
      r = await eng.runTask('sign', input, { onPartial: (p) => drawPartial(p) });
    } finally { busy = false; form.classList.remove('busy'); }
    r.offlineAtAsk = offlineAtAsk;
    if (input.image) r.photoUrl = input.image.url;
    if (r.status === 'invalid') { toast(r.reasonText); showEmpty(); results.push(r); return; }
    drawCard(r);
    results.push(r);
  }

  function drawWorking(input) {
    card.className = 'read-card';
    card.removeAttribute('data-id');
    // replaceChildren() writes a null argument as the text "null", so the photo is left out when there is none
    card.replaceChildren(...[
      input.image ? el('div', { className: 'gc-photo' }, el('img', { src: input.image.url, alt: 'Your photo' })) : null,
      el('div', { className: 'gc-rows', id: 'read-live' }),
      el('div', { className: 'meta' }, el('span', { className: 'badge-source b-wait', id: 'read-status', text: 'Working' })),
    ].filter(Boolean));
  }

  function drawPartial(p) {
    const status = card.querySelector('#read-status');
    if (status) status.textContent = p.where === 'cloud' ? 'Asking the cloud AI…' : p.where === 'device' ? 'Reading on this computer…' : 'Working';
    const live = card.querySelector('#read-live');
    if (!live || !p.card) return;
    live.replaceChildren(...p.card.rows.filter((x) => x.en || x.ko).map((x) => rowView({ ...x, enText: x.en, price: null }, true)));
  }

  function drawCard(r) {
    card.className = 'read-card';
    card.dataset.id = r.id;
    const rec = r.record;
    const parts = [];
    if (r.photoUrl) parts.push(el('div', { className: 'gc-photo' }, el('img', { src: r.photoUrl, alt: 'Your photo' })));
    if (r.status !== 'done') {
      if (r.kind === 'text' && r.input?.text) parts.push(el('div', { className: 'gc-source', lang: 'ko', text: r.input.text }));
      parts.push(el('p', { className: `gc-notice ${r.blockedBy ? 'offline' : 'failed'}`, id: 'read-notice', text: r.reasonText || 'Could not explain this.' }));
      if (r.reload) parts.push(el('button', { type: 'button', className: 'reload-page', id: 'read-reload', text: 'Reload the page', onclick: () => location.reload() }));
    } else if (!rec.found) {
      parts.push(el('p', { className: 'gc-notice', id: 'read-notice', text: r.kind === 'photo' ? 'No Korean text could be read in this photo. Try a clearer, closer photo, or type the Korean words.' : 'The AI could not explain this text. Please try again.' }));
    } else {
      const single = r.kind === 'text' && rec.rows.length === 1;
      parts.push(el('div', { className: 'gc-label', text: r.kind === 'photo' ? 'Read from your photo' : single ? 'Korean text' : `Korean text · ${rec.rows.length} lines` }));
      if (single) {
        const x = rec.rows[0];
        parts.push(el('div', { className: 'gc-single' }, el('div', { className: 'gc-ko big', lang: 'ko', text: x.ko }), el('div', { className: 'gc-en big', text: x.en ? `${x.enText || x.en}${x.price ? `, ${x.price}` : ''}` : '(no meaning given)' })));
      } else {
        parts.push(el('div', { className: 'gc-rows', id: 'read-rows' }, rec.rows.map((x) => rowView(x))));
      }
      if (rec.todo) parts.push(el('div', { className: 'gc-todo', id: 'read-todo' }, el('span', { className: 'gc-todo-h', text: 'What to do' }), el('span', { text: rec.todo })));
      if (rec.note) parts.push(el('p', { className: 'gc-note', id: 'read-note', text: rec.note }));
    }
    const b = badge(r);
    parts.push(el('div', { className: 'meta' },
      el('span', { className: `badge-source ${b.cls}`, id: 'read-badge', text: b.text }),
      r.timing?.totalMs != null ? el('span', { className: 'muted', id: 'read-time', text: `${(r.timing.totalMs / 1000).toFixed(1)} s` }) : null,
      el('span', { className: 'muted', text: r.offlineAtAsk ? 'Asked offline' : 'Asked online' }),
      r.status === 'done' ? el('span', { className: 'muted', text: r.reasonText }) : null,
      r.raw ? el('details', { className: 'given' }, el('summary', { text: 'What the AI wrote' }), el('pre', { text: r.raw })) : null));
    card.replaceChildren(...parts);
  }

  function rowView(x, live = false) {
    return el('div', { className: `gc-row${x.missing ? ' missing' : ''}${live ? ' live' : ''}` },
      el('div', { className: 'gc-main' },
        el('div', { className: 'gc-en', text: x.enText || x.en || (x.missing ? '(no meaning given for this line)' : '') }),
        x.ko ? el('div', { className: 'gc-ko', lang: 'ko', text: x.ko }) : null),
      x.price ? el('div', { className: 'gc-price', text: x.price }) : null);
  }
}

function badge(r) {
  if (r.status === 'done' && r.source === 'on_device') return { text: 'On-device AI', cls: 'b-device' };
  if (r.status === 'done' && r.source === 'in_cloud') return { text: 'Cloud AI', cls: 'b-cloud' };
  if (r.blockedBy === 'offline') return { text: 'Offline', cls: 'b-none' };
  return { text: 'Not answered', cls: 'b-none' };
}

/** A chosen file -> { data (base64), mimeType, url (for the preview), size }. Large or unusual photos are redrawn as JPEG. */
async function photoOf(file) {
  if (!/^image\//.test(file.type)) throw new Error('Choose a photo (JPEG or PNG).');
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('This photo could not be opened. Choose a JPEG or PNG photo.');
  const { width, height } = bmp;
  let blob = file;
  if (!KEEP_TYPES.includes(file.type) || Math.max(width, height) > MAX_SIDE) {
    const k = Math.min(1, MAX_SIDE / Math.max(width, height));
    const c = document.createElement('canvas');
    c.width = Math.round(width * k);
    c.height = Math.round(height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
  }
  bmp.close?.();
  const data = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = () => no(new Error('This photo could not be read.')); fr.readAsDataURL(blob); });
  return { data, mimeType: blob.type || 'image/jpeg', url: URL.createObjectURL(blob), name: file.name, bytes: blob.size, width, height };
}
