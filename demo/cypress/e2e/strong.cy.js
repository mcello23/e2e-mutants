const clean = (text) => text.replace(/\s+/g, ' ').trim();

const shows = (selector, expected) =>
  cy.get(selector).should(($el) => {
    expect(clean($el.text())).to.equal(expected);
  });

const rowCells = (id) => cy.get(`[data-cy=order-row][data-id="${id}"] td`);

const expectRow = (id, cells) =>
  rowCells(id).should(($cells) => {
    expect([...$cells].map((td) => clean(td.textContent))).to.deep.equal(cells);
  });

const expectItems = (rows) =>
  cy.get('[data-cy=detail-item]').should(($rows) => {
    const actual = [...$rows].map((tr) => [...tr.querySelectorAll('td')].map((td) => clean(td.textContent)));
    expect(actual).to.deep.equal(rows);
  });

describe('orders dashboard', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('greets the signed-in user with their plan', () => {
    shows('[data-cy=greeting]', 'Olá, Marina Alves');
    shows('[data-cy=plan]', 'Plano Business');
  });

  it('shows revenue, orders, conversion and last update', () => {
    shows('[data-cy=kpi-revenue]', 'R$ 128.450,50');
    shows('[data-cy=kpi-orders]', '312');
    shows('[data-cy=kpi-conversion]', '4,25%');
    shows('[data-cy=kpi-updated]', '12/11/2026 às 06:30');
  });

  it('lists the five most recent orders in order', () => {
    cy.get('[data-cy=order-row]').should('have.length', 5);
    shows('[data-cy=orders-count]', '5 pedidos');
    cy.get('[data-cy=order-row]').then(($rows) => {
      expect([...$rows].map((row) => row.dataset.id)).to.deep.equal(['ORD-1001', 'ORD-1002', 'ORD-1003', 'ORD-1004', 'ORD-1005']);
    });
  });

  it('renders customer, date, status and total for every order', () => {
    expectRow('ORD-1001', ['ORD-1001', 'Ana Souza', '10/11/2026', 'Pago', 'R$ 1.450,00']);
    expectRow('ORD-1002', ['ORD-1002', 'Bruno Carvalho', '11/11/2026', 'Pendente', 'R$ 389,90']);
    expectRow('ORD-1003', ['ORD-1003', 'Carla Mendes', '08/11/2026', 'Enviado', 'R$ 12.780,35']);
    expectRow('ORD-1004', ['ORD-1004', 'Diego Ferreira', '05/11/2026', 'Cancelado', 'R$ 74,50']);
    expectRow('ORD-1005', ['ORD-1005', 'Elisa Rocha', '12/11/2026', 'Pago', 'R$ 2.315,00']);
  });

  it('opens ORD-1001 with its items, total and notes', () => {
    cy.get('[data-cy=order-row][data-id="ORD-1001"]').click();
    shows('[data-cy=detail-title]', 'Pedido ORD-1001');
    shows('[data-cy=detail-customer]', 'Cliente: Ana Souza');
    expectItems([
      ['MOE-210', 'Moedor elétrico', '1', 'R$ 899,00', 'R$ 899,00'],
      ['CAF-250', 'Café especial 250g', '6', 'R$ 42,50', 'R$ 255,00'],
      ['PRE-600', 'Prensa francesa 600ml', '2', 'R$ 148,00', 'R$ 296,00']
    ]);
    shows('[data-cy=detail-total]', 'R$ 1.450,00');
    shows('[data-cy=detail-notes]', 'Entregar na portaria do prédio');
  });

  it('switches the detail panel to another order', () => {
    cy.get('[data-cy=order-row][data-id="ORD-1001"]').click();
    shows('[data-cy=detail-title]', 'Pedido ORD-1001');
    cy.get('[data-cy=order-row][data-id="ORD-1003"]').click();
    shows('[data-cy=detail-title]', 'Pedido ORD-1003');
    shows('[data-cy=detail-customer]', 'Cliente: Carla Mendes');
    expectItems([
      ['ESP-900', 'Máquina de espresso dupla', '1', 'R$ 11.890,35', 'R$ 11.890,35'],
      ['TAM-058', 'Tamper de aço 58mm', '2', 'R$ 195,00', 'R$ 390,00'],
      ['JAR-350', 'Jarra de leite 350ml', '4', 'R$ 125,00', 'R$ 500,00']
    ]);
    shows('[data-cy=detail-total]', 'R$ 12.780,35');
    shows('[data-cy=detail-notes]', 'Instalação agendada para a próxima semana');
  });
});
