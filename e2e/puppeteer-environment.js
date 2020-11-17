// eslint-disable-next-line no-unused-vars
const puppeteer = require('puppeteer');

const { getBrowsers } = require('./config/get-browsers');

const NodeEnvironment = require('jest-environment-node');

class PuppeteerEnvironment extends NodeEnvironment {
  async setup() {
    await super.setup();

    this.global.browsersInfo = await getBrowsers();
  }

  async teardown() {
    await super.teardown();

    await Promise.all(this.global.browsersInfo.map(({ browser }) => this.closeBrowser(browser)));
  }

  /**
   * @param {puppeteer.Browser} browser
   */
  closeBrowser(browser) {
    return browser.close();
  }
}

module.exports = PuppeteerEnvironment;
