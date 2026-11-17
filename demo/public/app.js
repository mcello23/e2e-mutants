const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('pt-BR');
const day = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short' });
const time = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', timeStyle: 'short' });

const statusLabels = { paid: 'Pago', pending: 'Pendente', shipped: 'Enviado', cancelled: 'Cancelado' };

function el(selector) {
  return document.querySelector(`[data-cy="${selector}"]`);
}

function setText(selector, value) {
  el(selector).textContent = value;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

function formatDay(isoDate) {
  const [year, month, dayOfMonth] = isoDate.slice(0, 10).split('-');
  return `${dayOfMonth}/${month}/${year}`;
}

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function renderMe(me) {
  setText('greeting', `Olá, ${me.name}`);
  setText('plan', `Plano ${me.plan}`);
}

function renderSummary(summary) {
  const updatedAt = new Date(summary.updatedAt);
  setText('kpi-revenue', money.format(summary.revenue));
  setText('kpi-orders', integer.format(summary.orders));
  setText('kpi-conversion', percent.format(summary.conversionRate));
  setText('kpi-updated', `${day.format(updatedAt)} às ${time.format(updatedAt)}`);
}

function statusCell(status) {
  const td = cell('');
  const badge = document.createElement('span');
  badge.className = 'status';
  badge.textContent = statusLabels[status] ?? status;
  td.append(badge);
  return td;
}

function orderRow(order) {
  const tr = document.createElement('tr');
  tr.dataset.cy = 'order-row';
  tr.dataset.id = order.id;
  tr.append(
    cell(order.id),
    cell(order.customer),
    cell(formatDay(order.createdAt)),
    statusCell(order.status),
    cell(money.format(order.total), 'num')
  );
  tr.addEventListener('click', () => openOrder(order, tr));
  return tr;
}

function renderOrders(orders) {
  setText('orders-count', `${orders.length} pedidos`);
  el('orders-body').replaceChildren(...orders.map(orderRow));
}

function itemRow(item) {
  const tr = document.createElement('tr');
  tr.dataset.cy = 'detail-item';
  tr.append(
    cell(item.sku),
    cell(item.name),
    cell(String(item.qty), 'num'),
    cell(money.format(item.price), 'num'),
    cell(money.format(item.qty * item.price), 'num')
  );
  return tr;
}

async function openOrder(order, row) {
  document.querySelectorAll('tr.selected').forEach((selected) => selected.classList.remove('selected'));
  row.classList.add('selected');
  const detail = await getJson(`/api/orders/${encodeURIComponent(order.id)}`);
  setText('detail-title', `Pedido ${detail.id}`);
  setText('detail-customer', `Cliente: ${order.customer}`);
  el('detail-items').replaceChildren(...detail.items.map(itemRow));
  setText('detail-total', money.format(order.total));
  setText('detail-notes', detail.notes);
  el('order-detail').hidden = false;
}

getJson('/api/me').then(renderMe);
getJson('/api/summary').then(renderSummary);
getJson('/api/orders').then(renderOrders);
