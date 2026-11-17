import { defineConfig } from 'cypress';
import { setupE2eMutants } from 'e2e-mutants';

export default defineConfig({
  fixturesFolder: false,
  e2e: {
    baseUrl: `http://127.0.0.1:${process.env.PORT ?? 4517}`,
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',
    setupNodeEvents(on, config) {
      return setupE2eMutants(on, config);
    }
  }
});
