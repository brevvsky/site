const $ = s => document.querySelector(s);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let products = [], category = 'All';
const dialog = $('#product-dialog'), licenseDialog = $('#license-dialog');
document.querySelectorAll('dialog .close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(el => el.addEventListener('click', event => { if (event.target === el) { const r = el.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) el.close(); } }));
$('#year').textContent = new Date().getFullYear();
function imageUrl(value) { return /^\.\/uploads\/[a-zA-Z0-9.-]+$/.test(value) ? value : './assets/vehicle.svg'; }
function render() {
  const search = $('#search').value.toLowerCase().trim(), access = $('#access-filter').value;
  const filtered = products.filter(p => (category === 'All' || p.category === category) && (access === 'all' || p.access === access) && `${p.title} ${p.description}`.toLowerCase().includes(search));
  $('#asset-count').textContent = `${String(filtered.length).padStart(2, '0')} ASSET${filtered.length === 1 ? '' : 'S'}`;
  $('#catalog').innerHTML = filtered.length ? filtered.map(p => `<button class="product-card" data-id="${escape(p.id)}" aria-label="View ${escape(p.title)}"><div class="product-image"><img src="${escape(imageUrl(p.images?.[0]))}" alt="${escape(p.title)} preview" loading="lazy"><span class="badge">${p.access === 'free' ? 'FREE ASSET' : 'PERSONAL LICENSE'}</span></div><div class="product-body"><span class="product-category">${escape(p.category.toUpperCase())}</span><h3>${escape(p.title)}</h3><p>${escape(p.description)}</p><div class="product-bottom"><span class="price">${escape(p.access === 'free' ? 'Free download' : p.price || 'License required')}</span><span>View asset</span></div></div></button>`).join('') : `<div class="empty-state"><div class="empty-symbol">[ B ]</div><h3>${products.length ? 'No assets found.' : 'Good things are being built.'}</h3><p>${products.length ? 'Try another search or choose a different category.' : 'The collection is on its way. Check back for vehicles and systems made for your next project.'}</p></div>`;
  document.querySelectorAll('[data-id]').forEach(button => button.addEventListener('click', () => openProduct(button.dataset.id)));
}
function openLicense(id) {
  dialog.close();
  $('#license-product').innerHTML = products.filter(p => p.access === 'paid').map(p => `<option value="${escape(p.id)}">${escape(p.title)}</option>`).join('');
  if (id) $('#license-product').value = id;
  $('#license-form').reset();
  $('#license-form button').disabled = !products.some(p => p.access === 'paid');
  if (id) $('#license-product').value = id;
  $('#license-form .form-status').textContent = products.some(p => p.access === 'paid') ? '' : 'No licensed assets are available yet. Check back soon.';
  licenseDialog.showModal();
}
function openProduct(id) {
  const p = products.find(p => p.id === id); if (!p) return;
  $('#product-detail').innerHTML = `<p class="eyebrow">${escape(p.category.toUpperCase())} / ROBLOX ASSET</p><h2 id="product-title">${escape(p.title)}</h2><div class="detail-gallery">${(p.images?.length ? p.images : ['./assets/vehicle.svg']).map((url,i) => `<img src="${escape(imageUrl(url))}" alt="${escape(p.title)} preview ${i+1}">`).join('')}</div><p class="detail-description">${escape(p.description)}</p><div class="access-box"><h3>${p.access === 'free' ? 'Make it yours. For free.' : 'Get access to this asset'}</h3><p class="detail-description">${escape(p.access === 'free' ? 'Download this asset and import it into Roblox Studio.' : p.instructions || 'Contact the creator to obtain your personal license. Once you receive your code, enter it here to download your copy.')}</p>${p.access === 'paid' && p.contactUrl ? `<a class="button ghost" target="_blank" rel="noopener noreferrer" href="${escape(p.contactUrl)}">Contact creator</a> ` : ''}<button class="button primary" id="product-download">${p.access === 'free' ? 'Download asset' : 'I have a license'}</button><p class="form-status" role="status"></p></div>`;
  $('#product-download').addEventListener('click', () => p.access === 'paid' ? openLicense(p.id) : download(p.id, '', $('#product-download'), $('#product-detail .form-status')));
  dialog.showModal();
}
async function download(productId, code, button, status) {
  button.disabled = true; status.textContent = 'Preparing your download…';
  try {
    const response = await fetch('./api/download', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ productId, code }), cache:'no-store', credentials:'omit' });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Download is temporarily unavailable. Please try again.'); }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url;
    link.download = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || `${productId}.rbxmx`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = 'Your download is ready. Open the file in Roblox Studio.';
  } catch(error) { status.textContent = error.message; } finally { button.disabled = false; }
}
$('#license-form').addEventListener('submit', event => { event.preventDefault(); const data = new FormData(event.target); download(data.get('productId'), data.get('code'), event.target.querySelector('button'), event.target.querySelector('.form-status')); });
$('#open-license').addEventListener('click', () => openLicense());
document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => { category = button.dataset.category; document.querySelectorAll('.tab').forEach(el => { el.classList.toggle('active', el === button); el.setAttribute('aria-pressed', String(el === button)); }); render(); }));
$('#search').addEventListener('input', render); $('#access-filter').addEventListener('change', render);
try { const response = await fetch('./catalog.json', {cache:'no-store'}); if (!response.ok) throw Error(); const catalog = await response.json(); products = catalog.products.map(p => ({...p,contactUrl:p.contactUrl || catalog.contactUrl || ''})); render(); } catch { $('#asset-count').textContent = 'COLLECTION UNAVAILABLE'; $('#catalog').innerHTML = '<div class="empty-state"><h3>We couldn’t load the collection.</h3><p>Please refresh the page in a moment.</p></div>'; }
