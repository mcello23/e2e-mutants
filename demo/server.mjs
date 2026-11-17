import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'public');

const me = { name: 'Marina Alves', locale: 'pt-BR', plan: 'Business' };

const summary = { revenue: 128450.5, orders: 312, conversionRate: 0.0425, updatedAt: '2026-11-12T09:30:00Z' };

const orders = [
  { id: 'ORD-1001', customer: 'Ana Souza', total: 1450, status: 'paid', createdAt: '2026-11-10' },
  { id: 'ORD-1002', customer: 'Bruno Carvalho', total: 389.9, status: 'pending', createdAt: '2026-11-11' },
  { id: 'ORD-1003', customer: 'Carla Mendes', total: 12780.35, status: 'shipped', createdAt: '2026-11-08' },
  { id: 'ORD-1004', customer: 'Diego Ferreira', total: 74.5, status: 'cancelled', createdAt: '2026-11-05' },
  { id: 'ORD-1005', customer: 'Elisa Rocha', total: 2315, status: 'paid', createdAt: '2026-11-12' }
];

const details = {
  'ORD-1001': {
    items: [
      { sku: 'MOE-210', name: 'Moedor elétrico', qty: 1, price: 899 },
      { sku: 'CAF-250', name: 'Café especial 250g', qty: 6, price: 42.5 },
      { sku: 'PRE-600', name: 'Prensa francesa 600ml', qty: 2, price: 148 }
    ],
    notes: 'Entregar na portaria do prédio'
  },
  'ORD-1002': {
    items: [
      { sku: 'CHA-120', name: 'Chaleira bico de ganso', qty: 1, price: 289.9 },
      { sku: 'FIL-100', name: 'Filtros de papel 102', qty: 4, price: 25 }
    ],
    notes: 'Cliente pediu nota fiscal no CNPJ'
  },
  'ORD-1003': {
    items: [
      { sku: 'ESP-900', name: 'Máquina de espresso dupla', qty: 1, price: 11890.35 },
      { sku: 'TAM-058', name: 'Tamper de aço 58mm', qty: 2, price: 195 },
      { sku: 'JAR-350', name: 'Jarra de leite 350ml', qty: 4, price: 125 }
    ],
    notes: 'Instalação agendada para a próxima semana'
  },
  'ORD-1004': {
    items: [{ sku: 'XIC-090', name: 'Xícara de porcelana', qty: 2, price: 37.25 }],
    notes: 'Cancelado a pedido do cliente'
  },
  'ORD-1005': {
    items: [
      { sku: 'BAL-002', name: 'Balança com timer', qty: 1, price: 315 },
      { sku: 'GRA-001', name: 'Café em grãos 1kg', qty: 16, price: 125 }
    ],
    notes: 'Presente: incluir cartão'
  }
};

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function sendFile(res, name) {
  const ext = name.slice(name.lastIndexOf('.'));
  const body = await readFile(join(root, name));
  res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    if (pathname === '/' || pathname === '/index.html') return await sendFile(res, 'index.html');
    if (pathname === '/app.js') return await sendFile(res, 'app.js');
    if (pathname === '/api/me') return sendJson(res, 200, me);
    if (pathname === '/api/summary') return sendJson(res, 200, summary);
    if (pathname === '/api/orders') return sendJson(res, 200, orders);
    const match = /^\/api\/orders\/([^/]+)$/.exec(pathname);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const detail = details[id];
      return detail ? sendJson(res, 200, { id, ...detail }) : sendJson(res, 404, { error: 'order not found' });
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, 500, { error: String(error) });
  }
});

const port = Number(process.env.PORT ?? 4517);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`demo server on http://127.0.0.1:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
