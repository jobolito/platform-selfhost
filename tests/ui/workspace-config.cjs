#!/usr/bin/env node
// Drive and verify a workspace's supported UI configuration in a real browser.
//
// Plugin filtering goes through Settings > Configure (PluginConfiguration.enabled), the
// same toggle an Owner uses by hand. This is UI filtering, not access control.
// Every session uses a fresh browser context, so a stored last route cannot hide the
// landing behaviour. Credentials and tokens are never printed.
//
// Commands:
//   list                 print the plugin toggles (Owner)
//   set                  change toggles (Owner), then confirm them from a new browser context
//     --disable "A,B" --enable "C"
//   verify               generic checks; passing is NOT Phase 0 acceptance
//     --landing-path app/space/special --require a,b --forbid c,d
//     [--open a,b] [--widget calendar] [--expect-role ROLE] [--screenshot file.png]
//   phase0               the full Phase 0 acceptance contract in phase0-contract.json
//     --expect-role OWNER|USER --screenshot file.png
//     [--require-document-page [--document-screenshot file.png]]
//
// Env:
//   HULY_URL           public origin (required), e.g. https://huly.example.com
//   HULY_STATE_FILE    mode 600 file with SMOKE_EMAIL, SMOKE_PASSWORD, optional SMOKE_WS_URL
//                      (default ../.smoke-state)
//   HULY_WORKSPACE     workspace URL slug; overrides SMOKE_WS_URL
//   CHROME_PATH        browser executable (default, recommended: Playwright's bundled browser)
//   HULY_TIMEOUT_MS    wait limit for each step (default 60000)

const { chromium } = require('@playwright/test')
const path = require('path')
const contract = require('./phase0-contract.json')
const {
  csv,
  parseArgs,
  readCredentialFile,
  resolveOutputPath,
  validateBaseUrl,
  validateWorkspace,
  writeOutputFile
} = require('./workspace-config-lib.cjs')

const FATAL_CONSOLE = /ChunkLoadError|Loading chunk|dynamically imported module|Cannot read propert|is not a function|is not defined/i

class Session {
  constructor (browser, base, workspace, state, timeout) {
    Object.assign(this, { browser, base, workspace, state, timeout })
    this.settle = Math.min(3000, timeout / 4)
    this.failures = []
    this.runtimeErrors = new Set()
    this.selections = []
  }

  fail (message) {
    this.failures.push(message)
    console.error(`FAIL: ${message}`)
  }

  async open () {
    this.context = await this.browser.newContext({ viewport: { width: 1440, height: 900 } })
    this.page = await this.context.newPage()
    this.page.setDefaultTimeout(this.timeout)
    this.page.on('pageerror', (error) => this.runtimeErrors.add(`uncaught: ${error.name}`))
    this.page.on('crash', () => this.runtimeErrors.add('page crashed'))
    this.page.on('console', (message) => {
      if (message.type() === 'error' && FATAL_CONSOLE.test(message.text())) this.runtimeErrors.add('fatal console error')
    })
    this.page.on('response', (response) => this.watchResponse(response))
    await this.login()
  }

  async close () {
    await this.context?.close()
  }

  // The client's own selectWorkspace answer says which workspace this page really connected to.
  watchResponse (response) {
    const url = new URL(response.url())
    if (url.origin !== this.base) return
    if (response.status() >= 500) this.runtimeErrors.add(`HTTP ${response.status()} from ${url.pathname.split('/')[1]}`)
    if (response.request().method() !== 'POST' || !url.pathname.startsWith('/_accounts')) return
    let method
    try {
      method = JSON.parse(response.request().postData() ?? '{}').method
    } catch {
      return
    }
    if (method !== 'selectWorkspace') return
    this.selections.push(
      response.json().then(
        (body) => ({ url: body.result?.workspaceUrl, role: body.result?.role }),
        () => ({})
      )
    )
  }

  async login () {
    const { page, base, state, timeout } = this
    await page.goto(`${base}/login/login`)
    const withPassword = page.getByText('Login with password', { exact: true })
    const password = page.locator('input[name=current-password]')
    await withPassword.or(password).first().waitFor({ timeout })
    if (await withPassword.isVisible()) await withPassword.click()
    await page.locator('input[name=email]').fill(state.SMOKE_EMAIL)
    await password.fill(state.SMOKE_PASSWORD)
    await page.getByRole('button', { name: 'Log In', exact: true }).click()
    await page.waitForURL(/selectWorkspace|workbench/, { timeout })
  }

  // Enter through the workspace root so the workbench picks the landing route itself, and
  // confirm which workspace the client selected. Throws before any mutation can happen.
  async openWorkspace () {
    const { page, base, workspace } = this
    this.selections = []
    await page.goto(`${base}/workbench/${workspace}`)
    await page.locator('button[id^="app-"]').first().waitFor({ timeout: this.timeout })
    const deadline = Date.now() + this.timeout
    while (this.selections.length === 0 && Date.now() < deadline) await page.waitForTimeout(100)
    if (this.selections.length === 0) throw new Error('the client did not select a workspace')
    const selected = await this.selections[this.selections.length - 1]
    if (selected.url !== workspace) throw new Error(`selected workspace is not the target "${workspace}"`)
    if (this.route().split('/')[2] !== workspace) throw new Error(`page left the target workspace "${workspace}"`)
    this.role = selected.role
    console.log(`selected workspace: ${selected.url} role: ${selected.role}`)
  }

  route () {
    return decodeURIComponent(new URL(this.page.url()).pathname)
  }

  // Wait until the workbench stops rewriting the route.
  async stableRoute () {
    const root = `/workbench/${this.workspace}`
    const deadline = Date.now() + this.timeout
    let route = this.route()
    let since = Date.now()
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(100)
      const current = this.route()
      if (current !== route) {
        route = current
        since = Date.now()
      } else if (route.replace(/\/$/, '') !== root && Date.now() - since >= this.settle) {
        break
      }
    }
    return route
  }

  async openConfigure () {
    await this.page.goto(`${this.base}/workbench/${this.workspace}/setting/setting/configuration`)
    await this.page.locator('.plugin-card').first().waitFor({ timeout: this.timeout })
    if (this.route().split('/')[2] !== this.workspace) throw new Error(`page left the target workspace "${this.workspace}"`)
  }

  async readCards () {
    return await this.page.locator('.plugin-card').evaluateAll((cards) =>
      cards.map((card) => ({
        name: card.querySelector('.plugin-card__name')?.textContent?.trim(),
        enabled: card.classList.contains('enabled')
      }))
    )
  }

  async setPlugin (name, enabled) {
    const before = (await this.readCards()).filter((card) => card.name === name)
    if (before.length !== 1) throw new Error(`expected one plugin card named "${name}", found ${before.length}`)
    if (before[0].enabled === enabled) {
      console.log(`unchanged: ${name}=${enabled}`)
      return
    }
    const card = this.page.locator('.plugin-card').filter({
      has: this.page.locator('.plugin-card__name').getByText(name, { exact: true })
    })
    // The client normally reloads after an update, but only the state read back afterwards counts.
    const reloaded = this.page.waitForEvent('load', { timeout: Math.min(this.timeout, 10_000) }).catch(() => {})
    await card.locator('label.toggle').click()
    await reloaded
    await this.openConfigure()
    const after = (await this.readCards()).filter((c) => c.name === name)
    if (after.length !== 1 || after[0].enabled !== enabled) {
      throw new Error(`plugin "${name}" did not persist as enabled=${enabled}`)
    }
    console.log(`changed: ${name}=${enabled}`)
  }

  async readRail () {
    return await this.page.locator('button[id^="app-"]').evaluateAll((buttons) => [
      ...new Set(buttons.map((button) => button.id.replace(/^app-/, '')))
    ])
  }

  checkRail (rail, required, forbidden) {
    const apps = rail.map((id) => id.split(':')[0])
    console.log(`rail: ${[...new Set(apps)].join(' ')}`)
    for (const app of required) if (!apps.includes(app)) this.fail(`required app missing from rail: ${app}`)
    for (const app of forbidden) if (apps.includes(app)) this.fail(`forbidden app in rail: ${app}`)
    return apps
  }

  navigator () {
    return this.page.locator('.antiPanel-navigator')
  }

  async navigatorTitle () {
    const header = this.navigator().locator('.hulyNavPanel-header').first()
    await header.waitFor({ timeout: this.timeout })
    return (await header.innerText()).trim()
  }

  async waitForNavigatorTitle (expected) {
    const deadline = Date.now() + this.timeout
    let title = ''
    while (Date.now() < deadline) {
      title = await this.navigatorTitle().catch(() => '')
      if (title === expected) return title
      await this.page.waitForTimeout(100)
    }
    return title
  }

  // A routed app must render its own navigator, not just change the URL.
  async openApp ({ id, navigatorTitle }) {
    // Clicking the current app's rail button collapses the navigator, so only click to switch.
    if (this.route().split('/')[3] !== id) await this.page.locator(`button[id^="app-${id}:"]`).first().click()
    const deadline = Date.now() + this.timeout
    while (this.route().split('/')[3] !== id && Date.now() < deadline) await this.page.waitForTimeout(100)
    const routed = this.route().split('/')[3]
    if (routed !== id) {
      this.fail(`opening ${id} routed to "${routed}"`)
      return
    }
    const title = navigatorTitle !== undefined
      ? await this.waitForNavigatorTitle(navigatorTitle)
      : await this.navigatorTitle().catch(() => '')
    const chars = (await this.navigator().innerText().catch(() => '')).trim().length
    console.log(`opened ${id}: navigator "${title}", ${chars} chars`)
    if (navigatorTitle !== undefined && title !== navigatorTitle) {
      this.fail(`${id} navigator title is "${title}", expected "${navigatorTitle}"`)
    }
    if (chars <= title.length) this.fail(`${id} navigator rendered no content`)
  }

  // The widget must open in the sidebar. Text elsewhere on the page does not count.
  async openCalendarWidget () {
    const widget = this.page.locator('.sidebar-content .calendar-container')
    if (await widget.isVisible()) {
      this.fail('calendar widget was already open, so opening it proves nothing')
      return
    }
    const before = this.page.url()
    await this.page.locator('button[id^="app-calendar:"]').first().click()
    try {
      await widget.first().waitFor({ state: 'visible', timeout: this.timeout })
    } catch {
      this.fail('calendar widget did not open in the sidebar')
      return
    }
    // Time cells are the widget's own grid, whatever the locale's time format.
    const cells = await widget.first().locator('.time-cell').allInnerTexts()
    const hours = cells.filter((text) => text.trim() !== '').length
    console.log(`opened widget calendar: ${hours} time labels`)
    if (hours < 3) this.fail(`calendar widget shows no time grid (${hours} time labels)`)
    if (this.page.url() !== before) this.fail('calendar widget changed the route')
  }

  async screenshot (output) {
    if (output === undefined) return
    writeOutputFile(output.resolved, await this.page.screenshot(), output.identity)
    console.log(`screenshot: ${path.basename(output.resolved)}`)
  }

  checkRuntimeErrors () {
    if (this.runtimeErrors.size > 0) this.fail(`runtime errors: ${[...this.runtimeErrors].join(', ')}`)
  }

  checkRole (expected) {
    if (expected !== undefined && this.role !== expected) {
      throw new Error(`workspace role is ${this.role}, expected ${expected}`)
    }
  }

  async checkLanding (landingPath) {
    const route = await this.stableRoute()
    const expected = `/workbench/${this.workspace}/${landingPath}`
    console.log(`landing route: ${route}`)
    if (route !== expected) this.fail(`landing route is "${route}", expected "${expected}"`)
  }

  async countRows () {
    const rows = this.page.locator('.hulyComponent table.antiTable tbody tr')
    await rows.first().waitFor({ timeout: this.timeout }).catch(() => {})
    return await rows.count()
  }

  async checkLandingPage () {
    const title = await this.waitForNavigatorTitle(contract.landingNavigatorTitle)
    if (title !== contract.landingNavigatorTitle) this.fail(`landing navigator title is "${title}"`)
    const navigatorText = (await this.navigator().innerText().catch(() => '')).trim()
    if (!navigatorText.includes(contract.landingPageTitle)) {
      this.fail(`landing navigator does not list "${contract.landingPageTitle}"`)
    }
    const rows = await this.countRows()
    const pageText = (await this.page.locator('.hulyComponent').first().innerText().catch(() => '')).trim()
    const documents = await this.navigator().locator('.hulyNavGroup-container .hulyNavItem-container').count()
    // Counts only: names in a private workspace do not belong in a log.
    console.log(`rendered: navigator "${title}", ${navigatorText.length} chars, ${documents} document items`)
    console.log(`rendered: page "${contract.landingPageTitle}" table rows ${rows}, ${pageText.length} chars`)
    if (!pageText.includes(contract.landingPageTitle)) this.fail(`landing page does not show "${contract.landingPageTitle}"`)
    if (rows < contract.landingMinTableRows) this.fail(`landing page has ${rows} table rows, expected at least ${contract.landingMinTableRows}`)
    return documents
  }

  async openFirstDocument (output) {
    const items = this.navigator().locator('.hulyNavGroup-container .hulyNavItem-container')
    if ((await items.count()) === 0) {
      this.fail('no document in the navigator to open')
      return
    }
    const before = this.route()
    await items.first().click()
    const deadline = Date.now() + this.timeout
    while (this.route() === before && Date.now() < deadline) await this.page.waitForTimeout(100)
    if (this.route() === before || this.route().split('/')[3] !== 'document') {
      this.fail('opening a document did not change to a document route')
      return
    }
    const editor = this.page.locator('[contenteditable=true]').first()
    const text = await editor.waitFor({ timeout: this.timeout }).then(() => editor.innerText(), () => '')
    console.log(`opened document: ${text.trim().length} editor chars`)
    if (text.trim() === '') this.fail('opened document shows no content')
    await this.screenshot(output)
  }

  checkPluginStates (cards) {
    const known = [...contract.pluginsOn, ...contract.pluginsOff]
    for (const card of cards) {
      if (!known.includes(card.name)) this.fail(`plugin not in the contract: ${card.name}`)
    }
    for (const name of known) {
      const matching = cards.filter((card) => card.name === name)
      const wanted = contract.pluginsOn.includes(name)
      if (matching.length !== 1) this.fail(`plugin card missing: ${name}`)
      else if (matching[0].enabled !== wanted) this.fail(`plugin ${name} is ${matching[0].enabled ? 'on' : 'off'}`)
    }
    console.log(`plugin state checked: ${cards.length} toggles`)
  }
}

async function runVerify (session, options, outputs) {
  console.log('generic checks only: passing is not Phase 0 acceptance')
  await session.openWorkspace()
  session.checkRole(options['expect-role'])
  await session.checkLanding(options['landing-path'])
  session.checkRail(await session.readRail(), csv(options.require), csv(options.forbid))
  await session.screenshot(outputs.screenshot)
  for (const id of csv(options.open)) await session.openApp({ id })
  for (const widget of csv(options.widget)) {
    if (widget !== 'calendar') throw new Error(`unsupported widget: ${widget}`)
    await session.openCalendarWidget()
  }
  session.checkRuntimeErrors()
}

async function runPhase0 (session, options, outputs) {
  console.log('phase 0 acceptance contract')
  await session.openWorkspace()
  session.checkRole(options['expect-role'])
  await session.checkLanding(contract.landingPath)
  const apps = session.checkRail(
    await session.readRail(),
    [...contract.apps.map((app) => app.id), ...contract.widgets],
    contract.forbiddenApps
  )
  for (const app of apps) {
    if (!contract.railApps.includes(app)) session.fail(`app not in the contract: ${app}`)
  }
  const documents = await session.checkLandingPage()
  await session.screenshot(outputs.screenshot)

  if (options['require-document-page'] === true) await session.openFirstDocument(outputs.documentScreenshot)
  else console.log(`document page: not required, not opened (${documents} document items visible)`)

  for (const app of contract.apps) await session.openApp(app)
  await session.openCalendarWidget()

  if (session.role === 'OWNER') {
    await session.openConfigure()
    session.checkPluginStates(await session.readCards())
  } else {
    console.log(`plugin state: not checked, Settings > Configure needs OWNER (role ${session.role})`)
  }
  session.checkRuntimeErrors()
}

async function runSet (makeSession, options) {
  const disable = csv(options.disable).map((name) => [name, false])
  const enable = csv(options.enable).map((name) => [name, true])
  const changes = [...disable, ...enable]

  const session = await makeSession()
  await session.openWorkspace()
  session.checkRole('OWNER')
  await session.openConfigure()
  const names = (await session.readCards()).map((card) => card.name)
  const unknown = changes.filter(([name]) => !names.includes(name)).map(([name]) => name)
  if (unknown.length > 0) throw new Error(`unknown plugin: ${unknown.join(', ')}`)
  for (const [name, enabled] of changes) await session.setPlugin(name, enabled)
  await session.close()

  // Confirm from a new session: state that only survives in this browser is not persisted.
  const fresh = await makeSession()
  await fresh.openWorkspace()
  await fresh.openConfigure()
  const cards = await fresh.readCards()
  for (const [name, enabled] of changes) {
    const card = cards.find((c) => c.name === name)
    if (card?.enabled !== enabled) fresh.fail(`plugin "${name}" is not enabled=${enabled} in a new session`)
  }
  for (const card of cards) console.log(`${card.enabled ? 'on ' : 'off'} ${card.name}`)
  await fresh.close()
  return fresh.failures.length
}

async function main () {
  const { command, options } = parseArgs(process.argv.slice(2))
  const base = validateBaseUrl(process.env.HULY_URL)
  const timeout = process.env.HULY_TIMEOUT_MS === undefined ? 60_000 : Number(process.env.HULY_TIMEOUT_MS)
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error('HULY_TIMEOUT_MS must be a positive integer')

  const { state, identity } = readCredentialFile(process.env.HULY_STATE_FILE ?? path.join(__dirname, '..', '.smoke-state'))
  secrets = [state.SMOKE_EMAIL, state.SMOKE_PASSWORD]
  const workspace = validateWorkspace(process.env.HULY_WORKSPACE ?? state.SMOKE_WS_URL)
  const output = (file) => (file === undefined ? undefined : { resolved: resolveOutputPath(file, identity), identity })
  const outputs = { screenshot: output(options.screenshot), documentScreenshot: output(options['document-screenshot']) }
  if (outputs.screenshot !== undefined && outputs.screenshot.resolved === outputs.documentScreenshot?.resolved) {
    throw new Error('--screenshot and --document-screenshot are the same file')
  }

  const browser = await chromium.launch(
    process.env.CHROME_PATH !== undefined ? { executablePath: process.env.CHROME_PATH } : {}
  )
  try {
    const makeSession = async () => {
      const session = new Session(browser, base, workspace, state, timeout)
      await session.open()
      return session
    }
    if (command === 'set') {
      if ((await runSet(makeSession, options)) > 0) process.exitCode = 1
      return
    }
    const session = await makeSession()
    if (command === 'list') {
      await session.openWorkspace()
      await session.openConfigure()
      for (const card of await session.readCards()) console.log(`${card.enabled ? 'on ' : 'off'} ${card.name}`)
    } else if (command === 'verify') {
      await runVerify(session, options, outputs)
    } else {
      await runPhase0(session, options, outputs)
    }
    console.log(session.failures.length === 0 ? `PASS: ${command}` : `FAILED: ${session.failures.length} check(s)`)
    if (session.failures.length > 0) process.exitCode = 1
  } finally {
    await browser.close()
  }
}

let secrets = []

function scrub (text) {
  return secrets.reduce((result, secret) => result.split(secret).join('<redacted>'), text)
}

main().catch((error) => {
  console.error(`FAIL: ${scrub(String(error.message ?? error).split('\n')[0])}`)
  process.exitCode = 1
})
