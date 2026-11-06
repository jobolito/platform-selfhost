#!/usr/bin/env node
// Drive and verify a workspace's supported UI configuration in a real browser.
//
// Plugin filtering goes through Settings > Configure (PluginConfiguration.enabled), the
// same toggle an Owner uses by hand. This is UI filtering, not access control.
// Every run uses a fresh browser context, so a stored last-route cannot hide the
// landing behaviour. Credentials and tokens are never printed.
//
// Usage:
//   node workspace-config.cjs list
//   node workspace-config.cjs set --disable "Human Resources,Office" [--enable "Cards"]
//   node workspace-config.cjs verify --landing document
//     [--require app-a,app-b] [--forbid app-c,app-d] [--open app-a,app-b] [--widget app-c] [--screenshot file.png]
//
// Env:
//   HULY_URL           public URL (required), e.g. https://huly.example.com
//   HULY_STATE_FILE    file with SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_WS_URL (default ../.smoke-state)
//   HULY_WORKSPACE     workspace URL slug; overrides SMOKE_WS_URL
//   CHROME_PATH        browser executable (default: Playwright's bundled browser)

const { chromium } = require('@playwright/test')
const { readFileSync } = require('fs')
const path = require('path')

const TIMEOUT = 60_000

function fail (message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

function parseArgs (argv) {
  const [command, ...rest] = argv
  const options = {}
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error(`bad argument: ${rest[i]}`)
    options[rest[i].slice(2)] = rest[i + 1]
  }
  return { command, options }
}

const csv = (value) => (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)

function readState () {
  const file = process.env.HULY_STATE_FILE ?? path.join(__dirname, '..', '.smoke-state')
  const state = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/)
    // values are written with bash printf %q
    if (match != null) state[match[1]] = match[2].replace(/\\(.)/g, '$1')
  }
  return state
}

async function login (page, base, state) {
  await page.goto(`${base}/login/login`)
  const withPassword = page.getByText('Login with password', { exact: true })
  const password = page.locator('input[name=current-password]')
  await withPassword.or(password).first().waitFor({ timeout: TIMEOUT })
  if (await withPassword.isVisible()) await withPassword.click()
  await page.locator('input[name=email]').fill(state.SMOKE_EMAIL)
  await password.fill(state.SMOKE_PASSWORD)
  await page.getByRole('button', { name: 'Log In', exact: true }).click()
  await page.waitForURL(/selectWorkspace|workbench/, { timeout: TIMEOUT })
}

// Enter through the workspace root so the workbench picks the landing route itself.
async function openWorkspace (page, base, workspace) {
  await page.goto(`${base}/workbench/${workspace}`)
  await page.locator('button[id^="app-"]').first().waitFor({ timeout: TIMEOUT })
}

async function openConfigure (page, base, workspace) {
  await page.goto(`${base}/workbench/${workspace}/setting/setting/configuration`)
  await page.locator('.plugin-card').first().waitFor({ timeout: TIMEOUT })
}

async function readCards (page) {
  return await page.locator('.plugin-card').evaluateAll((cards) =>
    cards.map((card) => ({
      name: card.querySelector('.plugin-card__name')?.textContent?.trim(),
      enabled: card.classList.contains('enabled')
    }))
  )
}

async function setPlugin (page, base, workspace, name, enabled) {
  const card = page.locator('.plugin-card').filter({
    has: page.locator('.plugin-card__name').getByText(name, { exact: true })
  })
  if ((await card.count()) !== 1) throw new Error(`expected one plugin card named "${name}"`)
  if ((await card.evaluate((el) => el.classList.contains('enabled'))) === enabled) {
    console.log(`unchanged: ${name}=${enabled}`)
    return
  }
  // the client reloads itself after a plugin configuration update
  const reload = page.waitForEvent('load', { timeout: TIMEOUT })
  await card.locator('label.toggle').click()
  await reload
  await openConfigure(page, base, workspace)
  console.log(`changed: ${name}=${enabled}`)
}

async function readRail (page) {
  return await page.locator('button[id^="app-"]').evaluateAll((buttons) => [
    ...new Set(buttons.map((button) => button.id.replace(/^app-/, '')))
  ])
}

async function waitForLandingRoute (page, workspace) {
  const root = new RegExp(`/workbench/${workspace}/?$`)
  const deadline = Date.now() + TIMEOUT
  while (root.test(new URL(page.url()).pathname) && Date.now() < deadline) {
    await page.waitForTimeout(250)
  }
  // the workbench may rewrite the route again once the app and space resolve
  await page.waitForTimeout(3000)
  return new URL(page.url()).pathname
}

async function verify (page, base, workspace, options) {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message.split('\n')[0]))

  await openWorkspace(page, base, workspace)
  const route = await waitForLandingRoute(page, workspace)
  const landing = decodeURIComponent(route).split('/')[3]
  console.log(`landing route: ${decodeURIComponent(route)}`)
  if (landing !== options.landing) fail(`landing app is "${landing}", expected "${options.landing}"`)

  const rail = await readRail(page)
  console.log(`rail: ${rail.join(' ')}`)
  for (const app of csv(options.require)) {
    if (!rail.some((id) => id.startsWith(`${app}:`))) fail(`required app missing from rail: ${app}`)
  }
  for (const app of csv(options.forbid)) {
    if (rail.some((id) => id.startsWith(`${app}:`))) fail(`hidden app still in rail: ${app}`)
  }

  // capture the landing before --open navigates away from it
  if (options.screenshot !== undefined) await page.screenshot({ path: options.screenshot })

  for (const app of csv(options.open)) {
    await page.locator(`button[id^="app-${app}:"]`).first().click()
    await page.waitForTimeout(3000)
    const opened = decodeURIComponent(new URL(page.url()).pathname).split('/')[3]
    console.log(`opened ${app}: route app=${opened}`)
    if (opened !== app) fail(`opening ${app} routed to "${opened}"`)
  }
  // sidebar widgets such as the calendar open next to the page and do not change the route
  for (const app of csv(options.widget)) {
    const before = page.url()
    await page.locator(`button[id^="app-${app}:"]`).first().click()
    await page.getByText('Today', { exact: true }).first().waitFor({ timeout: TIMEOUT })
    console.log(`opened widget ${app}`)
    if (page.url() !== before) fail(`widget ${app} changed the route`)
  }
  if (errors.length > 0) console.log(`page errors (${errors.length}): ${[...new Set(errors)].join(' | ')}`)
}

async function main () {
  const { command, options } = parseArgs(process.argv.slice(2))
  const base = process.env.HULY_URL?.replace(/\/$/, '')
  if (base === undefined) throw new Error('HULY_URL is not set')
  if (!['list', 'set', 'verify'].includes(command)) throw new Error(`unknown command: ${command}`)
  if (command === 'verify' && options.landing === undefined) throw new Error('verify needs --landing')

  const state = readState()
  const workspace = process.env.HULY_WORKSPACE ?? state.SMOKE_WS_URL
  const browser = await chromium.launch(
    process.env.CHROME_PATH !== undefined ? { executablePath: process.env.CHROME_PATH } : {}
  )
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await context.newPage()
    page.setDefaultTimeout(TIMEOUT)
    await login(page, base, state)
    console.log(`workspace: ${workspace}`)

    if (command === 'verify') {
      await verify(page, base, workspace, options)
      return
    }
    await openConfigure(page, base, workspace)
    if (command === 'set') {
      for (const name of csv(options.disable)) await setPlugin(page, base, workspace, name, false)
      for (const name of csv(options.enable)) await setPlugin(page, base, workspace, name, true)
    }
    for (const card of await readCards(page)) console.log(`${card.enabled ? 'on ' : 'off'} ${card.name}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(`FAIL: ${String(error.message ?? error).split('\n')[0]}`)
  process.exit(1)
})
