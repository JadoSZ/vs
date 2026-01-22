// @ts-check
/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: 'tests/e2e',
  timeout: 30 * 1000,
  expect: { toMatchSnapshot: { threshold: 0.01 } },
  use: {
    headless: true,
    viewport: { width: 1280, height: 900 }
  }
}
module.exports = config
