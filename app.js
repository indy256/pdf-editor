const $ = (id) => document.getElementById(id);
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const state = { bytes: null, source: null, preview: null, loadingTask: null, name: '', order: [], original: [], selected: new Set(), history: [], cards: new Map(), images: new Map(), addedPages: new Map(), addedTasks: new Set(), nextId: 0, busy: false, revision: 0 };
let pdfjs;
let observer;
let draggedId = null;
let renderQueue = [];
let rendering = false;

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
  $('message').hidden = !text;
}

function setBusy(busy, label = '') {
  state.busy = busy;
  $('loading-label').textContent = label;
  $('loading').hidden = !busy;
  document.querySelector('main').inert = busy;
}

async function libraries() {
  if (!globalThis.PDFLib) throw new Error('The PDF library could not load. Please reload the page.');
  if (!pdfjs) {
    pdfjs = await import('./vendor/pdfjs/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/build/pdf.worker.mjs', import.meta.url).href;
  }
}

function createPdfTask(bytes) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href,
    wasmUrl: new URL('./vendor/pdfjs/wasm/', import.meta.url).href,
    isEvalSupported: false,
  });
  task.onPassword = () => { task.destroy().catch(() => {}); };
  return task;
}

function pdfPage(id) {
  return state.addedPages.get(id) || { source: state.source, preview: state.preview, index: id };
}

async function openFile(file) {
  if (!file || state.busy) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    message('Please choose a PDF document (.pdf).', true);
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    message('This PDF is too large. Please choose a file under 100 MB.', true);
    return;
  }
  setBusy(true, 'Opening your PDF…');
  message('');
  let loadingTask;
  let newPreview;
  try {
    await libraries();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const source = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    if (!source.getPageCount()) throw new Error('This document has no pages to organize.');
    loadingTask = createPdfTask(bytes);
    newPreview = await loadingTask.promise;
    if (newPreview.numPages !== source.getPageCount()) throw new Error('This PDF has an inconsistent page structure and cannot be edited.');
    observer?.disconnect();
    renderQueue = [];
    state.revision++;
    const oldTask = state.loadingTask;
    const oldAddedTasks = state.addedTasks;
    Object.assign(state, { bytes, source, preview: newPreview, loadingTask, name: file.name, order: Array.from({ length: source.getPageCount() }, (_, index) => index), selected: new Set(), history: [], cards: new Map(), images: new Map(), addedPages: new Map(), addedTasks: new Set(), nextId: source.getPageCount() });
    state.original = [...state.order];
    if (oldTask) oldTask.destroy().catch(() => {});
    for (const task of oldAddedTasks) task.destroy().catch(() => {});
    $('file-name').textContent = state.name;
    $('file-details').textContent = `${state.original.length} original ${state.original.length === 1 ? 'page' : 'pages'} · ${formatSize(file.size)} · PDF document`;
    $('upload-view').hidden = true;
    $('editor-view').hidden = false;
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          const id = Number(entry.target.dataset.id);
          const { preview, index } = pdfPage(id);
          renderQueue.push({ card: entry.target, id, preview, index, revision: state.revision });
        }
      }
      renderPreviews();
    }, { rootMargin: '350px' });
    drawPages();
  } catch (error) {
    if (loadingTask) await loadingTask.destroy().catch(() => {});
    const protectedFile = /encrypt|password/i.test(`${error.name} ${error.message}`);
    message(protectedFile ? 'This PDF is password-protected. Please unlock it before opening it here.' : `Could not open this PDF. ${/no pages|inconsistent|library could not/.test(error.message) ? error.message : 'The file may be damaged or unsupported. Please try another document.'}`, true);
  } finally {
    setBusy(false);
    $('file-input').value = '';
  }
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function pageName(id) {
  const added = state.addedPages.get(id);
  if (added) return `${added.name} page ${added.index + 1}`;
  return state.images.has(id) ? `JPG ${state.images.get(id).name}` : `original page ${id + 1}`;
}

function isJpeg(file) { return /\.jpe?g$/i.test(file.name) || file.type === 'image/jpeg'; }

async function addPdfs(files) {
  files = Array.from(files);
  if (state.busy || !files.length) return;
  const tasks = [];
  let committed = false;
  try {
    if (!state.source) throw new Error('Open a PDF first, then add more PDF pages.');
    if (files.some((file) => !/\.pdf$/i.test(file.name) && file.type !== 'application/pdf')) throw new Error('Please choose only PDF documents.');
    if (files.reduce((total, file) => total + file.size, 0) > MAX_FILE_SIZE) throw new Error('Please add up to 100 MB of PDF files at a time.');
    setBusy(true, 'Adding PDF pages…');
    message('');
    const pending = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const source = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
        if (!source.getPageCount()) throw new Error('This PDF has no pages.');
        const task = createPdfTask(bytes);
        tasks.push(task);
        const preview = await task.promise;
        if (preview.numPages !== source.getPageCount()) throw new Error('The page structure is inconsistent.');
        for (let index = 0; index < source.getPageCount(); index++) pending.push({ source, preview, index, name: file.name });
      } catch (error) {
        const reason = /encrypt|password/i.test(`${error.name} ${error.message}`) ? 'Please unlock this password-protected PDF first.' : 'The PDF may be damaged, empty, or unsupported.';
        throw new Error(`Could not add "${file.name}". ${reason}`);
      }
    }
    remember();
    for (const page of pending) {
      const id = state.nextId++;
      state.addedPages.set(id, page);
      state.order.push(id);
    }
    tasks.forEach((task) => state.addedTasks.add(task));
    committed = true;
    state.selected.clear();
    drawPages();
    message(`${pending.length} PDF ${pending.length === 1 ? 'page added' : 'pages added'} at the end. Drag or use the arrows to move them.`);
  } catch (error) {
    message(error.message, true);
  } finally {
    if (!committed) await Promise.all(tasks.map((task) => task.destroy().catch(() => {})));
    setBusy(false);
    $('append-pdf-input').value = '';
  }
}

async function addImages(files) {
  files = Array.from(files);
  if (state.busy || !files.length) return;
  try {
    if (!state.source) throw new Error('Open a PDF first, then add JPG pages.');
    if (files.some((file) => !isJpeg(file))) throw new Error('Please choose only JPG or JPEG images.');
    if (files.reduce((total, file) => total + file.size, 0) > MAX_FILE_SIZE) throw new Error('Please add up to 100 MB of JPG files at a time.');
    setBusy(true, 'Adding JPG pages…');
    message('');
    const pending = [];
    // Prepare the whole batch before committing it, so a bad file cannot leave a partial edit.
    for (const file of files) {
      let bitmap;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const probe = await PDFLib.PDFDocument.create();
        const jpeg = await probe.embedJpg(bytes);
        if (jpeg.width * jpeg.height > 25_000_000) throw new Error('Image exceeds 25 megapixels.');
        bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { imageOrientation: 'from-image' });
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d').drawImage(bitmap, 0, 0);
        // Lossless normalization makes EXIF-rotated photos match their previews in the PDF.
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('Image could not be decoded.');
        const thumbnail = document.createElement('canvas');
        const scale = Math.min(360 / bitmap.width, 460 / bitmap.height);
        thumbnail.width = Math.max(1, Math.round(bitmap.width * scale));
        thumbnail.height = Math.max(1, Math.round(bitmap.height * scale));
        thumbnail.getContext('2d').drawImage(bitmap, 0, 0, thumbnail.width, thumbnail.height);
        thumbnail.setAttribute('role', 'img');
        thumbnail.setAttribute('aria-label', `Preview of JPG ${file.name}`);
        pending.push({ name: file.name, bytes: new Uint8Array(await blob.arrayBuffer()), width: bitmap.width, height: bitmap.height, thumbnail });
        canvas.width = canvas.height = 0;
      } catch (error) {
        throw new Error(`Could not add "${file.name}". ${/25 megapixels/.test(error.message) ? error.message : 'Please use a valid JPG image.'}`);
      } finally { bitmap?.close(); }
    }
    remember();
    for (const image of pending) {
      const id = state.nextId++;
      state.images.set(id, image);
      state.order.push(id);
    }
    state.selected.clear();
    drawPages();
    message(`${pending.length} JPG ${pending.length === 1 ? 'page added' : 'pages added'} at the end. Drag or use the arrows to move them.`);
  } catch (error) {
    message(error.message, true);
  } finally {
    setBusy(false);
    $('image-input').value = '';
  }
}

async function renderPreviews() {
  if (rendering) return;
  rendering = true;
  try {
    while (renderQueue.length) {
      const { card, id, preview, index, revision } = renderQueue.shift();
      if (revision !== state.revision) continue;
      try {
        const page = await preview.getPage(index + 1);
        if (revision !== state.revision) continue;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(360 / base.width, 460 / base.height) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `Preview of ${pageName(id)}`);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        if (revision !== state.revision) continue;
        card.querySelector('.preview-placeholder')?.remove();
        card.querySelector('.page-preview').append(canvas);
        page.cleanup();
      } catch {
        if (revision === state.revision) {
          const placeholder = card.querySelector('.preview-placeholder');
          if (placeholder) placeholder.textContent = 'Preview unavailable. This page can still be organized.';
        }
      }
    }
  } finally { rendering = false; }
}

function actionButton(name, className, label, action) {
  const button = document.createElement('button');
  button.className = `icon-button ${className}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  button.addEventListener('click', action);
  return button;
}

function createCard(id) {
  const card = document.createElement('article');
  card.className = 'page-card';
  card.dataset.id = id;
  card.setAttribute('role', 'listitem');
  const preview = document.createElement('div');
  preview.className = 'page-preview';
  preview.draggable = true;
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'page-checkbox';
  checkbox.setAttribute('aria-label', `Select ${pageName(id)}`);
  checkbox.addEventListener('change', () => {
    checkbox.checked ? state.selected.add(id) : state.selected.delete(id);
    updateControls();
  });
  const grip = icon('grip');
  grip.classList.add('grip');
  const placeholder = document.createElement('span');
  placeholder.className = 'preview-placeholder';
  placeholder.textContent = 'Loading preview…';
  preview.append(checkbox, grip, placeholder);
  const caption = document.createElement('div');
  caption.className = 'page-caption';
  const label = document.createElement('div');
  label.className = 'page-label';
  const actions = document.createElement('div');
  actions.className = 'page-actions';
  actions.append(
    actionButton('arrow', 'previous', `Move ${pageName(id)} earlier`, () => movePage(id, state.order.indexOf(id) - 1, 'previous')),
    actionButton('arrow', 'next', `Move ${pageName(id)} later`, () => movePage(id, state.order.indexOf(id) + 1, 'next')),
    actionButton('trash', 'remove', `Remove ${pageName(id)}`, () => removePages([id])),
  );
  caption.append(label, actions);
  card.append(preview, caption);
  preview.addEventListener('dragstart', (event) => {
    if (event.target === checkbox) { event.preventDefault(); return; }
    draggedId = id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(id));
    card.classList.add('dragging');
  });
  preview.addEventListener('dragend', clearDrag);
  card.addEventListener('dragover', (event) => {
    if (draggedId === null || draggedId === id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    card.classList.add('drop-target');
  });
  card.addEventListener('dragleave', (event) => { if (!card.contains(event.relatedTarget)) card.classList.remove('drop-target'); });
  card.addEventListener('drop', (event) => {
    if (draggedId === null) return;
    event.preventDefault();
    const from = draggedId;
    clearDrag();
    movePage(from, state.order.indexOf(id));
  });
  state.cards.set(id, card);
  if (state.images.has(id)) {
    placeholder.remove();
    preview.append(state.images.get(id).thumbnail);
  } else {
    observer.observe(card);
  }
  return card;
}

function clearDrag() {
  draggedId = null;
  document.querySelectorAll('.dragging, .drop-target').forEach((element) => element.classList.remove('dragging', 'drop-target'));
}

function drawPages() {
  const fragment = document.createDocumentFragment();
  state.order.forEach((id, index) => {
    const card = state.cards.get(id) || createCard(id);
    const label = card.querySelector('.page-label');
    label.textContent = `Page ${index + 1}`;
    const origin = document.createElement('span');
    origin.className = 'page-origin';
    origin.textContent = state.images.has(id) ? state.images.get(id).name : state.addedPages.has(id) ? pageName(id) : `Original ${id + 1}`;
    origin.title = origin.textContent;
    label.append(origin);
    card.querySelector('.previous').disabled = index === 0;
    card.querySelector('.next').disabled = index === state.order.length - 1;
    fragment.append(card);
  });
  $('page-grid').replaceChildren(fragment);
  $('page-grid').hidden = !state.order.length;
  $('empty-pages').hidden = !!state.order.length;
  updateControls();
}

function changed() { return state.order.length !== state.original.length || state.order.some((id, index) => id !== state.original[index]); }

function updateControls() {
  for (const id of state.order) {
    const card = state.cards.get(id);
    card.classList.toggle('selected', state.selected.has(id));
    card.querySelector('input').checked = state.selected.has(id);
  }
  $('select-all').checked = state.order.length > 0 && state.selected.size === state.order.length;
  $('select-all').indeterminate = state.selected.size > 0 && state.selected.size < state.order.length;
  $('select-all').disabled = !state.order.length;
  $('selected-count').textContent = state.selected.size ? ` (${state.selected.size})` : '';
  $('remove-selected').disabled = !state.selected.size;
  $('undo').disabled = !state.history.length;
  $('reset').disabled = !changed();
  $('download').disabled = !state.order.length;
  $('page-count').textContent = `${state.order.length} ${state.order.length === 1 ? 'page' : 'pages'}`;
  $('edit-status').textContent = changed() ? 'Changes ready to download' : 'Ready when you are';
}

function remember() {
  state.history.push([...state.order]);
  if (state.history.length > 100) state.history.shift();
}

function movePage(id, target, focusAction) {
  if (state.busy) return;
  const from = state.order.indexOf(id);
  if (from < 0 || target < 0 || target >= state.order.length || from === target) return;
  remember();
  state.order.splice(from, 1);
  state.order.splice(target, 0, id);
  drawPages();
  if (focusAction) {
    const card = state.cards.get(id);
    const button = card.querySelector(`.${focusAction}`);
    (button.disabled ? card.querySelector('input') : button).focus();
  }
  message(`${pageName(id)} moved to position ${target + 1}.`);
}

function removePages(ids) {
  if (state.busy || !ids.length) return;
  const removed = new Set(ids);
  const position = state.order.findIndex((id) => removed.has(id));
  remember();
  state.order = state.order.filter((id) => !removed.has(id));
  state.selected.clear();
  drawPages();
  const nextId = state.order[Math.min(position, state.order.length - 1)];
  if (nextId !== undefined) state.cards.get(nextId).querySelector('input').focus();
  else $('restore-pages').focus();
  message(`${removed.size} ${removed.size === 1 ? 'page removed' : 'pages removed'}. Use Undo to bring ${removed.size === 1 ? 'it' : 'them'} back.`);
}

function undo() {
  if (state.busy || !state.history.length) return;
  state.order = state.history.pop();
  state.selected.clear();
  drawPages();
  message('Last change undone.');
}

function reset() {
  if (state.busy || !changed()) return;
  remember();
  state.order = [...state.original];
  state.selected.clear();
  drawPages();
  message('All original pages restored in their original order.');
}

async function imagePageSize(id) {
  const position = state.order.indexOf(id);
  let neighbour;
  // Search outward in the current order; prefer the preceding PDF page on a tie.
  for (let distance = 1; distance < state.order.length; distance++) {
    for (const index of [position - distance, position + distance]) {
      const candidate = state.order[index];
      if (candidate !== undefined && !state.images.has(candidate)) {
        neighbour = candidate;
        break;
      }
    }
    if (neighbour !== undefined) break;
  }
  // An image-only arrangement still uses the original document's first page width.
  const reference = pdfPage(neighbour ?? state.original[0]);
  const page = await reference.preview.getPage(reference.index + 1);
  const width = page.getViewport({ scale: 1 }).width;
  const image = state.images.get(id);
  return { width, height: width * image.height / image.width };
}

async function download() {
  if (state.busy || !state.order.length) return;
  setBusy(true, 'Preparing your PDF…');
  try {
    // Preserve the original bytes when there are no page changes.
    let bytes = state.bytes;
    if (changed()) {
      const output = await PDFLib.PDFDocument.create();
      // Copy each source's pages together to preserve shared resources, then interleave them.
      const groups = new Map();
      for (const id of state.order) {
        if (state.images.has(id)) continue;
        const { source, index } = pdfPage(id);
        if (!groups.has(source)) groups.set(source, []);
        groups.get(source).push({ id, index });
      }
      const copiedPages = new Map();
      for (const [source, entries] of groups) {
        const pages = await output.copyPages(source, entries.map((entry) => entry.index));
        entries.forEach((entry, index) => copiedPages.set(entry.id, pages[index]));
      }
      for (const id of state.order) {
        const image = state.images.get(id);
        if (image) {
          const embedded = await output.embedPng(image.bytes);
          const { width, height } = await imagePageSize(id);
          output.addPage([width, height]).drawImage(embedded, { x: 0, y: 0, width, height });
        } else {
          output.addPage(copiedPages.get(id));
        }
      }
      const title = state.source.getTitle();
      const author = state.source.getAuthor();
      if (title) output.setTitle(title);
      if (author) output.setAuthor(author);
      bytes = await output.save();
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.name.replace(/\.pdf$/i, '')}-edited.pdf`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    message(`Your PDF is ready — ${state.order.length} ${state.order.length === 1 ? 'page' : 'pages'}, in the order you chose.`);
  } catch {
    message('This PDF could not be exported. Your page arrangement is still here; try again or open another file.', true);
  } finally { setBusy(false); }
}

async function sample() {
  if (state.busy) return;
  setBusy(true, 'Creating a little inspiration…');
  let file;
  try {
    await libraries();
    const { PDFDocument, StandardFonts, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const purple = rgb(.44, .35, .68);
    const dark = rgb(.17, .16, .22);
    const gray = rgb(.55, .52, .60);
    const titles = ['A little room\nto imagine.', 'Good things\nstart here.', 'Make space for\nwhat matters.', 'The next\nchapter.'];
    const subtitles = ['A field guide to a more thoughtful everyday.', 'Collect ideas. Follow your curiosity.', 'Less noise. More of the things you love.', 'Small steps lead to wonderful places.'];
    for (let i = 0; i < 4; i++) {
      const page = doc.addPage([420, 594]);
      page.drawRectangle({ x: 0, y: 0, width: 420, height: 594, color: rgb(.985, .98, .965) });
      page.drawText('THE EVERYDAY EDIT', { x: 36, y: 549, size: 9, font: bold, color: purple });
      page.drawText(`VOL. 0${i + 1}`, { x: 334, y: 549, size: 8, font: regular, color: gray });
      page.drawLine({ start: { x: 36, y: 530 }, end: { x: 384, y: 530 }, thickness: .7, color: rgb(.84, .82, .87) });
      page.drawText(titles[i], { x: 36, y: 468, size: 36, lineHeight: 43, font: bold, color: dark });
      page.drawText(subtitles[i], { x: 36, y: 363, size: 10, font: regular, color: gray });
      page.drawRectangle({ x: 36, y: 120, width: 348, height: 211, color: [rgb(.86, .82, .93), rgb(.84, .88, .81), rgb(.94, .85, .75), rgb(.81, .86, .92)][i] });
      page.drawCircle({ x: 210, y: 225, size: 76, color: rgb(.97, .95, .90) });
      page.drawRectangle({ x: 164 + i * 8, y: 120, width: 90, height: 127 + i * 10, color: purple });
      page.drawText('A collection of ideas, beautifully in order.', { x: 36, y: 77, size: 9, font: regular, color: gray });
      page.drawText(`PDF editor                                        ${String(i + 1).padStart(2, '0')}`, { x: 36, y: 35, size: 8, font: bold, color: purple });
    }
    doc.setTitle('The Everyday Edit');
    file = new File([await doc.save()], 'The everyday edit.pdf', { type: 'application/pdf' });
  } catch { message('The sample could not be created. Please reload the page and try again.', true); }
  finally { setBusy(false); }
  if (file) await openFile(file);
}

$('choose-file').addEventListener('click', () => $('file-input').click());
$('replace-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (event) => openFile(event.target.files[0]));
$('add-images').addEventListener('click', () => $('image-input').click());
$('image-input').addEventListener('change', (event) => addImages(event.target.files));
$('add-pdf').addEventListener('click', () => $('append-pdf-input').click());
$('append-pdf-input').addEventListener('change', (event) => addPdfs(event.target.files));
$('try-sample').addEventListener('click', sample);
$('download').addEventListener('click', download);
$('undo').addEventListener('click', undo);
$('reset').addEventListener('click', reset);
$('restore-pages').addEventListener('click', reset);
$('remove-selected').addEventListener('click', () => removePages([...state.selected]));
$('select-all').addEventListener('change', (event) => {
  state.selected = new Set(event.target.checked ? state.order : []);
  updateControls();
});
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey && !/^(INPUT|TEXTAREA)$/.test(event.target.tagName)) {
    event.preventDefault();
    undo();
  }
});
document.addEventListener('dragover', (event) => {
  if (!Array.from(event.dataTransfer.types).includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  $('drop-zone').classList.add('drag-over');
});
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) $('drop-zone').classList.remove('drag-over');
});
document.addEventListener('drop', (event) => {
  $('drop-zone').classList.remove('drag-over');
  if (!Array.from(event.dataTransfer.types).includes('Files')) return;
  event.preventDefault();
  const files = Array.from(event.dataTransfer.files);
  if (files.some(isJpeg)) { addImages(files); return; }
  if (state.source) { addPdfs(files); return; }
  if (files.length > 1) { message('Please open one PDF at a time, or drop JPG images to add pages.', true); return; }
  openFile(files[0]);
});
