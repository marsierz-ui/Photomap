const toastEl = document.getElementById('toast');
const modalEl = document.getElementById('modal');
const modalBox = document.getElementById('modal-box');

let toastTimer = null;

export function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('err', isError);
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), isError ? 6000 : 3000);
}

export function closeModal() {
  modalEl.classList.add('hidden');
  modalBox.innerHTML = '';
}

/** Render arbitrary HTML into the modal. `setup(box, close)` wires the content. */
export function modal(html, setup) {
  modalBox.innerHTML = html;
  modalEl.classList.remove('hidden');
  const firstInput = modalBox.querySelector('input, select, button');
  if (firstInput) firstInput.focus();
  if (setup) setup(modalBox, closeModal);
}

modalEl.addEventListener('mousedown', (e) => { if (e.target === modalEl) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalEl.classList.contains('hidden')) closeModal();
});

export function confirmModal(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    modal(
      `<h3>${title}</h3><div>${message}</div>
       <div class="actions">
         <button class="btn" data-act="cancel">Cancel</button>
         <button class="btn danger" data-act="ok">${confirmLabel}</button>
       </div>`,
      (box, close) => {
        box.querySelector('[data-act=cancel]').onclick = () => { close(); resolve(false); };
        box.querySelector('[data-act=ok]').onclick = () => { close(); resolve(true); };
      },
    );
  });
}

export const el = (id) => document.getElementById(id);

/** The readable text inside a fragment of HTML, for searching and for places
 *  that want a line rather than a document. */
export function stripTags(html) {
  // An inert document, so nothing in the markup can load or run on the way past.
  const doc = new DOMParser().parseFromString(html ?? '', 'text/html');
  return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
