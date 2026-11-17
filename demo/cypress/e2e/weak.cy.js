describe('orders dashboard (smoke)', () => {
  beforeEach(() => {
    cy.visit('/');
  });

  it('loads the dashboard', () => {
    cy.get('[data-cy=greeting]').should('be.visible');
    cy.get('[data-cy=plan]').should('exist');
  });

  it('shows the four KPI cards', () => {
    cy.get('[data-cy=kpi]').should('have.length', 4).and('be.visible');
  });

  it('shows the revenue KPI', () => {
    cy.get('[data-cy=kpi-revenue]').should('be.visible').and('not.be.empty');
  });

  it('lists recent orders', () => {
    cy.get('[data-cy=order-row]').should('have.length.greaterThan', 0);
    cy.get('[data-cy=orders-count]').should('be.visible');
  });

  it('opens the order detail panel', () => {
    cy.get('[data-cy=order-row]').first().click();
    cy.get('[data-cy=order-detail]').should('be.visible');
  });

  it('shows the items of an order', () => {
    cy.get('[data-cy=order-row]').first().click();
    cy.get('[data-cy=detail-item]').should('have.length.at.least', 1);
    cy.get('[data-cy=detail-notes]').should('exist');
  });
});
